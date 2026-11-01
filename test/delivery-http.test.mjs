import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startServer, startProvider } from './helpers.mjs';

// Real app + the unmodified mock provider. The provider's /deliveries ledger tells what the
// customer really received, independently of what the app claims.
const ALPHA = 'demo-alpha-token';
const APP_PORT = 4393, PROVIDER_PORT = 4394, RESTARTED_APP_PORT = 4395;
let provider, providerDir;

before(async () => { provider = await startProvider(PROVIDER_PORT); providerDir = provider.dir; });
after(async () => { await provider?.stop(); rmSync(providerDir, { recursive: true, force: true, maxRetries: 5 }); });

const appEnv = (extra = {}) => ({ PROVIDER_URL: provider.base, PROVIDER_TIMEOUT_MS: '700', ...extra });
async function withApp(fn, env) {
  await provider.mode('normal');
  const app = await startServer(APP_PORT, { env: appEnv(env) });
  try { await fn(app); } finally { await app.stop(); }
}
const post = (app, action, body = {}) => app.call(ALPHA, 'POST', `/api/tickets/101/${action}`, body);
const ticket = async (app) => (await app.call(ALPHA, 'GET', '/api/tickets/101')).json;
const ledger = async (text) => (await provider.deliveries()).filter((d) => d.body === text);
const actions = (t) => t.audit.map((a) => a.action);
async function approved(app, text) {
  assert.equal((await post(app, 'draft', { body: text })).status, 200);
  assert.equal((await post(app, 'approve')).status, 200);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a normal send is SENT, the attempt keeps the provider id and the customer got exactly one message', async () => {
  await withApp(async (app) => {
    await approved(app, 'http normal');
    const r = await post(app, 'send');
    assert.equal(r.status, 200);
    assert.equal(r.json.send_state, 'SENT');
    const received = await ledger('http normal');
    assert.equal(received.length, 1);
    assert.equal(r.json.attempts[0].provider_id, received[0].id);
    assert.equal(r.json.attempts[0].client_ref, received[0].client_ref);
    assert.deepEqual(actions(r.json).filter((a) => a.startsWith('send') || a === 'sent'), ['send_started', 'sent']);
  });
});

test('504 after acceptance: UNKNOWN, no resend, and reconcile resolves it from the provider ledger', async () => {
  await withApp(async (app) => {
    await approved(app, 'http 504');
    await provider.mode('accept_then_timeout');
    const sent = await post(app, 'send');
    assert.equal(sent.status, 504);
    assert.equal(sent.json.sendState, 'UNKNOWN');
    assert.equal((await ledger('http 504')).length, 1, 'the provider did accept it');

    const t = await ticket(app);
    assert.equal(t.send_state, 'UNKNOWN');
    assert.equal(t.attempts[0].state, 'UNKNOWN');

    assert.equal((await post(app, 'send')).status, 409);
    assert.equal((await post(app, 'automation')).status, 409);
    assert.equal((await ledger('http 504')).length, 1, 'still one delivery after the blocked retries');

    const rec = await post(app, 'reconcile');
    assert.equal(rec.status, 200);
    assert.equal(rec.json.send_state, 'SENT');
    assert.equal(rec.json.attempts[0].provider_id, (await ledger('http 504'))[0].id);
    assert.equal((await ledger('http 504')).length, 1, 'reconciling must not send');
  });
});

test('503 before acceptance is a safe FAILED; the operator can send again and one message arrives', async () => {
  await withApp(async (app) => {
    await approved(app, 'http 503');
    await provider.mode('reject_before_accept');
    const refused = await post(app, 'send');
    assert.equal(refused.status, 502);
    assert.equal(refused.json.sendState, 'FAILED');
    assert.equal((await ledger('http 503')).length, 0);
    assert.equal((await ticket(app)).send_state, 'FAILED');
    assert.equal((await post(app, 'reconcile')).status, 409, 'nothing uncertain to reconcile');

    await provider.mode('normal');
    const again = await post(app, 'send');
    assert.equal(again.status, 200);
    assert.equal(again.json.send_state, 'SENT');
    assert.equal((await ledger('http 503')).length, 1);
  });
});

test('accept_then_delay: the request does not hang, the result is UNKNOWN and reconcile finds it', async () => {
  await withApp(async (app) => {
    await approved(app, 'http delay');
    await provider.mode('accept_then_delay');
    const started = Date.now();
    const sent = await post(app, 'send');
    assert.ok(Date.now() - started < 5000, 'the call must give up long before the provider answers');
    assert.equal(sent.status, 504);
    assert.equal((await ticket(app)).send_state, 'UNKNOWN');
    assert.equal((await ledger('http delay')).length, 1);

    assert.equal((await post(app, 'send')).status, 409);
    const rec = await post(app, 'reconcile');
    assert.equal(rec.json.send_state, 'SENT');
    assert.equal((await ledger('http delay')).length, 1);
  });
});

test('a double click sends once', async () => {
  await withApp(async (app) => {
    await approved(app, 'http double click');
    await provider.mode('accept_then_delay');
    const results = await Promise.all([post(app, 'send'), post(app, 'send'), post(app, 'send')]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [409, 409, 504], 'one request owns the send, the others are refused');
    assert.equal((await ledger('http double click')).length, 1);
  });
});

test('killing the app during a send leaves UNKNOWN after restart, with no second send', async () => {
  await provider.mode('normal');
  const first = await startServer(APP_PORT, { env: appEnv({ PROVIDER_TIMEOUT_MS: '30000' }) });
  let second;
  try {
    await approved(first, 'http crash');
    await provider.mode('accept_then_delay');
    const inFlight = post(first, 'send').catch(() => null); // dies with the process
    let state;
    for (let i = 0; i < 60 && state !== 'PENDING'; i++) { await sleep(50); state = (await ticket(first)).send_state; }
    assert.equal(state, 'PENDING', 'the attempt is recorded before the provider answers');
    assert.equal((await ledger('http crash')).length, 1);

    await first.crash(); // no SIGTERM handler runs: the state must already be in SQLite
    await inFlight;

    second = await startServer(RESTARTED_APP_PORT, { env: appEnv(), dir: first.dir });
    const t = await ticket(second);
    assert.equal(t.send_state, 'UNKNOWN');
    assert.equal(t.attempts[0].state, 'UNKNOWN');
    assert.ok(actions(t).includes('send_unknown'));
    assert.equal((await post(second, 'send')).status, 409);
    assert.equal((await post(second, 'automation')).status, 409);
    assert.equal((await ledger('http crash')).length, 1, 'the restart must not send again');

    await provider.mode('normal');
    const rec = await post(second, 'reconcile');
    assert.equal(rec.json.send_state, 'SENT');
    assert.equal(rec.json.attempts[0].provider_id, (await ledger('http crash'))[0].id);
    assert.equal((await ledger('http crash')).length, 1);
  } finally {
    await second?.stop();
    await first.stop();
  }
});

test('provider unreachable: UNKNOWN; not_found after it returns is inconclusive; a lookup failure keeps UNKNOWN', async () => {
  await provider.mode('normal');
  const app = await startServer(APP_PORT, { env: appEnv() });
  let back;
  try {
    await approved(app, 'http provider down');
    await provider.crash(); // connection refused: the app cannot know whether anything was accepted
    const sent = await post(app, 'send');
    assert.equal(sent.status, 504);
    assert.equal((await ticket(app)).send_state, 'UNKNOWN');

    const failedLookup = await post(app, 'reconcile'); // provider still down
    assert.equal(failedLookup.status, 502);
    assert.equal((await ticket(app)).send_state, 'UNKNOWN');

    back = await startProvider(PROVIDER_PORT, { dir: providerDir });
    const inconclusive = await post(app, 'reconcile'); // provider has no record of the reference
    assert.equal(inconclusive.status, 200);
    assert.equal(inconclusive.json.send_state, 'UNKNOWN', 'not_found must not authorize a retry');
    assert.equal((await post(app, 'send')).status, 409);
    assert.equal((await back.deliveries()).filter((d) => d.body === 'http provider down').length, 0);
    const t = await ticket(app);
    assert.ok(actions(t).includes('reconcile_failed'));
    assert.ok(actions(t).includes('reconcile_inconclusive'));
  } finally {
    await app.stop();
    // Later tests need a live provider with the same ledger, even if this test failed midway.
    provider = back ?? await startProvider(PROVIDER_PORT, { dir: providerDir });
  }
});

test('reconcile with nothing to reconcile answers 409', async () => {
  await withApp(async (app) => {
    assert.equal((await post(app, 'reconcile')).status, 409);
    await approved(app, 'http nothing');
    assert.equal((await post(app, 'reconcile')).status, 409);
  });
});

test('another organization cannot reconcile or send an uncertain ticket', async () => {
  await withApp(async (app) => {
    await approved(app, 'http isolation');
    await provider.mode('accept_then_timeout');
    assert.equal((await post(app, 'send')).status, 504);
    const beta = (path) => app.call('demo-beta-token', 'POST', `/api/tickets/101/${path}`, {});
    assert.equal((await beta('reconcile')).status, 404);
    assert.equal((await beta('send')).status, 404);
    assert.equal((await ticket(app)).send_state, 'UNKNOWN');
  });
});
