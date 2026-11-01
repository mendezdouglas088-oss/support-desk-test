import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const alpha2 = { id: 'agent-alpha-2', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const TICKET = 101;

const conflict = (e) => e.status === 409;
const actions = (t) => t.audit.map((a) => a.action);

function makeProvider({ send } = {}) {
  const calls = [];
  return {
    calls,
    send: async (m) => {
      calls.push(m);
      if (send) return send(m, calls.length);
      return { providerMessageId: `p-${calls.length}` };
    },
    lookup: async () => ({ state: 'not_found' })
  };
}

function setup(providerOptions) {
  const provider = makeProvider(providerOptions);
  const service = new DeskService({ provider });
  service.updateDraft(alpha, TICKET, 'Approved reply');
  service.approveDraft(alpha, TICKET);
  return { service, provider };
}

test('handoff records the owner and WHO took the ticket', () => {
  const { service } = setup();
  try {
    assert.equal(service.getTicket(alpha, TICKET).owner, 'automation');
    const t = service.handoff(alpha, TICKET);
    assert.equal(t.owner, 'human');
    assert.equal(t.human_id, 'agent-alpha');
    const entry = t.audit.find((a) => a.action === 'human_handoff');
    assert.ok(entry);
    assert.match(entry.detail, /agent-alpha/);
  } finally { service.close(); }
});

test('automation can send while the ticket still belongs to automation', async () => {
  const { service, provider } = setup();
  try {
    const t = await service.sendReply(alpha, TICKET, { automatic: true });
    assert.equal(t.send_state, 'SENT');
    assert.equal(provider.calls.length, 1);
  } finally { service.close(); }
});

test('after takeover an automatic send is refused by the server and nothing reaches the provider', async () => {
  const { service, provider } = setup();
  try {
    service.handoff(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET, { automatic: true }), conflict);
    const t = service.getTicket(alpha, TICKET);
    assert.equal(provider.calls.length, 0);
    assert.equal(t.send_state, 'DRAFT', 'no attempt was reserved');
    assert.equal(t.attempts.length, 0);
    assert.ok(actions(t).includes('automation_blocked'), 'the refusal is explained in the audit trail');
    assert.equal(t.approved_version, t.version, 'the approval is untouched');
  } finally { service.close(); }
});

test('after takeover the human can still send the approved reply manually', async () => {
  const { service, provider } = setup();
  try {
    service.handoff(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET, { automatic: true }), conflict);
    const t = await service.sendReply(alpha, TICKET);
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.owner, 'human');
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].body, 'Approved reply');
  } finally { service.close(); }
});

test('a manual send still needs approval after takeover', async () => {
  const provider = makeProvider();
  const service = new DeskService({ provider });
  try {
    service.updateDraft(alpha, TICKET, 'Not approved');
    service.handoff(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(provider.calls.length, 0);
  } finally { service.close(); }
});

test('a takeover while an automatic send is in flight does not recall it, and later automation is refused', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, provider } = setup({ send: async () => { await gate; return { providerMessageId: 'p-1' }; } });
  try {
    const inFlight = service.sendReply(alpha, TICKET, { automatic: true });
    assert.equal(service.getTicket(alpha, TICKET).send_state, 'PENDING');
    service.handoff(alpha, TICKET); // takeover commits after the dispatch started
    release();
    const t = await inFlight;
    assert.equal(t.send_state, 'SENT', 'the message already dispatched is not recalled');
    assert.equal(t.owner, 'human');
    assert.equal(provider.calls.length, 1);
    await assert.rejects(() => service.sendReply(alpha, TICKET, { automatic: true }), conflict);
  } finally { service.close(); }
});

test('taking over twice: the same agent is a no-op, another agent cannot overwrite it', () => {
  const { service } = setup();
  try {
    service.handoff(alpha, TICKET);
    const again = service.handoff(alpha, TICKET);
    assert.equal(again.human_id, 'agent-alpha');
    assert.equal(again.audit.filter((a) => a.action === 'human_handoff').length, 1);
    assert.throws(() => service.handoff(alpha2, TICKET), conflict);
    assert.equal(service.getTicket(alpha, TICKET).human_id, 'agent-alpha');
  } finally { service.close(); }
});

test('another organization cannot take over a ticket, and the owner does not change', async () => {
  const { service } = setup();
  try {
    assert.throws(() => service.handoff(beta, TICKET), (e) => e.status === 404);
    assert.throws(() => service.handoff(beta, 99999), (e) => e.status === 404);
    const t = service.getTicket(alpha, TICKET);
    assert.equal(t.owner, 'automation');
    assert.equal(t.human_id, null);
    assert.ok(!actions(t).includes('human_handoff'));
    assert.equal((await service.sendReply(alpha, TICKET, { automatic: true })).send_state, 'SENT');
  } finally { service.close(); }
});
