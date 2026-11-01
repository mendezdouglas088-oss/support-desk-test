import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const ALPHA = 'demo-alpha-token';
const BETA = 'demo-beta-token';
const evt = (over = {}) => ({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help', ...over });
let server;

before(async () => { server = await startServer(4391); });
after(async () => { await server?.stop(); });

const ticket = async (token, id) => (await server.call(token, 'GET', `/api/tickets/${id}`)).json;
const inbound = (t) => t.audit.filter((a) => a.action === 'inbound');

test('webhooks without the right secret are rejected and store nothing', async () => {
  assert.equal((await server.webhook(evt({ eventId: 'no-secret' }), null)).status, 401);
  assert.equal((await server.webhook(evt({ eventId: 'wrong-secret' }), 'guessed-secret')).status, 401);
  assert.equal((await ticket(ALPHA, 101)).messages.length, 0);
});

test('malformed webhook bodies get 400, never 5xx', async () => {
  for (const body of [null, 42, 'text', [], {}, { ...evt(), body: 7 }]) {
    const r = await server.webhook(body);
    assert.equal(r.status, 400, `body ${JSON.stringify(body)} gave ${r.status}`);
  }
  assert.equal((await ticket(ALPHA, 101)).messages.length, 0);
});

test('the same event sent twice answers 200 both times but is stored once', async () => {
  const first = await server.webhook(evt());
  const second = await server.webhook(evt());
  const t = await ticket(ALPHA, 101);
  assert.equal(t.messages.length, 1, 'the message must be stored once');
  assert.equal(inbound(t).length, 1, 'the inbound audit entry must be written once');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { accepted: true, duplicate: false });
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { accepted: true, duplicate: true });
});

test('25 simultaneous copies of one event are stored exactly once', async () => {
  const event = evt({ eventId: 'event-burst', body: 'burst' });
  const results = await Promise.all(Array.from({ length: 25 }, () => server.webhook(event)));
  const t = await ticket(ALPHA, 101);
  assert.equal(t.messages.filter((m) => m.event_id === 'event-burst').length, 1, 'stored messages');
  assert.equal(inbound(t).filter((a) => a.detail === 'event-burst').length, 1, 'inbound audit entries');
  assert.ok(results.every((r) => r.status === 200), 'every copy must be answered 200');
  assert.equal(results.filter((r) => r.json.duplicate === false).length, 1, 'exactly one copy is the first');
});

test('the same eventId is accepted separately for another organization', async () => {
  const r = await server.webhook(evt({ tenantId: 'beta', ticketId: 202, body: 'Hello from beta' }));
  assert.deepEqual(r.json, { accepted: true, duplicate: false });
  assert.deepEqual((await ticket(BETA, 202)).messages.map((m) => m.body), ['Hello from beta']);
  assert.equal((await ticket(ALPHA, 101)).messages.filter((m) => m.body === 'Hello from beta').length, 0);
});

test('an event naming a ticket of another organization is rejected', async () => {
  const r = await server.webhook(evt({ eventId: 'cross', tenantId: 'alpha', ticketId: 202 }));
  assert.equal(r.status, 400);
  assert.equal((await ticket(BETA, 202)).messages.filter((m) => m.event_id === 'cross').length, 0);
});
