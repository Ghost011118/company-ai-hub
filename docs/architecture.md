# Company AI Hub architecture

## Product boundary

Company AI Hub is a Codex-compatible managed capability gateway. Employees point local Codex at the company base URL. Administrators configure one OpenAI-compatible upstream and centrally publish company agents, reusable skills, and always-on prompt modules. The gateway assembles those modules before forwarding each Responses API request.

## Capability model

- **Prompt**: company instructions that are always injected after publication; personal prompts remain drafts until approved.
- **Skill**: reusable instructions. A skill can be always-on or attached to one or more agents.
- **Agent**: a selectable persona/workflow with its own instructions and attached skills.
- **Scope**: company capabilities are admin-managed; personal capabilities are owned by one member.
- **Order**: always-on company modules, selected company Agent and bound Skills, then the caller's original instructions. Each group uses ascending priority and stable name order.

## Community contribution workflow

1. A member creates a personal Agent, Skill, or Prompt.
2. Submitting it creates an immutable review snapshot with author attribution.
3. An administrator approves or rejects the snapshot and may leave a review note.
4. Approval publishes a company-scoped copy linked to the submission. Later edits to the personal original cannot alter the reviewed company copy.
5. Only approved, enabled company copies participate in company-wide injection.

Only declarative instruction text is supported in the MVP. Skills do not execute arbitrary server-side code.

## Request flow

1. Local Codex calls the company `/v1/responses` endpoint with a gateway bearer token.
2. The server loads enabled, approved company capabilities. An optional `X-Company-Agent` header selects one published Agent and its bound Skills.
3. The composition service prepends a company block to the request's existing `instructions`.
4. The server decrypts the company upstream credential in memory and forwards the otherwise intact Responses request.
5. JSON or SSE is streamed back transparently; secrets and message bodies are excluded from audit events.

## Security boundaries

- Passwords use `scrypt` with per-password salts.
- Sessions use random, hashed, database-backed tokens in `HttpOnly` cookies.
- State-changing browser calls require a per-session CSRF token.
- Provider keys use AES-256-GCM at rest and are never returned by APIs.
- Gateway access uses one deployment-managed bearer token in the MVP; there is no key issuance UI.
- Provider URLs default to public HTTPS destinations and do not follow redirects.
- Production startup requires an exact provider hostname allowlist; network egress controls remain recommended defense in depth.
- Request validation, body limits, rate limits, CSP, and generic production errors are enabled.
