#!/usr/bin/env node
// cli.mjs — operator surface for building, validating, inspecting, and
// publishing the X queue. Markdown content is the source of truth; queue.json
// is a generated local artifact. state.json is the durable publication ledger.

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadLibrary,
  PILLARS,
  renderPost,
} from './parse.mjs';
import {
  summarize,
  URL_RE,
  validate,
} from './validate.mjs';
import {
  DEFAULTS,
  schedule,
  stats as queueStats,
} from './schedule.mjs';
import { COST } from './cost-model.mjs';
import {
  credsFromEnv,
  createPost,
  uploadMedia,
  whoAmI,
} from './xdk-client.mjs';
import { isDue } from './post-time.mjs';
import {
  readState,
  writeStateAtomic,
} from './state-store.mjs';
import { acquirePublishLock } from './publish-lock.mjs';
import {
  beginPublication,
  clearPreparedPublication,
  finishPublication,
  markNeedsReconciliation,
  markPublishing,
  reconcileAsNotPosted,
  reconcileAsPosted,
} from './publication-state.mjs';

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(ROOT, 'content');
const MEDIA_DIR = process.env.MEDIA_DIR ?? join(ROOT, 'media');
const QUEUE = join(ROOT, 'queue.json');
const STATE = join(ROOT, 'state.json');
const PUBLISH_LOCK = join(ROOT, '.xqueue-publish.lock');

loadDotenv();

const [, , cmd = 'help', ...args] = process.argv;

const flag = (name) => args.includes(`--${name}`);

const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function loadDotenv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, name, rawValue] = match;
    if (process.env[name]) continue;

    process.env[name] = rawValue.replace(/^["']|["']$/g, '');
  }
}

function figuresAvailable() {
  if (!existsSync(MEDIA_DIR)) return null;

  const set = new Set();
  for (const file of readdirSync(MEDIA_DIR)) {
    const match = file.match(/(?:figure[-_]?)?(\d+)\.(png|jpg|jpeg|gif|webp)$/i);
    if (match) set.add(Number(match[1]));
  }
  return set;
}

function figurePath(number) {
  if (!existsSync(MEDIA_DIR)) return null;

  const pattern = new RegExp(
    `(?:figure[-_]?)?0*${number}\\.(png|jpg|jpeg|gif|webp)$`,
    'i',
  );

  const file = readdirSync(MEDIA_DIR).find((name) => pattern.test(name));
  return file ? join(MEDIA_DIR, file) : null;
}

const readJSON = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;

const writeJSON = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

function projectCost(queue) {
  let cost = 0;
  for (const post of queue) {
    cost += URL_RE.test(post.body) ? COST.postWithUrl : COST.post;
  }
  return cost;
}

function publicationCost(post) {
  return URL_RE.test(post.body) ? COST.postWithUrl : COST.post;
}

function getErrorStatus(error) {
  const raw =
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.response?.statusCode;

  const status = Number(raw);
  return Number.isInteger(status) ? status : null;
}

function isDefinitePostRejection(error) {
  const status = getErrorStatus(error);
  return [400, 401, 403, 404, 409, 413, 422, 429].includes(status);
}

function cmdBuild() {
  const posts = loadLibrary(LIBRARY_DIR);

  const queue = schedule(posts, {
    start: opt('start', DEFAULTS.start),
    slots: opt('slots', DEFAULTS.slots.join(',')).split(','),
    daysOfWeek: opt('days', DEFAULTS.daysOfWeek.join(','))
      .split(',')
      .map(Number),
    timezone: opt('tz', DEFAULTS.timezone),
  });

  writeJSON(QUEUE, queue);

  const stats = queueStats(queue);
  console.log(
    `Built ${stats.posts} posts across ${stats.postingDays} posting days (${stats.weeks} weeks).`,
  );
  console.log(`${stats.first} -> ${stats.last}`);
  console.log(
    'Split: ' +
      Object.entries(stats.shares)
        .map(([key, value]) => `${key} ${value}`)
        .join('  '),
  );
  console.log(`Queue written to ${QUEUE}`);
}

function cmdValidate() {
  const production = flag('production');
  const posts = loadLibrary(LIBRARY_DIR);

  const findings = validate(posts, {
    premium: !flag('no-premium'),
    figuresAvailable: figuresAvailable(),
    requireFigures: production,
  });

  const counts = summarize(findings);
  const shown = flag('quiet')
    ? findings.filter((finding) => finding.level === 'error')
    : findings;

  for (const finding of shown) {
    console.log(
      `${finding.level.toUpperCase().padEnd(5)} ` +
        `${finding.id.padEnd(5)} ` +
        `${finding.rule.padEnd(24)} ` +
        finding.message,
    );
  }

  console.log(
    `\n${posts.length} posts checked. ${counts.error} errors, ${counts.warn} warnings, ${counts.info} info.` +
      (production ? ' [PRODUCTION MEDIA REQUIRED]' : ''),
  );

  if (counts.error) process.exit(1);
}

function cmdStats() {
  const posts = loadLibrary(LIBRARY_DIR);
  const queue = readJSON(QUEUE, null) ?? schedule(posts);
  const stats = queueStats(queue);
  const state = readState(STATE);
  const done = Object.keys(state.posted).length;

  console.log(`Library      ${posts.length} posts`);

  for (const [pillar, count] of Object.entries(stats.byPillar)) {
    console.log(
      `  ${pillar} ${PILLARS[pillar].name.padEnd(20)} ` +
        `${String(count).padStart(3)}  ${stats.shares[pillar].padStart(4)}  ` +
        `(target ${Math.round(PILLARS[pillar].share * 100)}%)`,
    );
  }

  console.log(`\nRunway       ${stats.postingDays} posting days, ${stats.weeks} weeks at 2/day`);
  console.log(`Window       ${stats.first} -> ${stats.last}`);
  console.log(`Published    ${done} / ${queue.length}`);
  console.log(`Remaining    ${queue.length - done}`);
  console.log(
    `Inflight     ${state.inflight ? `${state.inflight.postId} (${state.inflight.status})` : 'none'}`,
  );

  const totalCost = projectCost(queue);
  console.log(`\nAPI cost     $${totalCost.toFixed(2)} for the whole queue`);
  console.log(`             $${(totalCost / stats.weeks * 4.33).toFixed(2)}/month at this cadence`);
  console.log('X subscription: Premium required for long-form posts in this library');
}

function cmdNext() {
  const queue = readJSON(QUEUE, null);
  if (!queue) throw new Error('No queue.json — run `pnpm build` first.');

  const state = readState(STATE);
  const requested = args.find((arg) => /^\d+$/.test(arg));
  const count = Number(requested ?? 6);

  const pending = queue
    .filter((post) => !state.posted[post.id])
    .slice(0, count);

  for (const post of pending) {
    const text = renderPost(post);
    console.log(`\n${'-'.repeat(66)}`);
    console.log(`${post.id}  ${post.title}`);
    console.log(
      `${post.scheduledDate} ${post.scheduledTime} ${post.timezone}  ` +
        `[${post.slot}]  ${text.length} chars` +
        (post.figure ? `  figure ${post.figure}` : ''),
    );
    console.log(`${'-'.repeat(66)}`);
    console.log(text);
  }

  console.log(
    `\n${pending.length} shown, ${queue.length - Object.keys(state.posted).length} remaining in queue.`,
  );
}

function validateForPublication() {
  const findings = validate(loadLibrary(LIBRARY_DIR), {
    figuresAvailable: figuresAvailable(),
    requireFigures: true,
  });

  const errors = findings.filter((finding) => finding.level === 'error');
  if (errors.length) {
    const summary = errors
      .slice(0, 12)
      .map((finding) => `${finding.id}:${finding.rule}`)
      .join(', ');
    throw new Error(
      `Production validation failed with ${errors.length} error(s): ${summary}. Run \`pnpm validate:production\`.`,
    );
  }
}

async function cmdPost() {
  const requestedLive = flag('live');
  const requestedDry = flag('dry-run');

  if (requestedLive && requestedDry) {
    throw new Error('Choose either --live or --dry-run, not both.');
  }

  const dry = !requestedLive;
  const queue = readJSON(QUEUE, null);
  if (!queue) throw new Error('No queue.json — run `pnpm build` first.');

  if (!dry) {
    validateForPublication();
  } else {
    const findings = validate(loadLibrary(LIBRARY_DIR), {
      figuresAvailable: figuresAvailable(),
    });
    const blocked = findings.filter((finding) => finding.level === 'error');
    if (blocked.length) {
      throw new Error(`Validation errors on ${blocked.length} finding(s); refusing dry-run.`);
    }
  }

  let lock = null;

  try {
    if (!dry) {
      lock = acquirePublishLock(PUBLISH_LOCK);
    }

    const state = readState(STATE);

    if (!dry && state.inflight?.status === 'prepared') {
      console.error(
        `Recovering abandoned pre-publication attempt for ${state.inflight.postId}; no create-post call had been marked as started.`,
      );
      clearPreparedPublication(state);
      writeStateAtomic(STATE, state);
    } else if (!dry && state.inflight) {
      throw new Error(
        `Publication ${state.inflight.postId} is ${state.inflight.status}. ` +
          'Refusing another live post until it is reconciled.',
      );
    }

    const now = new Date();
    const due = queue.filter((post) => !state.posted[post.id] && isDue(post, now));

    if (!due.length) {
      console.log('Nothing due.');
      return;
    }

    console.log(
      `${due.length} post(s) due.` +
        (dry ? '  [DRY RUN — nothing will be sent]' : '  [LIVE — PUBLICATION ENABLED]'),
    );

    const creds = dry ? null : credsFromEnv();
    const publishable = dry ? due : due.slice(0, 1);

    if (!dry && due.length > 1) {
      console.log(
        `Backlog protection: ${due.length} posts are due; live mode will publish only the oldest one this run.`,
      );
    }

    for (const post of publishable) {
      const text = renderPost(post);
      const cost = publicationCost(post);

      console.log(
        `\n[${post.id}] ${post.title} — ${text.length} chars, ~$${cost.toFixed(3)}`,
      );

      let mediaPath = null;
      if (post.figure != null) {
        mediaPath = figurePath(post.figure);
        if (!mediaPath) {
          throw new Error(
            `Required figure ${post.figure} for ${post.id} is missing from ${MEDIA_DIR}; refusing to publish.`,
          );
        }
        console.log(`  media: ${mediaPath}`);
      }

      if (dry) {
        console.log(text);
        console.log('  DRY RUN: validated; not sent.');
        continue;
      }

      beginPublication(state, post, text, cost);
      writeStateAtomic(STATE, state);

      const mediaIds = [];
      try {
        if (mediaPath) {
          mediaIds.push(await uploadMedia(creds, mediaPath));
        }
      } catch (error) {
        clearPreparedPublication(state);
        writeStateAtomic(STATE, state);
        throw error;
      }

      markPublishing(state);
      writeStateAtomic(STATE, state);

      let response;
      try {
        response = await createPost(creds, { text, mediaIds });
      } catch (error) {
        if (isDefinitePostRejection(error)) {
          state.inflight = null;
          writeStateAtomic(STATE, state);
          throw error;
        }

        markNeedsReconciliation(state, error);
        writeStateAtomic(STATE, state);
        throw new Error(
          `Ambiguous X create-post outcome for ${post.id}; automatic retry is blocked. ` +
            'Verify the X account, then run `pnpm reconcile -- --posted <tweet-id>` or `pnpm reconcile -- --not-posted`.',
          { cause: error },
        );
      }

      const id = response?.data?.id;
      if (!id) {
        markNeedsReconciliation(
          state,
          new Error('X returned a create response without a post ID'),
        );
        writeStateAtomic(STATE, state);
        throw new Error(
          `X create response for ${post.id} had no post ID; automatic retry is blocked pending reconciliation.`,
        );
      }

      finishPublication(state, String(id));
      writeStateAtomic(STATE, state);
      console.log(`  posted: https://x.com/i/status/${id}`);
    }

    if (!dry) {
      console.log(`\nCumulative API spend: $${(state.spend ?? 0).toFixed(2)}`);
    }
  } finally {
    lock?.release();
  }
}

async function cmdWhoami() {
  const me = await whoAmI(credsFromEnv());
  console.log(JSON.stringify(me, null, 2));
}

function cmdReconcile() {
  const postedId = opt('posted');
  const notPosted = flag('not-posted');

  if ((!postedId && !notPosted) || (postedId && notPosted)) {
    throw new Error(
      'Reconciliation requires exactly one of `--posted <tweet-id>` or `--not-posted`.',
    );
  }

  const lock = acquirePublishLock(PUBLISH_LOCK);
  try {
    const state = readState(STATE);
    if (!state.inflight) {
      throw new Error('No publication requires reconciliation.');
    }

    const postId = state.inflight.postId;

    if (postedId) {
      reconcileAsPosted(state, postedId);
      writeStateAtomic(STATE, state);
      console.log(`Reconciled ${postId} as posted: https://x.com/i/status/${postedId}`);
      return;
    }

    reconcileAsNotPosted(state);
    writeStateAtomic(STATE, state);
    console.log(
      `Reconciled ${postId} as NOT posted. It may become eligible on the next live run.`,
    );
  } finally {
    lock.release();
  }
}

function cmdHelp() {
  console.log(`
xqueue

Commands:

  pnpm build
      Rebuild generated queue.json from Markdown + schedule policy inputs.

  pnpm validate
      Validate content rules. Missing local media is informational.

  pnpm validate:production
      Production gate. Every referenced figure must exist locally.

  pnpm stats
      Show queue, publishing state, runway, and cost projection.

  pnpm next
      Show upcoming unpublished posts.

  pnpm post
      SAFE DEFAULT. Dry-run anything currently due.

  pnpm post:live
      LIVE. Publish at most the oldest due post.

  pnpm reconcile -- --posted <tweet-id>
      Owner action after an ambiguous create-post outcome when X DID post it.

  pnpm reconcile -- --not-posted
      Owner action after verifying an ambiguous create-post outcome DID NOT post.

  node src/cli.mjs whoami
      Verify the authenticated X account.

Safety invariants:

  Live posting requires --live.
  Production media validation blocks missing figures.
  A filesystem lock blocks concurrent live publishers.
  state.json is written atomically.
  A publication intent is persisted before the X create call begins.
  Ambiguous create-post outcomes block automatic retries until reconciled.
  Already-posted queue IDs are skipped.
  Backlog protection publishes at most one live post per run.
`.trim());
}

const commands = {
  build: cmdBuild,
  validate: cmdValidate,
  stats: cmdStats,
  next: cmdNext,
  post: cmdPost,
  whoami: cmdWhoami,
  reconcile: cmdReconcile,
  help: cmdHelp,
};

const fn = commands[cmd] ?? cmdHelp;

try {
  await fn();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${message}`);
  process.exitCode = 1;
}
