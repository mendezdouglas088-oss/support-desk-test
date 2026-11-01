import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, DeskError } from './store.mjs';

// This inherited implementation is intentionally incomplete. See README acceptance criteria.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
    this.recoverInterruptedSends();
  }
  close() { this.db.close(); }
  // A send that was PENDING when the process stopped (crash, kill, restart) may or may
  // not have reached the provider. Killing a process on Windows runs no SIGTERM handler,
  // so this decision is taken from what SQLite says at startup: the attempt becomes
  // UNKNOWN, which blocks any new send until the operator reconciles it.
  recoverInterruptedSends() {
    this.inTransaction(() => {
      const pending = this.db.prepare("SELECT id, ticket_id, version, client_ref FROM attempts WHERE state = 'PENDING'").all();
      for (const a of pending) {
        this.db.prepare("UPDATE attempts SET state = 'UNKNOWN' WHERE id = ?").run(a.id);
        this.db.prepare("UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ? AND send_state = 'PENDING'").run(a.ticket_id);
        record(this.db, a.ticket_id, 'send_unknown',
          `The process stopped while v${a.version} was being sent (ref ${a.client_ref}); check delivery before sending again`);
      }
    });
  }
  listTickets(actor) {
    return this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? ORDER BY id').all(actor.tenantId);
  }
  // Every ticket access goes through here. The organization comes from the actor
  // resolved on the server, never from the request. A ticket that belongs to
  // another organization looks exactly like one that does not exist (404).
  row(actor, id) {
    if (!actor?.tenantId) throw new DeskError(401, 'Sign in using a demo identity');
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?')
      .get(id, actor.tenantId);
    if (!row) throw new DeskError(404, 'Ticket not found');
    return row;
  }
  getTicket(actor, id) { return ticketView(this.db, this.row(actor, id)); }
  // Runs fn inside one write transaction. BEGIN IMMEDIATE takes the write lock up
  // front, so two connections (or a restarted process) can never interleave their
  // check-then-write. Commits on success and rolls everything back on any error.
  inTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
      throw error;
    }
  }
  // Inbound webhook. An event is identified by (organization, eventId): replaying it
  // answers 200 with duplicate:true and changes nothing. The UNIQUE constraint in the
  // database is the real guarantee; it also holds across restarts and processes.
  receiveWebhook(event) {
    const invalid = () => new DeskError(400, 'Invalid event');
    if (event === null || typeof event !== 'object' || Array.isArray(event)) throw invalid();
    const { tenantId, ticketId, eventId, body } = event;
    const id = typeof ticketId === 'number' ? ticketId
      : typeof ticketId === 'string' && /^\d+$/.test(ticketId) ? Number(ticketId) : NaN;
    const eid = typeof eventId === 'number' && Number.isFinite(eventId) ? String(eventId) : eventId;
    if (typeof tenantId !== 'string' || !tenantId || !Number.isSafeInteger(id)
      || typeof eid !== 'string' || !eid.trim() || typeof body !== 'string') throw invalid();
    return this.inTransaction(() => {
      const t = this.db.prepare('SELECT id FROM tickets WHERE id = ? AND tenant_id = ?').get(id, tenantId);
      if (!t) throw invalid();
      const inserted = this.db.prepare(
        'INSERT INTO messages(tenant_id, ticket_id, event_id, body) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT(tenant_id, event_id) DO NOTHING').run(tenantId, t.id, eid, body);
      if (inserted.changes === 0) return { accepted: true, duplicate: true };
      record(this.db, t.id, 'inbound', eid);
      return { accepted: true, duplicate: false };
    });
  }
  // Any edit bumps the version AND clears the approval: the stored text is no longer
  // the text somebody approved. send_state is deliberately not touched, so an edit can
  // never hide a reply that was already sent or whose delivery is uncertain.
  updateDraft(actor, id, body) {
    this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    this.inTransaction(() => {
      this.db.prepare('UPDATE tickets SET draft = ?, version = version + 1, approved_version = NULL WHERE id = ? AND tenant_id = ?')
        .run(body, id, actor.tenantId);
      record(this.db, id, 'draft_updated', actor.id);
    });
    return this.getTicket(actor, id);
  }
  // `version` is optional. When the caller names the version it is looking at and the
  // draft has moved on since, the approval is refused (409) instead of silently
  // approving text the approver never saw.
  approveDraft(actor, id, version) {
    this.row(actor, id);
    if (version != null && !Number.isSafeInteger(version)) throw new DeskError(400, 'version must be an integer');
    this.inTransaction(() => {
      const t = this.row(actor, id);
      if (!t.draft) throw new DeskError(400, 'No draft');
      if (version != null && version !== t.version) {
        throw new DeskError(409, `The draft changed: its current version is ${t.version}`);
      }
      this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ? AND tenant_id = ?')
        .run(id, actor.tenantId);
      record(this.db, id, 'approved', `${actor.id}: v${t.version}`);
    });
    return this.getTicket(actor, id);
  }
  handoff(actor, id) {
    this.row(actor, id);
    this.db.prepare("UPDATE tickets SET owner = 'human' WHERE id = ? AND tenant_id = ?")
      .run(id, actor.tenantId);
    record(this.db, id, 'human_handoff', actor.id);
    return this.getTicket(actor, id);
  }
  async sendReply(actor, id, { automatic = false } = {}) {
    // Reserve the attempt before touching the provider. State check, approval check, the
    // read of the approved text and the PENDING record happen in ONE transaction, so a
    // double click or an overlapping request finds PENDING and is refused, and a crash
    // right after leaves a stored reference to reconcile. The body and version stored are
    // the approved ones; a later edit cannot change what this call sends.
    const attempt = this.inTransaction(() => {
      const t = this.row(actor, id);
      if (t.send_state === 'SENT') throw new DeskError(409, 'A reply was already sent for this ticket');
      if (t.send_state === 'PENDING') throw new DeskError(409, 'A send is already in progress for this ticket');
      if (t.send_state === 'UNKNOWN') {
        throw new DeskError(409, 'A previous send is not confirmed yet: check its delivery before sending again');
      }
      // DRAFT, or FAILED (the provider explicitly refused the last attempt).
      if (t.approved_version == null || t.approved_version !== t.version) {
        throw new DeskError(409, 'Approve the reply first');
      }
      const clientRef = randomUUID();
      const previous = this.db.prepare('SELECT id FROM attempts WHERE ticket_id = ? AND version = ?').get(id, t.version);
      if (previous) {
        // Only a FAILED attempt of this same version can get here: it reuses its row.
        this.db.prepare("UPDATE attempts SET client_ref = ?, body = ?, state = 'PENDING', provider_id = NULL WHERE id = ?")
          .run(clientRef, t.draft, previous.id);
      } else {
        this.db.prepare("INSERT INTO attempts(ticket_id, version, client_ref, body, state) VALUES (?, ?, ?, ?, 'PENDING')")
          .run(id, t.version, clientRef, t.draft);
      }
      this.db.prepare("UPDATE tickets SET send_state = 'PENDING' WHERE id = ? AND tenant_id = ?").run(id, actor.tenantId);
      record(this.db, id, 'send_started', `${automatic ? 'automation' : actor.id}: v${t.version} (ref ${clientRef})`);
      return { clientRef, body: t.draft, version: t.version };
    });

    // Exactly one call to the provider. Nothing here retries: a retry needs a stored decision.
    let result, failure;
    try {
      result = await this.provider.send({ clientRef: attempt.clientRef, ticketId: id, body: attempt.body });
      if (typeof result?.providerMessageId !== 'string' || !result.providerMessageId) {
        failure = Object.assign(new Error('The provider answered without a message id'), { kind: 'unknown' });
      }
    } catch (error) { failure = error; }

    if (!failure) {
      this.inTransaction(() => {
        this.db.prepare("UPDATE attempts SET state = 'SENT', provider_id = ? WHERE client_ref = ?")
          .run(result.providerMessageId, attempt.clientRef);
        this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ? AND tenant_id = ?").run(id, actor.tenantId);
        record(this.db, id, 'sent',
          `${automatic ? 'automation' : actor.id}: ${result.providerMessageId} (v${attempt.version})`);
      });
      return this.getTicket(actor, id);
    }

    // Only an explicit "not accepted" is a safe failure. Anything else may have been delivered.
    if (failure.kind === 'not_accepted') {
      this.inTransaction(() => {
        this.db.prepare("UPDATE attempts SET state = 'FAILED' WHERE client_ref = ?").run(attempt.clientRef);
        this.db.prepare("UPDATE tickets SET send_state = 'FAILED' WHERE id = ? AND tenant_id = ?").run(id, actor.tenantId);
        record(this.db, id, 'send_failed', `${failure.message} (v${attempt.version}, ref ${attempt.clientRef})`);
      });
      throw new DeskError(502, `${failure.message}. It was not delivered; you may send it again.`, { sendState: 'FAILED' });
    }
    this.inTransaction(() => {
      this.db.prepare("UPDATE attempts SET state = 'UNKNOWN' WHERE client_ref = ?").run(attempt.clientRef);
      this.db.prepare("UPDATE tickets SET send_state = 'UNKNOWN' WHERE id = ? AND tenant_id = ?").run(id, actor.tenantId);
      record(this.db, id, 'send_unknown', `${failure.message} (v${attempt.version}, ref ${attempt.clientRef})`);
    });
    throw new DeskError(504, `${failure.message}. Delivery is UNKNOWN: check it before sending again.`, { sendState: 'UNKNOWN' });
  }
  // Resolves the uncertain attempt using provider evidence. It never sends.
  //   delivered  -> SENT, provider id stored; count > 1 is audited as a duplicate
  //   not_found  -> inconclusive: stays UNKNOWN, no retry is authorized
  //   lookup error -> stays UNKNOWN, reported as 502
  async reconcile(actor, id) {
    const attempt = this.inTransaction(() => {
      const t = this.row(actor, id);
      if (t.send_state !== 'UNKNOWN') throw new DeskError(409, 'There is no uncertain delivery to check');
      const a = this.db.prepare("SELECT * FROM attempts WHERE ticket_id = ? AND state = 'UNKNOWN' ORDER BY id DESC LIMIT 1").get(id);
      if (!a) throw new DeskError(409, 'There is no uncertain delivery to check');
      return a;
    });
    let found;
    try {
      found = await this.provider.lookup(attempt.client_ref);
    } catch {
      record(this.db, id, 'reconcile_failed', `${actor.id}: the provider lookup failed (v${attempt.version}, ref ${attempt.client_ref})`);
      throw new DeskError(502, 'Could not check the delivery with the provider. The state stays UNKNOWN.', { sendState: 'UNKNOWN' });
    }
    this.inTransaction(() => {
      // Another overlapping check may have resolved it while we waited for the provider.
      const current = this.db.prepare('SELECT state FROM attempts WHERE id = ?').get(attempt.id);
      if (current.state !== 'UNKNOWN') return;
      if (found?.state === 'delivered' && typeof found.providerMessageId === 'string' && found.providerMessageId) {
        this.db.prepare("UPDATE attempts SET state = 'SENT', provider_id = ? WHERE id = ?").run(found.providerMessageId, attempt.id);
        this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ? AND tenant_id = ?").run(id, actor.tenantId);
        record(this.db, id, 'reconciled', `${actor.id}: delivered as ${found.providerMessageId} (v${attempt.version})`);
        if (found.count > 1) {
          record(this.db, id, 'duplicate_delivery',
            `The provider has ${found.count} deliveries for reference ${attempt.client_ref} (v${attempt.version})`);
        }
      } else {
        record(this.db, id, 'reconcile_inconclusive',
          `${actor.id}: the provider has no record of ref ${attempt.client_ref}; this does not prove it was not delivered`);
      }
    });
    return this.getTicket(actor, id);
  }
}
