#!/usr/bin/env node
// cli.mjs — the whole operator surface.
//
//   node src/cli.mjs build      rebuild queue.json from the markdown library
//   node src/cli.mjs validate   run every rule; exit 1 on any error
//   node src/cli.mjs stats      pillar split, runway, cost projection
//   node src/cli.mjs next [n]   show what posts next
//   node src/cli.mjs post       publish anything due (add --dry-run first)
//   node src/cli.mjs whoami     verify credentials
//
// The markdown files are the source of truth. queue.json is generated.
// state.json records what actually went out, so a re-run can't double-post.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary, renderPost, PILLARS } from './parse.mjs';
import { validate, summarize, URL_RE } from './validate.mjs';
import { schedule, stats as queueStats, DEFAULTS } from './schedule.mjs';
import { credsFromEnv, createPost, uploadMedia, whoAmI, COST } from './x-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(ROOT, 'content');
const MEDIA_DIR = process.env.MEDIA_DIR ?? join(ROOT, 'media');
const QUEUE = join(ROOT, 'queue.json');
const STATE = join(ROOT, 'state.json');

loadDotenv();

const [, , cmd = 'help', ...args] = process.argv;
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function loadDotenv() {
  const f = join(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function figuresAvailable() {
  if (!existsSync(MEDIA_DIR)) return null;
  const set = new Set();
  for (const f of readdirSync(MEDIA_DIR)) {
    const m = f.match(/(?:figure[-_]?)?(\d+)\.(png|jpg|jpeg|gif|webp)$/i);
    if (m) set.add(Number(m[1]));
  }
  return set;
}

function figurePath(n) {
  if (!existsSync(MEDIA_DIR)) return null;
  const f = readdirSync(MEDIA_DIR).find((x) => new RegExp(`(?:figure[-_]?)?0*${n}\\.(png|jpg|jpeg|gif|webp)$`, 'i').test(x));
  return f ? join(MEDIA_DIR, f) : null;
}

const readJSON = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const writeJSON = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

function projectCost(queue) {
  let cents = 0;
  for (const q of queue) cents += URL_RE.test(q.body) ? COST.postWithUrl : COST.post;
  return cents;
}

// ---------------------------------------------------------------- commands

function cmdBuild() {
  const posts = loadLibrary(LIBRARY_DIR);
  const queue = schedule(posts, {
    start: opt('start', DEFAULTS.start),
    slots: opt('slots', DEFAULTS.slots.join(',')).split(','),
    daysOfWeek: opt('days', DEFAULTS.daysOfWeek.join(',')).split(',').map(Number),
    timezone: opt('tz', DEFAULTS.timezone),
  });
  writeJSON(QUEUE, queue);
  const s = queueStats(queue);
  console.log(`Built ${s.posts} posts across ${s.postingDays} posting days (${s.weeks} weeks).`);
  console.log(`${s.first} -> ${s.last}`);
  console.log(`Split: ${Object.entries(s.shares).map(([k, v]) => `${k} ${v}`).join('  ')}`);
  console.log(`Queue written to ${QUEUE}`);
}

function cmdValidate() {
  const posts = loadLibrary(LIBRARY_DIR);
  const findings = validate(posts, {
    premium: !flag('no-premium'),
    figuresAvailable: figuresAvailable(),
  });
  const counts = summarize(findings);

  const show = flag('quiet') ? findings.filter((f) => f.level === 'error') : findings;
  for (const f of show) {
    console.log(`${f.level.toUpperCase().padEnd(5)} ${f.id.padEnd(5)} ${f.rule.padEnd(20)} ${f.message}`);
  }
  console.log(`\n${posts.length} posts checked. ${counts.error} errors, ${counts.warn} warnings, ${counts.info} info.`);
  if (counts.error) process.exit(1);
}

function cmdStats() {
  const posts = loadLibrary(LIBRARY_DIR);
  const queue = readJSON(QUEUE, null) ?? schedule(posts);
  const s = queueStats(queue);
  const state = readJSON(STATE, { posted: {} });
  const done = Object.keys(state.posted).length;

  console.log(`Library      ${posts.length} posts`);
  for (const [k, v] of Object.entries(s.byPillar)) {
    console.log(`  ${k} ${PILLARS[k].name.padEnd(20)} ${String(v).padStart(3)}  ${s.shares[k].padStart(4)}  (target ${Math.round(PILLARS[k].share * 100)}%)`);
  }
  console.log(`\nRunway       ${s.postingDays} posting days, ${s.weeks} weeks at 2/day`);
  console.log(`Window       ${s.first} -> ${s.last}`);
  console.log(`Published    ${done} / ${queue.length}`);
  console.log(`Remaining    ${queue.length - done}`);
  console.log(`\nAPI cost     $${projectCost(queue).toFixed(2)} for the whole queue`);
  console.log(`             $${(projectCost(queue) / s.weeks * 4.33).toFixed(2)}/month at this cadence`);
  console.log(`X subscription: $8/mo (Premium) for 25k-char posts + reply prioritization`);
}

function cmdNext() {
  const queue = readJSON(QUEUE, null);
  if (!queue) return console.error('No queue.json — run `build` first.');
  const state = readJSON(STATE, { posted: {} });
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 6);
  const pending = queue.filter((q) => !state.posted[q.id]).slice(0, n);

  for (const q of pending) {
    const text = renderPost(q);
    console.log(`\n${'-'.repeat(66)}`);
    console.log(`${q.id}  ${q.title}`);
    console.log(`${q.scheduledDate} ${q.scheduledTime} ${q.timezone}  [${q.slot}]  ${text.length} chars${q.figure ? `  figure ${q.figure}` : ''}`);
    console.log(`${'-'.repeat(66)}`);
    console.log(text);
  }
  console.log(`\n${pending.length} shown, ${queue.length - Object.keys(state.posted).length} remaining in queue.`);
}

async function cmdPost() {
  const dry = flag('dry-run');
  const queue = readJSON(QUEUE, null);
  if (!queue) return console.error('No queue.json — run `build` first.');

  // Refuse to publish anything the validator rejects.
  const findings = validate(loadLibrary(LIBRARY_DIR), { figuresAvailable: figuresAvailable() });
  const blocked = new Set(findings.filter((f) => f.level === 'error').map((f) => f.id));
  if (blocked.size) {
    console.error(`Validation errors on ${blocked.size} post(s). Fix them or run \`validate\` to see. Refusing to post.`);
    process.exit(1);
  }

  const state = readJSON(STATE, { posted: {}, spend: 0 });
  const now = new Date();
  const due = queue.filter((q) => {
    if (state.posted[q.id]) return false;
    const at = new Date(`${q.scheduledDate}T${q.scheduledTime}:00`);
    return at <= now;
  });

  if (!due.length) return console.log('Nothing due.');
  console.log(`${due.length} post(s) due.${dry ? '  [DRY RUN — nothing will be sent]' : ''}`);

  const creds = dry ? null : credsFromEnv();

  for (const q of due) {
    const text = renderPost(q);
    const cost = URL_RE.test(q.body) ? COST.postWithUrl : COST.post;
    console.log(`\n[${q.id}] ${q.title} — ${text.length} chars, ~$${cost.toFixed(3)}`);

    if (dry) { console.log(text); continue; }

    try {
      const mediaIds = [];
      if (q.figure != null) {
        const p = figurePath(q.figure);
        if (p) mediaIds.push(await uploadMedia(creds, p));
        else console.warn(`  figure ${q.figure} not found in ${MEDIA_DIR} — posting without it`);
      }
      const res = await createPost(creds, { text, mediaIds });
      const id = res?.data?.id;
      state.posted[q.id] = { tweetId: id, at: new Date().toISOString(), cost };
      state.spend = +(state.spend + cost).toFixed(4);
      writeJSON(STATE, state);
      console.log(`  posted: https://x.com/i/status/${id}`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      if (err.status === 429) {
        console.error(`  rate limited${err.resetAt ? `, resets ${new Date(err.resetAt * 1000).toISOString()}` : ''} — stopping this run`);
        break;
      }
    }
  }
  if (!dry) console.log(`\nCumulative API spend: $${(state.spend ?? 0).toFixed(2)}`);
}

async function cmdWhoami() {
  const me = await whoAmI(credsFromEnv());
  console.log(JSON.stringify(me, null, 2));
}

function cmdHelp() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

const commands = { build: cmdBuild, validate: cmdValidate, stats: cmdStats, next: cmdNext, post: cmdPost, whoami: cmdWhoami, help: cmdHelp };
const fn = commands[cmd] ?? cmdHelp;
try {
  await fn();
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
