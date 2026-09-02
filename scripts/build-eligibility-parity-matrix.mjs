#!/usr/bin/env node
// build-eligibility-parity-matrix.mjs
//
// Proves that cloudflare/src/eligibility.mjs reaches the SAME publication
// eligibility decision as the local runtime for the same instant, the same
// canonical queue, and the same publication ledger.
//
// LOCAL side  — composed from the real production modules:
//     src/state-store.mjs   normalizeState   (what readState() applies)
//     src/runtime-health.mjs analyzeRuntime / isResolved
//     src/post-time.mjs     isDue / scheduledAt
//   plus the two framing steps src/cli.mjs cmdPost() performs around them,
//   which are not exported and therefore have to be restated here:
//     (a) validateForPublication()'s `unique-id` error rule, which aborts a
//         live run before state.json is even read, and
//     (b) the selection `due.slice(0, 1)`.
//
// CLOUDFLARE side — cloudflare/src/eligibility.mjs, an independent
//   re-implementation with its own time-zone math and no imports from src/.
//
// Writes docs/evidence/eligibility-parity-matrix.json and exits non-zero if
// any row is FAIL.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';
import { analyzeRuntime, isResolved } from '../src/runtime-health.mjs';
import { isDue } from '../src/post-time.mjs';
import { normalizeState } from '../src/state-store.mjs';

import {
  STRUCTURAL_FAILURES,
  evaluateEligibility,
} from '../cloudflare/src/eligibility.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'config', 'schedule-policy.json');
const CONTENT = join(ROOT, 'content');
const OUT_DIR = join(ROOT, 'docs', 'evidence');
const OUT_FILE = join(OUT_DIR, 'eligibility-parity-matrix.json');

const MAX_PUBLICATIONS = 1;
const TZ = 'America/Chicago';

const INFLIGHT_BLOCK_REASON = {
  prepared: 'inflight_prepared',
  publishing: 'inflight_publishing',
  needs_reconciliation: 'inflight_needs_reconciliation',
};

// ---------------------------------------------------------------------------
// canonical production queue, regenerated in-process (queue.json is gitignored)
// ---------------------------------------------------------------------------

function productionQueue() {
  const policy = JSON.parse(readFileSync(POLICY, 'utf8'));

  return schedule(loadLibrary(CONTENT), {
    start: policy.campaignStart,
    slots: policy.slots,
    daysOfWeek: policy.daysOfWeek,
    timezone: policy.timezone,
    deferToEnd: policy.deferToEnd ?? [],
  });
}

// ---------------------------------------------------------------------------
// LOCAL decision model
// ---------------------------------------------------------------------------

function refusal(code) {
  return {
    refused: true,
    refusalCode: code,
    health: null,
    blocked: true,
    blockReason: code,
    selected: [],
  };
}

function classifyLocalThrow(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (/queue must be an array/i.test(message)) return 'malformed_queue';
  if (/graceMinutes/.test(message)) return 'invalid_grace';
  if (/scheduledDate, scheduledTime and timezone are required/.test(message)) {
    return 'malformed_queue';
  }
  if (error instanceof RangeError || /time zone/i.test(message)) {
    return 'unknown_timezone';
  }

  return `unclassified:${message}`;
}

function localProjection(queue, ledger, { now, graceMinutes }) {
  // Stage 1 — cmdPost --live calls validateForPublication() BEFORE it reads
  // state.json. validate.mjs raises an error-level `unique-id` finding for a
  // repeated id, which aborts the run. Restated here because validate() takes
  // library posts, not queue rows.
  if (Array.isArray(queue)) {
    const seen = new Set();
    for (const post of queue) {
      const id = post?.id;
      if (seen.has(id)) {
        return { ...refusal('duplicate_post_ids'), liveWouldPublish: [] };
      }
      seen.add(id);
    }
  }

  // Stage 2 — readState() -> normalizeState().
  let state;
  try {
    state = normalizeState(ledger);
  } catch {
    return { ...refusal('malformed_ledger'), liveWouldPublish: [] };
  }

  // Stage 3 — analyzeRuntime(), the real local health computation.
  let report;
  try {
    report = analyzeRuntime(queue, state, { now, graceMinutes });
  } catch (error) {
    return {
      ...refusal(classifyLocalThrow(error)),
      liveWouldPublish: [],
    };
  }

  // Stage 4 — cmdPost()'s selection, read-only.
  const due = queue.filter(
    (post) => !isResolved(state, post.id) && isDue(post, now),
  );

  const blockReason = state.inflight
    ? INFLIGHT_BLOCK_REASON[state.inflight.status]
    : null;

  // What the ACTUAL live run would publish: cmdPost recovers an inflight whose
  // status is 'prepared' by mutating state.json and then proceeds.
  const liveWouldPublish = (
    !state.inflight || state.inflight.status === 'prepared'
  )
    ? due.slice(0, MAX_PUBLICATIONS).map((post) => post.id)
    : [];

  return {
    refused: false,
    refusalCode: null,
    health: {
      ok: report.ok,
      postedCount: report.postedCount,
      skippedCount: report.skippedCount,
      unresolvedCount: report.unresolvedCount,
      due: report.due.map((post) => post.id),
      overdue: report.overdue.map((post) => post.id),
      next: report.next ? report.next.id : null,
      inflight: report.inflight ?? null,
      graceMinutes: report.graceMinutes,
    },
    blocked: blockReason !== null,
    blockReason,
    selected: blockReason ? [] : due.slice(0, MAX_PUBLICATIONS).map((p) => p.id),
    liveWouldPublish,
  };
}

// ---------------------------------------------------------------------------
// CLOUDFLARE decision model
// ---------------------------------------------------------------------------

function cloudflareProjection(queue, ledger, { now, graceMinutes }) {
  const result = evaluateEligibility(queue, ledger, {
    now,
    graceMinutes,
    maxPublications: MAX_PUBLICATIONS,
  });

  const refused = result.failures.some(
    (code) => STRUCTURAL_FAILURES.includes(code),
  );

  return {
    refused,
    refusalCode: refused ? result.failures[0] : null,
    health: refused ? null : result.health,
    blocked: result.selection.blocked,
    blockReason: result.selection.blockReason,
    selected: result.selection.selected,
    safeToPublish: result.safeToPublish,
    failures: result.failures,
  };
}

const COMPARED_FIELDS = [
  'refused',
  'refusalCode',
  'health',
  'blocked',
  'blockReason',
  'selected',
];

function comparable(projection) {
  const out = {};
  for (const key of COMPARED_FIELDS) {
    out[key] = projection[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function post(id, scheduledDate, scheduledTime, timezone = TZ) {
  return { id, scheduledDate, scheduledTime, timezone };
}

function ledger({ posted = {}, skipped = {}, inflight = null } = {}) {
  return { version: 1, posted, skipped, spend: 0, inflight };
}

function postedRecord(id, tweetId = `tweet-${id}`) {
  return { [id]: { tweetId, at: '2026-09-01T19:31:00.000Z' } };
}

function postedAllExcept(queue, keepIds) {
  const posted = {};
  for (const entry of queue) {
    if (!keepIds.includes(entry.id)) {
      posted[entry.id] = {
        tweetId: `mirror-${entry.id}`,
        at: '2026-09-01T00:00:00.000Z',
      };
    }
  }
  return posted;
}

// P1: 2026-09-01 14:30 America/Chicago == 2026-09-01T19:30:00.000Z
const P1 = post('P1', '2026-09-01', '14:30');
// P2: 2026-09-02 14:30 America/Chicago == 2026-09-02T19:30:00.000Z
const P2 = post('P2', '2026-09-02', '14:30');

function fixtures(realQueue) {
  const cases = [];

  const add = (row) => cases.push({ graceMinutes: 20, ...row });

  // ---- inclusive-due / strict-overdue boundaries ------------------------
  add({
    id: 'before-due',
    description: 'One unresolved post, one millisecond before its instant: not due.',
    queue: [P1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:29:59.999Z',
  });

  add({
    id: 'exactly-due',
    description: 'now === the post instant. Proves `due` uses <= (INCLUSIVE).',
    queue: [P1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:30:00.000Z',
  });

  add({
    id: 'inside-grace',
    description: 'Ten minutes late with a twenty minute grace: due, not overdue, healthy.',
    queue: [P1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'exactly-at-grace-boundary',
    description:
      'now - grace === the post instant. Proves `overdue` uses < (STRICT): still healthy.',
    queue: [P1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:50:00.000Z',
  });

  add({
    id: 'stale-beyond-grace',
    description:
      'One millisecond past the grace cutoff: overdue, health.ok false. Selection is NOT blocked — cmdPost publishes through a stale backlog.',
    queue: [P1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:50:00.001Z',
  });

  // ---- ledger resolution -------------------------------------------------
  add({
    id: 'already-posted',
    description: 'Ledger records the post as published: resolved, nothing due.',
    queue: [P1],
    ledgerSetup: 'posted: P1',
    ledger: ledger({ posted: postedRecord('P1') }),
    nowIso: '2026-09-01T20:30:00.000Z',
  });

  add({
    id: 'owner-skipped',
    description: 'Owner-skipped post is resolved and never becomes a backlog.',
    queue: [P1],
    ledgerSetup: 'skipped: P1',
    ledger: ledger({
      skipped: {
        P1: { at: '2026-09-01T19:45:00.000Z', reason: 'missed cutover window' },
      },
    }),
    nowIso: '2026-09-01T20:30:00.000Z',
  });

  add({
    id: 'empty-queue',
    description: 'Empty queue with an empty ledger: healthy, nothing due, no next.',
    queue: [],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T20:30:00.000Z',
  });

  // ---- inflight ----------------------------------------------------------
  add({
    id: 'inflight-prepared',
    description:
      'inflight prepared with a due post. Local live mode recovers by MUTATING state.json; the read-only projection cannot, and blocks.',
    queue: [P1],
    ledgerSetup: 'inflight: P1 prepared',
    ledger: ledger({ inflight: { postId: 'P1', status: 'prepared' } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'inflight-publishing',
    description: 'inflight publishing: local live mode throws, nothing may be selected.',
    queue: [P1],
    ledgerSetup: 'inflight: P1 publishing',
    ledger: ledger({ inflight: { postId: 'P1', status: 'publishing' } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'inflight-needs-reconciliation',
    description: 'inflight needs_reconciliation while nothing is due: blocked and unhealthy.',
    queue: [P1],
    ledgerSetup: 'inflight: P1 needs_reconciliation',
    ledger: ledger({ inflight: { postId: 'P1', status: 'needs_reconciliation' } }),
    nowIso: '2026-09-01T19:00:00.000Z',
  });

  add({
    id: 'needs-reconciliation-with-due-post',
    description:
      'P1 is due but a different post is stuck needing reconciliation: due is non-empty, selection is empty.',
    queue: [P1, P2],
    ledgerSetup: 'inflight: P2 needs_reconciliation',
    ledger: ledger({ inflight: { postId: 'P2', status: 'needs_reconciliation' } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  // ---- real 180-post production queue, deferred tail ---------------------
  add({
    id: 'deferred-tail-B1',
    description:
      'Real 180-post production queue, everything but the deferred tail published. B1 2027-01-04 14:30 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: all 177 posts before the deferred tail',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['B1', 'A30', 'C1']) }),
    nowIso: '2027-01-04T20:30:00.000Z',
  });

  add({
    id: 'deferred-tail-A30',
    description:
      'Real production queue with B1 published. A30 2027-01-04 22:15 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: all 178 posts through B1',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['A30', 'C1']) }),
    nowIso: '2027-01-05T04:15:00.000Z',
  });

  add({
    id: 'deferred-tail-C1',
    description:
      'Real production queue with only C1 outstanding. C1 2027-01-05 14:30 America/Chicago is exactly due and is the final post.',
    queue: realQueue,
    ledgerSetup: 'posted: all 179 posts through A30',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['C1']) }),
    nowIso: '2027-01-05T20:30:00.000Z',
  });

  // ---- DST ---------------------------------------------------------------
  const S1 = post('S1', '2027-03-14', '01:30'); // 07:30Z, CST
  const S2 = post('S2', '2027-03-14', '03:30'); // 08:30Z, CDT

  add({
    id: 'dst-spring-forward',
    description:
      'America/Chicago 2027-03-14 spring forward: 01:30 CST resolves to 07:30Z, 03:30 CDT resolves to 08:30Z (one hour apart in wall clock, one hour apart in UTC across the transition).',
    queue: [S1, S2],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-03-14T08:30:00.000Z',
    graceMinutes: 120,
  });

  const G1 = post('G1', '2027-03-14', '02:30'); // nonexistent wall clock

  add({
    id: 'dst-spring-forward-gap-before',
    description:
      'Nonexistent wall clock 2027-03-14 02:30 (the spring-forward gap). Both implementations resolve it to 2027-03-14T07:30:00.000Z; one millisecond earlier it is not yet due.',
    queue: [G1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-03-14T07:29:59.999Z',
  });

  add({
    id: 'dst-spring-forward-gap-due',
    description:
      'The same nonexistent wall clock is due at exactly 2027-03-14T07:30:00.000Z.',
    queue: [G1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-03-14T07:30:00.000Z',
  });

  const F1 = post('F1', '2027-11-07', '01:30'); // ambiguous, first (CDT) occurrence
  const F2 = post('F2', '2027-11-07', '02:30'); // 08:30Z, CST

  add({
    id: 'dst-fall-back',
    description:
      'America/Chicago 2027-11-07 fall back: 01:30 resolves to 06:30Z (CDT) and 02:30 resolves to 08:30Z (CST) — two hours of UTC across one hour of wall clock.',
    queue: [F1, F2],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-11-07T06:30:00.000Z',
    graceMinutes: 120,
  });

  add({
    id: 'dst-fall-back-ambiguous-before',
    description:
      'Ambiguous wall clock 2027-11-07 01:30 occurs twice. Both implementations pick the FIRST (CDT, 06:30Z) occurrence, so at 06:29:59.999Z it is not due.',
    queue: [F1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-11-07T06:29:59.999Z',
  });

  add({
    id: 'dst-fall-back-ambiguous-first-occurrence',
    description:
      'The ambiguous wall clock is due at 06:30:00.000Z (first occurrence). Had either side resolved it to the repeated CST hour it would not be due here.',
    queue: [F1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-11-07T06:30:00.000Z',
  });

  // ---- ordering ----------------------------------------------------------
  add({
    id: 'queue-order-differs-from-chronological-order',
    description:
      'Queue array order [later, earlier]. due preserves ARRAY order, so selection takes the later post first — it is not sorted by instant.',
    queue: [post('Z1', '2026-09-01', '22:15'), post('Y1', '2026-09-01', '14:30')],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-02T03:15:00.000Z',
    graceMinutes: 720,
  });

  add({
    id: 'multiple-due-posts',
    description:
      'Three due posts, maxPublications 1: at most one is selected, the first in array order.',
    queue: [P1, post('M2', '2026-09-01', '22:15'), P2],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-02T20:00:00.000Z',
    graceMinutes: 4320,
  });

  add({
    id: 'next-tie-keeps-array-order',
    description:
      'Two unresolved future posts share an instant: `next` keeps queue array order (stable sort).',
    queue: [post('T2', '2026-09-02', '14:30'), post('T1', '2026-09-02', '14:30')],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:30:00.000Z',
  });

  // ---- fail-closed inputs -------------------------------------------------
  add({
    id: 'malformed-queue-not-an-array',
    description: 'Queue is an object, not an array.',
    queue: { P1 },
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-queue-missing-scheduled-time',
    description: 'A queue entry has no scheduledTime, so no instant can be resolved.',
    queue: [{ id: 'P1', scheduledDate: '2026-09-01', timezone: TZ }],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'duplicate-post-ids',
    description:
      'The same id appears twice. Ledger resolution by id is ambiguous; cmdPost --live aborts on the unique-id validation error before reading state.',
    queue: [P1, post('P1', '2026-09-02', '14:30')],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-posted-and-skipped',
    description: 'One post id recorded as both posted and skipped.',
    queue: [P1],
    ledgerSetup: 'posted: P1 AND skipped: P1',
    ledger: {
      version: 1,
      posted: { P1: { tweetId: '1', at: '2026-09-01T19:31:00.000Z' } },
      skipped: { P1: { at: '2026-09-01T19:32:00.000Z', reason: 'bad state' } },
      spend: 0,
      inflight: null,
    },
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-invalid-inflight-status',
    description: 'inflight.status is not one of prepared/publishing/needs_reconciliation.',
    queue: [P1],
    ledgerSetup: 'inflight: P1 with status "wedged"',
    ledger: ledger({ inflight: { postId: 'P1', status: 'wedged' } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-inflight-also-posted',
    description: 'inflight.postId is also recorded as posted.',
    queue: [P1],
    ledgerSetup: 'posted: P1 AND inflight: P1 publishing',
    ledger: ledger({
      posted: postedRecord('P1'),
      inflight: { postId: 'P1', status: 'publishing' },
    }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'unknown-timezone',
    description: 'A queue entry names a time zone this runtime cannot resolve.',
    queue: [post('P1', '2026-09-01', '14:30', 'Mars/Phobos')],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'negative-grace-minutes',
    description: 'graceMinutes is negative.',
    queue: [P1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
    graceMinutes: -1,
  });

  return cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

export function buildMatrix() {
  const realQueue = productionQueue();

  const queueBytes = `${JSON.stringify(realQueue, null, 2)}\n`;
  const queueSha = createHash('sha256').update(queueBytes, 'utf8').digest('hex');

  const rows = fixtures(realQueue).map((fixture) => {
    const now = new Date(fixture.nowIso);
    const options = { now, graceMinutes: fixture.graceMinutes };

    const local = localProjection(fixture.queue, fixture.ledger, options);
    const cloudflare = cloudflareProjection(fixture.queue, fixture.ledger, options);

    const divergences = [];

    const equal = isDeepStrictEqual(comparable(local), comparable(cloudflare));
    if (!equal) {
      divergences.push(
        'FAIL: compared projections differ between local and Cloudflare.',
      );
    }

    // Safety direction: the Cloudflare gate may only ever WITHHOLD.
    let safe = true;
    if (
      cloudflare.safeToPublish &&
      !isDeepStrictEqual(cloudflare.selected, local.liveWouldPublish)
    ) {
      safe = false;
      divergences.push(
        'FAIL: Cloudflare reports safeToPublish for a selection the local live run would not make.',
      );
    }

    if (!isDeepStrictEqual(local.selected, local.liveWouldPublish)) {
      divergences.push(
        `Documented: read-only projection selects ${JSON.stringify(local.selected)} while a local LIVE run would publish ${JSON.stringify(local.liveWouldPublish)} (cmdPost recovers a 'prepared' inflight by mutating state.json; a read-only evaluator must not assume that happened).`,
      );
    }

    if (!cloudflare.safeToPublish && local.liveWouldPublish.length > 0) {
      divergences.push(
        `Documented: Cloudflare withholds (safeToPublish false, failures ${JSON.stringify(cloudflare.failures)}) where a local live run would publish ${JSON.stringify(local.liveWouldPublish)}. Withholding only; never permitting.`,
      );
    }

    return {
      id: fixture.id,
      description: fixture.description,
      nowIso: fixture.nowIso,
      timezone: TZ,
      graceMinutes: fixture.graceMinutes,
      ledgerSetup: fixture.ledgerSetup,
      local,
      cloudflare,
      divergences,
      verdict: equal && safe ? 'PASS' : 'FAIL',
    };
  });

  const pass = rows.filter((row) => row.verdict === 'PASS').length;

  return {
    subject:
      'Parity between the local xqueue eligibility decision and cloudflare/src/eligibility.mjs',
    localComposition: [
      'src/state-store.mjs normalizeState',
      'src/runtime-health.mjs analyzeRuntime + isResolved',
      'src/post-time.mjs isDue + scheduledAt',
      "src/cli.mjs cmdPost framing: validateForPublication unique-id gate, then due.slice(0, 1)",
    ],
    cloudflareModule: 'cloudflare/src/eligibility.mjs',
    comparedFields: COMPARED_FIELDS,
    maxPublications: MAX_PUBLICATIONS,
    productionQueue: { count: realQueue.length, sha256: queueSha },
    documentedDivergences: [
      "Read-only fail-closed on a 'prepared' inflight: local live mode clears it by writing state.json and proceeds; the Cloudflare evaluator cannot write, so it blocks with reason inflight_prepared.",
      'safeToPublish is a Cloudflare-only extra gate (it ANDs health.ok on top of the local decision). It can only withhold, never permit; selection.selected still mirrors the local decision exactly.',
      'A missing ledger (null/undefined) is malformed_ledger rather than an implied empty ledger: not knowing what was already published is exactly when we must fail closed.',
      'invalid_now and invalid_max_publications are Cloudflare-only guards on inputs the local runtime hard-codes; both can only withhold. They are unit-tested rather than matrixed, because the local runtime has no corresponding refusal to compare against.',
    ],
    summary: { total: rows.length, pass, fail: rows.length - pass },
    cases: rows,
  };
}

function main() {
  const matrix = buildMatrix();

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');

  for (const row of matrix.cases) {
    if (row.verdict !== 'PASS') {
      console.error(`FAIL ${row.id}`);
      console.error(`  local:      ${JSON.stringify(comparable(row.local))}`);
      console.error(`  cloudflare: ${JSON.stringify(comparable(row.cloudflare))}`);
      for (const note of row.divergences) console.error(`  ${note}`);
    }
  }

  console.log(
    `Eligibility parity matrix: ${matrix.summary.pass}/${matrix.summary.total} PASS ` +
      `(queue ${matrix.productionQueue.count} posts, sha256 ${matrix.productionQueue.sha256}).`,
  );
  console.log(`Wrote ${OUT_FILE}`);

  if (matrix.summary.fail > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
