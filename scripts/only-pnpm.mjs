// Refuse npm and yarn. The usual way to do this is the `only-allow` package,
// but this repo has zero dependencies and is not breaking that for a guard
// that fits in ten lines.
//
// npm_config_user_agent looks like "pnpm/10.15.0 npm/? node/v22.0.0 linux x64".

const ua = process.env.npm_config_user_agent ?? '';
const manager = ua.split('/')[0];

// No user agent means it was run directly (node scripts/only-pnpm.mjs) — fine.
if (manager && manager !== 'pnpm') {
  console.error(`
  This repo uses pnpm. You ran ${manager}.

    corepack enable
    pnpm install

  (There are no dependencies, so install does almost nothing — but the
   scripts and CI assume pnpm.)
`);
  process.exit(1);
}
