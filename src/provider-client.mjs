// Talks to the delivery provider. Failure semantics follow CONTRACT.md:
//   - HTTP 503  -> definitely NOT accepted        (error.kind = 'not_accepted')
//   - HTTP 504, any other non-2xx status, a timeout, a lost connection or an unreadable
//     answer -> the provider MAY have accepted it (error.kind = 'unknown')
// Nothing here retries: whether to send again is decided by the service, from stored state.
export class ProviderClient {
  // timeoutMs bounds every call, so a provider that accepts and then stalls
  // (accept_then_delay holds the answer for 10 s) cannot hang a request.
  constructor(baseUrl = 'http://127.0.0.1:4301', { timeoutMs = 3000 } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }
  async send(payload) {
    let response;
    try {
      response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (cause) {
      throw uncertain(cause?.name === 'TimeoutError'
        ? `The provider did not answer within ${this.timeoutMs} ms`
        : 'The connection to the provider was lost', cause);
    }
    if (!response.ok) {
      const error = new Error(response.status === 503
        ? 'The provider explicitly did not accept the message'
        : `The provider did not confirm delivery (HTTP ${response.status})`);
      error.kind = response.status === 503 ? 'not_accepted' : 'unknown';
      throw error;
    }
    try {
      return await response.json();
    } catch (cause) {
      throw uncertain('The provider answered with something unreadable', cause);
    }
  }
  async lookup(clientRef) {
    const r = await fetch(`${this.baseUrl}/messages?clientRef=${encodeURIComponent(clientRef)}`,
      { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error('Lookup unavailable');
    return r.json();
  }
}

function uncertain(message, cause) {
  const error = new Error(message);
  error.kind = 'unknown';
  error.cause = cause;
  return error;
}
