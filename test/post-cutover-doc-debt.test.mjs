import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('active operator docs name canonical source map and production status surface', () => {
  const readme = text('README.md');
  const runbook = text('docs/RUNBOOK.md');
  const source = text('docs/architecture/source-of-truth.md');

  assert.match(readme, /pnpm production:status/);
  assert.match(readme, /docs\/architecture\/source-of-truth\.md/);
  assert.match(runbook, /pnpm production:status/);
  assert.match(runbook, /production mutation control plane is tracked by #145|tracked by #145/);
  assert.match(source, /production D1/);
  assert.match(source, /production R2/);
  assert.match(source, /#145/);
});

test('historical roadmap cannot present itself as current operator plan', () => {
  const roadmap = text('docs/roadmaps/continuous-queue-reverse-plan.md');

  assert.match(roadmap, /Status: historical design record/);
  assert.match(roadmap, /current production authority and rollback instructions live in `docs\/RUNBOOK\.md`/);
  assert.doesNotMatch(roadmap, /^Status: planning baseline$/m);
});

test('preview-only mutation code references the residual production control-plane debt', () => {
  const intake = text('scripts/continuous-queue-intake.mjs');
  const owner = text('scripts/continuous-queue-owner-ops.mjs');
  const reschedule = text('scripts/continuous-queue-reschedule.mjs');
  const ownerCore = text('src/continuous-queue-owner-ops.mjs');
  const rescheduleCore = text('src/continuous-queue-reschedule.mjs');

  for (const source of [intake, owner, reschedule]) {
    assert.match(source, /#145/);
  }

  assert.doesNotMatch(owner, /until dynamic cutover/);
  assert.doesNotMatch(reschedule, /until dynamic cutover/);
  assert.doesNotMatch(ownerCore, /preview-only-until-dynamic-cutover/);
  assert.doesNotMatch(rescheduleCore, /dynamic-preview-until-cutover/);
});
