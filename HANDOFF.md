# Handoff

> **Status: work in progress.** Requirements 1 (isolation), 2 (duplicate webhooks) and 3 (exact-text approval) are complete and verified. Requirements 4 (honest delivery) and 5 (human takeover) are implemented and their tests are written, but the suite has **not been run yet** against them. Requirement 6 is not implemented yet. Updated as each requirement is finished. Spanish version: `HANDOFF_SPANISH.md`.

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
  - `sendReply` decides what to send in one transaction: `send_state` must be `DRAFT` or `FAILED` (otherwise **409**, so a sent, in-progress or unconfirmed reply cannot be sent again), the approval must match the current version (otherwise 409), and it captures that body and version. The provider receives exactly that body; an edit made while the provider call is in flight cannot change it.
  - `approveDraft` accepts an optional `version`: if the draft moved on, it answers 409; a non-integer gives 400. Omitting it approves the current version. The audit records the version in `approved` and `sent` entries (for example `agent-alpha: v2`).
  - Decisions: editing stays allowed after `SENT`/`UNKNOWN` (state preserved); a ticket holds one sent reply, and a follow-up flow is not designed. The pinned body/version are now stored in `attempts` as part of requirement 4, which adds the `UNKNOWN`/`FAILED` states an attempt row needs (without them a failed send would leave the ticket stuck on `UNIQUE(ticket_id, version)`).
- **Requirement 4 - Honest delivery and recovery** (`src/service.mjs`, `src/server.mjs`, `src/provider-client.mjs`).
  - `sendReply` reserves the attempt **before** calling the provider. In one transaction it checks state and approval, reads the approved text and stores a `PENDING` row in `attempts` (body, version and a new `client_ref`), sets the ticket to `PENDING` and audits `send_started`. A double click or an overlapping request finds `PENDING` and gets **409**.
  - The provider is called **once**, with no automatic retry. `ProviderClient` has a timeout (default 3 s, `PROVIDER_TIMEOUT_MS`) and classifies failures: HTTP 503 is `not_accepted`; 504, any other non-2xx status, a timeout, a lost connection or an unreadable answer is `unknown`. A 200 without a `providerMessageId` also counts as uncertain.
  - Outcomes: success is `SENT`, with the provider ID stored in `attempts` (audit `sent`). An explicit 503 is `FAILED` (**502**, audit `send_failed`), a safe failure after which the operator may send again, reusing the same attempt row with a new reference. Anything else is `UNKNOWN` (**504**, audit `send_unknown`): the reference is kept and every new send, manual or automatic, is blocked, even after editing and re-approving. Error bodies include `sendState`.
  - Restart: when the service starts, any `PENDING` attempt becomes `UNKNOWN` (audit `send_unknown`). On Windows, killing the process runs no `SIGTERM` handler, so the safety comes from the state already stored in SQLite.
  - `reconcile` (it returned 501 before) works only on a ticket in `UNKNOWN` (otherwise **409**) and never sends. It looks up the stored reference at the provider: `delivered` resolves the same attempt to `SENT` with its ID (audit `reconciled`, plus `duplicate_delivery` if `count` is greater than 1); `not_found` is inconclusive, so the ticket stays `UNKNOWN` and `reconcile_inconclusive` is audited; a failed lookup answers **502**, stays `UNKNOWN` and audits `reconcile_failed`. Two simultaneous checks resolve the attempt once.
- **Requirement 5 - Human takeover** (`src/service.mjs`, `src/store.mjs`).
  - `sendReply` reads `owner` in the same transaction that reserves the attempt. An automatic dispatch (`/automation`, which sets `automatic: true` on the server) on a ticket not owned by `automation` answers **409**, reserves nothing, never calls the provider and audits `automation_blocked`. Manual sends by a human are unaffected and still need approval. Check and reservation are one transaction, so a takeover that commits first always wins.
  - A message already dispatched before the takeover is not recalled: a takeover during an in-flight automatic send lets that send finish.
  - `handoff` now runs in a transaction and stores who took the ticket in a new `tickets.human_id` column (the `human_handoff` audit entry also names the agent). The same agent repeating it is a no-op; a different agent gets **409** and cannot overwrite it. A foreign ticket is 404 as before. `openStore` adds the column to an existing database with `ALTER TABLE`, so this change does not require deleting `data/`.
- **Tests added:** `isolation.test.mjs`, `isolation-http.test.mjs` (port 4390), `webhook.test.mjs`, `webhook-http.test.mjs` (4391), `approval.test.mjs`, `approval-http.test.mjs` (4392), `delivery.test.mjs`, `delivery-http.test.mjs` (4393-4395), `takeover.test.mjs`, `takeover-http.test.mjs` (4396-4397) and `helpers.mjs` (starts the real server with a temporary SQLite database; one port per HTTP file because `node --test` runs files in parallel).

**Proposed, not started:** requirement 6 (usable handoff UI).

## Verification

Command: `npm test` (Node v24.22.2). Original code `aa0662a`; requirement 1 `d5f7b3a`; requirement 2 `5200b04`; requirement 3 is the uncommitted diff against `5200b04`.

- **After the fixes (requirements 1-3):** **33 of 33 tests pass, 0 fail** (8 + 13 + 12), run in the project folder.
- **Requirements 4 and 5: not run yet.** `takeover.test.mjs` and `takeover-http.test.mjs` (requirement 5, same approach) are also written. `delivery.test.mjs` (unit tests with a stub provider) and `delivery-http.test.mjs` (real app plus the unmodified mock provider, using its `/deliveries` ledger to check what the customer received) are written, but `npm test` has not been run with them. There is no pass/fail count and no before/after result to report. Run `npm test` and update this section.
- **Requirement 1, before the fix:** 4 of 8 failed; Alpha got **HTTP 200** reading Beta's ticket 202.
- **Requirement 2, before the fix** (tests against the original `service.mjs`, `store.mjs`, `server.mjs` in a temporary copy): **11 of 13 failed**, for example `25 simultaneous copies of one event are stored exactly once` and `message and audit entry are written atomically`.
- **Requirement 3, before the fix** (new tests against the code from `5200b04`): **9 of 12 failed, 3 passed**. The 3 that passed are regression guards. Failing tests include:
  - `editing an approved draft invalidates the approval, so the new text cannot be sent`
  - `a reply that was already sent cannot be sent again`
  - `editing after SENT keeps the SENT state and still cannot trigger a second send`
  - `editing never erases an uncertain delivery state, and that state blocks sending`
  - `approving can name the version, and a stale version is refused`
- **Verified only manually:** nothing yet. Still to check in the browser: Alpha and Beta see only their own ticket; a replayed event (`npm run event`) shows one message; edit-after-approve shows an error on Send; with the provider in `accept_then_timeout`, Send leaves the ticket `UNKNOWN` and `reconcile` resolves it without a second delivery in `/deliveries`.
- **Not covered:** requirement 6, and the requirement 4-5 results (tests written, not run). The UI does not yet show `PENDING`/`UNKNOWN`/`FAILED` clearly or offer a reconcile button (requirement 6).

## Operator instructions

Requirements 1-5. The screen to follow these steps is requirement 6 and is not done; until then, the actions are HTTP calls (`POST /api/tickets/:id/send`, `POST /api/tickets/:id/reconcile`).

- An agent sees only their organization's tickets. Another organization's ticket shows "Ticket not found" by design.
- A repeated webhook event answers `duplicate: true` and changes nothing; this is expected.
- After editing a draft, **approve it again**. Send is refused (409) until the current version is approved. A ticket already `SENT`, or with an unconfirmed send, refuses new sends.
- If the app refuses to start with an "older schema" message, delete `data/` (demo data only).
- Send states: `PENDING` (a send is in progress; wait), `SENT` (delivered, nothing to do), `FAILED` (the provider explicitly refused it, nothing reached the customer, and you may press Send again), `UNKNOWN` (the provider may have delivered it).
- **Uncertain delivery (`UNKNOWN`):** do not resend, and do not edit and resend. Call **reconcile**. If the provider confirms delivery, the ticket becomes `SENT` with the provider ID. If the audit shows `duplicate_delivery`, the customer received more than one copy and someone must follow up. `not_found` or a failed lookup do not prove the message was not delivered: the ticket stays `UNKNOWN`, so check again later. There is deliberately no override to resend. A send that was in flight when the app restarted also appears as `UNKNOWN`.
- **Takeover:** use handoff to take a ticket. From then on automation can no longer send it (it answers 409 and the audit shows `automation_blocked`); you can still approve and send manually. Another agent cannot take a ticket you already took. A message automation dispatched before your takeover is not recalled.

## Remaining risks and production plan

**Remaining defects (not yet fixed):**

- A ticket in `UNKNOWN` can only leave that state through `reconcile`. If the provider never records the reference, it stays blocked until someone handles it outside the app (no manual override or escalation flow).
- Restart recovery assumes one process: at startup every `PENDING` attempt becomes `UNKNOWN`, which would be wrong if several processes shared the database.
- Takeover does not recall a message already dispatched (accepted by the exercise), and there is no way to release a ticket back to automation.
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
- **Accepted suggestions:** (1) scope `row()` to the actor's organization; (2) `UNIQUE(tenant_id, event_id)` plus `ON CONFLICT DO NOTHING` in one transaction; (3) clear the approval on every edit, check state and approval and capture body and version in one transaction, and leave `send_state` alone on edit; (4) reserve a `PENDING` attempt in the same transaction as the checks and before calling the provider, make a single provider call, mark `UNKNOWN` on any unconfirmed result and on restart, and reconcile from the stored reference; (5) check the owner inside the same transaction that reserves the attempt, so a takeover that commits first always wins, and record who took the ticket. Items 1-3 are verified by tests that fail on the previous code and pass after; the tests for items 4 and 5 are written but not run yet.
- **Time:** about 10 minutes for requirement 1 (estimate). Requirements 2 to 5 not recorded yet. Total to be updated at the end.
