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
  if (
    /nonexistent local wall-clock time/i.test(message) ||
    /ambiguous local wall-clock time/i.test(message) ||
    /scheduledDate\/scheduledTime must be strict/i.test(message) ||
    /not a real calendar wall clock/i.test(message) ||
    /scheduledAt must be canonical/i.test(message)
  ) {
    return 'invalid_scheduled_assignment';
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
      ...(report.deferredCount === undefined ? {} : { deferredCount: report.deferredCount }),
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
      'Real 180-post production queue with 173 posts resolved before B1. B1 2027-01-04 14:30 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 173 posts before B1',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['B1', 'A30', 'C1', 'B30', 'D1', 'B14', 'A59']) }),
    nowIso: '2027-01-04T20:30:00.000Z',
  });

  add({
    id: 'deferred-tail-A30',
    description:
      'Real 180-post production queue with 174 posts resolved before A30. A30 2027-01-04 22:15 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 174 posts before A30',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['A30', 'C1', 'B30', 'D1', 'B14', 'A59']) }),
    nowIso: '2027-01-05T04:15:00.000Z',
  });

  add({
    id: 'deferred-tail-C1',
    description:
      'Real 180-post production queue with 175 posts resolved before C1. C1 2027-01-05 14:30 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 175 posts before C1',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['C1', 'B30', 'D1', 'B14', 'A59']) }),
    nowIso: '2027-01-05T20:30:00.000Z',
  });

  add({
    id: 'deferred-tail-B30',
    description:
      'Real 180-post production queue with 176 posts resolved before B30. B30 2027-01-05 22:15 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 176 posts before B30',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['B30', 'D1', 'B14', 'A59']) }),
    nowIso: '2027-01-06T04:15:00.000Z',
  });

  add({
    id: 'deferred-tail-D1',
    description:
      'Real 180-post production queue with 177 posts resolved before D1. D1 2027-01-06 14:30 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 177 posts before D1',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['D1', 'B14', 'A59']) }),
    nowIso: '2027-01-06T20:30:00.000Z',
  });

  add({
    id: 'deferred-tail-B14',
    description:
      'Real 180-post production queue with 178 posts resolved before B14. B14 2027-01-06 22:15 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 178 posts before B14',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['B14', 'A59']) }),
    nowIso: '2027-01-07T04:15:00.000Z',
  });

  add({
    id: 'deferred-tail-A59',
    description:
      'Real 180-post production queue with 179 posts resolved before A59. A59 2027-01-07 14:30 America/Chicago is exactly due.',
    queue: realQueue,
    ledgerSetup: 'posted: 179 posts before A59',
    ledger: ledger({ posted: postedAllExcept(realQueue, ['A59']) }),
    nowIso: '2027-01-07T20:30:00.000Z',
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
      'Nonexistent wall clock 2027-03-14 02:30 (the spring-forward gap). Both implementations refuse the assignment instead of normalizing it.',
    queue: [G1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-03-14T07:29:59.999Z',
  });

  add({
    id: 'dst-spring-forward-gap-due',
    description:
      'The same nonexistent wall clock remains invalid regardless of evaluation time.',
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
      'America/Chicago 2027-11-07 fall back: an undisambiguated 01:30 assignment is ambiguous and both implementations refuse the queue.',
    queue: [F1, F2],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-11-07T06:30:00.000Z',
    graceMinutes: 120,
  });

  add({
    id: 'dst-fall-back-ambiguous-before',
    description:
      'Ambiguous wall clock 2027-11-07 01:30 occurs twice. Both implementations refuse it without an explicit offset.',
    queue: [F1],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2027-11-07T06:29:59.999Z',
  });

  add({
    id: 'dst-fall-back-ambiguous-first-occurrence',
    description:
      'The ambiguous wall clock remains invalid at the first occurrence because no explicit offset was committed.',
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
    id: 'malformed-ledger-missing',
    description:
      'No ledger at all. Not knowing what has already been published is exactly when both sides must fail closed; a missing ledger is NOT an implied empty ledger.',
    queue: [P1],
    ledgerSetup: 'ledger is null',
    ledger: null,
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-posted-record-without-tweet-id',
    description:
      'A posted record carries no tweetId, so the ledger cannot prove the post was actually published.',
    queue: [P1],
    ledgerSetup: 'posted: P1 with no tweetId',
    ledger: ledger({ posted: { P1: { at: '2026-09-01T19:31:00.000Z' } } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-skipped-record-without-reason',
    description: 'A skipped record carries no reason, so the owner skip is unattributable.',
    queue: [P1],
    ledgerSetup: 'skipped: P1 with no reason',
    ledger: ledger({ skipped: { P1: { at: '2026-09-01T19:32:00.000Z' } } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-negative-spend',
    description: 'spend is negative, so the ledger is not a trustworthy record of the campaign.',
    queue: [P1],
    ledgerSetup: 'spend: -0.01',
    ledger: { version: 1, posted: {}, skipped: {}, spend: -0.01, inflight: null },
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-skipped-key-shadows-object-prototype',
    description:
      "ADVERSARIAL REGRESSION: skipped is keyed 'constructor'. normalizeState decides 'already posted?' with the truthiness test `if (posted[postId])`, which is true for every inherited Object.prototype member, so the LOCAL runtime throws and refuses to publish at all. A hasOwnProperty-based membership test would accept this ledger and select P1 — local refuses, Cloudflare accepts, the one dangerous divergence direction.",
    queue: [P1],
    ledgerSetup: "skipped: { constructor: ... } with an empty posted map",
    ledger: ledger({
      skipped: {
        constructor: { at: '2026-09-01T19:32:00.000Z', reason: 'operator skip' },
      },
    }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'malformed-ledger-inflight-postid-shadows-object-prototype',
    description:
      "Same truthiness rule on the inflight guard: normalizeState rejects inflight.postId 'toString' via `posted[inflight.postId] || skipped[inflight.postId]`. The refusal must be the LEDGER refusal both sides, not the softer inflight block.",
    queue: [P1],
    ledgerSetup: "inflight: { postId: 'toString', status: 'publishing' }",
    ledger: ledger({ inflight: { postId: 'toString', status: 'publishing' } }),
    nowIso: '2026-09-01T19:40:00.000Z',
  });

  add({
    id: 'failure-precedence-ledger-before-grace',
    description:
      'Two refusable inputs at once: a malformed ledger AND a negative graceMinutes. cmdPost reads state.json before it calls analyzeRuntime, so the reported refusal must be malformed_ledger, not invalid_grace. Pins the failure PRECEDENCE, not just the failure set.',
    queue: [P1],
    ledgerSetup: 'posted: P1 with no tweetId',
    ledger: ledger({ posted: { P1: { at: '2026-09-01T19:31:00.000Z' } } }),
    nowIso: '2026-09-01T19:40:00.000Z',
    graceMinutes: -1,
  });

  add({
    id: 'failure-precedence-grace-before-timezone',
    description:
      'A negative graceMinutes AND an unresolvable time zone. analyzeRuntime validates graceMinutes before it resolves any instant, so the reported refusal must be invalid_grace, not unknown_timezone.',
    queue: [post('P1', '2026-09-01', '14:30', 'Mars/Phobos')],
    ledgerSetup: 'empty ledger',
    ledger: ledger(),
    nowIso: '2026-09-01T19:40:00.000Z',
    graceMinutes: -1,
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

  // #52 adds only the committed scheduledAt field to the static queue shape.
  // Strip that field and the exact legacy canonical bytes must still hash to
  // the pre-#52 production queue SHA, proving no ID/content/local slot drift.
  const legacyProjection = realQueue.map(({ scheduledAt, ...post }) => post);
  const legacyQueueBytes = `${JSON.stringify(legacyProjection, null, 2)}\n`;
  const legacyQueueSha = createHash('sha256')
    .update(legacyQueueBytes, 'utf8')
    .digest('hex');

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

    // Safety direction, second rule: safeToPublish ANDs health.ok on top of the
    // local decision, so it must never be true for an instant at which the REAL
    // local analyzeRuntime reports an unhealthy runtime.
    if (
      !local.refused &&
      local.health &&
      local.health.ok === false &&
      cloudflare.safeToPublish
    ) {
      safe = false;
      divergences.push(
        'FAIL: Cloudflare reports safeToPublish while the local health report is not ok.',
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
    productionQueue: {
      count: realQueue.length,
      sha256: queueSha,
      legacyProjectionSha256: legacyQueueSha,
    },
    documentedDivergences: [
      "Read-only fail-closed on a 'prepared' inflight: local live mode clears it by writing state.json and proceeds; the Cloudflare evaluator cannot write, so it blocks with reason inflight_prepared.",
      'safeToPublish is a Cloudflare-only extra gate (it ANDs health.ok on top of the local decision). It can only withhold, never permit; selection.selected still mirrors the local decision exactly.',
      'A missing ledger (null/undefined) is malformed_ledger rather than an implied empty ledger: not knowing what was already published is exactly when we must fail closed.',
      'invalid_now and invalid_max_publications are Cloudflare-only guards on inputs the local runtime hard-codes; both can only withhold. They are unit-tested rather than matrixed, because the local runtime has no corresponding refusal to compare against.',
      'A queue entry with no usable id is PUBLISHED by the local runtime (isResolved falls through and isDue succeeds) but is malformed_queue for Cloudflare. Withholding only; asserted in test/cloudflare-eligibility-adversarial.test.mjs rather than matrixed, because the two sides legitimately disagree there.',
      'A sparse (hole-containing) queue is likewise malformed_queue for Cloudflare while the local runtime silently skips the holes and publishes. Withholding only; unit-tested.',
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
