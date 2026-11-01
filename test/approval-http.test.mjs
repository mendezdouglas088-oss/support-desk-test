import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const ALPHA = 'demo-alpha-token';
let server;

// These cases are all refused before any provider call, so no mock provider is needed.
before(async () => { server = await startServer(4392); });
after(async () => { await server?.stop(); });

const post = (action, body = {}) => server.call(ALPHA, 'POST', `/api/tickets/101/${action}`, body);
const get = async () => (await server.call(ALPHA, 'GET', '/api/tickets/101')).json;

test('over HTTP, editing after approval clears the approval and the send is refused with 409', async () => {
  assert.equal((await post('draft', { body: 'Approved wording' })).status, 200);
  const approved = await post('approve');
  assert.equal(approved.status, 200);
  assert.equal(approved.json.approved_version, approved.json.version);

  const edited = await post('draft', { body: 'Unapproved wording' });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.approved_version, null);

  const send = await post('send');
  assert.equal(send.status, 409);
  const automation = await post('automation');
  assert.equal(automation.status, 409);
  const t = await get();
  assert.equal(t.send_state, 'DRAFT');
  assert.equal(t.audit.filter((a) => a.action === 'sent').length, 0);
});

test('over HTTP, approving a stale version is refused and a bad version is a 400', async () => {
  const current = (await get()).version;
  const stale = await post('approve', { version: current - 1 });
  assert.equal(stale.status, 409);
  assert.equal((await get()).approved_version, null);

  assert.equal((await post('approve', { version: 'abc' })).status, 400);
  const ok = await post('approve', { version: current });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.approved_version, current);
});
