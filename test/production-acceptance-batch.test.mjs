import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseJsonOutput,
  parseScheduledLog,
  parseWorkerVersionId,
} from '../scripts/production-acceptance-batch.mjs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('acceptance parser extracts JSON after pnpm command chatter', () => {
  const parsed = parseJsonOutput(
    '$ node example.mjs\n' +
    '[{"results":[{"halted":1,"generation":8}],"success":true}]\n',
  );
  assert.equal(parsed[0].results[0].halted, 1);
  assert.equal(parsed[0].results[0].generation, 8);
});

test('acceptance parser extracts immutable Worker version ID', () => {
  assert.equal(
    parseWorkerVersionId(
      'Uploaded xqueue-publisher-production\n' +
      'Worker Version ID: 30c688d4-8718-4bf7-b1c1-d8d146adafea\n',
    ),
    '30c688d4-8718-4bf7-b1c1-d8d146adafea',
  );
});

test('scheduled tail parser extracts structured scheduler evidence', () => {
  const event = parseScheduledLog(
    'Connected to xqueue-publisher-production\n' +
    '  (log) {"event":"scheduled","heartbeatRecorded":true,' +
    '"schedulerAuthority":true,"result":{"reason":"publication_halted",' +
    '"dispatched":false}}\n',
  );

  assert.equal(event.event, 'scheduled');
  assert.equal(event.heartbeatRecorded, true);
  assert.equal(event.schedulerAuthority, true);
  assert.equal(event.result.dispatched, false);
});

test('production acceptance orchestration is explicit, resumable and fail-closed', () => {
  const source = text('scripts/production-acceptance-batch.mjs');

  assert.match(source, /--release requires --apply/);
  assert.match(
    source,
    /--apply requires --confirm xqueue-production-acceptance/,
  );
  assert.match(source, /previous mutation has ambiguous outcome/);
  assert.match(source, /status: 'ready_for_release'/);
  assert.match(source, /status: 'complete'/);
  assert.match(source, /state\.json/);
  assert.match(source, /summary\.json/);
  assert.match(source, /missed_assignments_deferred/);
  assert.match(source, /publication_halted/);

  assert.doesNotMatch(source, /\bset\s+-[Ee]/);
  assert.doesNotMatch(source, /set\s+-Eeuo\s+pipefail/);
});

test('package exposes one production acceptance command', () => {
  const pkg = JSON.parse(text('package.json'));
  assert.equal(
    pkg.scripts['production:acceptance'],
    'node scripts/production-acceptance-batch.mjs',
  );
});
