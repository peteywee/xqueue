# XQueue Production Runbook

## Operating model

XQueue is deliberately fail-closed:

- Markdown under `content/` is the content source of truth.
- `config/schedule-policy.json` is the production scheduling policy.
- `queue.json` is generated locally and is never committed.
- `state.json` is the durable publication ledger and is never committed.
- Live publication requires the explicit `--live` path.
- A live run publishes at most one overdue post.
- Concurrent live publishers are blocked by `.xqueue-publish.lock`.
- An ambiguous create-post outcome blocks automatic retries until the owner reconciles it.

## First-time setup

### 1. Install runtime and dependencies

The repository currently requires Node 22.13+ and pnpm. The package manager is pinned in `package.json`.

```bash
git clone <your-repo> xqueue
cd xqueue
corepack enable
pnpm install --frozen-lockfile
```

Do not use npm or yarn; the preinstall guard rejects them.

### 2. Configure X credentials

Create an X developer app with Read and Write permissions, then generate the user-context credentials after those permissions are set.

Copy the environment template and provide all four values:

```bash
cp .env.example .env
chmod 600 .env
```

Required values:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_SECRET`

Verify the identity before enabling live publication:

```bash
node src/cli.mjs whoami
```

The returned username must be the intended production account.

### 3. Provision required media

Figures remain local deployment assets. Copy them into `media/` using a supported name such as `figure-23.png`, `figure_23.png`, or `23.png`.

Production validation is strict:

```bash
pnpm validate:production
```

If any post references a figure that is missing, production validation fails and live publication is blocked.

### 4. Build and verify the production queue

```bash
pnpm verify
pnpm validate:production
node scripts/xqueue-health.mjs
pnpm next 10
pnpm post:dry
```

`pnpm verify` runs tests, content validation, deterministic queue generation from production policy, and schedule health.

Do not commit `queue.json`. A fresh clone must regenerate the same schedule from Markdown plus `config/schedule-policy.json`.

## Scheduler

The scheduler must invoke the explicit live command. **Do not use `node src/cli.mjs post` by itself; that is intentionally a dry-run.**

Example cron entry:

```cron
*/15 * * * * cd /home/patrick/xqueue && /usr/bin/env corepack pnpm post:live >> /home/patrick/xqueue/post.log 2>&1
```

Before installing the cron line, verify the exact executable paths on the production host:

```bash
command -v node
command -v corepack
command -v pnpm || true
pwd
```

The tool itself decides whether anything is due. Live mode publishes only the oldest due post in a run, so a machine waking from sleep cannot flush an entire backlog at once.

## Daily/weekly checks

```bash
cd /home/patrick/xqueue
pnpm health
pnpm stats
pnpm next 10
```

Before editing or deploying content:

```bash
pnpm verify
pnpm validate:production
```

## Publication state and crash recovery

### Normal state

`state.json` records remote post IDs only after X confirms a successful create operation. Writes are atomic.

`pnpm stats` reports any in-flight publication state.

### Abandoned `prepared` attempt

If the process dies before the create-post phase starts, the next live run can safely clear the `prepared` attempt and retry. No public post could have been created yet.

### Ambiguous create-post outcome

A network failure or server failure can occur after the request has left the machine but before the X post ID reaches XQueue. In that case XQueue cannot safely infer whether the post exists.

XQueue records the attempt as `needs_reconciliation` and blocks all later live posts.

1. Open the production X account and inspect the timeline.
2. Compare the queued post text/title with what is visible remotely.
3. If the post exists, copy its numeric X post ID and run:

```bash
pnpm reconcile -- --posted <tweet-id>
```

4. If you have positively verified that the post does not exist, run:

```bash
pnpm reconcile -- --not-posted
```

`--not-posted` is an owner-reserved decision. Do not use it merely because the API returned an error; verify the remote account first.

## Common failure modes

### `Publisher lock is already held`

Another live execution is active, or a previous process died while holding the lock. XQueue automatically removes a stale lock only when it can prove the recorded process on the same host no longer exists. Otherwise, inspect the process before taking any manual action.

### Production validation reports missing figures

List the local media inventory:

```bash
find media -maxdepth 1 -type f -print | sort
```

Provision the missing figure and rerun:

```bash
pnpm validate:production
```

Do not bypass the production media gate.

### `state.json` cannot be parsed

Live publication must stop. Do not delete the file and retry; deletion would erase the local idempotency ledger and could duplicate historical posts. Preserve the file, restore from a known-good copy if available, and reconcile against the X account.

### 401/403

Run:

```bash
node src/cli.mjs whoami
```

If identity/authentication fails, fix credentials or app permissions before any live attempt.

### 429

A concrete 429 rejection is treated as not accepted by X and does not create an ambiguous publication record. Do not loop manually; wait for the platform limit to clear.

### Machine slept through scheduled times

When the machine resumes, overdue posts are eligible, but backlog protection publishes only one live post per invocation. Continue normal scheduler runs rather than manually flushing the queue.

## What remains manual

- Replies and conversations.
- DMs.
- Follows and likes.
- Legal advice or responses to individual legal situations.
- Reconciliation after an ambiguous create-post outcome.
- Credential provisioning and production scheduler installation.

These are intentionally outside the autonomous publisher boundary.
