// The web container's serving contract (apps/web/nginx.conf): the native shells read the hosted build from
// another origin, and nginx inherits no header into a location that sets one of its own.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const conf = readFileSync(new URL('../../apps/web/nginx.conf', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const locations = [...conf.matchAll(/^ {4}location (.+?) \{\n([\s\S]*?)^ {4}\}/gm)].map((m) => ({ match: m[1], body: m[2] }));
const headers = (body) => Object.fromEntries([...body.matchAll(/add_header (\S+) "([^"]*)"/g)].map((m) => [m[1], m[2]]));

test('web nginx: version.json answers any origin and is never served stale — a shell compares it with its own bundle from https://localhost or capacitor://localhost', () => {
  const version = locations.find((l) => l.match === '= /version.json');
  assert.ok(version, 'without a location of its own the file carries no Access-Control-Allow-Origin, and the webview refuses the answer');
  assert.deepEqual(headers(version.body), { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
});

test('web nginx: every location that sets a header includes the security headers again', () => {
  const setting = locations.filter((l) => /add_header/.test(l.body));
  assert.ok(setting.length >= 8, 'the locations were found');
  for (const l of setting) assert.match(l.body, /include \/etc\/nginx\/snippets\/security-headers\.conf;/, `location ${l.match}`);
});
