import { resolveUniqueWallClock } from './schedule-slot.mjs';

function committedInstant(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('scheduledAt must be a canonical UTC ISO instant');
  }

  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw new Error('scheduledAt must be a canonical UTC ISO instant');
  }

  const canonical = new Date(epochMs).toISOString();
  if (canonical !== value) {
    throw new Error('scheduledAt must be canonical ISO-8601 UTC with milliseconds');
  }

  return new Date(epochMs);
}

/**
 * Return the exact committed publication instant.
 *
 * New assignments persist scheduledAt when they are created. The wall-clock
 * fallback is retained only so older generated/test fixtures can be read during
 * migration; it uses the strict unique resolver and therefore rejects DST gaps
 * and ambiguous repeated hours instead of guessing.
 */
export function scheduledAt({
  scheduledAt: persistedScheduledAt,
  scheduledDate,
  scheduledTime,
  timezone,
  utcOffsetMinutes = null,
}) {
  if (persistedScheduledAt !== undefined && persistedScheduledAt !== null) {
    return committedInstant(persistedScheduledAt);
  }

  return resolveUniqueWallClock({
    scheduledDate,
    scheduledTime,
    timezone,
    utcOffsetMinutes,
  });
}

export function isDue(post, now = new Date()) {
  return scheduledAt(post) <= now;
}
