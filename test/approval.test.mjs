import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const TICKET = 101;

// A provider that records what it receives. `gate` lets a test pause a send midway.
function setup({ gate } = {}) {
  const delivered = [];
  const service = new DeskService({
    provider: {
      send: async (m) => {
        delivered.push(m);
        if (gate) await gate;
        return { providerMessageId: `p-${delivered.length}` };
      }
    }
  });
  return { service, delivered };
}

const conflict = (e) => e.status === 409;
const badRequest = (e) => e.status === 400;
const audit = (t, action) => t.audit.filter((a) => a.action === action);

test('editing an approved draft invalidates the approval, so the new text cannot be sent', async () => {
  const { service, delivered } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'Text A');
    const approved = service.approveDraft(alpha, TICKET);
    assert.equal(approved.approved_version, approved.version);

    const edited = service.updateDraft(alpha, TICKET, 'Text B, never approved');
    assert.equal(edited.approved_version, null, 'the approval must be cleared by the edit');
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(delivered.length, 0, 'nothing may reach the customer');
  } finally { service.close(); }
});

test('the provider receives exactly the approved text and version', async () => {
  const { service, delivered } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'First wording');
    service.updateDraft(alpha, TICKET, 'Final wording');
    const approved = service.approveDraft(alpha, TICKET);
    await service.sendReply(alpha, TICKET);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].body, 'Final wording');
    assert.equal(approved.version, 2);
  } finally { service.close(); }
});

test('an edit made while the provider call is in flight does not change what was sent', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, delivered } = setup({ gate });
  try {
    service.updateDraft(alpha, TICKET, 'Approved text');
    service.approveDraft(alpha, TICKET);
    const sending = service.sendReply(alpha, TICKET);
    // The provider call is pending. Someone edits the draft in the meantime.
    service.updateDraft(alpha, TICKET, 'Edited after approval');
    release();
    const t = await sending;
    assert.equal(delivered[0].body, 'Approved text');
    assert.equal(t.draft, 'Edited after approval');
    assert.equal(t.approved_version, null, 'the late edit must still invalidate the approval');
    assert.match(audit(t, 'sent')[0].detail, /v1\b/, 'the audit must name the version that was sent');
  } finally { service.close(); }
});

test('a reply that was already sent cannot be sent again', async () => {
  const { service, delivered } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'Only once');
    service.approveDraft(alpha, TICKET);
    await service.sendReply(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    await assert.rejects(() => service.sendReply(alpha, TICKET, { automatic: true }), conflict);
    assert.equal(delivered.length, 1, 'the customer must receive one message');
  } finally { service.close(); }
});

test('editing after SENT keeps the SENT state and still cannot trigger a second send', async () => {
  const { service, delivered } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'Sent text');
    service.approveDraft(alpha, TICKET);
    await service.sendReply(alpha, TICKET);

    const edited = service.updateDraft(alpha, TICKET, 'Different text');
    assert.equal(edited.send_state, 'SENT', 'an edit must not erase the delivery state');
    service.approveDraft(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(delivered.length, 1);
  } finally { service.close(); }
});

test('editing never erases an uncertain delivery state, and that state blocks sending', async () => {
  const { service, delivered } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'Maybe delivered');
    service.approveDraft(alpha, TICKET);
    // UNKNOWN is produced by requirement 4. Here it is set directly to test the invariant.
    service.db.prepare("UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ?").run(TICKET);

    const edited = service.updateDraft(alpha, TICKET, 'Edited while uncertain');
    assert.equal(edited.send_state, 'UNKNOWN');
    service.approveDraft(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(delivered.length, 0);
    assert.equal(service.getTicket(alpha, TICKET).send_state, 'UNKNOWN');
  } finally { service.close(); }
});

test('approving can name the version, and a stale version is refused', () => {
  const { service } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'v1 text');
    service.updateDraft(alpha, TICKET, 'v2 text');

    assert.throws(() => service.approveDraft(alpha, TICKET, 1), conflict, 'v1 is no longer the current draft');
    assert.equal(service.getTicket(alpha, TICKET).approved_version, null, 'a refused approval changes nothing');
    assert.throws(() => service.approveDraft(alpha, TICKET, 'two'), badRequest);
    assert.throws(() => service.approveDraft(alpha, TICKET, 1.5), badRequest);

    const t = service.approveDraft(alpha, TICKET, 2);
    assert.equal(t.approved_version, 2);
    assert.equal(service.approveDraft(alpha, TICKET).approved_version, 2, 'omitting the version approves the current one');
  } finally { service.close(); }
});

test('the audit records which version was approved and which was sent', async () => {
  const { service } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'one');
    service.updateDraft(alpha, TICKET, 'two');
    service.approveDraft(alpha, TICKET);
    const t = await service.sendReply(alpha, TICKET);
    assert.match(audit(t, 'approved')[0].detail, /agent-alpha.*v2\b/);
    assert.match(audit(t, 'sent')[0].detail, /agent-alpha.*v2\b/);
  } finally { service.close(); }
});

test('a refused send or approval writes no audit entry and does not touch the ticket', async () => {
  const { service } = setup();
  try {
    service.updateDraft(alpha, TICKET, 'draft');
    const before = service.getTicket(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict); // never approved
    assert.deepEqual(service.getTicket(alpha, TICKET), before);
  } finally { service.close(); }
});

test('approval rules do not leak across organizations', () => {
  const { service } = setup();
  try {
    service.updateDraft(beta, 202, 'beta draft');
    assert.throws(() => service.approveDraft(alpha, 202, 1), (e) => e.status === 404);
    assert.equal(service.getTicket(beta, 202).approved_version, null);
  } finally { service.close(); }
});
