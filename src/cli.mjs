#!/usr/bin/env node
// cli.mjs — the whole operator surface.
//
//   node src/cli.mjs build
//       Rebuild queue.json from the markdown content library.
//
//   node src/cli.mjs validate
//       Run every content rule; exit 1 on any blocking error.
//
//   node src/cli.mjs stats
//       Show pillar split, runway, publication state, and cost projection.
//
//   node src/cli.mjs next [n]
//       Show the next n unpublished posts.
//
//   node src/cli.mjs post
//       Safe default: dry-run anything currently due.
//
//   node src/cli.mjs post --dry-run
//       Explicit dry-run. Nothing is sent to X.
//
//   node src/cli.mjs post --live
//       LIVE publication of anything currently due.
//
//   node src/cli.mjs whoami
//       Verify OAuth credentials through the official X SDK.
//
// The markdown files are the source of truth.
// queue.json is generated.
// state.json records what actually went out so a re-run cannot double-post.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';

import {
  join,
  dirname,
  resolve,
} from 'node:path';

import { fileURLToPath } from 'node:url';

import {
  loadLibrary,
  renderPost,
  PILLARS,
} from './parse.mjs';

import {
  validate,
  summarize,
  URL_RE,
} from './validate.mjs';

import {
  schedule,
  stats as queueStats,
  DEFAULTS,
} from './schedule.mjs';

// Keep the existing media uploader during this migration.
// XDK is used for authentication, whoami, and post creation.
import {
  COST,
} from './x-client.mjs';

import {
  credsFromEnv,
  createPost,
  uploadMedia,
  whoAmI,
} from './xdk-client.mjs';

import {
  isDue,
} from './post-time.mjs';

const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

const LIBRARY_DIR =
  process.env.LIBRARY_DIR ?? join(ROOT, 'content');

const MEDIA_DIR =
  process.env.MEDIA_DIR ?? join(ROOT, 'media');

const QUEUE = join(ROOT, 'queue.json');
const STATE = join(ROOT, 'state.json');

loadDotenv();

const [, , cmd = 'help', ...args] = process.argv;

const flag = (name) =>
  args.includes(`--${name}`);

const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);

  return i >= 0 && args[i + 1]
    ? args[i + 1]
    : fallback;
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadDotenv() {
  const file = join(ROOT, '.env');

  if (!existsSync(file)) {
    return;
  }

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(
      /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/,
    );

    if (!match) {
      continue;
    }

    const [, name, rawValue] = match;

    // Never overwrite a value already provided by the process environment.
    if (process.env[name]) {
      continue;
    }

    process.env[name] = rawValue.replace(
      /^["']|["']$/g,
      '',
    );
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

function figuresAvailable() {
  if (!existsSync(MEDIA_DIR)) {
    return null;
  }

  const set = new Set();

  for (const file of readdirSync(MEDIA_DIR)) {
    const match = file.match(
      /(?:figure[-_]?)?(\d+)\.(png|jpg|jpeg|gif|webp)$/i,
    );

    if (match) {
      set.add(Number(match[1]));
    }
  }

  return set;
}

function figurePath(number) {
  if (!existsSync(MEDIA_DIR)) {
    return null;
  }

  const pattern = new RegExp(
    `(?:figure[-_]?)?0*${number}\\.(png|jpg|jpeg|gif|webp)$`,
    'i',
  );

  const file = readdirSync(MEDIA_DIR).find((name) =>
    pattern.test(name),
  );

  return file
    ? join(MEDIA_DIR, file)
    : null;
}

// ---------------------------------------------------------------------------
// JSON state
// ---------------------------------------------------------------------------

const readJSON = (path, fallback) =>
  existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : fallback;

const writeJSON = (path, value) =>
  writeFileSync(
    path,
    JSON.stringify(value, null, 2) + '\n',
  );

// ---------------------------------------------------------------------------
// Cost projection
// ---------------------------------------------------------------------------

function projectCost(queue) {
  let cost = 0;

  for (const post of queue) {
    cost += URL_RE.test(post.body)
      ? COST.postWithUrl
      : COST.post;
  }

  return cost;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdBuild() {
  const posts = loadLibrary(LIBRARY_DIR);

  const queue = schedule(posts, {
    start: opt(
      'start',
      DEFAULTS.start,
    ),

    slots: opt(
      'slots',
      DEFAULTS.slots.join(','),
    ).split(','),

    daysOfWeek: opt(
      'days',
      DEFAULTS.daysOfWeek.join(','),
    )
      .split(',')
      .map(Number),

    timezone: opt(
      'tz',
      DEFAULTS.timezone,
    ),
  });

  writeJSON(QUEUE, queue);

  const stats = queueStats(queue);

  console.log(
    `Built ${stats.posts} posts across ` +
    `${stats.postingDays} posting days ` +
    `(${stats.weeks} weeks).`,
  );

  console.log(
    `${stats.first} -> ${stats.last}`,
  );

  console.log(
    'Split: ' +
      Object.entries(stats.shares)
        .map(
          ([key, value]) =>
            `${key} ${value}`,
        )
        .join('  '),
  );

  console.log(
    `Queue written to ${QUEUE}`,
  );
}

function cmdValidate() {
  const posts = loadLibrary(LIBRARY_DIR);

  const findings = validate(posts, {
    premium: !flag('no-premium'),
    figuresAvailable: figuresAvailable(),
  });

  const counts = summarize(findings);

  const shown = flag('quiet')
    ? findings.filter(
        (finding) =>
          finding.level === 'error',
      )
    : findings;

  for (const finding of shown) {
    console.log(
      `${finding.level
        .toUpperCase()
        .padEnd(5)} ` +
      `${finding.id.padEnd(5)} ` +
      `${finding.rule.padEnd(20)} ` +
      finding.message,
    );
  }

  console.log(
    `\n${posts.length} posts checked. ` +
    `${counts.error} errors, ` +
    `${counts.warn} warnings, ` +
    `${counts.info} info.`,
  );

  if (counts.error) {
    process.exit(1);
  }
}

function cmdStats() {
  const posts = loadLibrary(LIBRARY_DIR);

  const queue =
    readJSON(QUEUE, null) ??
    schedule(posts);

  const stats = queueStats(queue);

  const state = readJSON(
    STATE,
    {
      posted: {},
      spend: 0,
    },
  );

  const done =
    Object.keys(state.posted).length;

  console.log(
    `Library      ${posts.length} posts`,
  );

  for (
    const [pillar, count]
    of Object.entries(stats.byPillar)
  ) {
    console.log(
      `  ${pillar} ` +
      `${PILLARS[pillar].name.padEnd(20)} ` +
      `${String(count).padStart(3)}  ` +
      `${stats.shares[pillar].padStart(4)}  ` +
      `(target ${Math.round(
        PILLARS[pillar].share * 100,
      )}%)`,
    );
  }

  console.log(
    `\nRunway       ` +
    `${stats.postingDays} posting days, ` +
    `${stats.weeks} weeks at 2/day`,
  );

  console.log(
    `Window       ${stats.first} -> ${stats.last}`,
  );

  console.log(
    `Published    ${done} / ${queue.length}`,
  );

  console.log(
    `Remaining    ${queue.length - done}`,
  );

  const totalCost =
    projectCost(queue);

  console.log(
    `\nAPI cost     ` +
    `$${totalCost.toFixed(2)} ` +
    `for the whole queue`,
  );

  console.log(
    `             ` +
    `$${(
      totalCost /
      stats.weeks *
      4.33
    ).toFixed(2)}/month ` +
    `at this cadence`,
  );

  console.log(
    'X subscription: Premium required ' +
    'for long-form posts in this library',
  );
}

function cmdNext() {
  const queue =
    readJSON(QUEUE, null);

  if (!queue) {
    console.error(
      'No queue.json — run `build` first.',
    );

    return;
  }

  const state = readJSON(
    STATE,
    {
      posted: {},
      spend: 0,
    },
  );

  const requested =
    args.find(
      (arg) => /^\d+$/.test(arg),
    );

  const count =
    Number(requested ?? 6);

  const pending = queue
    .filter(
      (post) =>
        !state.posted[post.id],
    )
    .slice(0, count);

  for (const post of pending) {
    const text =
      renderPost(post);

    console.log(
      `\n${'-'.repeat(66)}`,
    );

    console.log(
      `${post.id}  ${post.title}`,
    );

    console.log(
      `${post.scheduledDate} ` +
      `${post.scheduledTime} ` +
      `${post.timezone}  ` +
      `[${post.slot}]  ` +
      `${text.length} chars` +
      (
        post.figure
          ? `  figure ${post.figure}`
          : ''
      ),
    );

    console.log(
      `${'-'.repeat(66)}`,
    );

    console.log(text);
  }

  console.log(
    `\n${pending.length} shown, ` +
    `${
      queue.length -
      Object.keys(state.posted).length
    } remaining in queue.`,
  );
}

async function cmdPost() {
  const requestedLive =
    flag('live');

  const requestedDry =
    flag('dry-run');

  if (
    requestedLive &&
    requestedDry
  ) {
    throw new Error(
      'Choose either --live or --dry-run, not both.',
    );
  }

  // SAFE DEFAULT:
  // No --live means dry-run.
  const dry =
    !requestedLive;

  const queue =
    readJSON(QUEUE, null);

  if (!queue) {
    console.error(
      'No queue.json — run `build` first.',
    );

    return;
  }

  // -----------------------------------------------------------------------
  // Validation gate
  // -----------------------------------------------------------------------

  const findings = validate(
    loadLibrary(LIBRARY_DIR),
    {
      figuresAvailable:
        figuresAvailable(),
    },
  );

  const blocked = new Set(
    findings
      .filter(
        (finding) =>
          finding.level === 'error',
      )
      .map(
        (finding) =>
          finding.id,
      ),
  );

  if (blocked.size) {
    console.error(
      `Validation errors on ` +
      `${blocked.size} post(s). ` +
      'Fix them or run `validate` to see. ' +
      'Refusing to post.',
    );

    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // State / due-time gate
  // -----------------------------------------------------------------------

  const state = readJSON(
    STATE,
    {
      posted: {},
      spend: 0,
    },
  );

  const now =
    new Date();

  const due = queue.filter(
    (post) => {
      // Already published = never eligible again.
      if (state.posted[post.id]) {
        return false;
      }

      // q.timezone is respected by post-time.mjs.
      return isDue(
        post,
        now,
      );
    },
  );

  if (!due.length) {
    console.log(
      'Nothing due.',
    );

    return;
  }

  console.log(
    `${due.length} post(s) due.` +
      (
        dry
          ? '  [DRY RUN — nothing will be sent]'
          : '  [LIVE — PUBLICATION ENABLED]'
      ),
  );

  // Credentials are deliberately not loaded for dry-runs.
  const creds =
    dry
      ? null
      : credsFromEnv();

  // -----------------------------------------------------------------------
  // Publication loop
  // -----------------------------------------------------------------------

  const publishable = dry
    ? due
    : due.slice(0, 1);

  if (!dry && due.length > 1) {
    console.log(
      `Backlog protection: ${due.length} posts are due; ` +
      'live mode will publish only the oldest one this run.'
    );
  }

  for (const post of publishable) {
    const text =
      renderPost(post);

    const cost =
      URL_RE.test(post.body)
        ? COST.postWithUrl
        : COST.post;

    console.log(
      `\n[${post.id}] ` +
      `${post.title} — ` +
      `${text.length} chars, ` +
      `~$${cost.toFixed(3)}`,
    );

    // ---------------------------------------------------------------------
    // Media preflight
    //
    // This runs in BOTH dry and live modes.
    // If a post explicitly references a figure, its absence is blocking.
    // ---------------------------------------------------------------------

    let mediaPath = null;

    if (post.figure != null) {
      mediaPath =
        figurePath(post.figure);

      if (!mediaPath) {
        throw new Error(
          `Required figure ${post.figure} ` +
          `for ${post.id} is missing from ` +
          `${MEDIA_DIR}; refusing to publish.`,
        );
      }

      console.log(
        `  media: ${mediaPath}`,
      );
    }

    // Dry-run ends here.
    // No credentials have been loaded and no X API mutation occurs.
    if (dry) {
      console.log(text);

      console.log(
        '  DRY RUN: validated; not sent.',
      );

      continue;
    }

    // ---------------------------------------------------------------------
    // LIVE publication
    // ---------------------------------------------------------------------

    try {
      const mediaIds = [];

      if (mediaPath) {
        const mediaId =
          await uploadMedia(
            creds,
            mediaPath,
          );

        mediaIds.push(
          mediaId,
        );
      }

      const response =
        await createPost(
          creds,
          {
            text,
            mediaIds,
          },
        );

      const id =
        response?.data?.id;

      if (!id) {
        throw new Error(
          'X returned success without a post ID; ' +
          'state will not be updated.',
        );
      }

      // State is written only AFTER X returned the remote post ID.
      state.posted[post.id] = {
        tweetId: id,
        at: new Date().toISOString(),
        cost,
      };

      state.spend = +(
        (state.spend ?? 0) +
        cost
      ).toFixed(4);

      writeJSON(
        STATE,
        state,
      );

      console.log(
        `  posted: https://x.com/i/status/${id}`,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `  FAILED: ${message}`,
      );

      const status =
        error?.status ??
        error?.statusCode ??
        error?.response?.status;

      if (status === 429) {
        const resetAt =
          error?.resetAt ??
          error?.response?.headers?.[
            'x-rate-limit-reset'
          ];

        console.error(
          '  rate limited' +
            (
              resetAt
                ? `, resets ${new Date(
                    Number(resetAt) * 1000,
                  ).toISOString()}`
                : ''
            ) +
            ' — stopping this run',
        );

        break;
      }

      // Fail closed on all other publication errors.
      //
      // We do not continue to later posts after an unknown failure,
      // because that could create gaps or sequencing problems.
      throw error;
    }
  }

  if (!dry) {
    console.log(
      `\nCumulative API spend: ` +
      `$${(
        state.spend ?? 0
      ).toFixed(2)}`,
    );
  }
}

async function cmdWhoami() {
  const me =
    await whoAmI(
      credsFromEnv(),
    );

  console.log(
    JSON.stringify(
      me,
      null,
      2,
    ),
  );
}

function cmdHelp() {
  console.log(`
xqueue

Commands:

  pnpm build
      Rebuild queue.json.

  pnpm validate
      Validate the entire content library.

  pnpm stats
      Show queue and publishing statistics.

  pnpm next
      Show upcoming unpublished posts.

  node src/cli.mjs next 10
      Show the next 10 unpublished posts.

  pnpm post
      SAFE DEFAULT. Dry-run anything currently due.

  pnpm post:dry
      Explicit dry-run.

  pnpm post:live
      LIVE. Publish anything currently due.

  node src/cli.mjs whoami
      Verify the authenticated X account.

Safety:

  Live posting requires --live.
  --live and --dry-run cannot be combined.
  Validation errors block publication.
  Missing required figures block publication.
  Already-posted queue IDs are skipped.
  state.json is updated only after X returns a post ID.
`.trim());
}

const commands = {
  build: cmdBuild,
  validate: cmdValidate,
  stats: cmdStats,
  next: cmdNext,
  post: cmdPost,
  whoami: cmdWhoami,
  help: cmdHelp,
};

const fn =
  commands[cmd] ??
  cmdHelp;

try {
  await fn();
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(
    `\n${message}`,
  );

  process.exitCode = 1;
}
