import test from 'node:test';
import assert from 'node:assert/strict';

import { runPreviewAuthorityBootstrap } from '../scripts/d1-preview-authority-bootstrap.mjs';

const candidateSha = '7b74eb08ffeed609b83252d09d044e9c25e239dc';
const eventAt = '2026-09-15T12:00:00.000Z';
const transitionId = `preview-bootstrap-none-${candidateSha}`;
const confirm = '--confirm-preview-owner-none-bootstrap';

function jsonStatement(results) {
  return JSON.stringify([{ success: true, results, meta: {} }]);
}

function bootstrapBatch(eventRows, stateRows) {
  return JSON.stringify([
    { success: true, results: eventRows, meta: {} },
    { success: true, results: stateRows, meta: {} },
  ]);
}

function seededEvent(overrides = {}) {
  return {
    generation: 1,
    transition_id: transitionId,
    previous_owner: null,
    next_owner: 'none',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: null,
    event_at: eventAt,
    detail: 'initial preview authority bootstrap; authority intentionally unowned',
    ...overrides,
  };
}

function seededState(overrides = {}) {
  return {
    singleton_id: 1,
    owner: 'none',
    generation: 1,
    transition_state: 'stable',
    transition_id: transitionId,
    previous_owner: null,
    candidate_sha: candidateSha,
    deployment_id: null,
    transitioned_at: eventAt,
    updated_at: eventAt,
    ...overrides,
  };
}

function createRunner({
  branch = 'hardening/issue-59-d1-mirror-activation',
  status = '',
  productionSchema = [],
  previewSchema = ['authority_events', 'authority_state'],
  authorityBefore = { state: null, event: null },
  bootstrapMode = 'success',
  corruptReadback = false,
  mirror = '{"version":1,"posted":{},"skipped":{},"spend":0,"inflight":null}',
} = {}) {
  const calls = [];
  let seeded = false;

  const runProcess = async (invocation) => {
    calls.push(invocation);

    if (invocation.command === 'git') {
      const command = invocation.args.join(' ');
      if (command === 'branch --show-current') {
        return { exitCode: 0, stdout: `${branch}\n`, stderr: '' };
      }
      if (command === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${candidateSha}\n`, stderr: '' };
      }
      if (command === 'status --porcelain --untracked-files=all') {
        return { exitCode: 0, stdout: status, stderr: '' };
      }
      throw new Error(`unexpected git invocation: ${command}`);
    }

    assert.equal(invocation.command, 'pnpm');
    const database = invocation.args[3];
    const config = invocation.args[5];
    const sql = invocation.args.at(-1);

    if (sql.includes("FROM sqlite_master")) {
      const names = database === 'xqueue-production' ? productionSchema : previewSchema;
      return {
        exitCode: 0,
        stdout: jsonStatement(names.map((name) => ({ name }))),
        stderr: '',
      };
    }

    if (sql.includes('FROM authority_state') && sql.includes('LIMIT 1')) {
      let row = seeded ? seededState() : authorityBefore.state;
      if (seeded && corruptReadback) row = seededState({ owner: 'local-systemd' });
      return { exitCode: 0, stdout: jsonStatement(row ? [row] : []), stderr: '' };
    }

    if (sql.includes('FROM authority_events') && sql.includes('ORDER BY generation DESC')) {
      const row = seeded ? seededEvent() : authorityBefore.event;
      return { exitCode: 0, stdout: jsonStatement(row ? [row] : []), stderr: '' };
    }

    if (sql.includes("FROM runtime_metadata") && sql.includes("state.snapshot_json")) {
      return {
        exitCode: 0,
        stdout: jsonStatement([{ value: mirror, updated_at: eventAt }]),
        stderr: '',
      };
    }

    if (sql.includes('INSERT INTO authority_events') && sql.includes('INSERT INTO authority_state')) {
      assert.equal(database, 'xqueue-preview');
      assert.equal(config, 'wrangler.preview.jsonc');

      if (bootstrapMode === 'refused') {
        return { exitCode: 0, stdout: bootstrapBatch([], []), stderr: '' };
      }
      if (bootstrapMode === 'partial') {
        seeded = true;
        return {
          exitCode: 0,
          stdout: bootstrapBatch([seededEvent()], []),
          stderr: '',
        };
      }

      seeded = true;
      return {
        exitCode: 0,
        stdout: bootstrapBatch([seededEvent()], [seededState()]),
        stderr: '',
      };
    }

    throw new Error(`unexpected Wrangler SQL: ${sql}`);
  };

  return { runProcess, calls };
}

const fixedNow = () => new Date(eventAt);

test('preview bootstrap wrapper performs bounded seed and independent proofs', async () => {
  const { runProcess, calls } = createRunner();

  const result = await runPreviewAuthorityBootstrap({
    argv: [confirm],
    runProcess,
    now: fixedNow,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_seeded_unowned');
  assert.equal(result.env, 'preview');
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.transitionId, transitionId);
  assert.equal(result.owner, 'none');
  assert.equal(result.generation, 1);
  assert.equal(result.deploymentId, null);
  assert.equal(result.mirrorUnchanged, true);
  assert.equal(result.productionAuthoritySchemaAbsent, true);
  assert.equal(result.mirrorSyncAllowed, false);

  const productionCalls = calls.filter(
    (call) => call.command === 'pnpm' && call.args[3] === 'xqueue-production',
  );
  assert.ok(productionCalls.length >= 2);
  for (const call of productionCalls) {
    assert.match(call.args.at(-1), /^SELECT name\nFROM sqlite_master/);
    assert.doesNotMatch(call.args.at(-1), /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i);
  }

  const previewWrites = calls.filter(
    (call) =>
      call.command === 'pnpm' &&
      call.args[3] === 'xqueue-preview' &&
      /\bINSERT INTO authority_events\b/.test(call.args.at(-1)),
  );
  assert.equal(previewWrites.length, 1);
  assert.doesNotMatch(
    previewWrites[0].args.at(-1),
    /runtime_metadata|publication_state|publication_events/,
  );
});

test('wrapper requires the exact explicit confirmation and performs no process calls otherwise', async () => {
  const { runProcess, calls } = createRunner();

  await assert.rejects(
    () => runPreviewAuthorityBootstrap({ argv: [], runProcess, now: fixedNow }),
    /explicit confirmation required/,
  );
  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm, '--env=production'],
      runProcess,
      now: fixedNow,
    }),
    /explicit confirmation required/,
  );

  assert.equal(calls.length, 0);
});

test('wrapper refuses the wrong branch and a dirty worktree before D1 access', async () => {
  const wrong = createRunner({ branch: 'main' });
  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm],
      runProcess: wrong.runProcess,
      now: fixedNow,
    }),
    /requires branch hardening\/issue-59-d1-mirror-activation/,
  );
  assert.equal(
    wrong.calls.some((call) => call.command === 'pnpm'),
    false,
  );

  const dirty = createRunner({ status: '?? local-note.txt\n' });
  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm],
      runProcess: dirty.runProcess,
      now: fixedNow,
    }),
    /requires a clean worktree/,
  );
  assert.equal(
    dirty.calls.some((call) => call.command === 'pnpm'),
    false,
  );
});

test('wrapper proves production authority schema absent before preview mutation', async () => {
  const { runProcess, calls } = createRunner({
    productionSchema: ['authority_state'],
  });

  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm],
      runProcess,
      now: fixedNow,
    }),
    /production authority schema must remain absent/,
  );

  assert.equal(
    calls.some(
      (call) =>
        call.command === 'pnpm' &&
        call.args[3] === 'xqueue-preview' &&
        /\bINSERT INTO\b/.test(call.args.at(-1)),
    ),
    false,
  );
});

test('wrapper requires the exact preview authority schema and empty tables before mutation', async () => {
  const missingSchema = createRunner({ previewSchema: ['authority_state'] });
  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm],
      runProcess: missingSchema.runProcess,
      now: fixedNow,
    }),
    /preview authority schema is not exact/,
  );

  const preseeded = createRunner({
    authorityBefore: {
      state: seededState(),
      event: seededEvent(),
    },
  });
  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm],
      runProcess: preseeded.runProcess,
      now: fixedNow,
    }),
    /requires empty authority tables/,
  );
  assert.equal(
    preseeded.calls.some(
      (call) =>
        call.command === 'pnpm' &&
        /\bINSERT INTO authority_events\b/.test(call.args.at(-1)),
    ),
    false,
  );
});

test('executor refusal remains refusal and does not become claimed success', async () => {
  const { runProcess } = createRunner({ bootstrapMode: 'refused' });
  const result = await runPreviewAuthorityBootstrap({
    argv: [confirm],
    runProcess,
    now: fixedNow,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'preview_authority_bootstrap_precondition_failed');
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.transitionId, transitionId);
});

test('partial bootstrap return remains indeterminate', async () => {
  const { runProcess } = createRunner({ bootstrapMode: 'partial' });
  const result = await runPreviewAuthorityBootstrap({
    argv: [confirm],
    runProcess,
    now: fixedNow,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'preview_authority_bootstrap_readback_mismatch');
});

test('independent post-write authority mismatch fails closed', async () => {
  const { runProcess } = createRunner({ corruptReadback: true });

  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: [confirm],
      runProcess,
      now: fixedNow,
    }),
    /independent readback did not match exact bootstrap evidence/,
  );
});
