import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverFile = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
export const WEBHOOK_SECRET = 'fictional-webhook-secret';

// Starts the real app server on `port` with a throwaway SQLite database.
// Every test file must use its own port: node --test runs files in parallel.
export async function startServer(port) {
  const dir = mkdtempSync(join(tmpdir(), 'desk-http-'));
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, PORT: String(port), DESK_DB: join(dir, 'desk.sqlite') },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    const onExit = (code) => reject(new Error(`server exited early (${code})`));
    child.once('error', reject);
    child.once('exit', onExit);
    child.stdout.on('data', (d) => {
      if (String(d).includes('Support desk')) { child.off('exit', onExit); resolve(); }
    });
  });
  const base = `http://127.0.0.1:${port}`;

  // Authenticated API call. `body` is JSON-encoded (so `null` is sent as the text "null").
  async function call(token, method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  // Webhook call. secret: undefined = the valid fixture secret, null = send no secret header.
  async function webhook(event, secret) {
    const headers = { 'Content-Type': 'application/json' };
    if (secret !== null) headers['X-Demo-Webhook-Secret'] = secret === undefined ? WEBHOOK_SECRET : secret;
    const res = await fetch(base + '/webhooks/ghl', { method: 'POST', headers, body: JSON.stringify(event) });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async function stop() {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }

  return { base, call, webhook, stop };
}
