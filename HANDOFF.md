# Handoff

> **Status: work in progress.** Requirement 1 (customer-data isolation) is complete and verified. Requirements 2-6 are not implemented yet. This document is updated as each requirement is finished. Spanish version: `HANDOFF_SPANISH.md`.

## Changes and ownership

**Completed**

- **Requirement 1 - Isolation between organizations** (`src/service.mjs`).
  - `row(actor, id)` now looks a ticket up by `id` **and** the actor's `tenant_id`. The organization comes from the actor resolved on the server (bearer token), never from the request body, the query string or the URL.
  - A ticket of another organization returns **404**, identical to a ticket that does not exist, so ticket IDs cannot be enumerated. An actor without an organization gets 401.
  - Defense in depth: the four `UPDATE` statements (`updateDraft`, `approveDraft`, `handoff` and the `SENT` update in `sendReply`) also filter by `tenant_id`.
  - Routes, fixture identities, the mock provider and the database schema were not changed.
- **New tests:** `test/isolation.test.mjs` (service level) and `test/isolation-http.test.mjs` (starts the real server on port 4390 with a temporary SQLite database).

**Proposed, not started**

- Requirement 2: duplicate-webhook prevention.
- Requirement 3: approval of the exact reply.
- Requirement 4: honest delivery state (`UNKNOWN`) and `reconcile`.
- Requirement 5: human takeover.
- Requirement 6: usable handoff UI.

## Verification

Command: `npm test` (Node v24.22.2). The original code is commit `aa0662a`; the fix is the uncommitted diff against it.

- **Before the fix** (real run of the new tests against the original `service.mjs`): **4 of 8 tests failed**. Alpha received **HTTP 200** when reading Beta's ticket 202. Failing tests:
  - `a tenantId supplied by the client never widens access`
  - `alpha cannot act on beta ticket 202 over HTTP, and beta data stays untouched`
  - `alpha cannot read, edit, approve, take over, send or reconcile a beta ticket`
  - `a foreign ticket is indistinguishable from one that does not exist`
- **After the fix:** **8 of 8 tests pass**, re-run in the current project folder.
- The other 4 tests (the 2 original smoke tests, the invalid-identity test and the own-tickets test) passed both before and after.
- **Verified only manually:** nothing yet. Still to check in the browser: switch between Alpha and Beta and confirm each sees only its own ticket.

## Operator instructions

Pending (depends on requirement 4). For requirement 1 only: a support agent sees only their own organization's tickets. Asking for another organization's ticket returns "Ticket not found" by design; this is not an outage.

## Remaining risks and production plan

**Remaining defects (not yet fixed):**

- Repeated webhook events create duplicate messages.
- Editing a draft does not invalidate its approval.
- `sendReply` retries automatically with a new `clientRef`, which can send the customer two messages.
- There is no `UNKNOWN` state and `reconcile` returns 501.
- Human takeover is not enforced on automatic sends.
- The UI shows state and audit as raw JSON.

**Accepted shortcuts (per `CONTRACT.md`):**

- Demo bearer tokens and a published webhook secret.
- The webhook trusts the `tenantId` in its body because the secret authenticates the caller.
- Single process, SQLite, synthetic data.

**First checks for a real GHL pilot (proposed):**

- Derive the organization from verified identity only (for example, mapping the GHL location ID to a tenant), never from client input.
- Put `tenant_id` on every table and add database constraints.
- Run a two-sandbox-location test where cross-access must return 404.
- Log and alert on denied cross-organization attempts (not implemented today).
- Rollback by redeploying the previous build.

This exercise is not production-ready.

## AI use and time

- **Tool:** Claude (Anthropic) in claude.ai with the Desktop Commander and Filesystem extensions, used to review the project, plan the work, draft the tests and propose the fix.
- **Accepted suggestion:** scope `row()` to the actor's organization and return 404 for foreign tickets. Verified by the tests above, which fail on the original code and pass after the fix.
- **Time:** about 10 minutes for requirement 1 (estimate). Total time to be updated at the end.
