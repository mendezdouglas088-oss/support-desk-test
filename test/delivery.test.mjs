import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const TICKET = 101;

const conflict = (e) => e.status === 409;
const actions = (t) => t.audit.map((a) => a.action);
const never = () => new Promise(() => {}); // a provider call that never answers
const timeout = () => Object.assign(new Error('Provider did not answer in time'), { kind: 'unknown' });
const rejected = () => Object.assign(new Error('Provider did not confirm delivery'), { kind: 'not_accepted' });

// A provider whose behaviour each test chooses. `calls` records every send.
function makeProvider({ send, lookup } = {}) {
  const calls = [];
  return {
    calls,
    send: async (m) => {
      calls.push(m);
      if (send) return send(m, calls.length);
      return { providerMessageId: `p-${calls.length}` };
    },
    lookup: async (ref) => (lookup ? lookup(ref) : { state: 'not_found' })
  };
}

function setup(providerOptions) {
  const provider = makeProvider(providerOptions);
  const service = new DeskService({ provider });
  service.updateDraft(alpha, TICKET, 'Approved reply');
  service.approveDraft(alpha, TICKET);
  return { service, provider };
}

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-delivery-'));
  try { return await fn(join(dir, 'desk.sqlite')); }
  finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

test('a successful send stores the attempt with the exact body, version, reference and provider id', async () => {
  const { service, provider } = setup();
  try {
    const t = await service.sendReply(alpha, TICKET);
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.attempts.length, 1);
    const [a] = t.attempts;
    assert.equal(a.state, 'SENT');
    assert.equal(a.provider_id, 'p-1');
    assert.equal(a.body, 'Approved reply');
    assert.equal(a.version, 1);
    assert.equal(a.client_ref, provider.calls[0].clientRef, 'the stored reference is the one the provider received');
    assert.deepEqual(actions(t).filter((x) => x.startsWith('send') || x === 'sent'), ['send_started', 'sent']);
  } finally { service.close(); }
});

test('the attempt is stored BEFORE the provider is called', async () => {
  let seenDuringSend;
  const { service } = setup({
    send: async () => {
      const t = service.getTicket(alpha, TICKET);
      seenDuringSend = { state: t.send_state, attempts: t.attempts.map((a) => ({ state: a.state, body: a.body })) };
      return { providerMessageId: 'p-1' };
    }
  });
  try {
    await service.sendReply(alpha, TICKET);
    assert.deepEqual(seenDuringSend, { state: 'PENDING', attempts: [{ state: 'PENDING', body: 'Approved reply' }] });
  } finally { service.close(); }
});

test('a timeout is recorded as UNKNOWN, is never retried and blocks further sends', async () => {
  const { service, provider } = setup({ send: async () => { throw timeout(); } });
  try {
    await assert.rejects(() => service.sendReply(alpha, TICKET), (e) => e.status === 504);
    const t = service.getTicket(alpha, TICKET);
    assert.equal(provider.calls.length, 1, 'one call only: no automatic retry');
    assert.equal(t.send_state, 'UNKNOWN');
    assert.equal(t.attempts[0].state, 'UNKNOWN');
    assert.equal(t.attempts[0].client_ref, provider.calls[0].clientRef, 'the reference needed to reconcile is stored');
    assert.ok(actions(t).includes('send_unknown'));

    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    await assert.rejects(() => service.sendReply(alpha, TICKET, { automatic: true }), conflict);
    assert.equal(provider.calls.length, 1);
  } finally { service.close(); }
});

test('editing and re-approving while the delivery is UNKNOWN still cannot send again', async () => {
  const { service, provider } = setup({ send: async () => { throw timeout(); } });
  try {
    await assert.rejects(() => service.sendReply(alpha, TICKET), (e) => e.status === 504);
    service.updateDraft(alpha, TICKET, 'A different reply');
    service.approveDraft(alpha, TICKET);
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(provider.calls.length, 1);
    assert.equal(service.getTicket(alpha, TICKET).send_state, 'UNKNOWN');
  } finally { service.close(); }
});

test('an explicit rejection is a safe FAILED: no automatic retry, but the operator may send again', async () => {
  const { service, provider } = setup({ send: (m, n) => { if (n === 1) throw rejected(); return { providerMessageId: 'p-ok' }; } });
  try {
    await assert.rejects(() => service.sendReply(alpha, TICKET), (e) => e.status === 502);
    let t = service.getTicket(alpha, TICKET);
    assert.equal(provider.calls.length, 1, 'no automatic retry');
    assert.equal(t.send_state, 'FAILED');
    assert.equal(t.attempts[0].state, 'FAILED');
    assert.ok(actions(t).includes('send_failed'));

    t = await service.sendReply(alpha, TICKET); // the operator decides to try again
    assert.equal(provider.calls.length, 2);
    assert.notEqual(provider.calls[0].clientRef, provider.calls[1].clientRef, 'a new attempt gets a new reference');
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.attempts.length, 1, 'the same version reuses its attempt row');
    assert.equal(t.attempts[0].provider_id, 'p-ok');
    assert.equal(t.attempts[0].client_ref, provider.calls[1].clientRef);
  } finally { service.close(); }
});

test('two overlapping sends of the same approved version reach the provider once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service, provider } = setup({ send: async () => { await gate; return { providerMessageId: 'p-1' }; } });
  try {
    const first = service.sendReply(alpha, TICKET);
    const second = service.sendReply(alpha, TICKET);
    // The second request must be refused immediately. If it is not, it is waiting on the
    // provider, so a timer turns "would hang" into a plain assertion failure.
    const outcome = await Promise.race([
      second.then(() => 'sent', (e) => e.status),
      new Promise((resolve) => setTimeout(() => resolve('reached the provider'), 100))
    ]);
    try {
      assert.equal(outcome, 409);
      assert.equal(service.getTicket(alpha, TICKET).send_state, 'PENDING');
    } finally { release(); await Promise.allSettled([first, second]); }
    assert.equal(service.getTicket(alpha, TICKET).send_state, 'SENT');
    assert.equal(provider.calls.length, 1);
  } finally { service.close(); }
});

test('a 200 answer without a message id is treated as uncertain, not as sent', async () => {
  const { service } = setup({ send: async () => ({}) });
  try {
    await assert.rejects(() => service.sendReply(alpha, TICKET), (e) => e.status === 504);
    assert.equal(service.getTicket(alpha, TICKET).send_state, 'UNKNOWN');
  } finally { service.close(); }
});

test('a send interrupted by a restart becomes UNKNOWN and is never sent again', async () => {
  await withTempDb(async (path) => {
    const crashed = new DeskService({ databasePath: path, provider: makeProvider({ send: never }) });
    const provider = makeProvider({ lookup: () => ({ state: 'delivered', providerMessageId: 'p-late', count: 1 }) });
    let restarted;
    try {
      crashed.updateDraft(alpha, TICKET, 'Approved reply');
      crashed.approveDraft(alpha, TICKET);
      crashed.sendReply(alpha, TICKET).catch(() => {}); // never answers: the process "dies" here
      assert.equal(crashed.getTicket(alpha, TICKET).send_state, 'PENDING');

      restarted = new DeskService({ databasePath: path, provider });
      let t = restarted.getTicket(alpha, TICKET);
      assert.equal(t.send_state, 'UNKNOWN', 'the pending attempt is uncertain after a restart');
      assert.equal(t.attempts[0].state, 'UNKNOWN');
      assert.ok(actions(t).includes('send_unknown'));
      await assert.rejects(() => restarted.sendReply(alpha, TICKET), conflict);
      assert.equal(provider.calls.length, 0, 'the restart must not send again');

      t = await restarted.reconcile(alpha, TICKET);
      assert.equal(t.send_state, 'SENT');
      assert.equal(t.attempts[0].provider_id, 'p-late');
      assert.equal(provider.calls.length, 0, 'resolved by evidence, without resending');
    } finally { restarted?.close(); crashed.close(); }
  });
});

test('a restart leaves already resolved attempts alone', async () => {
  await withTempDb(async (path) => {
    const first = new DeskService({ databasePath: path, provider: makeProvider() });
    first.updateDraft(alpha, TICKET, 'Approved reply');
    first.approveDraft(alpha, TICKET);
    await first.sendReply(alpha, TICKET);
    first.close();
    const second = new DeskService({ databasePath: path, provider: makeProvider() });
    try {
      const t = second.getTicket(alpha, TICKET);
      assert.equal(t.send_state, 'SENT');
      assert.equal(t.attempts[0].state, 'SENT');
      assert.ok(!actions(t).includes('send_unknown'));
    } finally { second.close(); }
  });
});

async function uncertain(lookup) {
  const ctx = setup({ send: async () => { throw timeout(); }, lookup });
  await assert.rejects(() => ctx.service.sendReply(alpha, TICKET), (e) => e.status === 504);
  return ctx;
}

test('reconcile: delivered resolves the same attempt to SENT with its provider id, without resending', async () => {
  const { service, provider } = await uncertain(() => ({ state: 'delivered', providerMessageId: 'p-real', count: 1 }));
  try {
    const t = await service.reconcile(alpha, TICKET);
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.attempts.length, 1);
    assert.equal(t.attempts[0].state, 'SENT');
    assert.equal(t.attempts[0].provider_id, 'p-real');
    assert.equal(provider.calls.length, 1, 'reconciling must not send');
    assert.ok(actions(t).includes('reconciled'));
    assert.ok(!actions(t).includes('duplicate_delivery'));
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
  } finally { service.close(); }
});

test('reconcile: the lookup is made with the stored reference of the uncertain attempt', async () => {
  const asked = [];
  const { service, provider } = await uncertain((ref) => { asked.push(ref); return { state: 'delivered', providerMessageId: 'p', count: 1 }; });
  try {
    await service.reconcile(alpha, TICKET);
    assert.deepEqual(asked, [provider.calls[0].clientRef]);
  } finally { service.close(); }
});

test('reconcile: more than one delivery is recorded as a duplicate', async () => {
  const { service } = await uncertain(() => ({ state: 'delivered', providerMessageId: 'p-1', count: 2 }));
  try {
    const t = await service.reconcile(alpha, TICKET);
    assert.equal(t.send_state, 'SENT');
    const dup = t.audit.find((a) => a.action === 'duplicate_delivery');
    assert.ok(dup, 'the duplicate must be audited');
    assert.match(dup.detail, /2/);
  } finally { service.close(); }
});

test('reconcile: not_found is inconclusive, stays UNKNOWN and never authorizes a retry', async () => {
  const { service, provider } = await uncertain(() => ({ state: 'not_found' }));
  try {
    const t = await service.reconcile(alpha, TICKET);
    assert.equal(t.send_state, 'UNKNOWN');
    assert.equal(t.attempts[0].state, 'UNKNOWN');
    assert.ok(actions(t).includes('reconcile_inconclusive'));
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(provider.calls.length, 1);
    // It can be checked again later.
    assert.equal((await service.reconcile(alpha, TICKET)).send_state, 'UNKNOWN');
  } finally { service.close(); }
});

test('reconcile: a failed lookup leaves the state UNKNOWN, reports it and allows no retry', async () => {
  const { service, provider } = await uncertain(() => { throw new Error('Lookup unavailable'); });
  try {
    await assert.rejects(() => service.reconcile(alpha, TICKET), (e) => e.status === 502);
    const t = service.getTicket(alpha, TICKET);
    assert.equal(t.send_state, 'UNKNOWN');
    assert.ok(actions(t).includes('reconcile_failed'));
    await assert.rejects(() => service.sendReply(alpha, TICKET), conflict);
    assert.equal(provider.calls.length, 1);
  } finally { service.close(); }
});

test('reconcile: with nothing pending or uncertain it answers 409', async () => {
  const { service } = setup();
  try {
    await assert.rejects(() => service.reconcile(alpha, TICKET), conflict); // approved, never sent
    await service.sendReply(alpha, TICKET);
    await assert.rejects(() => service.reconcile(alpha, TICKET), conflict); // already SENT
  } finally { service.close(); }
});

test('reconcile: after a safe FAILED there is nothing to reconcile', async () => {
  const { service } = setup({ send: () => { throw rejected(); } });
  try {
    await assert.rejects(() => service.sendReply(alpha, TICKET), (e) => e.status === 502);
    await assert.rejects(() => service.reconcile(alpha, TICKET), conflict);
  } finally { service.close(); }
});

test('reconcile: two overlapping checks resolve the attempt once', async () => {
  const { service } = await uncertain(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return { state: 'delivered', providerMessageId: 'p-1', count: 1 };
  });
  try {
    const results = await Promise.allSettled([service.reconcile(alpha, TICKET), service.reconcile(alpha, TICKET)]);
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    const t = service.getTicket(alpha, TICKET);
    assert.equal(t.send_state, 'SENT');
    assert.equal(t.audit.filter((a) => a.action === 'reconciled').length, 1);
  } finally { service.close(); }
});

test('reconcile and send respect organization isolation', async () => {
  const { service, provider } = await uncertain(() => ({ state: 'delivered', providerMessageId: 'p', count: 1 }));
  try {
    await assert.rejects(() => service.reconcile(beta, TICKET), (e) => e.status === 404);
    await assert.rejects(() => service.sendReply(beta, TICKET), (e) => e.status === 404);
    assert.equal(service.getTicket(alpha, TICKET).send_state, 'UNKNOWN');
    assert.equal(provider.calls.length, 1);
  } finally { service.close(); }
});
