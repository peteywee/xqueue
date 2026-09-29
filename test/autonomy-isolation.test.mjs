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

test('only the explicit #145 control-plane adapter may consume the Batch 0 autonomy model', () => {
  const approved = new Map([
    [
      join(ROOT, 'src/mutation-control-plane.mjs'),
      new Set(['./autonomy/decision-model.mjs', './autonomy/fault-catalog.mjs']),
    ],
  ]);
  const production = [
    ...walk(join(ROOT, 'src')).filter((f) => !f.startsWith(AUTONOMY)),
    ...walk(join(ROOT, 'cloudflare/src')),
    ...walk(join(ROOT, 'scripts')).filter((f) => !f.endsWith('autonomy-batch0-evidence.mjs')),
  ];

  for (const file of production) {
    const source = readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]*autonomy\/[^'"]+)['"]/gm)]
      .map((m) => m[1])
      .sort();
    if (imports.length === 0) continue;

    const allowed = approved.get(file);
    assert.ok(allowed, `${file} references src/autonomy without approval`);
    assert.deepEqual(imports, [...allowed].sort(), `${file} autonomy imports widened beyond the approved #145 boundary`);
  }

  for (const file of approved.keys()) {
    assert.ok(production.includes(file), `${file} approved consumer is missing from production scan`);
  }
});

test('Batch 0 autonomy artifacts do not leak into wrangler configuration, migrations, or workflows', () => {
  const wrangler = readdirSync(ROOT).filter((n) => n.startsWith('wrangler'));
  for (const name of wrangler) assert.ok(!/autonomy/i.test(readFileSync(join(ROOT, name), 'utf8')), name);
  for (const dir of ['cloudflare/migrations', 'cloudflare/migrations-production', '.github/workflows']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      assert.ok(!/autonomy/i.test(name) && !/autonomy/i.test(readFileSync(join(ROOT, dir, name), 'utf8')), `${dir}/${name}`);
    }
  }
});
