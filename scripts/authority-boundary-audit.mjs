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

// ------------------------------------------------ 4. D1 writes stay off the ledger

// The invariant is NOT "the Worker never writes to D1" — lane B's publication lease needs atomic
// writes, and a lease row records who may ATTEMPT, never what was published. The invariant is that
// the Worker never writes the publication ledger, and that any write it does make lands in a lease
// table. Naming the tables states that precisely instead of banning writes wholesale.

const LEDGER_TABLES = ['publication_state', 'publication_events', 'runtime_metadata'];
const LEASE_TABLES = ['publication_leases', 'publication_lease_events'];

const WRITE_STATEMENT_RE =
  /\b(?:INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

const writeTargets = [];

// Scanned over the whole file rather than line by line: `\s+` crosses newlines, so a write whose
// table name sits on the next line cannot slip through a per-line regex.
for (const { path, text } of workerFiles) {
  for (const match of text.matchAll(WRITE_STATEMENT_RE)) {
    const table = match[1].toLowerCase();

    // `ON CONFLICT ... DO UPDATE SET` is an upsert clause, not a table reference — its table is
    // named by the INSERT. Skipping just the captured `SET` keyword, rather than the whole line,
    // means the marker cannot be pasted onto a real write to cloak it.
    if (table === 'set') continue;

    const line = text.slice(0, match.index).split('\n').length;
    writeTargets.push({ where: `${path}:${line}`, table });
  }
}

// Scope note: this scans Worker source only. Local tooling under scripts/ runs on the authoritative
// host and is not the Worker, so its D1 access is out of scope here. Static analysis also cannot
// follow an interpolated table name (`UPDATE ${t}`); this gate catches honest drift and the obvious
// attacks, not a determined author.

const ledgerWrites = writeTargets.filter((w) => LEDGER_TABLES.includes(w.table));

gate(
  'no D1 write to the publication ledger',
  ledgerWrites.length === 0,
  ledgerWrites.map((w) => `${w.where}(${w.table})`).join(' ') || 'none',
);

const strayWrites = writeTargets.filter((w) => !LEASE_TABLES.includes(w.table));

gate(
  'D1 writes confined to lease tables',
  strayWrites.length === 0,
  strayWrites.map((w) => `${w.where}(${w.table})`).join(' ') ||
    (writeTargets.length ? `${writeTargets.length} lease write(s)` : 'no writes'),
);

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
