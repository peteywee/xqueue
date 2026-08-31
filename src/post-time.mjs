const FORMATTERS = new Map();

function formatter(timeZone) {
  let f = FORMATTERS.get(timeZone);

  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });

    FORMATTERS.set(timeZone, f);
  }

  return f;
}

function partsAt(date, timeZone) {
  const parts = {};

  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }

  return parts;
}

export function scheduledAt({
  scheduledDate,
  scheduledTime,
  timezone,
}) {
  if (!scheduledDate || !scheduledTime || !timezone) {
    throw new Error(
      'scheduledDate, scheduledTime and timezone are required'
    );
  }

  const [year, month, day] =
    scheduledDate.split('-').map(Number);

  const [hour, minute] =
    scheduledTime.split(':').map(Number);

  const target =
    Date.UTC(year, month - 1, day, hour, minute, 0);

  let guess = target;

  // Convert the desired wall-clock time in q.timezone to UTC.
  // Multiple passes correctly resolve normal DST offset changes.
  for (let i = 0; i < 4; i++) {
    const p = partsAt(new Date(guess), timezone);

    const represented =
      Date.UTC(
        p.year,
        p.month - 1,
        p.day,
        p.hour,
        p.minute,
        p.second,
      );

    const delta = target - represented;

    if (delta === 0) {
      return new Date(guess);
    }

    guess += delta;
  }

  return new Date(guess);
}

export function isDue(post, now = new Date()) {
  return scheduledAt(post) <= now;
}
