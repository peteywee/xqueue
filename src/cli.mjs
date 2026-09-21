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
import {
  isDue,
  scheduledAt,
} from './post-time.mjs';
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
import {
  analyzeRuntime,
  isResolved,
} from './runtime-health.mjs';
import {
  deferMissedStaticAssignments,
  isMissedPost,
} from './deferred-lifecycle.mjs';

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

const LIBRARY_DIR = process.env.LIBRARY_DIR ?? join(ROOT, 'content');
const MEDIA_DIR = process.env.MEDIA_DIR ?? join(ROOT, 'media');
const QUEUE = join(ROOT, 'queue.json');
const STATE = join(ROOT, 'state.json');
const POLICY_FILE = join(ROOT, 'config', 'schedule-policy.json');
const PUBLISH_LOCK = join(ROOT, '.xqueue-publish.lock');

loadDotenv();

const [, , cmd = 'help', ...args] = process.argv;

const flag = (name) => args.includes(`--${name}`);

const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function positional() {
  const values = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (['--reason', '--grace-minutes', '--posted'].includes(arg)) i++;
      continue;
    }
    values.push(arg);
  }

  return values;
}

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

function requireQueue() {
  const queue = readJSON(QUEUE, null);
  if (!queue) throw new Error('No queue.json — run `pnpm build` first.');
  return queue;
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
  const posted = Object.keys(state.posted).length;
  const skipped = Object.keys(state.skipped).length;
  const resolved = posted + skipped;

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
  console.log(`Published    ${posted} / ${queue.length}`);
  console.log(`Skipped      ${skipped} / ${queue.length}`);
  console.log(`Remaining    ${queue.length - resolved}`);
  console.log(
    `Inflight     ${state.inflight ? `${state.inflight.postId} (${state.inflight.status})` : 'none'}`,
  );

  const totalCost = projectCost(queue);
  console.log(`\nAPI cost     $${totalCost.toFixed(2)} for the whole queue`);
  console.log(`             $${(totalCost / stats.weeks * 4.33).toFixed(2)}/month at this cadence`);
  console.log('X subscription: Premium required for long-form posts in this library');
}

function cmdNext() {
  const queue = requireQueue();
  const state = readState(STATE);
  const requested = args.find((arg) => /^\d+$/.test(arg));
  const count = Number(requested ?? 6);

  const pending = queue
    .filter((post) => !isResolved(state, post.id))
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

  const resolved = Object.keys(state.posted).length + Object.keys(state.skipped).length;
  console.log(`\n${pending.length} shown, ${queue.length - resolved} unresolved in queue.`);
}

function cmdRuntimeHealth() {
  const queue = requireQueue();
  const state = readState(STATE);
  const graceMinutes = Number(opt('grace-minutes', '20'));
  const report = analyzeRuntime(queue, state, {
    now: new Date(),
    graceMinutes,
  });

  console.log('=== XQUEUE RUNTIME HEALTH ===');
  console.log(`posted:      ${report.postedCount}`);
  console.log(`skipped:     ${report.skippedCount}`);
  console.log(`deferred:    ${report.deferredCount}`);
  console.log(`unresolved:  ${report.unresolvedCount}`);
  console.log(`due now:     ${report.due.length}`);
  console.log(`overdue:     ${report.overdue.length} (> ${report.graceMinutes} minute grace)`);
  console.log(
    `inflight:    ${report.inflight ? `${report.inflight.postId} (${report.inflight.status})` : 'none'}`,
  );

  if (report.next) {
    console.log(
      `next:        ${report.next.id} ${report.next.scheduledDate} ${report.next.scheduledTime} ${report.next.timezone}`,
    );
  } else {
    console.log('next:        none');
  }

  if (report.overdue.length) {
    console.log('\nOverdue unresolved posts:');
    for (const post of report.overdue.slice(0, 20)) {
      const minutes = Math.floor((Date.now() - scheduledAt(post).getTime()) / 60_000);
      console.log(
        `  ${post.id.padEnd(5)} ${post.scheduledDate} ${post.scheduledTime} ${post.timezone}  ${minutes}m overdue`,
      );
    }
    if (report.overdue.length > 20) {
      console.log(`  ... ${report.overdue.length - 20} more`);
    }
  }

  if (report.inflight) {
    console.error('\nXQUEUE RUNTIME HEALTH: FAIL — unresolved publication attempt requires reconciliation.');
    process.exit(1);
  }

  if (report.overdue.length) {
    console.error(
      '\nXQUEUE RUNTIME HEALTH: FAIL — stale backlog requires owner disposition before live scheduler cutover.',
    );
    console.error(
      'Use `pnpm skip -- <post-id> --reason "..."` only for posts you intentionally do not want published.',
    );
    process.exit(1);
  }

  console.log('\nXQUEUE RUNTIME HEALTH: PASS');
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
  const queue = requireQueue();

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
    const graceMinutes = 20;

    if (!dry) {
      const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
      const deferral = deferMissedStaticAssignments(queue, state, {
        now,
        graceMinutes,
        policyVersion: Number(policy.version),
      });

      if (deferral.deferred.length > 0) {
        writeStateAtomic(STATE, state);
        console.log(
          `Deferred ${deferral.deferred.length} missed assignment(s); stale slots cannot authorize catch-up publication.`,
        );
        for (const item of deferral.deferred.slice(0, 20)) {
          console.log(
            `  deferred ${item.postId}: ${item.resolvedAt} -> replacement required`,
          );
        }
      }
    }

    const due = queue.filter(
      (post) =>
        !isResolved(state, post.id) &&
        isDue(post, now) &&
        !isMissedPost(post, { now, graceMinutes }),
    );

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

function cmdSkip() {
  const [postId] = positional();
  const reason = opt('reason');

  if (!postId || !reason?.trim()) {
    throw new Error(
      'Skip requires `pnpm skip -- <post-id> --reason "why this post should never auto-publish"`.',
    );
  }

  const queue = requireQueue();
  const post = queue.find((item) => item.id === postId);
  if (!post) throw new Error(`Unknown queue post ID: ${postId}`);

  const lock = acquirePublishLock(PUBLISH_LOCK);
  try {
    const state = readState(STATE);

    if (state.inflight) {
      throw new Error(
        `Cannot skip while ${state.inflight.postId} is ${state.inflight.status}; reconcile it first.`,
      );
    }
    if (state.posted[postId]) {
      throw new Error(`${postId} is already recorded as posted and cannot be skipped.`);
    }
    if (state.skipped[postId]) {
      console.log(`${postId} is already skipped: ${state.skipped[postId].reason}`);
      return;
    }

    state.skipped[postId] = {
      at: new Date().toISOString(),
      reason: reason.trim(),
      scheduledDate: post.scheduledDate,
      scheduledTime: post.scheduledTime,
      timezone: post.timezone,
    };

    writeStateAtomic(STATE, state);
    console.log(`Skipped ${postId}. It is no longer eligible for automatic publication.`);
    console.log(`Reason: ${reason.trim()}`);
  } finally {
    lock.release();
  }
}

function cmdUnskip() {
  const [postId] = positional();
  if (!postId) throw new Error('Unskip requires `pnpm unskip -- <post-id>`.');

  const lock = acquirePublishLock(PUBLISH_LOCK);
  try {
    const state = readState(STATE);
    if (state.inflight) {
      throw new Error(
        `Cannot unskip while ${state.inflight.postId} is ${state.inflight.status}; reconcile it first.`,
      );
    }
    if (!state.skipped[postId]) {
      throw new Error(`${postId} is not currently skipped.`);
    }

    delete state.skipped[postId];
    writeStateAtomic(STATE, state);
    console.log(`Unskipped ${postId}. It is eligible again according to its schedule.`);
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

  pnpm runtime:health
      Fail if an ambiguous attempt exists or unresolved posts are stale.

  pnpm stats
      Show queue, publishing state, skipped items, runway, and cost projection.

  pnpm next
      Show upcoming unresolved posts.

  pnpm post
      SAFE DEFAULT. Dry-run anything currently due.

  pnpm post:live
      LIVE. Publish at most the oldest due post.

  pnpm skip -- <post-id> --reason "..."
      Owner action: permanently suppress a stale/unwanted queue item from auto-publication.

  pnpm unskip -- <post-id>
      Owner action: restore a skipped queue item to normal eligibility.

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
  Posted, skipped, deferred, and in-flight states are mutually exclusive.
  Missed assignments become deferred; live mode never catch-up publishes them.
  A publication intent is persisted before the X create call begins.
  Ambiguous create-post outcomes block automatic retries until reconciled.
  Posted and owner-skipped queue IDs are never auto-published again.
  Runtime health blocks stale backlog from silent scheduler cutover.
  Backlog protection publishes at most one live post per run.
`.trim());
}

const commands = {
  build: cmdBuild,
  validate: cmdValidate,
  'runtime-health': cmdRuntimeHealth,
  stats: cmdStats,
  next: cmdNext,
  post: cmdPost,
  whoami: cmdWhoami,
  reconcile: cmdReconcile,
  skip: cmdSkip,
  unskip: cmdUnskip,
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
