import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { startServer } from './helpers.mjs';

// The inbox is one static page. There is no DOM in node:test, so these tests guard the two
// things that can be checked without a browser: the page script is valid, and customer text
// never has a path into HTML parsing. They do not replace the manual <img onerror> check.
const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? '';

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>'
];
const ALPHA = 'demo-alpha-token';
let server;

before(async () => { server = await startServer(4401); });
after(async () => { await server?.stop(); });

test('the page script exists and is syntactically valid', () => {
  assert.ok(script.length > 500, 'the module script was not found in public/index.html');
  assert.doesNotThrow(() => new vm.Script('"use strict";\n' + script), 'a syntax error would blank the whole inbox');
});

test('the page never parses server text as HTML', () => {
  const sinks = /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|srcdoc|\beval\s*\(|new Function\b/;
  assert.equal(sinks.exec(script)?.[0], undefined, 'use textContent / append(string) / createElement instead');
  assert.match(script, /document\.createElement/, 'elements are built with the DOM API');
});

test('hostile customer text is stored and returned verbatim as JSON, never as HTML', async () => {
  for (const [i, body] of PAYLOADS.entries()) {
    const r = await server.webhook({ tenantId: 'alpha', ticketId: 101, eventId: `xss-${i}`, body });
    assert.equal(r.status, 200);
  }
  const res = await fetch(`${server.base}/api/tickets/101`, { headers: { Authorization: `Bearer ${ALPHA}` } });
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const t = await res.json();
  assert.deepEqual(t.messages.map((m) => m.body), PAYLOADS, 'the text is kept exactly as received');
});

test('the page itself is served as HTML and contains none of the customer payloads', async () => {
  const res = await fetch(server.base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const page = await res.text();
  for (const p of PAYLOADS) assert.ok(!page.includes(p), `the page must not embed customer text: ${p}`);
});
