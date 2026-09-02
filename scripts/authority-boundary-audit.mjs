#!/usr/bin/env node
// authority-boundary-audit.mjs — mechanical proof that the Cloudflare runtime has not acquired
// publication authority.
//
// This milestone's whole safety argument is that local systemd remains the sole publisher and that
// Cloudflare stays inert: no cron, no X credentials, no create-post path, no D1 writes from the
// Worker. Those are easy properties to lose accidentally in a refactor, so they are asserted here
// instead of being trusted to review.
//
// Exit 0 = every boundary holds. Exit 1 = at least one boundary is broken.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];

function gate(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)}${detail ? `  ${detail}` : ''}`);
}

/** Every file under `dir`, recursively, as repo-relative paths. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readAll(paths) {
  return paths.map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
}

/** Report every file/line matching `re`, ignoring paths matched by `exempt`. */
function findMatches(files, re, exempt = () => false) {
  const hits = [];
  for (const { path, text } of files) {
    if (exempt(path)) continue;
    text.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${path}:${i + 1}`);
    });
  }
  return hits;
}

const cloudflareFiles = readAll(walk(join(ROOT, 'cloudflare')));
const workerFiles = cloudflareFiles.filter((f) => f.path.startsWith('cloudflare/src/'));

// ---------------------------------------------------------------- 1. cron

const wranglerRaw = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
// wrangler.jsonc allows // comments; strip whole-line ones before parsing.
const wrangler = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, ''));
const crons = wrangler.triggers?.crons ?? [];

gate('cloudflare cron trigger count is 0', Array.isArray(crons) && crons.length === 0, `count=${crons.length}`);

// ------------------------------------------------------- 2. X credentials

const CREDENTIAL_RE =
  /\b(X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|consumer_key|consumer_secret|oauth_token|bearer_token)\b/i;

const credentialHits = [
  ...findMatches(cloudflareFiles, CREDENTIAL_RE),
  ...findMatches([{ path: 'wrangler.jsonc', text: wranglerRaw }], CREDENTIAL_RE),
];

gate('no X credential surface in cloudflare/', credentialHits.length === 0, credentialHits.join(' ') || 'none');

// Secret bindings would be the other way credentials arrive.
const secretBindings = [wrangler.vars, wrangler.secrets_store_secrets, wrangler.send_email]
  .filter(Boolean)
  .map((v) => JSON.stringify(v));

gate('wrangler declares no vars/secret bindings', secretBindings.length === 0, secretBindings.join(' ') || 'none');

// --------------------------------------------- 3. live X publication path

// `tweet_id` in cloudflare/migrations is a legitimate mirror column, not a publication call, so the
// call-surface check is scoped to Worker source only.
const PUBLISH_RE = /\b(createPost|uploadMedia|api\.x\.com|api\.twitter\.com|upload\.twitter\.com|@xdevplatform)\b/i;
const publishHits = findMatches(workerFiles, PUBLISH_RE);

gate('no X publication call in cloudflare/src/', publishHits.length === 0, publishHits.join(' ') || 'none');

// --------------------------------------------------------- 4. D1 is read-only

const D1_WRITE_RE = /\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE|REPLACE\s+INTO)\b/i;
const d1WriteHits = findMatches(workerFiles, D1_WRITE_RE);

gate('no D1 write statement in cloudflare/src/', d1WriteHits.length === 0, d1WriteHits.join(' ') || 'none');

// --------------------------------------------------------- 5. R2 is read-only

const R2_MUTATE_RE = /\bMEDIA\s*\.\s*(put|delete)\s*\(/i;
const r2MutateHits = findMatches(workerFiles, R2_MUTATE_RE);

gate('no R2 mutation in cloudflare/src/', r2MutateHits.length === 0, r2MutateHits.join(' ') || 'none');

// ------------------------------------------- 6. local systemd still authoritative

const unit = readFileSync(join(ROOT, 'deploy/systemd/xqueue.service'), 'utf8');

gate('systemd unit still runs post:live', /ExecStart=.*post:live/.test(unit), 'deploy/systemd/xqueue.service');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

gate('package.json still defines post:live', pkg.scripts?.['post:live'] === 'node src/cli.mjs post --live', pkg.scripts?.['post:live'] ?? 'MISSING');

// ------------------------------------------------ 7. runtime artifacts untracked

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
const mustNotTrack = ['queue.json', 'state.json', '.env', 'media-manifest.json'];
const leaked = mustNotTrack.filter((name) => tracked.includes(name));

gate('generated/secret artifacts are untracked', leaked.length === 0, leaked.join(' ') || 'none');

const trackedMedia = tracked.filter((p) => p.startsWith('media/') && p !== 'media/.gitkeep');

gate('no media binaries tracked', trackedMedia.length === 0, trackedMedia.join(' ') || 'none');

// ----------------------------------------------------------------- verdict

const failures = results.filter((r) => !r.ok);

console.log();
console.log(`=== AUTHORITY BOUNDARY: ${failures.length === 0 ? 'INTACT' : 'BROKEN'} ===`);
console.log(`${results.length - failures.length}/${results.length} gates passed.`);

if (failures.length) {
  console.error();
  for (const failure of failures) console.error(`BROKEN: ${failure.name} — ${failure.detail}`);
  process.exit(1);
}
