import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { AppDatabase, type CapabilityInput, type CapabilityView } from "./db.js";
import { composeCompanySystemPrompt } from "./composition.js";
import { buildCapabilityAnalysisRequest, capabilityImportBodySchema, capabilityInstallBodySchema, parseCapabilityAnalysis } from "./capability-import.js";
import { buildProviderUrl, validateProviderBaseUrl, type ProviderPolicy } from "./provider-policy.js";
import { decryptSecret, encryptSecret, hashPassword, hashToken, randomToken, tokenMatches, verifyPassword } from "./security.js";

const capabilityType = z.enum(["AGENT", "SKILL", "PROMPT"]);
const capabilityBody = z.object({
  type: capabilityType,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  instructions: z.string().trim().min(1).max(50_000),
  priority: z.number().int().min(-10_000).max(10_000).default(100),
  enabled: z.boolean().default(true),
  alwaysOn: z.boolean().default(false),
  skillIds: z.array(z.string().uuid()).max(100).default([]),
}).strict();
const capabilityPatch = capabilityBody.partial();
const loginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict();
const providerBody = z.object({
  baseUrl: z.string().url().max(2_000),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().min(1).max(4_096).optional(),
}).strict();
const agentReference = z.union([z.string().uuid(), z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120)]);
const responsesGatewayBody = z.object({
  instructions: z.string().max(200_000).optional(),
  model: z.string().min(1).max(200).optional(),
  stream: z.boolean().optional(),
}).passthrough();
const chatGatewayBody = z.object({
  messages: z.array(z.unknown()).min(1).max(200),
  model: z.string().min(1).max(200).optional(),
  stream: z.boolean().optional(),
}).passthrough();

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function safeErrorForLog(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "UnknownError", message: "A non-Error value was thrown" };
  const metadata = error as Error & { type?: unknown; status?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof metadata.type === "string" ? { type: metadata.type } : {}),
    ...(typeof metadata.status === "number" ? { status: metadata.status } : {}),
    ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
  };
}

export interface CreateAppOptions {
  config: AppConfig;
  database?: AppDatabase;
  fetchImpl?: typeof fetch;
  resolveProviderHost?: (hostname: string) => Promise<string[]>;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try { result[name] = decodeURIComponent(value); } catch { /* Ignore malformed cookies. */ }
  }
  return result;
}

function sessionCookieOptions(config: AppConfig): express.CookieOptions {
  return { httpOnly: true, sameSite: "strict", secure: config.sessionCookieSecure, path: "/", maxAge: config.sessionTtlMs };
}

function csrfCookieOptions(config: AppConfig): express.CookieOptions {
  return { httpOnly: false, sameSite: "strict", secure: config.sessionCookieSecure, path: "/", maxAge: config.sessionTtlMs };
}

function ownOrAdmin(req: Request, capability: CapabilityView): boolean {
  return capability.scope === "COMPANY" ? req.auth?.role === "ADMIN" : capability.ownerUserId === req.auth?.id;
}

function slugFromName(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `capability-${randomUUID().slice(0, 8)}`;
}

function safeCapabilityInput(value: z.infer<typeof capabilityBody>, fallbackSlug?: string): CapabilityInput {
  if (value.type !== "AGENT" && value.skillIds.length > 0) throw new HttpError(400, "INVALID_CAPABILITY", "Only agents can attach skills");
  return { ...value, slug: value.slug ?? fallbackSlug ?? slugFromName(value.name), alwaysOn: value.type === "PROMPT" ? true : value.alwaysOn };
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactSecret(item, secret));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecret(item, secret)]));
  return value;
}

async function readJsonWithLimit(response: globalThis.Response, limit: number): Promise<unknown> {
  if (!response.body) throw new HttpError(502, "PROVIDER_INVALID_RESPONSE", "Provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(502, "PROVIDER_RESPONSE_TOO_LARGE", "Provider response was too large");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(502, "PROVIDER_INVALID_RESPONSE", "Provider returned invalid JSON"); }
}

export async function waitForDrainOrTermination(
  response: Pick<Response, "destroyed" | "once" | "off">,
  request: Pick<Request, "aborted" | "once" | "off">,
): Promise<boolean> {
  if (response.destroyed || request.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      response.off("drain", onDrain);
      response.off("close", onTermination);
      response.off("error", onTermination);
      request.off("aborted", onTermination);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onTermination = () => finish(false);
    response.once("drain", onDrain);
    response.once("close", onTermination);
    response.once("error", onTermination);
    request.once("aborted", onTermination);
    if (response.destroyed || request.aborted) finish(false);
  });
}

export async function createApp(options: CreateAppOptions): Promise<{ app: express.Express; db: AppDatabase }> {
  const { config } = options;
  if (config.environment === "production" && (config.gatewayAuthDisabled || !config.gatewayBearerToken)) {
    throw new Error("Gateway authentication is required in production");
  }
  if (!config.gatewayAuthDisabled && !config.gatewayBearerToken) {
    throw new Error("Gateway authentication requires a bearer token unless explicitly disabled outside production");
  }
  if (config.environment === "production" && config.providerHostAllowlist.size === 0) {
    throw new Error("PROVIDER_HOST_ALLOWLIST must contain at least one exact hostname in production");
  }
  const db = options.database ?? new AppDatabase(config.databasePath);
  await db.bootstrapAdmin(config);
  db.deleteExpiredSessions();
  const fetchImpl = options.fetchImpl ?? fetch;
  const dummyPasswordHash = await hashPassword(randomToken());
  const providerPolicy: ProviderPolicy = {
    hostAllowlist: config.providerHostAllowlist,
    allowPrivateHosts: config.allowPrivateProviderHosts,
  };
  if (options.resolveProviderHost !== undefined) providerPolicy.resolve = options.resolveProviderHost;
  const gatewayTokenHash = config.gatewayBearerToken ? hashToken(config.gatewayBearerToken) : null;
  const requireGatewayAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (config.gatewayAuthDisabled) return next();
    const authorization = req.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!gatewayTokenHash || !token || !tokenMatches(token, gatewayTokenHash)) {
      return next(new HttpError(401, "GATEWAY_AUTH_REQUIRED", "Gateway authentication failed"));
    }
    next();
  };
  const loadSession = (req: Request, _res: Response, next: NextFunction) => {
    const token = parseCookies(req.headers.cookie).hub_session;
    if (token) {
      const auth = db.getSession(hashToken(token));
      if (auth) req.auth = auth;
    }
    next();
  };
  const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, "AUTH_REQUIRED", "Authentication required"));
    next();
  };
  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, "AUTH_REQUIRED", "Authentication required"));
    if (req.auth.role !== "ADMIN") return next(new HttpError(403, "ADMIN_REQUIRED", "Administrator access required"));
    next();
  };
  const requireCsrf = (req: Request, _res: Response, next: NextFunction) => {
    const token = req.get("x-csrf-token");
    if (!req.auth || !token || !tokenMatches(token, req.auth.csrfHash)) return next(new HttpError(403, "CSRF_INVALID", "CSRF validation failed"));
    next();
  };

  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", "data:"], connectSrc: ["'self'"] } } }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: config.environment === "test" ? 10_000 : 240, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/api/auth/login", rateLimit({ windowMs: 15 * 60_000, limit: config.environment === "test" ? 10_000 : 10, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/api/admin/capability-import", rateLimit({ windowMs: 60_000, limit: config.environment === "test" ? 10_000 : 12, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/v1", rateLimit({ windowMs: 60_000, limit: config.environment === "test" ? 10_000 : 120, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/v1", requireGatewayAuth);
  app.use("/api", loadSession);
  app.use("/api/admin/capability-import", requireAdmin, requireCsrf, express.json({ limit: "8mb", strict: true }));
  app.use("/api", express.json({ limit: "256kb", strict: true }));
  app.use("/v1", express.json({ limit: "8mb", strict: true }));

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const body = loginBody.parse(req.body);
      const user = db.getLoginUser(body.email);
      const passwordValid = await verifyPassword(body.password, user?.passwordHash ?? dummyPasswordHash);
      if (!user || !user.active || !passwordValid) {
        throw new HttpError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
      }
      const sessionToken = randomToken();
      const csrfToken = randomToken();
      db.createSession(user.id, hashToken(sessionToken), hashToken(csrfToken), new Date(Date.now() + config.sessionTtlMs).toISOString());
      res.cookie("hub_session", sessionToken, sessionCookieOptions(config));
      res.cookie("hub_csrf", csrfToken, csrfCookieOptions(config));
      db.audit(user.id, "AUTH_LOGIN", "SESSION", null);
      const { passwordHash: _, ...safeUser } = user;
      res.json({ authenticated: true, user: safeUser, csrfToken });
    } catch (error) { next(error); }
  });

  app.get("/api/session", (req, res) => {
    if (!req.auth) return res.json({ authenticated: false });
    let csrfToken = parseCookies(req.headers.cookie).hub_csrf;
    if (!csrfToken || !tokenMatches(csrfToken, req.auth.csrfHash)) {
      csrfToken = randomToken();
      db.rotateSessionCsrf(req.auth.sessionId, hashToken(csrfToken));
      res.cookie("hub_csrf", csrfToken, csrfCookieOptions(config));
    }
    const { sessionId: _, csrfHash: __, ...user } = req.auth;
    res.json({ authenticated: true, user, csrfToken });
  });

  app.post("/api/auth/logout", requireAuth, requireCsrf, (req, res) => {
    db.deleteSession(req.auth!.sessionId);
    db.audit(req.auth!.id, "AUTH_LOGOUT", "SESSION", req.auth!.sessionId);
    res.clearCookie("hub_session", { ...sessionCookieOptions(config), maxAge: undefined });
    res.clearCookie("hub_csrf", { ...csrfCookieOptions(config), maxAge: undefined });
    res.status(204).end();
  });

  app.get("/api/admin/users", requireAdmin, (req, res) => res.json({ users: db.listUsers() }));
  app.post("/api/admin/users", requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const body = z.object({ email: z.string().email().max(254), displayName: z.string().trim().min(1).max(120), password: z.string().min(12).max(256) }).strict().parse(req.body);
      const user = await db.createUser(body.email, body.displayName, body.password, "MEMBER");
      db.audit(req.auth!.id, "USER_CREATE", "USER", user.id, { role: "MEMBER" });
      res.status(201).json({ user });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return next(new HttpError(409, "EMAIL_EXISTS", "A user with that email already exists"));
      next(error);
    }
  });

  app.get("/api/provider", requireAdmin, (_req, res) => {
    const provider = db.getProvider();
    res.json({ provider: provider ? { baseUrl: provider.baseUrl, model: provider.model, hasApiKey: true, updatedAt: provider.updatedAt } : null });
  });
  app.put("/api/provider", requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const body = providerBody.parse(req.body);
      const previous = db.getProvider();
      if (!body.apiKey && !previous) throw new HttpError(400, "API_KEY_REQUIRED", "An API key is required for initial setup");
      let baseUrl: string;
      try { baseUrl = await validateProviderBaseUrl(body.baseUrl, providerPolicy); }
      catch { throw new HttpError(400, "INVALID_PROVIDER_URL", "Provider URL is not permitted"); }
      const ciphertext = body.apiKey ? encryptSecret(body.apiKey, config.encryptionKey) : previous!.apiKeyCiphertext;
      const provider = db.putProvider(req.auth!.id, baseUrl, body.model, ciphertext);
      db.audit(req.auth!.id, "PROVIDER_UPDATE", "COMPANY_PROVIDER_CONFIG", "company", { host: new URL(baseUrl).hostname, model: body.model });
      res.json({ provider: { baseUrl: provider.baseUrl, model: provider.model, hasApiKey: true, updatedAt: provider.updatedAt } });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/capability-import/analyze", requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const body = capabilityImportBodySchema.parse(req.body);
      const provider = db.getProvider();
      if (!provider) throw new HttpError(409, "PROVIDER_REQUIRED", "Configure the company AI provider before using intelligent import");
      const requestBody = buildCapabilityAnalysisRequest(body, provider.model);
      const { upstream, apiKey } = await fetchCompanyProvider("responses", requestBody, 120_000);
      if (upstream.status >= 300 && upstream.status < 400) throw new HttpError(502, "PROVIDER_REDIRECT_REJECTED", "Provider redirect was rejected");
      if (!upstream.ok) throw new HttpError(502, "AI_ANALYSIS_FAILED", "The AI provider could not analyze this capability source");
      const length = Number(upstream.headers.get("content-length") ?? 0);
      if (length > 2_000_000) throw new HttpError(502, "PROVIDER_RESPONSE_TOO_LARGE", "Capability analysis response was too large");
      const payload = await readJsonWithLimit(upstream, 2_000_000);
      let analysis;
      try { analysis = parseCapabilityAnalysis(redactSecret(payload, apiKey)); }
      catch { throw new HttpError(502, "AI_ANALYSIS_INVALID", "The AI provider returned an invalid capability analysis"); }
      db.audit(req.auth!.id, "CAPABILITY_IMPORT_ANALYZE", "CAPABILITY_IMPORT", null, {
        fileName: body.fileName ?? null,
        sourceLength: body.sourceText.length,
        proposalCount: analysis.proposals.length,
      });
      res.json({ analysis });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/capability-import/install", requireAdmin, requireCsrf, (req, res, next) => {
    try {
      const body = capabilityInstallBodySchema.parse(req.body);
      const result = db.createCompanyCapabilityBatch(body.proposals.map((proposal) => ({
        type: proposal.type,
        slug: proposal.slug,
        name: proposal.name,
        description: proposal.description,
        instructions: proposal.instructions,
        priority: proposal.priority,
        enabled: true,
        alwaysOn: proposal.type === "PROMPT" ? true : proposal.type === "AGENT" ? false : proposal.alwaysOn,
        skillSlugs: proposal.skillSlugs,
      })));
      db.audit(req.auth!.id, "CAPABILITY_IMPORT_INSTALL", "CAPABILITY_IMPORT", null, {
        createdIds: result.created.map((capability) => capability.id),
        skippedSlugs: result.skippedSlugs,
      });
      res.status(201).json({ capabilities: result.created, skippedSlugs: result.skippedSlugs });
    } catch (error) {
      if (String(error).includes("Missing company skill")) return next(new HttpError(409, "SKILL_BINDING_MISSING", "Install the referenced company skills before this agent"));
      next(error);
    }
  });

  app.get("/api/capabilities", requireAuth, (req, res, next) => {
    try {
      const scope = z.enum(["personal", "company"]).parse(req.query.scope ?? "personal");
      res.json({ capabilities: db.listCapabilities(scope === "company" ? "COMPANY" : "PERSONAL", req.auth!.id) });
    } catch (error) { next(error); }
  });
  app.post("/api/capabilities", requireAuth, requireCsrf, (req, res, next) => {
    try {
      const bodyWithScope = z.object({ scope: z.enum(["personal", "company"]).optional() }).passthrough().parse(req.body);
      const scope = z.enum(["personal", "company"]).parse(req.query.scope ?? bodyWithScope.scope ?? "personal");
      if (scope === "company" && req.auth!.role !== "ADMIN") throw new HttpError(403, "ADMIN_REQUIRED", "Administrator access required");
      const { scope: _, ...rawCapability } = req.body as Record<string, unknown>;
      const input = safeCapabilityInput(capabilityBody.parse(rawCapability));
      let capability: CapabilityView;
      try { capability = db.createCapability(input, scope === "company" ? "COMPANY" : "PERSONAL", scope === "company" ? null : req.auth!.id); }
      catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) throw new HttpError(409, "SLUG_EXISTS", "That capability slug is already in use");
        if (String(error).includes("Bound skills") || String(error).includes("company skills")) throw new HttpError(400, "INVALID_SKILL_BINDING", "Agent bindings must reference published company skills");
        throw error;
      }
      db.audit(req.auth!.id, "CAPABILITY_CREATE", "CAPABILITY", capability.id, { scope: capability.scope, type: capability.type });
      res.status(201).json({ capability });
    } catch (error) { next(error); }
  });
  app.patch("/api/capabilities/:id", requireAuth, requireCsrf, (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const current = db.getCapability(id);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Capability not found");
      if (!ownOrAdmin(req, current)) throw new HttpError(403, "FORBIDDEN", "Capability cannot be changed");
      const patch = capabilityPatch.parse(req.body);
      const input = safeCapabilityInput(capabilityBody.parse({
        type: current.type,
        slug: current.slug,
        name: current.name,
        description: current.description,
        instructions: current.instructions,
        priority: current.priority,
        enabled: current.enabled,
        alwaysOn: current.alwaysOn,
        skillIds: current.skillIds,
        ...patch,
      }), current.slug);
      let capability: CapabilityView;
      try { capability = db.updateCapability(id, input); }
      catch (error) {
        if (String(error).includes("UNIQUE constraint failed")) throw new HttpError(409, "SLUG_EXISTS", "That capability slug is already in use");
        if (String(error).includes("Bound skills") || String(error).includes("bound skill") || String(error).includes("company skills")) {
          throw new HttpError(400, "INVALID_SKILL_BINDING", "Agent bindings must reference published company skills");
        }
        throw error;
      }
      db.audit(req.auth!.id, "CAPABILITY_UPDATE", "CAPABILITY", id, { scope: capability.scope, type: capability.type });
      res.json({ capability });
    } catch (error) { next(error); }
  });
  app.delete("/api/capabilities/:id", requireAuth, requireCsrf, (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const current = db.getCapability(id);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Capability not found");
      if (!ownOrAdmin(req, current)) throw new HttpError(403, "FORBIDDEN", "Capability cannot be deleted");
      db.deleteCapability(id);
      db.audit(req.auth!.id, "CAPABILITY_DELETE", "CAPABILITY", id, { scope: current.scope, type: current.type });
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.post("/api/capabilities/:id/submit", requireAuth, requireCsrf, (req, res, next) => {
    try {
      z.object({}).strict().parse(req.body ?? {});
      const id = z.string().uuid().parse(req.params.id);
      const capability = db.getCapability(id);
      if (!capability || capability.scope !== "PERSONAL" || capability.ownerUserId !== req.auth!.id) {
        throw new HttpError(404, "NOT_FOUND", "Personal capability not found");
      }
      const submission = db.createSubmission(capability, req.auth!.id);
      db.audit(req.auth!.id, "SUBMISSION_CREATE", "SUBMISSION", submission.id, { type: submission.snapshot.type });
      res.status(201).json({ submission });
    } catch (error) { next(error); }
  });

  app.get("/api/submissions", requireAdmin, (_req, res) => res.json({ submissions: db.listSubmissions() }));
  app.post("/api/submissions/:id/review", requireAdmin, requireCsrf, (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id);
      const body = z.object({ decision: z.enum(["APPROVED", "REJECTED"]), note: z.string().trim().max(2_000).default("") }).strict().parse(req.body);
      const submission = db.reviewSubmission(id, req.auth!.id, body.decision, body.note);
      db.audit(req.auth!.id, `SUBMISSION_${body.decision}`, "SUBMISSION", id, { publishedCapabilityId: submission.publishedCapabilityId });
      res.json({ submission });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return next(new HttpError(409, "SLUG_EXISTS", "An approved company capability already uses this slug"));
      if (String(error).includes("binding is no longer valid")) return next(new HttpError(409, "SKILL_BINDING_STALE", "A referenced company skill is no longer available"));
      if (String(error).includes("not pending")) return next(new HttpError(409, "ALREADY_REVIEWED", "Submission has already been reviewed"));
      next(error);
    }
  });

  async function fetchCompanyProvider(endpoint: "responses" | "chat/completions" | "models", body?: Record<string, unknown>, timeoutMs = 10 * 60_000): Promise<{ upstream: globalThis.Response; apiKey: string }> {
    const provider = db.getProvider();
    if (!provider) throw new HttpError(503, "PROVIDER_REQUIRED", "The company AI provider is not configured");
    const apiKey = decryptSecret(provider.apiKeyCiphertext, config.encryptionKey);
    let url: string;
    try { url = await buildProviderUrl(provider.baseUrl, endpoint, providerPolicy); }
    catch { throw new HttpError(502, "PROVIDER_URL_INVALID", "The company AI provider URL is unavailable"); }
    const controller = new AbortController();
    const init: RequestInit = {
      method: body ? "POST" : "GET",
      headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json", "accept": body?.stream === true ? "text/event-stream" : "application/json" },
      redirect: "manual",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
    };
    if (body) init.body = JSON.stringify(body);
    try { return { upstream: await fetchImpl(url, init), apiKey }; }
    catch { throw new HttpError(502, "PROVIDER_UNAVAILABLE", "The company AI provider is unavailable"); }
  }

  async function relayUpstream(req: Request, res: Response, next: NextFunction, endpoint: "responses" | "chat/completions" | "models", body?: Record<string, unknown>): Promise<void> {
    try {
      const { upstream, apiKey } = await fetchCompanyProvider(endpoint, body);
      if (upstream.status >= 300 && upstream.status < 400) throw new HttpError(502, "PROVIDER_REDIRECT_REJECTED", "Provider redirect was rejected");
      const contentType = upstream.headers.get("content-type") ?? "application/json";
      res.status(upstream.status);
      res.setHeader("content-type", contentType);
      for (const header of ["cache-control", "x-request-id", "openai-processing-ms"]) {
        const value = upstream.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (body?.stream === true) {
        if (!upstream.body) throw new HttpError(502, "PROVIDER_INVALID_RESPONSE", "Provider returned an empty response");
        const reader = upstream.body.getReader();
        res.on("close", () => { if (!res.writableEnded) void reader.cancel(); });
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value)) && !(await waitForDrainOrTermination(res, req))) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        res.end();
        return;
      }
      const length = Number(upstream.headers.get("content-length") ?? 0);
      if (length > 10_000_000) throw new HttpError(502, "PROVIDER_RESPONSE_TOO_LARGE", "Provider response was too large");
      const payload = await readJsonWithLimit(upstream, 10_000_000);
      res.status(upstream.status).json(redactSecret(payload, apiKey));
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      next(error);
    }
  }

  app.post("/v1/responses", async (req, res, next) => {
    try {
      const body = responsesGatewayBody.parse(req.body);
      const selectedAgent = req.get("x-company-agent");
      const agent = selectedAgent ? agentReference.parse(selectedAgent) : undefined;
      const companyInstructions = composeCompanySystemPrompt(db, agent);
      const forwarded: Record<string, unknown> = {
        ...body,
        model: body.model ?? db.getProvider()?.model,
      };
      if (companyInstructions) {
        forwarded.instructions = body.instructions ? `${companyInstructions}\n\n[CLIENT INSTRUCTIONS]\n${body.instructions}` : companyInstructions;
      }
      await relayUpstream(req, res, next, "responses", forwarded);
    } catch (error) {
      if (String(error).includes("Selected agent is not accessible")) return next(new HttpError(400, "INVALID_AGENT", "Selected company agent is not accessible"));
      next(error);
    }
  });
  app.post("/v1/chat/completions", async (req, res, next) => {
    try {
      const body = chatGatewayBody.parse(req.body);
      const selectedAgent = req.get("x-company-agent");
      const agent = selectedAgent ? agentReference.parse(selectedAgent) : undefined;
      const companyInstructions = composeCompanySystemPrompt(db, agent);
      const forwarded: Record<string, unknown> = {
        ...body,
        model: body.model ?? db.getProvider()?.model,
        messages: companyInstructions ? [{ role: "system", content: companyInstructions }, ...body.messages] : body.messages,
      };
      await relayUpstream(req, res, next, "chat/completions", forwarded);
    } catch (error) {
      if (String(error).includes("Selected agent is not accessible")) return next(new HttpError(400, "INVALID_AGENT", "Selected company agent is not accessible"));
      next(error);
    }
  });
  app.get("/v1/models", async (req, res, next) => relayUpstream(req, res, next, "models"));

  app.use(express.static("public", { index: "index.html", fallthrough: true }));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return next(new HttpError(404, "NOT_FOUND", "API route not found"));
    res.sendFile("index.html", { root: "public" }, (error) => error ? next(error) : undefined);
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Request validation failed" } });
    if (error instanceof HttpError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    const parserType = error && typeof error === "object" ? (error as { type?: unknown }).type : undefined;
    if (parserType === "entity.parse.failed") return res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be valid JSON" } });
    if (parserType === "entity.too.large") return res.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "Request body exceeds the permitted size" } });
    if (config.environment !== "test") console.error("Unhandled application error", safeErrorForLog(error));
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
  });
  return { app, db };
}
