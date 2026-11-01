import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DeskService } from '../src/service.mjs';

const alpha = { id: 'agent-alpha', tenantId: 'alpha' };
const beta = { id: 'agent-beta', tenantId: 'beta' };
const evt = (over = {}) => ({ tenantId: 'alpha', ticketId: 101, eventId: 'event-1', body: 'Please help', ...over });
const inbound = (ticket) => ticket.audit.filter((a) => a.action === 'inbound');
const make = (databasePath) => new DeskService({ databasePath, provider: {} });
const badRequest = (e) => e.status === 400;

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-webhook-'));
  try { return fn(join(dir, 'desk.sqlite')); }
  finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

test('a repeated event creates one message and one audit entry', () => {
  const s = make();
  try {
    const first = s.receiveWebhook(evt());
    const second = s.receiveWebhook(evt());
    const t = s.getTicket(alpha, 101);
    assert.equal(t.messages.length, 1, 'the message must be stored once');
    assert.equal(inbound(t).length, 1, 'the inbound audit entry must be written once');
    assert.deepEqual(first, { accepted: true, duplicate: false });
    assert.deepEqual(second, { accepted: true, duplicate: true });
  } finally { s.close(); }
});

test('a replay with different text neither overwrites nor adds a message', () => {
  const s = make();
  try {
    s.receiveWebhook(evt({ body: 'original text' }));
    const replay = s.receiveWebhook(evt({ body: 'changed text' }));
    const t = s.getTicket(alpha, 101);
    assert.deepEqual(t.messages.map((m) => m.body), ['original text']);
    assert.equal(replay.duplicate, true);
  } finally { s.close(); }
});

test('event identity is per organization: alpha and beta may reuse the same eventId', () => {
  const s = make();
  try {
    const r = [
      s.receiveWebhook(evt()),
      s.receiveWebhook(evt({ tenantId: 'beta', ticketId: 202, body: 'Hello from beta' })),
      s.receiveWebhook(evt()),
      s.receiveWebhook(evt({ tenantId: 'beta', ticketId: 202 }))
    ];
    assert.deepEqual(s.getTicket(alpha, 101).messages.map((m) => m.body), ['Please help']);
    assert.deepEqual(s.getTicket(beta, 202).messages.map((m) => m.body), ['Hello from beta']);
    assert.deepEqual(r.map((x) => x.duplicate), [false, false, true, true]);
  } finally { s.close(); }
});

test('a duplicate is still detected after a restart and by a second connection', () => {
  withTempDb((path) => {
    const first = make(path);
    const r1 = first.receiveWebhook(evt());

    const concurrent = make(path); // second connection while the first is still open
    const r2 = concurrent.receiveWebhook(evt());
    concurrent.close();
    first.close();

    const restarted = make(path); // process restart
    try {
      const r3 = restarted.receiveWebhook(evt());
      const t = restarted.getTicket(alpha, 101);
      assert.equal(t.messages.length, 1);
      assert.equal(inbound(t).length, 1);
      assert.deepEqual([r1.duplicate, r2.duplicate, r3.duplicate], [false, true, true]);
    } finally { restarted.close(); }
  });
});

test('invalid events are rejected with 400, store nothing and do not consume the eventId', () => {
  const s = make();
  try {
    const invalid = [
      null, undefined, 'text', 42, [], {},
      evt({ eventId: '' }), evt({ eventId: undefined }), evt({ body: 5 }), evt({ body: undefined }),
      evt({ ticketId: 999 }), evt({ ticketId: 'abc' }),
      evt({ tenantId: 'beta' }), // ticket 101 belongs to alpha
      evt({ tenantId: undefined })
    ];
    for (const e of invalid) assert.throws(() => s.receiveWebhook(e), badRequest, JSON.stringify(e));
    assert.equal(s.getTicket(alpha, 101).messages.length, 0);
    assert.equal(s.getTicket(beta, 202).messages.length, 0);
    assert.equal(s.receiveWebhook(evt()).duplicate, false);
  } finally { s.close(); }
});

test('a database made with the old schema is refused with a clear message', () => {
  withTempDb((path) => {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL)');
    old.close();
    assert.throws(() => make(path), /older schema.*delete the data\/ folder/s);
  });
});

test('message and audit entry are written atomically', () => {
  const s = make();
  try {
    s.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    assert.throws(() => s.receiveWebhook(evt()), /simulated failure/);
    assert.equal(s.getTicket(alpha, 101).messages.length, 0, 'the message must be rolled back with the failed audit write');

    s.db.exec('DROP TRIGGER fail_audit');
    assert.equal(s.receiveWebhook(evt()).duplicate, false, 'the failed attempt must not block a later retry');
    const t = s.getTicket(alpha, 101);
    assert.equal(t.messages.length, 1);
    assert.equal(inbound(t).length, 1);
  } finally { s.close(); }
});
