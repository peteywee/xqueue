const FORMATTERS = new Map();
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function formatter(timeZone) {
  let found = FORMATTERS.get(timeZone);
  if (!found) {
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

function partsAt(epochMs, timeZone) {
  const parts = {};
  for (const part of formatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

function parseWallClock(scheduledDate, scheduledTime) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(scheduledDate ?? ''));
  const timeMatch = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(scheduledTime ?? ''));

  if (!dateMatch || !timeMatch) {
    throw new Error('scheduledDate/scheduledTime must be strict YYYY-MM-DD and HH:MM');
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const wallEpochMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const roundTrip = new Date(wallEpochMs);

  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    throw new Error('scheduledDate/scheduledTime is not a real calendar wall clock');
  }

  return { year, month, day, hour, minute, wallEpochMs };
}

function wallEpochAt(epochMs, timeZone) {
  const p = partsAt(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function matchesWallClock(epochMs, timeZone, target) {
  const p = partsAt(epochMs, timeZone);
  return (
    p.year === target.year &&
    p.month === target.month &&
    p.day === target.day &&
    p.hour === target.hour &&
    p.minute === target.minute &&
    p.second === 0
  );
}

function candidateOffsets(targetWallMs, timeZone) {
  const offsets = new Set();

  // A DST transition can put two UTC offsets around the same local date.
  // Sampling a four-day window at six-hour intervals discovers the offsets
  // that can plausibly map this wall clock without guessing one occurrence.
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) {
    const probe = targetWallMs + deltaHours * HOUR_MS;
    offsets.add(wallEpochAt(probe, timeZone) - probe);
  }

  return offsets;
}

export function resolveUniqueWallClock({
  scheduledDate,
  scheduledTime,
  timezone,
  utcOffsetMinutes = null,
}) {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new Error('timezone is required');
  }

  // Constructing/using the formatter throws RangeError for an unsupported zone.
  formatter(timezone);

  const target = parseWallClock(scheduledDate, scheduledTime);
  const matches = [];

  for (const offsetMs of candidateOffsets(target.wallEpochMs, timezone)) {
    const candidate = target.wallEpochMs - offsetMs;
    if (matchesWallClock(candidate, timezone, target)) matches.push(candidate);
  }

  const uniqueMatches = [...new Set(matches)].sort((a, b) => a - b);

  if (uniqueMatches.length === 0) {
    throw new Error(
      `nonexistent local wall-clock time: ${scheduledDate} ${scheduledTime} ${timezone}`,
    );
  }

  if (utcOffsetMinutes !== null) {
    if (!Number.isInteger(utcOffsetMinutes)) {
      throw new Error('utcOffsetMinutes must be an integer when provided');
    }

    const selected = uniqueMatches.filter(
      (epochMs) => (target.wallEpochMs - epochMs) / MINUTE_MS === utcOffsetMinutes,
    );

    if (selected.length !== 1) {
      throw new Error(
        `utcOffsetMinutes does not uniquely disambiguate: ${scheduledDate} ${scheduledTime} ${timezone}`,
      );
    }

    return new Date(selected[0]);
  }

  if (uniqueMatches.length !== 1) {
    throw new Error(
      `ambiguous local wall-clock time requires explicit utcOffsetMinutes: ${scheduledDate} ${scheduledTime} ${timezone}`,
    );
  }

  return new Date(uniqueMatches[0]);
}
