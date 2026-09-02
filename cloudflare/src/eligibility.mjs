// eligibility.mjs — Cloudflare-compatible, PURE, READ-ONLY port of the local
// xqueue publication-eligibility decision.
//
// AUTHORITY BOUNDARY
//   The local systemd unit (deploy/systemd/xqueue.service -> `pnpm post:live`)
//   remains the sole publication authority. This module never publishes, never
//   mutates a ledger, never touches D1, the filesystem, or the network. It only
//   answers: "given this queue, this ledger, and this instant, what would the
//   local runtime consider eligible?"
//
// INDEPENDENCE
//   This file deliberately re-implements the wall-clock -> UTC resolution and
//   the health/selection arithmetic instead of importing the local runtime
//   modules. Importing them would make the parity test tautological. The
//   re-derived arithmetic is what scripts/build-eligibility-parity-matrix.mjs
//   proves equal to the local implementation.
//
// CONSTRAINTS (enforced by test + grep in CI review)
//   - no Node built-in imports, no filesystem, no network, no D1
//   - no mutation of any argument
//   - never throws out of evaluateEligibility; malformed input becomes a
//     fail-closed failure code instead

/**
 * Failure codes that mean "the inputs themselves are not trustworthy".
 * When one of these is present the health projection is meaningless and the
 * local runtime would likewise refuse to run at all (see the mapping table in
 * scripts/build-eligibility-parity-matrix.mjs).
 */
export const STRUCTURAL_FAILURES = Object.freeze([
  'malformed_queue',
  'duplicate_post_ids',
  'malformed_ledger',
  'invalid_grace',
  'invalid_now',
  'invalid_max_publications',
  'unknown_timezone',
]);

/**
 * Inflight statuses, mirrored from src/state-store.mjs normalizeState.
 */
const INFLIGHT_STATUSES = Object.freeze([
  'prepared',
  'publishing',
  'needs_reconciliation',
]);

const INFLIGHT_BLOCK_REASON = Object.freeze({
  prepared: 'inflight_prepared',
  publishing: 'inflight_publishing',
  needs_reconciliation: 'inflight_needs_reconciliation',
});

const FORMATTERS = new Map();

function formatter(timeZone) {
  let found = FORMATTERS.get(timeZone);

  if (!found) {
    // Throws RangeError for a zone this runtime does not know.
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    FORMATTERS.set(timeZone, found);
  }

  return found;
}

/**
 * True when this runtime can resolve the named IANA time zone.
 */
export function isSupportedTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    return false;
  }

  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function partsAt(epochMs, timeZone) {
  const parts = {};

  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }

  return parts;
}

/**
 * Resolve a wall-clock (scheduledDate + scheduledTime, read in `timezone`) to a
 * UTC instant, expressed as epoch milliseconds.
 *
 * Independent re-implementation of src/post-time.mjs scheduledAt(): same
 * hourCycle 'h23' Intl formatter, same up-to-four iterative correction passes,
 * therefore the same resolution of nonexistent (spring-forward gap) and
 * ambiguous (fall-back repeated hour) wall clocks.
 *
 * Throws (like the local helper) when a required field is missing, and
 * RangeError when the zone is unknown. evaluateEligibility catches both.
 */
export function resolveScheduledAt({ scheduledDate, scheduledTime, timezone }) {
  if (!scheduledDate || !scheduledTime || !timezone) {
    throw new Error(
      'scheduledDate, scheduledTime and timezone are required',
    );
  }

  const [year, month, day] = String(scheduledDate).split('-').map(Number);
  const [hour, minute] = String(scheduledTime).split(':').map(Number);

  const target = Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = target;

  for (let pass = 0; pass < 4; pass += 1) {
    const parts = partsAt(guess, timezone);

    const represented = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );

    const delta = target - represented;

    if (delta === 0) {
      return guess;
    }

    guess += delta;
  }

  return guess;
}

/**
 * Mirror of src/runtime-health.mjs isResolved(): a post is resolved once the
 * ledger records it as posted or as owner-skipped.
 */
export function isLedgerResolved(ledger, postId) {
  return Boolean(
    ledger?.posted?.[postId] ||
    ledger?.skipped?.[postId],
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function toEpochMs(now) {
  // The local runtime reads the clock two different ways and BOTH require a
  // real Date:
  //   src/runtime-health.mjs analyzeRuntime() calls now.getTime(), which
  //     throws for a number or a string;
  //   src/post-time.mjs isDue() compares `scheduledAt(post) <= now`, a
  //     relational comparison that silently yields false for anything without
  //     Date's numeric valueOf — so cmdPost would find NOTHING due.
  // Coercing a number, a string, or a duck-typed { getTime } into an instant
  // here would let this module evaluate — and report safeToPublish for — a
  // clock the local runtime either refuses outright or reads as "nothing due".
  // That is the one divergence direction that is not fail-closed, so anything
  // that is not a usable Date becomes invalid_now.
  if (Object.prototype.toString.call(now) !== '[object Date]') {
    return null;
  }

  const ms = now.getTime();

  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

/**
 * Queue shape check. Mirrors what the local runtime relies on:
 * analyzeRuntime() throws unless the queue is an array, and scheduledAt()
 * throws unless every entry carries scheduledDate/scheduledTime/timezone.
 * An entry without an `id` cannot be matched against the ledger, so it is
 * treated as malformed rather than silently unresolved.
 */
function checkQueueShape(queue) {
  if (!Array.isArray(queue)) {
    return false;
  }

  // An INDEX loop, not Array.prototype.every: `every` skips array holes, so a
  // sparse queue used to pass this check and then crash the id scan below.
  // A hole reads as undefined here and is rejected as malformed.
  for (let i = 0; i < queue.length; i += 1) {
    const post = queue[i];

    const ok = (
      isPlainObject(post) &&
      isNonEmptyString(post.id) &&
      isNonEmptyString(post.scheduledDate) &&
      isNonEmptyString(post.scheduledTime) &&
      isNonEmptyString(post.timezone)
    );

    if (!ok) {
      return false;
    }
  }

  return true;
}

/**
 * Ledger validity, mirroring src/state-store.mjs normalizeState invariants.
 * A missing ledger is NOT treated as an empty ledger: not knowing what has
 * already been published is exactly the case where we must fail closed.
 */
function checkLedgerShape(ledger) {
  if (!isPlainObject(ledger)) {
    return false;
  }

  const posted = ledger.posted ?? {};
  const skipped = ledger.skipped ?? {};

  if (!isPlainObject(posted) || !isPlainObject(skipped)) {
    return false;
  }

  for (const record of Object.values(posted)) {
    if (!isPlainObject(record) || !isNonEmptyString(record.tweetId)) {
      return false;
    }
  }

  for (const [postId, record] of Object.entries(skipped)) {
    if (!isPlainObject(record)) {
      return false;
    }
    if (!isNonEmptyString(record.at) || !isNonEmptyString(record.reason)) {
      return false;
    }
    // normalizeState decides this with `if (posted[postId])` — a TRUTHINESS
    // test that is also true for every inherited Object.prototype member, so a
    // ledger keyed 'constructor'/'toString' makes the LOCAL runtime throw and
    // refuse to publish at all. A hasOwnProperty test accepted such a ledger
    // and reported safeToPublish for a post local would never reach. Mirror
    // the local test exactly.
    if (posted[postId]) {
      return false;
    }
  }

  const spend = ledger.spend ?? 0;
  if (!Number.isFinite(spend) || spend < 0) {
    return false;
  }

  const inflight = ledger.inflight ?? null;
  if (inflight !== null) {
    if (!isPlainObject(inflight)) {
      return false;
    }
    if (!isNonEmptyString(inflight.postId)) {
      return false;
    }
    if (!INFLIGHT_STATUSES.includes(inflight.status)) {
      return false;
    }
    // Same truthiness semantics as normalizeState's
    // `if (posted[inflight.postId] || skipped[inflight.postId])`.
    if (posted[inflight.postId] || skipped[inflight.postId]) {
      return false;
    }
  }

  return true;
}

function emptyHealth(graceMinutes) {
  return {
    ok: false,
    postedCount: 0,
    skippedCount: 0,
    unresolvedCount: 0,
    due: [],
    overdue: [],
    next: null,
    inflight: null,
    graceMinutes,
  };
}

/**
 * Evaluate publication eligibility.
 *
 * `health` reproduces src/runtime-health.mjs analyzeRuntime() exactly, except
 * that `due`, `overdue` and `next` are projected to post IDs (the local module
 * returns whole post objects).
 *   - `due` uses `<=` against now                       (INCLUSIVE)
 *   - `overdue` uses `<` against now - graceMinutes*60s  (STRICT)
 *   - `due` and `overdue` preserve QUEUE ARRAY ORDER; they are not re-sorted
 *   - `next` is the earliest unresolved future post (stable ascending sort)
 *
 * `selection` reproduces the read-only part of src/cli.mjs cmdPost():
 *   - blocked by ANY inflight publication
 *   - otherwise `due.slice(0, maxPublications)` in QUEUE ARRAY ORDER
 *   - a stale backlog does NOT block selection (only `pnpm runtime:health`
 *     fails on staleness; cmdPost publishes through it)
 *
 * `safeToPublish` is a CLOUDFLARE-ONLY EXTRA GATE. It ANDs health.ok on top of
 * the local decision, so it can only ever WITHHOLD relative to what the local
 * runtime would do. It can never permit a publication the local runtime would
 * refuse. Nothing in Cloudflare acts on it this milestone; it exists so a
 * future mirror can say "local would publish, and nothing looks wrong".
 *
 * Never throws. Malformed input becomes a fail-closed entry in `failures`.
 */
export function evaluateEligibility(queue, ledger, options = {}) {
  const {
    now,
    graceMinutes = 20,
    maxPublications = 1,
  } = isPlainObject(options) ? options : {};

  const failures = [];

  // Failure order intentionally mirrors the order in which the local runtime
  // would refuse: queue shape, then the unique-id validation gate cmdPost runs
  // before it reads state, then the ledger normalizer, then analyzeRuntime's
  // own argument checks, then the per-post time-zone resolution.
  const queueOk = checkQueueShape(queue);
  if (!queueOk) {
    failures.push('malformed_queue');
  }

  if (queueOk) {
    const seen = new Set();
    for (const post of queue) {
      if (seen.has(post.id)) {
        failures.push('duplicate_post_ids');
        break;
      }
      seen.add(post.id);
    }
  }

  if (!checkLedgerShape(ledger)) {
    failures.push('malformed_ledger');
  }

  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    failures.push('invalid_grace');
  }

  const nowMs = toEpochMs(now);
  if (nowMs === null) {
    // Cloudflare-only guard. The local runtime always passes `new Date()`;
    // an unusable clock here can only withhold, never permit.
    failures.push('invalid_now');
  }

  if (!Number.isInteger(maxPublications) || maxPublications < 0) {
    // Cloudflare-only guard on a knob the local runtime hard-codes to 1.
    failures.push('invalid_max_publications');
  }

  const instants = [];
  if (queueOk) {
    let zoneFailed = false;

    for (const post of queue) {
      if (!isSupportedTimeZone(post.timezone)) {
        zoneFailed = true;
        instants.push(null);
        continue;
      }

      try {
        instants.push(resolveScheduledAt(post));
      } catch {
        zoneFailed = true;
        instants.push(null);
      }
    }

    if (zoneFailed) {
      failures.push('unknown_timezone');
    }
  }

  const structural = failures.some(
    (code) => STRUCTURAL_FAILURES.includes(code),
  );

  if (structural) {
    return {
      health: emptyHealth(graceMinutes),
      selection: {
        blocked: true,
        blockReason: failures[0],
        selected: [],
      },
      safeToPublish: false,
      failures,
    };
  }

  // ---- health: byte-for-byte the analyzeRuntime arithmetic ----------------
  const cutoffMs = nowMs - graceMinutes * 60_000;

  const unresolvedIdx = [];
  for (let i = 0; i < queue.length; i += 1) {
    if (!isLedgerResolved(ledger, queue[i].id)) {
      unresolvedIdx.push(i);
    }
  }

  const dueIdx = unresolvedIdx.filter((i) => instants[i] <= nowMs);
  const overdueIdx = unresolvedIdx.filter((i) => instants[i] < cutoffMs);

  const upcomingIdx = unresolvedIdx
    .filter((i) => instants[i] > nowMs)
    .sort((a, b) => instants[a] - instants[b]);

  const inflight = ledger.inflight ?? null;

  const health = {
    ok: !inflight && overdueIdx.length === 0,
    postedCount: Object.keys(ledger.posted ?? {}).length,
    skippedCount: Object.keys(ledger.skipped ?? {}).length,
    unresolvedCount: unresolvedIdx.length,
    due: dueIdx.map((i) => queue[i].id),
    overdue: overdueIdx.map((i) => queue[i].id),
    next: upcomingIdx.length ? queue[upcomingIdx[0]].id : null,
    inflight,
    graceMinutes,
  };

  // ---- selection: the read-only half of cmdPost --------------------------
  //
  // DELIBERATE DIVERGENCE: local live mode "recovers" an inflight whose status
  // is 'prepared' by MUTATING state.json and then proceeds to publish. This
  // module is read-only, cannot perform that recovery, and must not assume it
  // happened, so it reports blocked/'inflight_prepared'. This is fail-closed:
  // it withholds where local would proceed, never the reverse.
  let blockReason = null;
  if (inflight) {
    blockReason = INFLIGHT_BLOCK_REASON[inflight.status];
    failures.push(blockReason);
  }

  const blocked = blockReason !== null;

  const selected = (blocked || failures.length > 0)
    ? []
    : health.due.slice(0, maxPublications);

  return {
    health,
    selection: {
      blocked,
      blockReason,
      selected,
    },
    safeToPublish: (
      health.ok &&
      !blocked &&
      selected.length > 0 &&
      failures.length === 0
    ),
    failures,
  };
}
