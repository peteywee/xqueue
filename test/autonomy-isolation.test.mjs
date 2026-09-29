import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const AUTONOMY = join(ROOT, 'src/autonomy');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|js|ts)$/.test(name)) out.push(p);
  }
  return out;
}

test('autonomy model is pure local code: imports only its own modules, no I/O, network, clock, randomness, or credentials', () => {
  const forbidden = [
    /from\s+['"]node:(fs|net|http|https|child_process|dgram|dns|worker_threads)/,
    /\bfetch\s*\(/, /process\.env/, /Date\.now|new Date\(/, /Math\.random/, /@xdevplatform/, /wrangler/, /cloudflare/i,
    /X_API_|X_ACCESS_|CLOUDFLARE_API_TOKEN/,
  ];
  const files = walk(AUTONOMY);
  assert.ok(files.length >= 5);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${file} matches ${pattern}`);
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(m[1].startsWith('./'), `${file} imports ${m[1]}`);
    }
  }
});

test('no production, publisher, worker, script, or CLI module imports the Batch 0 autonomy model', () => {
  const production = [...walk(join(ROOT, 'src')).filter((f) => !f.startsWith(AUTONOMY)), ...walk(join(ROOT, 'cloudflare/src')),
    ...walk(join(ROOT, 'scripts')).filter((f) => !f.endsWith('autonomy-batch0-evidence.mjs'))];
  for (const file of production) {
    assert.ok(!/autonomy\//.test(readFileSync(file, 'utf8')), `${file} references src/autonomy`);
  }
});

test('Batch 0 adds no wrangler configuration, migration, or workflow', () => {
  const wrangler = readdirSync(ROOT).filter((n) => n.startsWith('wrangler'));
  for (const name of wrangler) assert.ok(!/autonomy/i.test(readFileSync(join(ROOT, name), 'utf8')), name);
  for (const dir of ['cloudflare/migrations', 'cloudflare/migrations-production', '.github/workflows']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      assert.ok(!/autonomy/i.test(name) && !/autonomy/i.test(readFileSync(join(ROOT, dir, name), 'utf8')), `${dir}/${name}`);
    }
  }
});
