import { randomUUID } from 'node:crypto';
import { openStore, record, ticketView, DeskError } from './store.mjs';

// This inherited implementation is intentionally incomplete. See README acceptance criteria.
export class DeskService {
  constructor({ databasePath = ':memory:', provider }) {
    this.db = openStore(databasePath);
    this.provider = provider;
  }
  close() { this.db.close(); }
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
  updateDraft(actor, id, body) {
    this.row(actor, id);
    if (typeof body !== 'string' || !body.trim()) throw new DeskError(400, 'A reply is required');
    this.db.prepare("UPDATE tickets SET draft = ?, version = version + 1, send_state = 'DRAFT' WHERE id = ? AND tenant_id = ?")
      .run(body, id, actor.tenantId);
    record(this.db, id, 'draft_updated', actor.id);
    return this.getTicket(actor, id);
  }
  approveDraft(actor, id) {
    const t = this.row(actor, id);
    if (!t.draft) throw new DeskError(400, 'No draft');
    this.db.prepare('UPDATE tickets SET approved_version = version WHERE id = ? AND tenant_id = ?')
      .run(id, actor.tenantId);
    record(this.db, id, 'approved', actor.id);
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
    const t = this.row(actor, id);
    if (t.approved_version == null) throw new DeskError(409, 'Approve the reply first');
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await this.provider.send({ clientRef: randomUUID(), ticketId: id, body: t.draft });
        break;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    this.db.prepare("UPDATE tickets SET send_state = 'SENT' WHERE id = ? AND tenant_id = ?")
      .run(id, actor.tenantId);
    record(this.db, id, 'sent', `${automatic ? 'automation' : actor.id}: ${result.providerMessageId}`);
    return this.getTicket(actor, id);
  }
  async reconcile(actor, id) {
    this.row(actor, id);
    throw new DeskError(501, 'Reconciliation has not been implemented');
  }
}
