import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);

function workerEntries() {
  const configs = readdirSync(ROOT)
    .filter((name) => /^wrangler(\.[a-z0-9-]+)?\.jsonc$/.test(name))
    .sort();
  const entries = new Map();
  for (const config of configs) {
    const raw = readFileSync(new URL(config, ROOT), 'utf8');
    const { main } = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    if (typeof main === 'string') entries.set(main, config);
  }
  return entries;
}

// workerd treats every named export of a Worker's main module as a candidate
// entrypoint and refuses to start when one is not a function or class
// ("Incorrect type for map entry"). Node imports cannot see that failure.
test('every Worker entry module exports only functions besides its default handler', async () => {
  const entries = workerEntries();
  assert.ok(entries.has('cloudflare/src/mutation-production-intake-worker.mjs'));

  for (const [main, config] of entries) {
    const module = await import(pathToFileURL(new URL(main, ROOT).pathname).href);
    assert.equal(typeof module.default, 'object', `${config}: ${main} default export`);
    for (const [name, value] of Object.entries(module)) {
      if (name === 'default') continue;
      assert.equal(
        typeof value,
        'function',
        `${config}: ${main} named export ${name} would stop workerd from starting`,
      );
    }
  }
});
