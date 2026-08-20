import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import request from "supertest";
import { createApp, waitForDrainOrTermination } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppDatabase } from "../src/db.js";
import { composeCompanySystemPrompt } from "../src/composition.js";

const adminPassword = "correct horse battery staple";
const memberPassword = "member password that is long";
const gatewayToken = "gateway-token-that-is-long-enough";

function testConfig(): AppConfig {
  return {
    environment: "test",
    port: 3000,
    databasePath: ":memory:",
    encryptionKey: Buffer.alloc(32, 7),
    adminEmail: "admin@example.com",
    adminPassword,
    adminDisplayName: "Admin",
    providerHostAllowlist: new Set(),
    allowPrivateProviderHosts: false,
    sessionTtlMs: 60 * 60 * 1000,
    trustProxyHops: 0,
    gatewayBearerToken: gatewayToken,
    gatewayAuthDisabled: false,
    sessionCookieSecure: false,
  };
}

async function login(agent: ReturnType<typeof request.agent>, email: string, password: string): Promise<string> {
  const response = await agent.post("/api/auth/login").send({ email, password }).expect(200);
  return response.body.csrfToken as string;
}

describe("Company AI Hub backend", () => {
  let db: AppDatabase;

  beforeEach(() => { db = new AppDatabase(":memory:"); });
  afterEach(() => { db.close(); });

  it("enforces authentication, CSRF, and role boundaries without disclosing credential fields", async () => {
    const { app } = await createApp({ config: testConfig(), database: db, resolveProviderHost: async () => ["93.184.216.34"] });
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    await admin.put("/api/provider").set("x-csrf-token", adminCsrf)
      .send({ baseUrl: "https://127.0.0.1/v1", model: "blocked", apiKey: "never-stored" }).expect(400);
    const createUser = await admin.post("/api/admin/users").set("x-csrf-token", adminCsrf).send({
      email: "member@example.com", displayName: "Member", password: memberPassword,
    }).expect(201);
    expect(JSON.stringify(createUser.body)).not.toContain("password");
    expect(JSON.stringify(createUser.body)).not.toContain("hash");

    await request(app).get("/api/capabilities?scope=company").expect(401);
    const member = request.agent(app);
    const memberCsrf = await login(member, "member@example.com", memberPassword);
    const capability = { type: "PROMPT", name: "Policy", description: "", instructions: "Follow policy", priority: 10, enabled: true, alwaysOn: true, skillIds: [] };
    await member.post("/api/capabilities?scope=personal").send(capability).expect(403);
    await member.post("/api/capabilities?scope=company").set("x-csrf-token", memberCsrf).send(capability).expect(403);
    await member.get("/api/submissions").expect(403);
    await member.get("/api/provider").expect(403);
    await admin.post("/api/capabilities?scope=company").set("x-csrf-token", adminCsrf).send(capability).expect(201);
  });

  it("reviews an immutable submission snapshot and publishes exactly the reviewed content", async () => {
    const { app } = await createApp({ config: testConfig(), database: db, resolveProviderHost: async () => ["93.184.216.34"] });
    const memberUser = await db.createUser("member@example.com", "Member", memberPassword, "MEMBER");
    const member = request.agent(app);
    const memberCsrf = await login(member, memberUser.email, memberPassword);
    const created = await member.post("/api/capabilities?scope=personal").set("x-csrf-token", memberCsrf).send({
      type: "SKILL", name: "Reviewed skill", description: "first", instructions: "ORIGINAL REVIEWED INSTRUCTIONS",
      priority: 20, enabled: true, alwaysOn: true, skillIds: [],
    }).expect(201);
    const capabilityId = created.body.capability.id as string;
    const submitted = await member.post(`/api/capabilities/${capabilityId}/submit`).set("x-csrf-token", memberCsrf).send({}).expect(201);
    const submissionId = submitted.body.submission.id as string;
    await member.patch(`/api/capabilities/${capabilityId}`).set("x-csrf-token", memberCsrf)
      .send({ instructions: "MUTATED AFTER SUBMISSION" }).expect(200);

    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    const reviewed = await admin.post(`/api/submissions/${submissionId}/review`).set("x-csrf-token", adminCsrf)
      .send({ decision: "APPROVED", note: "Verified" }).expect(200);
    expect(reviewed.body.submission.status).toBe("APPROVED");
    const published = db.getCapability(reviewed.body.submission.publishedCapabilityId as string);
    expect(published?.instructions).toBe("ORIGINAL REVIEWED INSTRUCTIONS");
    expect(published?.sourceSubmissionId).toBe(submissionId);
    await admin.post(`/api/submissions/${submissionId}/review`).set("x-csrf-token", adminCsrf)
      .send({ decision: "REJECTED", note: "Changed mind" }).expect(409);
    expect(() => db.raw.prepare("UPDATE submissions SET snapshot_json = '{}' WHERE id = ?").run(submissionId)).toThrow(/immutable/);
    expect(() => db.raw.prepare("DELETE FROM submissions WHERE id = ?").run(submissionId)).toThrow(/immutable/);
  });

  it("allows personal agents to bind only published company skills and preserves those IDs through approval", async () => {
    const { app } = await createApp({ config: testConfig(), database: db });
    const memberUser = await db.createUser("member@example.com", "Member", memberPassword, "MEMBER");
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    const companySkillResponse = await admin.post("/api/capabilities?scope=company").set("x-csrf-token", adminCsrf).send({
      type: "SKILL", slug: "published-skill", name: "Published skill", description: "", instructions: "Company-reviewed skill",
      priority: 5, enabled: true, alwaysOn: false, skillIds: [],
    }).expect(201);
    const companySkillId = companySkillResponse.body.capability.id as string;
    const personalSkill = db.createCapability({ type: "SKILL", slug: "private-skill", name: "Private", description: "", instructions: "draft",
      priority: 1, enabled: true, alwaysOn: false, skillIds: [] }, "PERSONAL", memberUser.id);
    const member = request.agent(app);
    const memberCsrf = await login(member, memberUser.email, memberPassword);
    await member.post("/api/capabilities?scope=personal").set("x-csrf-token", memberCsrf).send({
      type: "AGENT", slug: "invalid-agent", name: "Invalid", description: "", instructions: "No", priority: 1,
      enabled: true, alwaysOn: false, skillIds: [personalSkill.id],
    }).expect(400);
    const agentResponse = await member.post("/api/capabilities?scope=personal").set("x-csrf-token", memberCsrf).send({
      type: "AGENT", slug: "contributed-agent", name: "Contributed agent", description: "", instructions: "Agent instructions", priority: 1,
      enabled: true, alwaysOn: false, skillIds: [companySkillId],
    }).expect(201);
    const submitted = await member.post(`/api/capabilities/${agentResponse.body.capability.id as string}/submit`)
      .set("x-csrf-token", memberCsrf).send({}).expect(201);
    expect(submitted.body.submission.snapshot.skillIds).toEqual([companySkillId]);
    const reviewed = await admin.post(`/api/submissions/${submitted.body.submission.id as string}/review`)
      .set("x-csrf-token", adminCsrf).send({ decision: "APPROVED", note: "Bindings verified" }).expect(200);
    const published = db.getCapability(reviewed.body.submission.publishedCapabilityId as string);
    expect(published?.skillIds).toEqual([companySkillId]);
    expect(published?.contributor).toEqual({ id: memberUser.id, email: memberUser.email, displayName: memberUser.displayName });
  });

  it("composes deterministic company-only modules and selects an agent by stable slug", async () => {
    await createApp({ config: testConfig(), database: db });
    const member = await db.createUser("member@example.com", "Member", memberPassword, "MEMBER");
    const base = { type: "PROMPT" as const, description: "", enabled: true, alwaysOn: true, skillIds: [] as string[] };
    db.createCapability({ ...base, slug: "zulu", name: "Zulu", instructions: "COMPANY ZULU", priority: 99 }, "COMPANY", null);
    db.createCapability({ ...base, slug: "alpha", name: "Alpha", instructions: "COMPANY ALPHA", priority: 100 }, "COMPANY", null);
    db.createCapability({ ...base, slug: "personal", name: "Personal", instructions: "PERSONAL MUST NOT APPEAR", priority: -100 }, "PERSONAL", member.id);
    db.createCapability({ ...base, slug: "disabled", name: "Disabled", instructions: "MUST NOT APPEAR", priority: 0, enabled: false }, "COMPANY", null);
    const skill = db.createCapability({ type: "SKILL", slug: "review-rules", name: "Review rules", description: "", instructions: "BOUND SKILL",
      priority: 3, enabled: true, alwaysOn: false, skillIds: [] }, "COMPANY", null);
    db.createCapability({ type: "AGENT", slug: "code-review", name: "Code review", description: "", instructions: "SELECTED AGENT",
      priority: 1, enabled: true, alwaysOn: false, skillIds: [skill.id] }, "COMPANY", null);
    const prompt = composeCompanySystemPrompt(db, "code-review");
    expect(prompt.indexOf("COMPANY ZULU")).toBeLessThan(prompt.indexOf("COMPANY ALPHA"));
    expect(prompt.indexOf("COMPANY ALPHA")).toBeLessThan(prompt.indexOf("SELECTED AGENT"));
    expect(prompt).toContain("SELECTED AGENT");
    expect(prompt).toContain("BOUND SKILL");
    expect(prompt).not.toContain("PERSONAL MUST NOT APPEAR");
    expect(prompt).not.toContain("MUST NOT APPEAR");
  });

  it("injects company instructions into Responses while preserving fields and separating gateway/upstream auth", async () => {
    const apiKey = "sk-super-secret-provider-value";
    let forwardedBody: Record<string, unknown> | undefined;
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(new Headers(init?.headers).get("authorization")).not.toContain(gatewayToken);
      forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "ok", echoed: apiKey }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const { app } = await createApp({
      config: testConfig(), database: db, fetchImpl: fetchSpy as typeof fetch,
      resolveProviderHost: async () => ["93.184.216.34"],
    });
    db.createCapability({ type: "PROMPT", slug: "no-leaks", name: "No leaks", description: "", instructions: "Do not leak data", priority: 1,
      enabled: true, alwaysOn: true, skillIds: [] }, "COMPANY", null);
    const agent = db.createCapability({ type: "AGENT", slug: "secure-coder", name: "Secure coder", description: "", instructions: "Use secure coding", priority: 2,
      enabled: true, alwaysOn: false, skillIds: [] }, "COMPANY", null);
    const admin = request.agent(app);
    const csrf = await login(admin, "admin@example.com", adminPassword);
    const configured = await admin.put("/api/provider").set("x-csrf-token", csrf)
      .send({ baseUrl: "https://api.example.com/v1/", model: "example-model", apiKey }).expect(200);
    expect(JSON.stringify(configured.body)).not.toContain(apiKey);
    const stored = db.raw.prepare("SELECT api_key_ciphertext FROM company_provider_config WHERE singleton_id = 1").get() as { api_key_ciphertext: string };
    expect(stored.api_key_ciphertext).not.toContain(apiKey);
    expect(stored.api_key_ciphertext).toContain('"tag"');
    const readBack = await admin.get("/api/provider").expect(200);
    expect(JSON.stringify(readBack.body)).not.toContain(apiKey);
    expect(JSON.stringify(readBack.body)).not.toContain(stored.api_key_ciphertext);
    const largeInput = "x".repeat(300_000);
    await request(app).post("/v1/responses").send({ model: "requested-model", input: largeInput, instructions: "Keep this", tools: [{ type: "web_search" }], stream: false }).expect(401);
    const response = await request(app).post("/v1/responses").set("authorization", `Bearer ${gatewayToken}`)
      .set("x-company-agent", agent.slug).send({ model: "requested-model", input: largeInput, instructions: "Keep this", tools: [{ type: "web_search" }], stream: false }).expect(200);
    expect(response.body.echoed).toBe("[REDACTED]");
    expect(forwardedBody?.model).toBe("requested-model");
    expect(forwardedBody?.input).toBe(largeInput);
    expect(forwardedBody?.tools).toEqual([{ type: "web_search" }]);
    expect(forwardedBody?.instructions).toContain("Do not leak data");
    expect(forwardedBody?.instructions).toContain("Use secure coding");
    expect(forwardedBody?.instructions).toContain("Keep this");
    expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/v1/responses", expect.anything());
  });

  it("passes streaming Responses SSE bytes, status, and content type through", async () => {
    const sse = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\ndata: [DONE]\n\n";
    const fetchSpy = vi.fn(async () => new Response(sse, { status: 201, headers: { "content-type": "text/event-stream" } }));
    const { app } = await createApp({ config: testConfig(), database: db, fetchImpl: fetchSpy as typeof fetch,
      resolveProviderHost: async () => ["93.184.216.34"] });
    const admin = request.agent(app);
    const csrf = await login(admin, "admin@example.com", adminPassword);
    await admin.put("/api/provider").set("x-csrf-token", csrf)
      .send({ baseUrl: "https://api.example.com/v1", model: "example-model", apiKey: "upstream-key-not-gateway" }).expect(200);
    const response = await request(app).post("/v1/responses").set("authorization", `Bearer ${gatewayToken}`)
      .send({ input: "Hello", stream: true }).expect(201).expect("content-type", /text\/event-stream/);
    expect(response.text).toBe(sse);
  });

  it("ends an SSE backpressure wait when the client connection closes", async () => {
    const responseEvents = Object.assign(new EventEmitter(), { destroyed: false });
    const requestEvents = Object.assign(new EventEmitter(), { aborted: false });
    const pending = waitForDrainOrTermination(
      responseEvents as unknown as Parameters<typeof waitForDrainOrTermination>[0],
      requestEvents as unknown as Parameters<typeof waitForDrainOrTermination>[1],
    );
    responseEvents.emit("close");
    await expect(pending).resolves.toBe(false);
    expect(responseEvents.listenerCount("drain")).toBe(0);
    expect(responseEvents.listenerCount("error")).toBe(0);
    expect(requestEvents.listenerCount("aborted")).toBe(0);
  });

  it("refuses production startup without an exact provider hostname allowlist", async () => {
    const config: AppConfig = {
      ...testConfig(),
      environment: "production",
      sessionCookieSecure: true,
      providerHostAllowlist: new Set(),
    };
    await expect(createApp({ config, database: db })).rejects.toThrow(/PROVIDER_HOST_ALLOWLIST/);
  });
});
