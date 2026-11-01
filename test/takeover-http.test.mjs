import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startServer, startProvider } from './helpers.mjs';

// Real app + the unmodified mock provider. /deliveries shows what the customer really received.
const ALPHA = 'demo-alpha-token';
const BETA = 'demo-beta-token';
const APP_PORT = 4396, PROVIDER_PORT = 4397;
let provider;

before(async () => { provider = await startProvider(PROVIDER_PORT); });
after(async () => { await provider?.stop(); });

async function withApp(fn) {
  await provider.mode('normal');
  const app = await startServer(APP_PORT, { env: { PROVIDER_URL: provider.base, PROVIDER_TIMEOUT_MS: '2000' } });
  try { await fn(app); } finally { await app.stop(); }
}
const post = (app, action, body = {}, token = ALPHA) => app.call(token, 'POST', `/api/tickets/101/${action}`, body);
const ticket = async (app) => (await app.call(ALPHA, 'GET', '/api/tickets/101')).json;
const ledger = async (text) => (await provider.deliveries()).filter((d) => d.body === text);
const actions = (t) => t.audit.map((a) => a.action);
async function approved(app, text) {
  assert.equal((await post(app, 'draft', { body: text })).status, 200);
  assert.equal((await post(app, 'approve')).status, 200);
}

test('after takeover /automation answers 409 and the customer receives nothing', async () => {
  await withApp(async (app) => {
    await approved(app, 'takeover automation');
    const h = await post(app, 'handoff');
    assert.equal(h.status, 200);
    assert.equal(h.json.owner, 'human');
    assert.equal(h.json.human_id, 'agent-alpha');

    const blocked = await post(app, 'automation');
    assert.equal(blocked.status, 409);
    assert.equal((await ledger('takeover automation')).length, 0);
    const t = await ticket(app);
    assert.equal(t.send_state, 'DRAFT');
    assert.equal(t.attempts.length, 0);
    assert.ok(actions(t).includes('automation_blocked'));
  });
});

test('the human can still send the approved reply after takeover; one message arrives', async () => {
  await withApp(async (app) => {
    await approved(app, 'takeover manual');
    await post(app, 'handoff');
    assert.equal((await post(app, 'automation')).status, 409);
    const sent = await post(app, 'send');
    assert.equal(sent.status, 200);
    assert.equal(sent.json.send_state, 'SENT');
    assert.equal((await ledger('takeover manual')).length, 1);
  });
});

test('automation works before takeover', async () => {
  await withApp(async (app) => {
    await approved(app, 'before takeover');
    const r = await post(app, 'automation');
    assert.equal(r.status, 200);
    assert.equal(r.json.send_state, 'SENT');
    assert.equal((await ledger('before takeover')).length, 1);
  });
});

test('another organization cannot take over ticket 101', async () => {
  await withApp(async (app) => {
    const r = await post(app, 'handoff', {}, BETA);
    assert.equal(r.status, 404);
    const t = await ticket(app);
    assert.equal(t.owner, 'automation');
    assert.equal(t.human_id, null);
  });
});
