import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { hashPassword } from "./security.js";
import type { AppConfig } from "./config.js";
import type { AuthenticatedUser, CapabilityScope, CapabilitySnapshot, CapabilityType, PublicUser, Role } from "./types.js";

type Row = Record<string, SQLInputValue>;

function asString(value: SQLInputValue | undefined): string {
  return String(value ?? "");
}

function asBoolean(value: SQLInputValue | undefined): boolean {
  return Number(value ?? 0) === 1;
}

function publicUser(row: Row): PublicUser {
  return {
    id: asString(row.id),
    email: asString(row.email),
    displayName: asString(row.display_name),
    role: asString(row.role) as Role,
    active: asBoolean(row.active),
    createdAt: asString(row.created_at),
  };
}

export interface CapabilityInput {
  type: CapabilityType;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  priority: number;
  enabled: boolean;
  alwaysOn: boolean;
  skillIds: string[];
}

export interface CapabilityView extends CapabilityInput {
  id: string;
  scope: CapabilityScope;
  ownerUserId: string | null;
  sourceSubmissionId: string | null;
  createdAt: string;
  updatedAt: string;
  contributor: Pick<PublicUser, "id" | "email" | "displayName"> | null;
}

export interface CompanyCapabilityBatchInput extends Omit<CapabilityInput, "skillIds"> {
  skillSlugs: string[];
}

export interface ProviderRecord {
  baseUrl: string;
  model: string;
  apiKeyCiphertext: string;
  updatedByUserId: string;
  updatedAt: string;
}

export interface SubmissionView {
  id: string;
  sourceCapabilityId: string | null;
  author: Pick<PublicUser, "id" | "email" | "displayName">;
  status: "PENDING" | "APPROVED" | "REJECTED";
  snapshot: CapabilitySnapshot;
  reviewNote: string | null;
  reviewedByUserId: string | null;
  publishedCapabilityId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export class AppDatabase {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  private migrate(): void {
    const version = Number((this.raw.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0);
    if (version > 1) throw new Error(`Database schema version ${version} is newer than this application supports`);
    if (version === 1) return;
    this.raw.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ADMIN', 'MEMBER')),
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE company_provider_config (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key_ciphertext TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE capabilities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('AGENT', 'SKILL', 'PROMPT')),
        scope TEXT NOT NULL CHECK (scope IN ('COMPANY', 'PERSONAL')),
        owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 100,
        always_on INTEGER NOT NULL DEFAULT 0 CHECK (always_on IN (0, 1)),
        source_submission_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((scope = 'PERSONAL' AND owner_user_id IS NOT NULL) OR (scope = 'COMPANY' AND owner_user_id IS NULL))
      ) STRICT;
      CREATE INDEX capabilities_scope_owner_idx ON capabilities(scope, owner_user_id, enabled, priority, name);
      CREATE UNIQUE INDEX capabilities_company_slug_uq ON capabilities(slug) WHERE scope = 'COMPANY';
      CREATE UNIQUE INDEX capabilities_personal_slug_uq ON capabilities(owner_user_id, slug) WHERE scope = 'PERSONAL';
      CREATE TABLE agent_skill_bindings (
        agent_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
        PRIMARY KEY (agent_id, skill_id),
        CHECK (agent_id <> skill_id)
      ) STRICT;
      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        source_capability_id TEXT,
        author_user_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        snapshot_json TEXT NOT NULL,
        review_note TEXT,
        reviewed_by_user_id TEXT REFERENCES users(id),
        published_capability_id TEXT REFERENCES capabilities(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT
      ) STRICT;
      CREATE INDEX submissions_status_created_idx ON submissions(status, created_at);
      CREATE TRIGGER submissions_snapshot_immutable
      BEFORE UPDATE ON submissions
      WHEN OLD.id IS NOT NEW.id
        OR OLD.source_capability_id IS NOT NEW.source_capability_id
        OR OLD.author_user_id IS NOT NEW.author_user_id
        OR OLD.snapshot_json IS NOT NEW.snapshot_json
        OR OLD.created_at IS NOT NEW.created_at
      BEGIN SELECT RAISE(ABORT, 'submission snapshot is immutable'); END;
      CREATE TRIGGER submissions_no_delete
      BEFORE DELETE ON submissions
      BEGIN SELECT RAISE(ABORT, 'submissions are immutable'); END;
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  async bootstrapAdmin(config: AppConfig): Promise<void> {
    if (!config.adminEmail && !config.adminPassword) return;
    if (!config.adminEmail || !config.adminPassword) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be supplied together");
    const existing = this.raw.prepare("SELECT id FROM users WHERE email = ?").get(config.adminEmail);
    if (existing) return;
    await this.createUser(config.adminEmail, config.adminDisplayName, config.adminPassword, "ADMIN");
  }

  async createUser(email: string, displayName: string, password: string, role: Role): Promise<PublicUser> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(password);
    this.raw.prepare("INSERT INTO users (id, email, display_name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, email.toLowerCase(), displayName, role, passwordHash, now);
    return { id, email: email.toLowerCase(), displayName, role, active: true, createdAt: now };
  }

  listUsers(): PublicUser[] {
    return (this.raw.prepare("SELECT id, email, display_name, role, active, created_at FROM users ORDER BY created_at, email").all() as Row[]).map(publicUser);
  }

  getLoginUser(email: string): (PublicUser & { passwordHash: string }) | null {
    const row = this.raw.prepare("SELECT id, email, display_name, role, active, created_at, password_hash FROM users WHERE email = ?").get(email.toLowerCase()) as Row | undefined;
    return row ? { ...publicUser(row), passwordHash: asString(row.password_hash) } : null;
  }

  createSession(userId: string, tokenHash: string, csrfHash: string, expiresAt: string): string {
    const id = randomUUID();
    this.raw.prepare("INSERT INTO sessions (id, user_id, token_hash, csrf_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, tokenHash, csrfHash, expiresAt, new Date().toISOString());
    return id;
  }

  getSession(tokenHash: string): AuthenticatedUser | null {
    const row = this.raw.prepare(`
      SELECT u.id, u.email, u.display_name, u.role, u.active, u.created_at, s.id session_id, s.csrf_hash
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
    `).get(tokenHash, new Date().toISOString()) as Row | undefined;
    if (!row) return null;
    return { ...publicUser(row), sessionId: asString(row.session_id), csrfHash: asString(row.csrf_hash) };
  }

  deleteSession(sessionId: string): void {
    this.raw.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  rotateSessionCsrf(sessionId: string, csrfHash: string): void {
    this.raw.prepare("UPDATE sessions SET csrf_hash = ? WHERE id = ?").run(csrfHash, sessionId);
  }

  deleteExpiredSessions(): void {
    this.raw.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

  getProvider(): ProviderRecord | null {
    const row = this.raw.prepare("SELECT base_url, model, api_key_ciphertext, updated_by_user_id, updated_at FROM company_provider_config WHERE singleton_id = 1").get() as Row | undefined;
    return row ? {
      baseUrl: asString(row.base_url), model: asString(row.model), apiKeyCiphertext: asString(row.api_key_ciphertext),
      updatedByUserId: asString(row.updated_by_user_id), updatedAt: asString(row.updated_at),
    } : null;
  }

  putProvider(updatedByUserId: string, baseUrl: string, model: string, apiKeyCiphertext: string): ProviderRecord {
    const now = new Date().toISOString();
    this.raw.prepare(`
      INSERT INTO company_provider_config (singleton_id, base_url, model, api_key_ciphertext, updated_by_user_id, updated_at) VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model,
        api_key_ciphertext = excluded.api_key_ciphertext, updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at
    `).run(baseUrl, model, apiKeyCiphertext, updatedByUserId, now);
    return { baseUrl, model, apiKeyCiphertext, updatedByUserId, updatedAt: now };
  }

  private skillIdsFor(agentId: string): string[] {
    return (this.raw.prepare("SELECT skill_id FROM agent_skill_bindings WHERE agent_id = ? ORDER BY skill_id").all(agentId) as Row[])
      .map((row) => asString(row.skill_id));
  }

  private capabilityView(row: Row): CapabilityView {
    const type = asString(row.type) as CapabilityType;
    return {
      id: asString(row.id), type, scope: asString(row.scope) as CapabilityScope,
      ownerUserId: row.owner_user_id == null ? null : asString(row.owner_user_id),
      slug: asString(row.slug), name: asString(row.name), description: asString(row.description), instructions: asString(row.instructions),
      enabled: asBoolean(row.enabled), priority: Number(row.priority), alwaysOn: asBoolean(row.always_on),
      sourceSubmissionId: row.source_submission_id == null ? null : asString(row.source_submission_id),
      createdAt: asString(row.created_at), updatedAt: asString(row.updated_at),
      contributor: row.contributor_id == null ? null : {
        id: asString(row.contributor_id), email: asString(row.contributor_email), displayName: asString(row.contributor_display_name),
      },
      skillIds: type === "AGENT" ? this.skillIdsFor(asString(row.id)) : [],
    };
  }

  listCapabilities(scope: CapabilityScope, ownerUserId?: string): CapabilityView[] {
    const rows = scope === "COMPANY"
      ? this.raw.prepare(`SELECT c.*, u.id contributor_id, u.email contributor_email, u.display_name contributor_display_name
          FROM capabilities c LEFT JOIN submissions s ON s.id = c.source_submission_id LEFT JOIN users u ON u.id = s.author_user_id
          WHERE c.scope = 'COMPANY' ORDER BY c.priority, c.name COLLATE NOCASE, c.id`).all()
      : this.raw.prepare(`SELECT c.*, NULL contributor_id, NULL contributor_email, NULL contributor_display_name
          FROM capabilities c WHERE c.scope = 'PERSONAL' AND c.owner_user_id = ? ORDER BY c.priority, c.name COLLATE NOCASE, c.id`).all(ownerUserId ?? "");
    return (rows as Row[]).map((row) => this.capabilityView(row));
  }

  getCapability(id: string): CapabilityView | null {
    const row = this.raw.prepare(`SELECT c.*, u.id contributor_id, u.email contributor_email, u.display_name contributor_display_name
      FROM capabilities c LEFT JOIN submissions s ON s.id = c.source_submission_id LEFT JOIN users u ON u.id = s.author_user_id
      WHERE c.id = ?`).get(id) as Row | undefined;
    return row ? this.capabilityView(row) : null;
  }

  private validateBindings(agentId: string, input: CapabilityInput): void {
    if (input.type !== "AGENT" && input.skillIds.length > 0) throw new Error("Only agents may bind skills");
    for (const skillId of new Set(input.skillIds)) {
      const skill = this.getCapability(skillId);
      if (!skill || skill.type !== "SKILL" || skill.scope !== "COMPANY") {
        throw new Error("Bound skills must be published company skills");
      }
      this.raw.prepare("INSERT INTO agent_skill_bindings (agent_id, skill_id) VALUES (?, ?)").run(agentId, skillId);
    }
  }

  private insertCapability(input: CapabilityInput, scope: CapabilityScope, ownerUserId: string | null, sourceSubmissionId: string | null = null): CapabilityView {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.raw.prepare(`INSERT INTO capabilities
      (id, type, scope, owner_user_id, slug, name, description, instructions, enabled, priority, always_on, source_submission_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.type, scope, ownerUserId, input.slug, input.name, input.description, input.instructions, input.enabled ? 1 : 0,
        input.priority, input.alwaysOn ? 1 : 0, sourceSubmissionId, now, now);
    this.validateBindings(id, input);
    return this.getCapability(id)!;
  }

  createCapability(input: CapabilityInput, scope: CapabilityScope, ownerUserId: string | null, sourceSubmissionId: string | null = null): CapabilityView {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const capability = this.insertCapability(input, scope, ownerUserId, sourceSubmissionId);
      this.raw.exec("COMMIT");
      return capability;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  createCompanyCapabilityBatch(inputs: CompanyCapabilityBatchInput[]): { created: CapabilityView[]; skippedSlugs: string[] } {
    const known = new Map(this.listCapabilities("COMPANY").map((capability) => [capability.slug, capability]));
    const created: CapabilityView[] = [];
    const skippedSlugs: string[] = [];
    const ordered = [...inputs].sort((left, right) => Number(left.type === "AGENT") - Number(right.type === "AGENT"));
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const input of ordered) {
        if (known.has(input.slug)) {
          skippedSlugs.push(input.slug);
          continue;
        }
        const skillIds = input.skillSlugs.map((skillSlug) => {
          const skill = known.get(skillSlug);
          if (!skill || skill.type !== "SKILL") throw new Error(`Missing company skill: ${skillSlug}`);
          return skill.id;
        });
        const capability = this.insertCapability({ ...input, skillIds }, "COMPANY", null);
        known.set(capability.slug, capability);
        created.push(capability);
      }
      this.raw.exec("COMMIT");
      return { created, skippedSlugs };
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  updateCapability(id: string, input: CapabilityInput): CapabilityView {
    const current = this.getCapability(id);
    if (!current) throw new Error("Capability not found");
    if (current.type === "SKILL" && input.type !== "SKILL") {
      const inbound = this.raw.prepare("SELECT 1 FROM agent_skill_bindings WHERE skill_id = ? LIMIT 1").get(id);
      if (inbound) throw new Error("A bound skill cannot change type");
    }
    const now = new Date().toISOString();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      this.raw.prepare(`UPDATE capabilities SET type = ?, slug = ?, name = ?, description = ?, instructions = ?, enabled = ?, priority = ?, always_on = ?, updated_at = ? WHERE id = ?`)
        .run(input.type, input.slug, input.name, input.description, input.instructions, input.enabled ? 1 : 0, input.priority, input.alwaysOn ? 1 : 0, now, id);
      this.raw.prepare("DELETE FROM agent_skill_bindings WHERE agent_id = ?").run(id);
      this.validateBindings(id, input);
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
    return this.getCapability(id)!;
  }

  deleteCapability(id: string): void {
    this.raw.prepare("DELETE FROM capabilities WHERE id = ?").run(id);
  }

  private snapshotCapability(capability: CapabilityView): CapabilitySnapshot {
    return { type: capability.type, slug: capability.slug, name: capability.name, description: capability.description, instructions: capability.instructions,
      priority: capability.priority, enabled: capability.enabled, alwaysOn: capability.alwaysOn, skillIds: [...capability.skillIds] };
  }

  createSubmission(capability: CapabilityView, authorUserId: string): SubmissionView {
    const id = randomUUID();
    const now = new Date().toISOString();
    const snapshot = this.snapshotCapability(capability);
    this.raw.prepare("INSERT INTO submissions (id, source_capability_id, author_user_id, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, capability.id, authorUserId, JSON.stringify(snapshot), now);
    return this.getSubmission(id)!;
  }

  getSubmission(id: string): SubmissionView | null {
    const row = this.raw.prepare(`SELECT s.*, u.email author_email, u.display_name author_display_name
      FROM submissions s JOIN users u ON u.id = s.author_user_id WHERE s.id = ?`).get(id) as Row | undefined;
    return row ? this.submissionView(row) : null;
  }

  listSubmissions(): SubmissionView[] {
    return (this.raw.prepare(`SELECT s.*, u.email author_email, u.display_name author_display_name
      FROM submissions s JOIN users u ON u.id = s.author_user_id ORDER BY s.created_at DESC, s.id`).all() as Row[])
      .map((row) => this.submissionView(row));
  }

  private submissionView(row: Row): SubmissionView {
    return {
      id: asString(row.id), sourceCapabilityId: row.source_capability_id == null ? null : asString(row.source_capability_id),
      author: { id: asString(row.author_user_id), email: asString(row.author_email), displayName: asString(row.author_display_name) },
      status: asString(row.status) as SubmissionView["status"], snapshot: JSON.parse(asString(row.snapshot_json)) as CapabilitySnapshot,
      reviewNote: row.review_note == null ? null : asString(row.review_note),
      reviewedByUserId: row.reviewed_by_user_id == null ? null : asString(row.reviewed_by_user_id),
      publishedCapabilityId: row.published_capability_id == null ? null : asString(row.published_capability_id),
      createdAt: asString(row.created_at), reviewedAt: row.reviewed_at == null ? null : asString(row.reviewed_at),
    };
  }

  reviewSubmission(id: string, reviewerId: string, decision: "APPROVED" | "REJECTED", note: string): SubmissionView {
    const submission = this.getSubmission(id);
    if (!submission || submission.status !== "PENDING") throw new Error("Submission is not pending");
    const now = new Date().toISOString();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      let publishedId: string | null = null;
      if (decision === "APPROVED") {
        const snapshot = submission.snapshot;
        for (const skillId of snapshot.skillIds) {
          const skill = this.getCapability(skillId);
          if (!skill || skill.type !== "SKILL" || skill.scope !== "COMPANY") {
            throw new Error("Submitted company skill binding is no longer valid");
          }
        }
        publishedId = randomUUID();
        this.raw.prepare(`INSERT INTO capabilities
          (id, type, scope, owner_user_id, slug, name, description, instructions, enabled, priority, always_on, source_submission_id, created_at, updated_at)
          VALUES (?, ?, 'COMPANY', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(publishedId, snapshot.type, snapshot.slug, snapshot.name, snapshot.description, snapshot.instructions, snapshot.enabled ? 1 : 0,
            snapshot.priority, snapshot.alwaysOn ? 1 : 0, id, now, now);
        for (const skillId of snapshot.skillIds) {
          this.raw.prepare("INSERT INTO agent_skill_bindings (agent_id, skill_id) VALUES (?, ?)").run(publishedId, skillId);
        }
      }
      const result = this.raw.prepare(`UPDATE submissions SET status = ?, review_note = ?, reviewed_by_user_id = ?,
        published_capability_id = ?, reviewed_at = ? WHERE id = ? AND status = 'PENDING'`)
        .run(decision, note || null, reviewerId, publishedId, now, id);
      if (Number(result.changes) !== 1) throw new Error("Submission is not pending");
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
    return this.getSubmission(id)!;
  }

  audit(actorUserId: string | null, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown> = {}): void {
    this.raw.prepare("INSERT INTO audit_events (id, actor_user_id, action, target_type, target_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), actorUserId, action, targetType, targetId, JSON.stringify(metadata), new Date().toISOString());
  }
}
