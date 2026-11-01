import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const ALPHA_TICKET = 101;
const BETA_TICKET = 202;

function setup() {
  const sent = [];
  const service = new DeskService({
    provider: {
      send: async (m) => { sent.push(m); return { providerMessageId: 'p-1' }; },
      lookup: async () => ({ state: 'not_found' })
    }
  });
  // Beta prepares an approved reply on its own ticket: the most tempting target.
  service.updateDraft(beta, BETA_TICKET, 'Reply meant for Casey only');
  service.approveDraft(beta, BETA_TICKET);
  return { service, sent, betaBefore: service.getTicket(beta, BETA_TICKET) };
}

const isNotFound = (e) => e.status === 404;

test('alpha cannot read, edit, approve, take over, send or reconcile a beta ticket', async () => {
  const { service, sent, betaBefore } = setup();
  try {
    assert.throws(() => service.getTicket(alpha, BETA_TICKET), isNotFound);
    assert.throws(() => service.updateDraft(alpha, BETA_TICKET, 'hijacked'), isNotFound);
    assert.throws(() => service.approveDraft(alpha, BETA_TICKET), isNotFound);
    assert.throws(() => service.handoff(alpha, BETA_TICKET), isNotFound);
    await assert.rejects(() => service.sendReply(alpha, BETA_TICKET), isNotFound);
    await assert.rejects(() => service.sendReply(alpha, BETA_TICKET, { automatic: true }), isNotFound);
    await assert.rejects(() => service.reconcile(alpha, BETA_TICKET), isNotFound);

    assert.equal(sent.length, 0, 'nothing may be dispatched for a foreign ticket');
    assert.deepEqual(service.getTicket(beta, BETA_TICKET), betaBefore, 'the beta ticket must be untouched');
  } finally {
    service.close();
  }
});

test('a foreign ticket is indistinguishable from one that does not exist', () => {
  const { service } = setup();
  try {
    const capture = (id) => { try { service.getTicket(alpha, id); } catch (e) { return { status: e.status, message: e.message }; } };
    assert.deepEqual(capture(BETA_TICKET), capture(999999));
    assert.equal(capture(BETA_TICKET).status, 404);
  } finally {
    service.close();
  }
});

test('each organization lists and works on its own ticket only', () => {
  const { service } = setup();
  try {
    assert.deepEqual(service.listTickets(alpha).map((t) => t.id), [ALPHA_TICKET]);
    assert.deepEqual(service.listTickets(beta).map((t) => t.id), [BETA_TICKET]);

    const t = service.updateDraft(alpha, ALPHA_TICKET, 'Hello Jordan');
    assert.equal(t.draft, 'Hello Jordan');
    assert.equal(service.approveDraft(alpha, ALPHA_TICKET).approved_version, t.version);
    assert.equal(service.handoff(alpha, ALPHA_TICKET).owner, 'human');
  } finally {
    service.close();
  }
});
