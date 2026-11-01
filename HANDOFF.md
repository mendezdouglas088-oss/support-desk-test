# Handoff

Requirements 1-6 are implemented and `npm test` passes 78 of 78. The UI has no browser-level automated tests and one manual check is still pending (see Verification). Longer Spanish version: `HANDOFF_SPANISH.md`.

## Changes and ownership

**Completed** (one commit per requirement; 6 and 7 together in `e5374e0`)

1. **Isolation** (`d5f7b3a`). `row(actor, id)` looks a ticket up by id **and** the tenant of the server-resolved token; `UPDATE`s filter by tenant too. A foreign ticket gives 404, identical to a missing one.
2. **Duplicate webhooks** (`5200b04`). `UNIQUE(tenant_id, event_id)`; message and audit are written in one `BEGIN IMMEDIATE` transaction. A replay answers 200 `duplicate: true` and creates nothing; malformed bodies give 400. A `data/` folder from an older schema is refused: delete it.
3. **Exact approval** (`2b2ed93`). Every edit bumps the version and clears the approval, without touching `send_state`. `sendReply` checks state and approval and pins body and version in one transaction. `approve` takes an optional `version` (409 if stale).
4. **Honest delivery** (`6e94356`). The attempt is stored as `PENDING` with its `client_ref` **before** the single provider call (3 s timeout, no retry). 200 is `SENT`; 503 is `FAILED` (safe to resend); anything else is `UNKNOWN` (504) and blocks every new send. A `PENDING` found at startup becomes `UNKNOWN`, so a kill (no SIGTERM on Windows) cannot cause a second send. `reconcile` looks up the stored reference: delivered is `SENT` (plus a `duplicate_delivery` audit if count > 1); `not_found` or a failed lookup stays `UNKNOWN`; nothing to check is 409.
5. **Takeover** (`1c22e36`). `owner` is checked in the transaction that reserves the attempt, so `/automation` after takeover answers 409 and audits `automation_blocked`. Manual human sends still work. `human_id` records who took the ticket; another agent gets 409.
6. **Usable UI** (`e5374e0`, `public/index.html`). A status banner names the next safe action; buttons are enabled by state (the server still decides); the conversation shows customer messages and our replies with state and date; attempts and audit are readable tables with highlighted unresolved failures; the page refreshes every 4 s without overwriting a draft; server text is only inserted as text nodes.
7. **Tests** (the last ones in `e5374e0`): 78 across `isolation`, `webhook`, `approval`, `delivery`, `takeover` (service-level and `-http` files), `ui.test.mjs` and the original smoke tests. HTTP files use ports 4390-4401, one per file.

**Proposed, not done:** release a ticket back to automation; an escalation path for an `UNKNOWN` that never resolves; a follow-up reply after `SENT`.

## Verification

Command: `npm test` (Node v24.22.2). Result: **78 tests, 78 pass, 0 fail** (about 3.6 s).

Before and after: each requirement's tests were also run against the code from before its fix, in a temporary copy.

| Requirement | Code before the fix | Tests failing there |
|---|---|---|
| 1 Isolation | `aa0662a` | 4 of 8 (Alpha got HTTP 200 on Beta's ticket 202) |
| 2 Webhooks | `aa0662a` | 11 of 13 (e.g. `25 simultaneous copies of one event are stored exactly once`) |
| 3 Approval | `5200b04` | 9 of 12 (3 are regression guards) |
| 4 Delivery | `2b2ed93` | 27 of 27 (e.g. `504 after acceptance: UNKNOWN, no resend...`, `a double click sends once`) |
| 5 Takeover | `6e94356` | 8 of 12 (4 are regression guards) |

The `-http` tests use the unmodified mock provider and its `/deliveries` ledger to check what the customer actually received.

**Not covered / manual only:** UI behavior (banner, enabled buttons, refresh) has no automated test; `ui.test.mjs` only checks that the page script is valid, uses no HTML-parsing calls, and that hostile text such as `<img onerror>` is stored and served as JSON. **Still to do by hand:** send that text through the webhook and confirm the browser shows it as text, then walk the `accept_then_timeout` flow in the UI.

## Operator instructions

- Read the banner on the ticket: it says the state and the next safe action. A disabled button is not safe right now.
- **`UNKNOWN`** means the provider may or may not have delivered. Do **not** resend, and do not edit and resend. Press **Check delivery**. If the provider confirms, the ticket becomes `SENT`. A `duplicate_delivery` audit entry means the customer got more than one copy: follow up by hand. "No record" or a failed check proves nothing: the ticket stays `UNKNOWN`, so check again later. There is deliberately no override to resend.
- **`FAILED`**: the provider refused it and nothing was delivered; sending again is safe. **`PENDING`**: wait; do not press Send again.
- **After a restart**, a send that was in flight appears as `UNKNOWN`; handle it the same way.
- After editing a draft, approve it again. **Take over** stops automation for that ticket; you can still approve and send manually.

## Remaining risks and production plan

**Remaining defects**
- An `UNKNOWN` the provider never resolves stays blocked; there is no override or escalation flow.
- Restart recovery assumes one process. If a database write fails after the provider answers, the ticket stays `PENDING` until restart, then `UNKNOWN` (safe, not automated).
- Takeover does not recall a dispatched message and cannot be released; one sent reply per ticket.
- `audit` and `attempts` have no `tenant_id`; unexpected errors answer 502, not 500.

**Shortcuts accepted by the contract:** demo tokens and a published webhook secret (the webhook trusts the body's `tenantId` because the secret authenticates the caller); one process; SQLite.

**First checks for a real GHL pilot**
- Derive the tenant only from verified identity (for example GHL location ID); add `tenant_id` and constraints to every table.
- Verify the webhook signature, retry behavior and event-ID stability; confirm whether the real API deduplicates or can look up a send by reference.
- Test with two sandbox locations: cross-access must return 404.
- Monitor denied cross-tenant attempts, duplicate-event rate, `duplicate_delivery` entries and tickets stuck in `UNKNOWN` or `PENDING`.
- Rollback: redeploy the previous build (schema changes are additive). Handoff: this document plus the operator steps above.

This exercise is not production-ready.

## AI use and time

- **Tool:** Claude (Anthropic) in claude.ai with the Filesystem and Desktop Commander extensions, to review, plan, write tests, propose fixes and run the suite.
- **Accepted suggestion:** reserve a `PENDING` attempt in the same transaction as the checks, before calling the provider. Verified by `the attempt is stored BEFORE the provider is called` and by the HTTP test that kills the app mid-send and checks `/deliveries` still shows one delivery; both fail on the earlier code.
- **Rejected or changed suggestions:** **[author to complete, or state that there were none]**
- **Time:** about 2 h 14 min of the 3 h limit (chronometer: 45 min 32 s left). By point, approximate (commit timestamps scaled to the chronometer total, no per-point timer was kept): 1 Isolation 7 min; 2 Webhooks 21 min; 3 Approval 7 min; 4 Delivery 29 min; 5 Takeover 8 min; 6 UI, 7 tests and this documentation 62 min.
