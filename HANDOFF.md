# Handoff

> **Status: work in progress.** Requirements 1 (customer-data isolation) and 2 (duplicate webhooks) are complete and verified. Requirements 3-6 are not implemented yet. This document is updated as each requirement is finished. Spanish version: `HANDOFF_SPANISH.md`.

## Changes and ownership

**Completed**

- **Requirement 1 - Isolation between organizations** (`src/service.mjs`).
  - `row(actor, id)` now looks a ticket up by `id` **and** the actor's `tenant_id`. The organization comes from the actor resolved on the server (bearer token), never from the request body, the query string or the URL.
  - A ticket of another organization returns **404**, identical to a ticket that does not exist, so ticket IDs cannot be enumerated. An actor without an organization gets 401.
  - Defense in depth: the four `UPDATE` statements (`updateDraft`, `approveDraft`, `handoff` and the `SENT` update in `sendReply`) also filter by `tenant_id`.
  - Routes, fixture identities, the mock provider and the database schema were not changed by this requirement.
- **Requirement 2 - Duplicate webhooks** (`src/store.mjs`, `src/service.mjs`, `src/server.mjs`).
  - `messages` now has `tenant_id` and `UNIQUE(tenant_id, event_id)`. An event is identified by (organization, eventId), so Alpha and Beta may reuse the same `eventId`. The database constraint is the real guarantee; it also holds across restarts and several connections.
  - `receiveWebhook` inserts the message and the `inbound` audit entry in **one transaction** (`BEGIN IMMEDIATE`). A failure in either write rolls back both, and a failed attempt does not consume the `eventId`.
  - A replayed event answers **200 with `duplicate: true`** and creates nothing: no second message and no second audit entry. The first delivery answers `duplicate: false`. A replay with different text does not overwrite the original.
  - Invalid input answers **400**, never 5xx: a JSON `null` body (and any non-object body, in `server.mjs`), a missing or empty `eventId`, a non-string `body`, an unknown ticket, or a ticket that belongs to another organization.
  - **Old schema guard:** `CREATE TABLE IF NOT EXISTS` would silently keep an old `messages` table without `tenant_id`. `openStore` now refuses to start on such a database with a clear message. **If `data/` already exists from an earlier run, stop the app and delete `data/` before starting.**
- **Tests added:** `test/isolation.test.mjs` (service level), `test/isolation-http.test.mjs` (real server on port 4390), `test/webhook.test.mjs` (service level), `test/webhook-http.test.mjs` (real server on port 4391) and `test/helpers.mjs` (starts the real server with a temporary SQLite database). Every HTTP test file uses its own port because `node --test` runs files in parallel.

**Proposed, not started**

- Requirement 3: approval of the exact reply.
- Requirement 4: honest delivery state (`UNKNOWN`) and `reconcile`.
- Requirement 5: human takeover.
- Requirement 6: usable handoff UI.

## Verification

Command: `npm test` (Node v24.22.2). The original code is commit `aa0662a`. Requirement 1 is commit `d5f7b3a`. Requirement 2 is the uncommitted diff against `d5f7b3a`.

- **After the fixes:** `npm test` -> **21 of 21 tests pass, 0 fail** (8 for requirement 1 including the 2 original smoke tests, 13 for requirement 2), run in the current project folder.
- **Requirement 1, before the fix** (real run of the isolation tests against the original `service.mjs`): **4 of 8 failed**. Alpha received **HTTP 200** when reading Beta's ticket 202. Failing tests:
  - `a tenantId supplied by the client never widens access`
  - `alpha cannot act on beta ticket 202 over HTTP, and beta data stays untouched`
  - `alpha cannot read, edit, approve, take over, send or reconcile a beta ticket`
  - `a foreign ticket is indistinguishable from one that does not exist`
- **Requirement 2, before the fix** (real run of `webhook.test.mjs` and `webhook-http.test.mjs` against the original `service.mjs`, `store.mjs` and `server.mjs` from `aa0662a`, in a temporary copy): **11 of 13 failed, 2 passed**. The two that passed only cover the missing webhook secret and an event naming another organization's ticket, which the original code already handled. Failing tests include:
  - `the same event sent twice answers 200 both times but is stored once`
  - `25 simultaneous copies of one event are stored exactly once`
  - `a duplicate is still detected after a restart and by a second connection`
  - `message and audit entry are written atomically`
  - `malformed webhook bodies get 400, never 5xx`
- Tests that passed both before and after: the 2 original smoke tests, the invalid-identity test, the own-tickets test, the missing-secret test and the cross-organization event test.
- **Verified only manually:** nothing yet. Still to check: in the browser, switch between Alpha and Beta and confirm each sees only its own ticket; replay the same event twice with `npm run event` and confirm one message appears.
- **Not covered yet:** requirements 3-6 (see remaining defects below). The second original smoke test still passes with the defective send logic, so it proves nothing about delivery.

## Operator instructions

Pending (depends on requirement 4). For requirements 1 and 2 only:

- A support agent sees only their own organization's tickets. Asking for another organization's ticket returns "Ticket not found" by design; this is not an outage.
- If the webhook provider resends an event, the second call answers `duplicate: true` and nothing changes. This is expected, not an error.
- If the app refuses to start with an "older schema" message, stop it and delete the `data/` folder (or point `DESK_DB` to a new file). Delete `data/` only on a demo database: it removes all local data.

## Remaining risks and production plan

**Remaining defects (not yet fixed):**

- Editing a draft does not invalidate its approval, and `sendReply` sends the current draft rather than the approved text.
- `sendReply` retries automatically with a new `clientRef`, which can send the customer two messages, and it has no timeout.
- Nothing is stored in `attempts` before calling the provider. There is no `UNKNOWN` or `FAILED` state and `reconcile` returns 501.
- Two simultaneous sends can both pass the checks.
- Human takeover is not enforced on automatic sends, and `handoff` does not record who took the ticket.
- The UI shows state and audit as raw JSON, shows only inbound messages and has no auto-refresh.

**Accepted shortcuts (per `CONTRACT.md`):**

- Demo bearer tokens and a published webhook secret.
- The webhook trusts the `tenantId` in its body because the secret authenticates the caller.
- Single process, SQLite, synthetic data. `BEGIN IMMEDIATE` and the `UNIQUE` constraint are enough for this, but SQLite would not scale to several writers.

**First checks for a real GHL pilot (proposed):**

- Derive the organization from verified identity only (for example, mapping the GHL location ID to a tenant), never from client input.
- Put `tenant_id` on every table (still missing on `audit` and `attempts`) and add database constraints.
- Verify the real GHL webhook signature and retry behavior, and confirm that its event IDs are stable across retries.
- Run a two-sandbox-location test where cross-access must return 404.
- Log and alert on denied cross-organization attempts and on duplicate-event rates (not implemented today).
- Rollback by redeploying the previous build.

This exercise is not production-ready.

## AI use and time

- **Tool:** Claude (Anthropic) in claude.ai with the Desktop Commander and Filesystem extensions, used to review the project, plan the work, draft the tests, propose the fixes and run the test suite.
- **Accepted suggestion (requirement 1):** scope `row()` to the actor's organization and return 404 for foreign tickets. Verified by the tests above, which fail on the original code and pass after the fix.
- **Accepted suggestion (requirement 2):** enforce uniqueness with `UNIQUE(tenant_id, event_id)` plus `ON CONFLICT DO NOTHING`, inside one `BEGIN IMMEDIATE` transaction together with the audit entry. Verified by the 13 webhook tests: 11 fail on the original code and all 13 pass after the fix.
- **Time:** about 10 minutes for requirement 1 (estimate). Requirement 2 time not recorded yet. Total time to be updated at the end.
