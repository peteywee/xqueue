# Runbook

## First-time setup

### 1. X Premium — $8/mo

Do this before anything else. Without a subscription every post in the library
truncates at 280 characters; they run 380–700.

Settings → Premium → **Premium**, not Basic. Basic ($3) gets you the 25,000
character limit but not reply prioritization, and replies are where the account
actually gets built in month one.

### 2. API credentials

developer.x.com → free developer account → create a project and app.

**Order matters:**

1. User authentication settings → App permissions → **Read and Write**
2. *Then* Keys and tokens → generate Access Token and Secret

Generating the token before setting permissions gives you a read-only token and
every post 403s. If you've already done it in the wrong order, regenerate the
token.

You need four values: API Key, API Secret, Access Token, Access Token Secret.

### 3. Local

```bash
git clone <your-repo> xqueue && cd xqueue
node --version              # needs v20+
cp .env.example .env        # paste the four values
cp ~/figures/*.png media/   # figure-1.png, figure-9.png, figure-14.png, figure-23.png
```

No `pnpm install` — there are no dependencies.

### 4. Verify before going live

```bash
pnpm verify              # tests, validation, queue build
node src/cli.mjs whoami     # confirms auth; should print your account
pnpm build --start 2026-09-07
pnpm post:dry            # read what it would send
```

Do not skip the dry run.

### 5. Cron

```cron
*/15 * * * * cd ~/xqueue && /usr/bin/node src/cli.mjs post >> ~/xqueue/post.log 2>&1
```

Runs every 15 minutes; the tool decides what's actually due and does nothing the
rest of the time.

## Weekly

```bash
pnpm stats     # remaining count — batch when it drops under 20
pnpm next 10   # read ahead, edit anything that's gone stale
```

Editing is the point. Rewrite posts four days ahead of publication, then
`pnpm verify` and commit. The queue rebuilds in under a second.

## Failure modes

**Posts didn't go out overnight.**
Most likely the Crostini container slept, so cron never fired. Check
`post.log` — if there are no entries at all, that's the cause. The fix is
moving the cron command to something always-on: a Cloudflare Worker on a cron
trigger, a small VPS, or any machine that stays up. The tool is stateless
apart from `state.json`.

**403 on post creation.**
App permissions were read-only when the access token was generated. Set
permissions to Read and Write, regenerate the token, update `.env`.

**401 on every call.**
Usually a stray space or quote in `.env`. `node src/cli.mjs whoami` isolates
it — if `whoami` fails, it's credentials, not posting.

**429 rate limited.**
The client stops the run rather than retrying, and logs the reset time. At ten
posts a week you should never see this; if you do, something is looping.

**Media upload errors.**
The chunked upload response shape has moved around in the v2 API. Text-only
posting is unaffected — comment out the figure attachment and keep publishing
while you fix it. This is the least-proven part of the client.

**Validation fails after an edit.**
`pnpm validate` names the post and the rule. Errors block publishing by
design; fix the post rather than bypassing the check.

## Cost

| | |
|---|---|
| Post creation | $0.015 |
| Post with a URL | $0.200 — never do this; links go in a reply |
| Whole 180-post queue | $2.70 |
| Monthly at 2/day × 5 days | ~$0.65 |
| X Premium | $8.00 |
| **Total** | **~$8.65/mo** |

Media upload billing isn't separately documented. Check real spend in the
developer console after week one.

## What stays manual, permanently

- **Replies.** Thirty minutes a day, typed by hand. Mass automated replies are bannable, and hand-written replies are why the account works.
- **DMs.** Where the consulting work comes from.
- **Follows and likes.** Bulk automation of either is explicitly prohibited.
- **Any response to a specific legal situation.** "I can't advise on specifics — talk to an employment attorney." Every time.
