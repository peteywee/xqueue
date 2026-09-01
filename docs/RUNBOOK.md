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

The repository requires Node 22.13+ and pnpm. The package manager is pinned in `package.json`.

```bash
git clone <your-repo> xqueue
cd xqueue
corepack enable
pnpm install --frozen-lockfile
```

Do not use npm or yarn; the preinstall guard rejects them.

### 2. Configure X credentials

Create an X developer app with Read and Write permissions, then generate the user-context credentials after those permissions are set.

```bash
cp .env.example .env
chmod 600 .env
```

Required values:

- `X_API_KEY`
- `X_API_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_SECRET`

Verify identity before enabling live publication:

```bash
node src/cli.mjs whoami
```

The returned username must be the intended production account.

### 3. Provision required media

Figures remain local deployment assets. Copy them into `media/` using a supported name such as `figure-23.png`, `figure_23.png`, or `23.png`.

```bash
pnpm validate:production
```

If any post references a missing figure, production validation fails and live publication is blocked.

### 4. Run the complete non-mutating production preflight

The canonical cutover gate is:

```bash
pnpm preflight:production
```

This checks runtime versions, exact local Git state, credential-file permissions, publication-ledger validity, repository tests, deterministic queue regeneration, strict production media validation, authenticated X identity, dry-run publication behavior, figure 23, and the active scheduler configuration.

The preflight never invokes `post:live` and never creates an X post. It exits nonzero on any blocking failure and ends with exactly one of:

```text
XQUEUE PRODUCTION PREFLIGHT: PASS
XQUEUE PRODUCTION PREFLIGHT: FAIL
```

Do not enable or modify the live scheduler until the preflight passes.

## Scheduler

The scheduler must invoke the explicit live command. **Do not use `node src/cli.mjs post` by itself; that is intentionally a dry-run.**

### Existing cron deployment

A valid cron entry looks like:

```cron
*/15 * * * * cd /home/patrick/xqueue && /usr/bin/env corepack pnpm post:live >> /home/patrick/xqueue/post.log 2>&1
```

Before retaining cron, verify the exact executable paths on the production host:

```bash
command -v node
command -v corepack
command -v pnpm || true
pwd
```

`pnpm preflight:production` audits active xqueue cron entries and fails if an entry does not explicitly use `post:live` or `post --live`.

### Reproducible user-systemd deployment

Version-controlled unit definitions live under `deploy/systemd/`.

The guarded installer is:

```bash
bash deploy/install-systemd-user.sh
```

It intentionally refuses to proceed unless all of these are true:

- the checkout is exactly `~/xqueue`;
- a user systemd manager is available;
- there is no active xqueue cron entry, preventing duplicate schedulers;
- `pnpm preflight:production` passes.

If those gates pass, it installs `xqueue.service` and `xqueue.timer` under `~/.config/systemd/user/` and enables the 15-minute timer. The installer does not invoke the service immediately and does not publish a post itself.

Inspect the installed scheduler with:

```bash
systemctl --user cat xqueue.service
systemctl --user cat xqueue.timer
systemctl --user list-timers xqueue.timer --all --no-pager
journalctl --user -u xqueue.service --no-pager -n 100
```

Use **one scheduler authority only**: cron or the user-systemd timer, never both.

The publisher itself decides whether anything is due. Live mode publishes only the oldest due post in a run, so a machine waking from sleep cannot flush an entire backlog at once.

## Routine checks

```bash
cd /home/patrick/xqueue
pnpm health
pnpm stats
pnpm next 10
```

Before editing, deploying, or changing the scheduler:

```bash
pnpm verify
pnpm preflight:production
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

```bash
find media -maxdepth 1 -type f -print | sort
pnpm validate:production
```

Do not bypass the production media gate.

### `state.json` cannot be parsed

Live publication must stop. Do not delete the file and retry; deletion would erase the local idempotency ledger and could duplicate historical posts. Preserve the file, restore from a known-good copy if available, and reconcile against the X account.

### 401/403

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
- Credential provisioning.
- Choosing and installing exactly one production scheduler authority.

These are intentionally outside the autonomous publisher boundary.
