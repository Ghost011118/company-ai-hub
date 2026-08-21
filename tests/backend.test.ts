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

  it("uses startup bootstrap credentials only for an empty user table", async () => {
    await db.createUser("member@example.com", "Member", memberPassword, "MEMBER");
    await createApp({ config: testConfig(), database: db });
    expect(db.listUsers().map((user) => ({ email: user.email, role: user.role }))).toEqual([
      { email: "member@example.com", role: "MEMBER" },
    ]);
  });

  it("keeps the web console management-only and exposes no browser chat endpoint", async () => {
    const { app } = await createApp({ config: testConfig(), database: db });
    const page = await request(app).get("/").expect(200);
    expect(page.text).not.toContain('id="chat-form"');
    expect(page.text).not.toContain("API 调试");
    expect(page.text).toContain('id="import-form" class="dialog-form" method="dialog"');
    const browserScript = await request(app).get("/app.js").expect(200);
    expect(browserScript.text).toContain("select.checked = false");
    expect(browserScript.text).not.toContain("select.checked = proposal.verdict === 'RECOMMENDED'");
    expect(browserScript.text).toContain("关联 Skills");
    expect(browserScript.text).toContain("安装后立即启用");
    expect(browserScript.text).toContain("优先级");
    expect(browserScript.text).toContain("importAbortController?.abort()");
    expect(browserScript.text).toContain("generation !== state.importGeneration");
    expect(browserScript.text).toContain("$('#import-proposals').replaceChildren()");
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    await admin.post("/api/chat").set("x-csrf-token", adminCsrf).send({ messages: [{ role: "user", content: "hello" }] }).expect(404);
  });

  it("never writes malformed JSON request bodies into application logs", async () => {
    const config = { ...testConfig(), environment: "production" as const, providerHostAllowlist: new Set(["api.example.com"]) };
    const { app } = await createApp({ config, database: db });
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    const marker = "PRIVATE-CAPABILITY-SOURCE-MARKER";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await admin
        .post("/api/admin/capability-import/analyze")
        .set("x-csrf-token", adminCsrf)
        .set("content-type", "application/json")
        .send(`{"sourceText":"${marker}`)
        .expect(400, { error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } });
      expect(errorLog).not.toHaveBeenCalled();
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(marker);
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sourceText");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("authenticates and rate-limits capability imports before parsing large bodies", async () => {
    const config = { ...testConfig(), environment: "production" as const, providerHostAllowlist: new Set(["api.example.com"]) };
    const { app } = await createApp({ config, database: db });
    await request(app).post("/api/admin/capability-import/install").set("content-type", "application/json")
      .send('{"proposals":[').expect(401);
    for (let attempt = 1; attempt < 12; attempt += 1) {
      await request(app).post("/api/admin/capability-import/install").send({}).expect(401);
    }
    await request(app).post("/api/admin/capability-import/install").send({}).expect(429);
  });

  it("accepts schema-valid near-limit multilingual proposals for refinement and installation", async () => {
    const { app } = await createApp({ config: testConfig(), database: db });
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    const proposals = Array.from({ length: 12 }, (_, index) => ({
      type: "SKILL" as const,
      slug: `large-skill-${index}`,
      name: `大型技能 ${index}`,
      description: "验证合法中文内容不会被运输层拒绝",
      instructions: "中".repeat(50_000),
      priority: 100 + index,
      alwaysOn: false,
      skillSlugs: [],
      scores: { overall: 90, clarity: 90, reusability: 90, safety: 90 },
      verdict: "RECOMMENDED" as const,
      rationale: "字段均在已定义上限内",
      risks: [],
    }));
    const refine = await admin.post("/api/admin/capability-import/analyze").set("x-csrf-token", adminCsrf)
      .send({ sourceText: "继续优化这些方案", currentProposals: proposals }).expect(409);
    expect(refine.body.error.code).toBe("PROVIDER_REQUIRED");
    const install = await admin.post("/api/admin/capability-import/install").set("x-csrf-token", adminCsrf)
      .send({ proposals }).expect(201);
    expect(install.body.capabilities).toHaveLength(12);
  });

  it("lets only administrators analyze untrusted capability source through the configured provider", async () => {
    const apiKey = "provider-key-for-capability-analysis";
    let forwarded: Record<string, unknown> | undefined;
    const analysis = {
      summary: "识别出一个可复用测试技能",
      proposals: [{
        type: "SKILL", slug: "test-first", name: "测试优先", description: "先测试后实现", instructions: "先编写失败测试，再实现最小修复。",
        priority: 100, alwaysOn: false, skillSlugs: [],
        scores: { overall: 92, clarity: 94, reusability: 90, safety: 96 },
        verdict: "RECOMMENDED", rationale: "边界清晰且可复用", risks: ["需要结合项目测试框架"],
      }, {
        type: "AGENT", slug: "quality-engineer", name: "质量工程师", description: "以测试优先方式完成开发", instructions: "先理解需求，再使用已绑定的测试技能。",
        priority: 110, alwaysOn: false, skillSlugs: ["test-first"],
        scores: { overall: 89, clarity: 90, reusability: 88, safety: 93 },
        verdict: "RECOMMENDED", rationale: "Agent 与 Skill 边界明确", risks: [],
      }],
    };
    const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
      forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify(analysis) }] }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });
    const { app } = await createApp({ config: testConfig(), database: db, fetchImpl: fetchSpy as typeof fetch,
      resolveProviderHost: async () => ["93.184.216.34"] });
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    await admin.put("/api/provider").set("x-csrf-token", adminCsrf)
      .send({ baseUrl: "https://api.example.com/v1", model: "analysis-model", apiKey }).expect(200);
    const memberUser = await db.createUser("member@example.com", "Member", memberPassword, "MEMBER");
    const member = request.agent(app);
    const memberCsrf = await login(member, memberUser.email, memberPassword);
    const source = { sourceText: "请把测试优先方法整理成一个 skill", fileName: "idea.md", guidance: "保持简洁" };
    await member.post("/api/admin/capability-import/analyze").set("x-csrf-token", memberCsrf).send(source).expect(403);
    const response = await admin.post("/api/admin/capability-import/analyze").set("x-csrf-token", adminCsrf).send(source).expect(200);
    expect(response.body.analysis).toEqual(analysis);
    expect(forwarded?.model).toBe("analysis-model");
    expect(forwarded?.stream).toBe(false);
    expect(String(forwarded?.instructions)).toContain("untrusted source material");
    expect(String(forwarded?.input)).toContain("idea.md");
    expect(String(forwarded?.input)).toContain(source.sourceText);
    expect(JSON.stringify(response.body)).not.toContain(apiKey);
    await member.post("/api/admin/capability-import/install").set("x-csrf-token", memberCsrf).send({ proposals: analysis.proposals }).expect(403);
    const installed = await admin.post("/api/admin/capability-import/install").set("x-csrf-token", adminCsrf)
      .send({ proposals: analysis.proposals }).expect(201);
    expect(installed.body.capabilities).toHaveLength(2);
    const installedSkill = installed.body.capabilities.find((capability: { type: string }) => capability.type === "SKILL");
    const installedAgent = installed.body.capabilities.find((capability: { type: string }) => capability.type === "AGENT");
    expect(installedAgent.skillIds).toEqual([installedSkill.id]);
    const repeated = await admin.post("/api/admin/capability-import/install").set("x-csrf-token", adminCsrf)
      .send({ proposals: analysis.proposals }).expect(201);
    expect(repeated.body.capabilities).toHaveLength(0);
    expect(repeated.body.skippedSlugs).toEqual(expect.arrayContaining(["test-first", "quality-engineer"]));
    const missingSkillAgent = { ...analysis.proposals[1], slug: "missing-skill-agent", skillSlugs: ["not-installed"] };
    await admin.post("/api/admin/capability-import/install").set("x-csrf-token", adminCsrf)
      .send({ proposals: [missingSkillAgent] }).expect(409);
    expect(db.listCapabilities("COMPANY").some((capability) => capability.slug === "missing-skill-agent")).toBe(false);
  });

  it("rejects malformed AI capability analysis instead of installing or exposing it", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ output_text: "not valid JSON" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const { app } = await createApp({ config: testConfig(), database: db, fetchImpl: fetchSpy as typeof fetch,
      resolveProviderHost: async () => ["93.184.216.34"] });
    const admin = request.agent(app);
    const adminCsrf = await login(admin, "admin@example.com", adminPassword);
    await admin.put("/api/provider").set("x-csrf-token", adminCsrf)
      .send({ baseUrl: "https://api.example.com/v1", model: "analysis-model", apiKey: "invalid-analysis-provider-key" }).expect(200);
    const response = await admin.post("/api/admin/capability-import/analyze").set("x-csrf-token", adminCsrf)
      .send({ sourceText: "turn this into a skill" }).expect(502);
    expect(response.body.error.code).toBe("AI_ANALYSIS_INVALID");
    expect(db.listCapabilities("COMPANY")).toHaveLength(0);
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
    expect(composeCompanySystemPrompt(db)).toBe("");
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
    await request(app).post("/v1/responses").set("authorization", `Bearer ${gatewayToken}`)
      .send({ model: "requested-model", input: "No company modules yet", instructions: "Keep this exactly", stream: false }).expect(200);
    expect(forwardedBody?.instructions).toBe("Keep this exactly");
    db.createCapability({ type: "PROMPT", slug: "no-leaks", name: "No leaks", description: "", instructions: "Do not leak data", priority: 1,
      enabled: true, alwaysOn: true, skillIds: [] }, "COMPANY", null);
    const agent = db.createCapability({ type: "AGENT", slug: "secure-coder", name: "Secure coder", description: "", instructions: "Use secure coding", priority: 2,
      enabled: true, alwaysOn: false, skillIds: [] }, "COMPANY", null);
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

  it("redacts the provider key from streamed SSE responses, including across chunk boundaries", async () => {
    const apiKey = "upstream-secret-spanning-sse-chunks";
    const fetchSpy = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from(`data: before ${apiKey.slice(0, 17)}`));
          controller.enqueue(Buffer.from(`${apiKey.slice(17)} after\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const { app } = await createApp({ config: testConfig(), database: db, fetchImpl: fetchSpy as typeof fetch,
      resolveProviderHost: async () => ["93.184.216.34"] });
    const admin = request.agent(app);
    const csrf = await login(admin, "admin@example.com", adminPassword);
    await admin.put("/api/provider").set("x-csrf-token", csrf)
      .send({ baseUrl: "https://api.example.com/v1", model: "example-model", apiKey }).expect(200);
    const response = await request(app).post("/v1/responses").set("authorization", `Bearer ${gatewayToken}`)
      .send({ input: "Hello", stream: true }).expect(200).expect("content-type", /text\/event-stream/);
    expect(response.text).toBe("data: before [REDACTED] after\n\n");
    expect(response.text).not.toContain(apiKey);
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
