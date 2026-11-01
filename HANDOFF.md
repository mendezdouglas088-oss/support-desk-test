# Handoff

> **Status: work in progress.** Requirements 1 (isolation), 2 (duplicate webhooks) and 3 (exact-text approval) are complete and verified. Requirements 4-6 are not implemented yet. Updated as each requirement is finished. Spanish version: `HANDOFF_SPANISH.md`.

## Changes and ownership

**Completed**

- **Requirement 1 - Isolation between organizations** (`src/service.mjs`). `row(actor, id)` looks a ticket up by `id` **and** the actor's `tenant_id`, which comes from the server-resolved bearer token, never from the request. A foreign ticket returns **404**, identical to a missing one, so IDs cannot be enumerated. The `UPDATE` statements also filter by `tenant_id` as defense in depth.
- **Requirement 2 - Duplicate webhooks** (`src/store.mjs`, `src/service.mjs`, `src/server.mjs`).
  - `messages` has `tenant_id` and `UNIQUE(tenant_id, event_id)`, so Alpha and Beta may reuse an `eventId`. The constraint holds across restarts and connections.
  - Message and `inbound` audit entry are written in one `BEGIN IMMEDIATE` transaction. A replay answers **200 `duplicate: true`** and creates nothing.
  - Invalid input (JSON `null`, missing `eventId`, unknown or foreign ticket) answers **400**, never 5xx.
  - `openStore` refuses a database with the old schema. **If `data/` exists from an earlier run, stop the app and delete `data/`.**
- **Requirement 3 - Approval of the exact text** (`src/service.mjs`, `src/server.mjs`).
  - `updateDraft` bumps the version **and clears `approved_version`**, so edited text must be approved again. It no longer touches `send_state`, so an edit cannot hide a `SENT` or `UNKNOWN` delivery.
  - `sendReply` decides what to send in one transaction: `send_state` must be `DRAFT` (otherwise **409**, so a sent reply cannot be sent again), the approval must match the current version (otherwise 409), and it captures that body and version. The provider receives exactly that body; an edit made while the provider call is in flight cannot change it.
  - `approveDraft` accepts an optional `version`: if the draft moved on, it answers 409; a non-integer gives 400. Omitting it approves the current version. The audit records the version in `approved` and `sent` entries (for example `agent-alpha: v2`).
  - Decisions: editing stays allowed after `SENT`/`UNKNOWN` (state preserved); a ticket holds one sent reply, and a follow-up flow is not designed. The pinned body/version live in memory inside `sendReply`. Writing them to `attempts` is left to requirement 4, because an attempt row needs `UNKNOWN`/`FAILED` or a failed send would leave the ticket stuck on `UNIQUE(ticket_id, version)`.
- **Tests added:** `isolation.test.mjs`, `isolation-http.test.mjs` (port 4390), `webhook.test.mjs`, `webhook-http.test.mjs` (4391), `approval.test.mjs`, `approval-http.test.mjs` (4392) and `helpers.mjs` (starts the real server with a temporary SQLite database; one port per HTTP file because `node --test` runs files in parallel).

**Proposed, not started:** requirement 4 (honest delivery, `UNKNOWN`, `reconcile`), 5 (human takeover), 6 (usable handoff UI).

## Verification

Command: `npm test` (Node v24.22.2). Original code `aa0662a`; requirement 1 `d5f7b3a`; requirement 2 `5200b04`; requirement 3 is the uncommitted diff against `5200b04`.

- **After the fixes:** **33 of 33 tests pass, 0 fail** (8 + 13 + 12), run in the project folder.
- **Requirement 1, before the fix:** 4 of 8 failed; Alpha got **HTTP 200** reading Beta's ticket 202.
- **Requirement 2, before the fix** (tests against the original `service.mjs`, `store.mjs`, `server.mjs` in a temporary copy): **11 of 13 failed**, for example `25 simultaneous copies of one event are stored exactly once` and `message and audit entry are written atomically`.
- **Requirement 3, before the fix** (new tests against the code from `5200b04`): **9 of 12 failed, 3 passed**. The 3 that passed are regression guards. Failing tests include:
  - `editing an approved draft invalidates the approval, so the new text cannot be sent`
  - `a reply that was already sent cannot be sent again`
  - `editing after SENT keeps the SENT state and still cannot trigger a second send`
  - `editing never erases an uncertain delivery state, and that state blocks sending`
  - `approving can name the version, and a stale version is refused`
- **Verified only manually:** nothing yet. Still to check in the browser: Alpha and Beta see only their own ticket; a replayed event (`npm run event`) shows one message; edit-after-approve shows an error on Send.
- **Not covered:** requirements 4-6. The `UNKNOWN` state is simulated in a test by writing it to the database, because the code does not produce it yet. A true double click is not fixed: two simultaneous sends can both read `DRAFT` before either marks `SENT` (requirement 4).

## Operator instructions

Pending (depends on requirement 4). For requirements 1-3 only:

- An agent sees only their organization's tickets. Another organization's ticket shows "Ticket not found" by design.
- A repeated webhook event answers `duplicate: true` and changes nothing; this is expected.
- After editing a draft, **approve it again**. Send is refused (409) until the current version is approved. A ticket already `SENT`, or with an unconfirmed send, refuses new sends.
- If the app refuses to start with an "older schema" message, delete `data/` (demo data only).

## Remaining risks and production plan

**Remaining defects (not yet fixed):**

- `sendReply` retries with a new `clientRef`, which can send the customer two messages, and has no timeout.
- Nothing is stored in `attempts` before calling the provider; there is no `UNKNOWN` or `FAILED` state and `reconcile` returns 501.
- Two simultaneous sends can both pass the checks.
- Human takeover is not enforced on automatic sends, and `handoff` does not record who took the ticket.
- The UI shows raw JSON, only inbound messages, always-active buttons and no auto-refresh.

**Accepted shortcuts (per `CONTRACT.md`), explained and not solved:**

- Demo bearer tokens and a published webhook secret. The webhook trusts the body's `tenantId` because the secret authenticates the caller.
- One process, SQLite, synthetic data. `BEGIN IMMEDIATE` and `UNIQUE` suffice here but would not scale to several writers.
- Out of scope by instruction: OAuth, a real LLM, attachments, billing and deployment. The mock provider and the demo authentication were not changed.

**First checks for a real GHL pilot (proposed):**

- Derive the organization from verified identity only (for example, GHL location ID to tenant).
- Put `tenant_id` on every table (missing on `audit` and `attempts`) and add database constraints.
- Verify the real GHL webhook signature, retry behavior and event-ID stability.
- Test with two sandbox locations: cross-access must return 404.
- Alert on denied cross-organization attempts and on duplicate-event rates (not implemented).
- Rollback by redeploying the previous build.

This exercise is not production-ready.

## AI use and time

- **Tool:** Claude (Anthropic) in claude.ai with the Desktop Commander and Filesystem extensions, used to review the project, plan, draft tests, propose fixes and run the suite.
- **Accepted suggestions:** (1) scope `row()` to the actor's organization; (2) `UNIQUE(tenant_id, event_id)` plus `ON CONFLICT DO NOTHING` in one transaction; (3) clear the approval on every edit, check state and approval and capture body and version in one transaction, and leave `send_state` alone on edit. Each is verified by tests that fail on the previous code and pass after.
- **Time:** about 10 minutes for requirement 1 (estimate). Requirements 2 and 3 not recorded yet. Total to be updated at the end.
