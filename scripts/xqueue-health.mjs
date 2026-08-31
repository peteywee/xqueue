#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  copyFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';

import {
  spawnSync,
} from 'node:child_process';

import {
  scheduledAt,
} from '../src/post-time.mjs';

const ROOT =
  new URL('../', import.meta.url);

const path = (name) =>
  new URL(name, ROOT);

const QUEUE =
  path('queue.json');

const STATE =
  path('state.json');

const POLICY =
  path('config/schedule-policy.json');

const REPAIR =
  process.argv.includes('--repair');

function readJSON(url, fallback = null) {
  if (!existsSync(url)) {
    return fallback;
  }

  return JSON.parse(
    readFileSync(url, 'utf8'),
  );
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  return false;
}

function audit() {
  const policy =
    readJSON(POLICY);

  const queue =
    readJSON(QUEUE);

  if (!policy) {
    return {
      ok: fail('schedule policy missing'),
      failures: 1,
    };
  }

  if (!Array.isArray(queue)) {
    return {
      ok: fail('queue.json missing or invalid'),
      failures: 1,
    };
  }

  let failures = 0;

  const gate = (
    name,
    ok,
    detail = '',
  ) => {
    console.log(
      `${name.padEnd(30)} ` +
      `${ok ? 'PASS' : 'FAIL'}` +
      `${detail ? `  ${detail}` : ''}`,
    );

    if (!ok) {
      failures++;
    }
  };

  const dateTimes =
    queue.map(
      (p) =>
        `${p.scheduledDate}T${p.scheduledTime}`,
    );

  const days =
    new Map();

  for (const post of queue) {
    if (!days.has(post.scheduledDate)) {
      days.set(
        post.scheduledDate,
        [],
      );
    }

    days
      .get(post.scheduledDate)
      .push(post);
  }

  const sorted =
    [...queue].sort(
      (a, b) =>
        scheduledAt(a).getTime() -
        scheduledAt(b).getTime(),
    );

  const actualTimes =
    [...new Set(
      queue.map(
        (p) => p.scheduledTime,
      ),
    )].sort();

  const expectedTimes =
    [...policy.slots].sort();

  const actualZones =
    [...new Set(
      queue.map(
        (p) => p.timezone,
      ),
    )];

  let invalidWeekdays = 0;

  for (const post of queue) {
    const dow =
      new Date(
        `${post.scheduledDate}T12:00:00Z`,
      ).getUTCDay();

    if (
      !policy.daysOfWeek.includes(dow)
    ) {
      invalidWeekdays++;
    }
  }

  const badDailyCounts =
    [...days.values()]
      .filter(
        (posts) =>
          posts.length !==
          policy.postsPerDay,
      );

  let chronologyErrors = 0;

  for (
    let i = 1;
    i < sorted.length;
    i++
  ) {
    if (
      scheduledAt(sorted[i]).getTime() <=
      scheduledAt(sorted[i - 1]).getTime()
    ) {
      chronologyErrors++;
    }
  }

  console.log();
  console.log(
    '=== XQUEUE SCHEDULE HEALTH ===',
  );

  gate(
    'queue item count',
    queue.length ===
      policy.expectedPosts,
    String(queue.length),
  );

  gate(
    'posting day count',
    days.size ===
      policy.expectedPostingDays,
    String(days.size),
  );

  gate(
    'campaign start',
    sorted[0]?.scheduledDate ===
      policy.campaignStart,
    sorted[0]?.scheduledDate ?? 'NONE',
  );

  gate(
    'timezone',
    actualZones.length === 1 &&
      actualZones[0] ===
        policy.timezone,
    actualZones.join(','),
  );

  gate(
    'slot times',
    JSON.stringify(actualTimes) ===
      JSON.stringify(expectedTimes),
    actualTimes.join(','),
  );

  gate(
    'configured weekdays',
    invalidWeekdays === 0,
    String(invalidWeekdays),
  );

  gate(
    'posts per day',
    badDailyCounts.length === 0,
    String(badDailyCounts.length),
  );

  gate(
    'unique date/time',
    new Set(dateTimes).size ===
      dateTimes.length,
    `${new Set(dateTimes).size}/${dateTimes.length}`,
  );

  gate(
    'strict chronology',
    chronologyErrors === 0,
    String(chronologyErrors),
  );

  const state =
    readJSON(
      STATE,
      {
        posted: {},
      },
    );

  const posted =
    state?.posted ?? {};

  console.log();
  console.log(
    `Recorded published posts: ${
      Object.keys(posted).length
    }`,
  );

  for (
    const [id, record]
    of Object.entries(posted)
  ) {
    console.log(
      `  ${id} -> ` +
      `${record.tweetId ?? 'NO-ID'}`,
    );
  }

  return {
    ok: failures === 0,
    failures,
  };
}

function rebuild() {
  const policy =
    readJSON(POLICY);

  if (!policy) {
    throw new Error(
      'schedule policy missing',
    );
  }

  console.log();
  console.log(
    '=== REBUILDING GENERATED QUEUE ===',
  );

  const result =
    spawnSync(
      process.execPath,
      [
        'src/cli.mjs',
        'build',

        '--start',
        policy.campaignStart,

        '--slots',
        policy.slots.join(','),

        '--days',
        policy.daysOfWeek.join(','),

        '--tz',
        policy.timezone,
      ],
      {
        cwd:
          new URL('.', ROOT),
        stdio: 'inherit',
      },
    );

  if (result.status !== 0) {
    throw new Error(
      `queue rebuild exited ${
        result.status
      }`,
    );
  }
}

const first =
  audit();

if (first.ok) {
  console.log();
  console.log(
    'XQUEUE HEALTH: PASS',
  );

  process.exit(0);
}

if (!REPAIR) {
  console.error();
  console.error(
    'XQUEUE HEALTH: FAIL',
  );

  process.exit(1);
}

console.log();
console.log(
  'DRIFT DETECTED — attempting safe repair',
);

const backup =
  path(
    `queue.json.selfheal-${Date.now()}.bak`,
  );

if (existsSync(QUEUE)) {
  copyFileSync(
    QUEUE,
    backup,
  );
}

try {
  rebuild();

  const second =
    audit();

  if (!second.ok) {
    throw new Error(
      'rebuilt queue failed policy audit',
    );
  }

  console.log();
  console.log(
    'XQUEUE SELF-HEAL: PASS',
  );

  if (existsSync(backup)) {
    unlinkSync(backup);
  }

  process.exit(0);
} catch (error) {
  console.error();
  console.error(
    'XQUEUE SELF-HEAL: FAIL',
  );

  console.error(
    error instanceof Error
      ? error.message
      : String(error),
  );

  if (existsSync(backup)) {
    renameSync(
      backup,
      QUEUE,
    );

    console.error(
      'Previous queue.json restored.',
    );
  }

  process.exit(1);
}
