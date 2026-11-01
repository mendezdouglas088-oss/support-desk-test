import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverFile = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const providerFile = fileURLToPath(new URL('../src/mock-provider.mjs', import.meta.url));
export const WEBHOOK_SECRET = 'fictional-webhook-secret';

// Spawns a child process and resolves once it prints `readyText` on stdout.
async function spawnReady(file, env, readyText) {
  const child = spawn(process.execPath, [file], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    const onExit = (code) => reject(new Error(`${file} exited early (${code})`));
    child.once('error', reject);
    child.once('exit', onExit);
    child.stdout.on('data', (d) => {
      if (String(d).includes(readyText)) { child.off('exit', onExit); resolve(); }
    });
  });
  let dead = false;
  exited.then(() => { dead = true; });
  // Hard kill: on Windows this is TerminateProcess, so no SIGTERM handler runs. That is the
  // point: whatever must survive has to be in SQLite already.
  const crash = async () => { if (!dead) { child.kill('SIGKILL'); await exited; } };
  return { crash };
}

// Starts the real app server on `port` with a throwaway SQLite database.
// Every test file must use its own port: node --test runs files in parallel.
// Pass `dir` to reuse the database folder of an earlier instance (a "restart"); the
// instance that created the folder removes it in stop().
export async function startServer(port, { env = {}, dir } = {}) {
  const ownsDir = !dir;
  dir ??= mkdtempSync(join(tmpdir(), 'desk-http-'));
  const proc = await spawnReady(serverFile,
    { PORT: String(port), DESK_DB: join(dir, 'desk.sqlite'), ...env }, 'Support desk');
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
    await proc.crash();
    if (ownsDir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }

  return { base, dir, call, webhook, crash: proc.crash, stop };
}

// Starts the unmodified mock provider (src/mock-provider.mjs) on `port` with its own
// throwaway ledger. Pass `dir` to bring a stopped provider back with its deliveries.
export async function startProvider(port, { dir } = {}) {
  const ownsDir = !dir;
  dir ??= mkdtempSync(join(tmpdir(), 'desk-provider-'));
  const proc = await spawnReady(providerFile,
    { PROVIDER_PORT: String(port), PROVIDER_DB: join(dir, 'provider.sqlite') }, 'Mock provider listening');
  const base = `http://127.0.0.1:${port}`;
  const json = async (path, init) => (await fetch(base + path, init)).json();
  return {
    base, dir,
    mode: (mode) => json('/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }),
    // The provider's real ledger: what the customer actually received.
    deliveries: () => json('/deliveries'),
    crash: proc.crash,
    async stop() {
      await proc.crash();
      if (ownsDir) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  };
}
