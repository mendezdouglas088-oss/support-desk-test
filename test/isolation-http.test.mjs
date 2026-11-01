import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const ALPHA = 'demo-alpha-token';
const BETA = 'demo-beta-token';
let server;

before(async () => { server = await startServer(4390); });
after(async () => { await server?.stop(); });

const call = (...args) => server.call(...args);
const denied = (status) => [403, 404].includes(status);

test('requests without a valid identity are rejected', async () => {
  assert.equal((await call(null, 'GET', '/api/tickets')).status, 401);
  assert.equal((await call('not-a-token', 'GET', '/api/tickets/101')).status, 401);
});

test('a tenantId supplied by the client never widens access', async () => {
  const list = await call(ALPHA, 'GET', '/api/tickets?tenantId=beta');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((t) => t.id), [101]);

  const read = await call(ALPHA, 'GET', '/api/tickets/202?tenantId=beta');
  assert.ok(denied(read.status), `expected 403/404, got ${read.status}`);
});

test('alpha cannot act on beta ticket 202 over HTTP, and beta data stays untouched', async () => {
  const attempts = [
    ['GET', '/api/tickets/202'],
    ['POST', '/api/tickets/202/draft', { body: 'hijacked', tenantId: 'beta' }],
    ['POST', '/api/tickets/202/approve', { tenantId: 'beta' }],
    ['POST', '/api/tickets/202/send', { tenantId: 'beta' }],
    ['POST', '/api/tickets/202/automation', { tenantId: 'beta' }],
    ['POST', '/api/tickets/202/handoff', { tenantId: 'beta' }],
    ['POST', '/api/tickets/202/reconcile', { tenantId: 'beta' }]
  ];
  for (const [method, path, body] of attempts) {
    const r = await call(ALPHA, method, path, body);
    assert.ok(denied(r.status), `${method} ${path} should be denied, got ${r.status}`);
  }
  const own = await call(BETA, 'GET', '/api/tickets/202');
  assert.equal(own.status, 200);
  assert.equal(own.json.draft, '');
  assert.equal(own.json.version, 0);
  assert.equal(own.json.owner, 'automation');
  assert.deepEqual(own.json.audit, []);
});
