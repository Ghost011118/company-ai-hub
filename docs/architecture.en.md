# Company AI Hub Architecture

[简体中文](architecture.md) | [English](architecture.en.md)

## Product boundary

Company AI Hub is a Codex-compatible managed capability gateway. Employees point local Codex at the company base URL. Administrators configure an upstream compatible with the OpenAI Responses API and centrally publish company Agents, reusable Skills, and always-on Prompts. The gateway assembles those modules before forwarding each Responses API request.

The gateway covers every Codex model request routed through the company API. Purely local file reads or command executions that do not produce a model API request never traverse the gateway and therefore cannot be injected or audited by it.

## Capability model

- **Prompt**: company instructions that are always injected after publication; a personal Prompt remains a draft until approved.
- **Skill**: reusable instructions. A Skill can be always-on or attached to one or more Agents.
- **Agent**: a selectable persona or workflow with its own instructions and attached Skills.
- **Scope**: company capabilities are admin-managed; personal capabilities belong to one employee.
- **Order**: always-on company Prompts/Skills, the selected company Agent and its Skills, then the caller's original `instructions`. Each group uses ascending priority and stable name order.
- **Empty configuration**: when no company capability is enabled, no default prompt is injected and the caller's original instructions remain unchanged.

Only declarative instruction text is supported in the MVP. Skills do not execute arbitrary contributor-supplied JavaScript, Python, or Shell code.

## Employee submission and review

1. An employee logs into the web console and creates a personal Agent, Skill, or Prompt.
2. Submission creates an immutable review snapshot with author attribution.
3. An administrator inspects and approves or rejects the snapshot and may leave a review note.
4. Approval publishes a company-scoped copy linked to the submission. Later edits to the personal draft cannot alter the reviewed company copy.
5. Only approved and enabled company copies participate in company-wide injection.

## Codex request flow

```text
Employee's local Codex
  -> Authorization: Bearer <company gateway credential>
  -> Company AI Hub /v1/responses
  -> load enabled company capabilities and compose instructions
  -> use the upstream credential held only by the server
  -> OpenAI or a Responses-compatible provider
  -> return safely processed JSON / byte-streamed SSE to Codex
```

1. Local Codex calls `/v1/responses` with the company's gateway Bearer Token.
2. The server loads enabled, approved company capabilities. An optional `X-Company-Agent` header selects one published Agent and its bound Skills.
3. The composition service prepends a company block to the request's existing `instructions`, preserving the original `input`, tools, and other Responses fields.
4. The server decrypts the configured upstream credential only in memory and forwards the request to the upstream `/responses` endpoint.
5. The gateway preserves the upstream status and supported safe response headers. JSON is parsed, secret-redacted, and re-serialized; SSE is forwarded as a byte stream. Secrets and message bodies are excluded from audit events.

Employees receive a company gateway credential, not an OpenAI or other upstream API key. The MVP uses one deployment-managed `GATEWAY_BEARER_TOKEN`; it does not yet provide per-employee issuance, rotation, revocation, or usage attribution. At production scale, place company SSO/IAP or an enterprise API management layer in front of the service.

## Web console

- Administrators manage company Agents/Skills/Prompts, configure the upstream provider, review submissions, and inspect the company library.
- Employees log in, manage personal Agents/Skills/Prompts, and submit them for review. The review queue and company-library management page are administrator-only.
- The web console is strictly a management plane for configuration, submission, and review. It provides no AI conversation or API-debug chat interface. Employees use AI through local Codex calling the company API directly.

## AI-assisted creation flow

1. An administrator opens the small company-library window, pastes source material, or lets the browser read a supported text file up to 100 KB.
2. The browser submits text, file name, guidance, and optional previous proposals to an administrator-only analysis endpoint. The server does not store the original file.
3. The server labels all material as untrusted data and calls the configured upstream `/responses` endpoint for strict JSON output.
4. The server validates capability types, slugs, lengths, Agent/Skill bindings, 0–100 scores, verdicts, and risks. An invalid provider response is rejected as a whole.
5. The administrator inspects proposals and can add guidance for another pass. Every proposal is unchecked by default and must be actively selected; `REJECT` items cannot be selected.
6. After confirmation, selected items install into the company library in one database transaction. Existing slugs are skipped, and any invalid Skill binding rolls back the complete set of new records.

This flow is a constrained capability-authoring assistant, not a general chat surface, and it never executes code found in source material or model output. Source material is sent to the company upstream provider, so that provider's retention and compliance policies still apply.

## Security boundaries

- Passwords use `scrypt` with per-password salts.
- Sessions use random, hashed, database-backed tokens in `HttpOnly` cookies.
- State-changing browser calls require a per-session CSRF token.
- Provider keys use AES-256-GCM at rest and are never returned by APIs.
- Gateway access uses one deployment-managed bearer token in the MVP; there is no employee key issuance UI.
- Provider URLs default to public HTTPS destinations and redirects are not followed.
- Production startup requires an exact provider-hostname allowlist; network egress controls remain recommended as defense in depth.
- Request validation, body limits, rate limits, CSP, and generic production errors are enabled.

See the [requirements acceptance matrix](requirements-matrix.en.md) for a line-by-line comparison.
