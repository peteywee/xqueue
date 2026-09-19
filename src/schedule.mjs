// schedule.mjs — turn the post library into a dated queue.
//
// Two decisions are encoded here and both are arguable, so both are options:
//
//  1. SLOT TIMES. Restaurant people are not on their phones at 7am. They are
//     on them in the afternoon lull between lunch and dinner service, and
//     again after close. Those are the two slots. Default 14:30 and 22:15
//     America/Chicago.
//
//  2. PILLAR CYCLE. A fixed 20-slot / 10-day cycle that hits the 40/25/20/15
//     split exactly and never puts two posts from the same pillar on one day.
//     Repeating it 9 times consumes exactly the 180-post library.

import { resolveUniqueWallClock } from './schedule-slot.mjs';

export const PILLAR_CYCLE = [
  ['A', 'B'], ['A', 'C'], ['B', 'D'], ['A', 'B'], ['A', 'D'],
  ['A', 'C'], ['B', 'C'], ['A', 'B'], ['A', 'D'], ['A', 'C'],
];

// Which pillar gets the better slot (the afternoon lull) when a day has two.
// Bookmarks on the law posts are the KPI, so B outranks everything.
const SLOT_RANK = { B: 0, A: 1, C: 2, D: 3 };

export const DEFAULTS = {
  slots: ['14:30', '22:15'],
  timezone: 'America/Chicago',
  daysOfWeek: [1, 2, 3, 4, 5], // Mon–Fri
  start: null,                 // ISO date; defaults to the next posting day
  deferToEnd: [],              // exact post IDs rescheduled after the normal tail
};

/** Deterministic topical spread: walk the list with a stride coprime to its length. */
function stride(list, step) {
  const n = list.length;
  if (n < 3) return [...list];
  let s = step % n;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  while (gcd(s, n) !== 1) s = (s + 1) % n || 1;
  const out = [];
  for (let i = 0, k = 0; i < n; i++, k = (k + s) % n) out.push(list[k]);
  return out;
}

function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function* postingDays(startISO, daysOfWeek) {
  const d = new Date(`${startISO}T12:00:00Z`);
  for (;;) {
    if (daysOfWeek.includes(d.getUTCDay())) yield ymd(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function nextDay(dateISO) {
  const d = new Date(`${dateISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return ymd(d);
}

function chronologyKey(post) {
  return post.scheduledAt ?? `${post.scheduledDate}T${post.scheduledTime}`;
}

function resolvedAssignmentFields(scheduledDate, scheduledTime, timezone) {
  return {
    scheduledDate,
    scheduledTime,
    timezone,
    scheduledAt: resolveUniqueWallClock({
      scheduledDate,
      scheduledTime,
      timezone,
    }).toISOString(),
  };
}

/**
 * Reschedule selected posts after the normal campaign tail without moving any
 * other post. Historical missed slots therefore remain empty instead of being
 * silently backfilled by unrelated content.
 */
function deferPostsToEnd(queue, ids, cfg) {
  if (!ids?.length) return queue;

  const requested = [...ids];
  const unique = new Set(requested);
  if (unique.size !== requested.length) {
    throw new Error('deferToEnd contains duplicate post IDs');
  }

  const byId = new Map(queue.map((post) => [post.id, post]));
  for (const id of requested) {
    if (!byId.has(id)) throw new Error(`deferToEnd references unknown post: ${id}`);
    if (byId.get(id).pinned) throw new Error(`refusing to defer pinned post: ${id}`);
  }

  const tail = [...queue].sort((a, b) => chronologyKey(a).localeCompare(chronologyKey(b))).at(-1);
  const days = postingDays(nextDay(tail.scheduledDate), cfg.daysOfWeek);
  let date = null;

  for (let i = 0; i < requested.length; i++) {
    const slotIndex = i % cfg.slots.length;
    if (slotIndex === 0) date = days.next().value;

    const post = byId.get(requested[i]);
    const scheduledTime = cfg.slots[slotIndex] ?? cfg.slots[cfg.slots.length - 1];
    Object.assign(
      post,
      resolvedAssignmentFields(date, scheduledTime, cfg.timezone),
    );
    post.slot = slotIndex === 0 ? 'lull' : 'post-close';
    post.deferredToEnd = true;
  }

  queue.sort((a, b) => chronologyKey(a).localeCompare(chronologyKey(b)));
  return queue;
}

export function schedule(posts, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const start = cfg.start ?? ymd(new Date());

  // Bucket by pillar, spread topics, force the pinned post to the front of A.
  const buckets = {};
  for (const p of posts) (buckets[p.pillar] ??= []).push(p);
  for (const k of Object.keys(buckets)) {
    buckets[k] = stride(buckets[k], 29);
    const pinnedAt = buckets[k].findIndex((p) => p.pinned);
    if (pinnedAt > 0) buckets[k].unshift(...buckets[k].splice(pinnedAt, 1));
  }

  const cursor = { A: 0, B: 0, C: 0, D: 0 };
  const days = postingDays(start, cfg.daysOfWeek);
  const queue = [];
  let dayIndex = 0;

  const total = posts.length;
  while (queue.length < total) {
    const date = days.next().value;
    const pattern = PILLAR_CYCLE[dayIndex % PILLAR_CYCLE.length];
    dayIndex++;

    // Rank the day's two pillars so the higher-value one lands in the lull slot.
    const ordered = [...pattern].sort((a, b) => SLOT_RANK[a] - SLOT_RANK[b]);

    for (let s = 0; s < ordered.length && queue.length < total; s++) {
      const pillar = ordered[s];
      const bucket = buckets[pillar];
      // Fall through to whichever pillar still has stock if this one is dry.
      const pick = cursor[pillar] < bucket.length
        ? bucket[cursor[pillar]++]
        : (() => {
            const alt = Object.keys(cursor).find((k) => cursor[k] < buckets[k].length);
            return alt ? buckets[alt][cursor[alt]++] : null;
          })();
      if (!pick) break;

      const scheduledTime = cfg.slots[s] ?? cfg.slots[cfg.slots.length - 1];

      queue.push({
        ...pick,
        ...resolvedAssignmentFields(date, scheduledTime, cfg.timezone),
        slot: s === 0 ? 'lull' : 'post-close',
        status: 'queued',
      });
    }
  }

  // The pinned post states the thesis of the whole account. It goes first,
  // ahead of the slot ranking, by swapping its schedule with whatever drew
  // the opening slot.
  const pin = queue.findIndex((q) => q.pinned);
  if (pin > 0) {
    const sched = (q) => ({
      scheduledDate: q.scheduledDate,
      scheduledTime: q.scheduledTime,
      timezone: q.timezone,
      scheduledAt: q.scheduledAt,
      slot: q.slot,
    });
    const first = sched(queue[0]);
    Object.assign(queue[0], sched(queue[pin]));
    Object.assign(queue[pin], first);
    const moved = queue.splice(pin, 1)[0];
    queue.unshift(moved);
  }

  return deferPostsToEnd(queue, cfg.deferToEnd, cfg);
}

export function stats(queue) {
  const byPillar = {};
  for (const q of queue) byPillar[q.pillar] = (byPillar[q.pillar] ?? 0) + 1;
  const dates = [...new Set(queue.map((q) => q.scheduledDate))].sort();
  return {
    posts: queue.length,
    postingDays: dates.length,
    weeks: +(dates.length / 5).toFixed(1),
    first: dates[0],
    last: dates[dates.length - 1],
    byPillar,
    shares: Object.fromEntries(
      Object.entries(byPillar).map(([k, v]) => [k, `${Math.round((v / queue.length) * 100)}%`]),
    ),
  };
}
