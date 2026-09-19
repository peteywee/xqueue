import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allocateAppendSlots,
  classifyItemReadback,
  executeIntakePlan,
  normalizeIntakeInput,
  planIntake,
  sha256Hex,
} from '../src/continuous-queue-intake.mjs';

const POLICY = {
  version: 2,
  timezone: 'America/Chicago',
  slots: ['14:30', '22:15'],
  daysOfWeek: [1, 2, 3, 4, 5],
};

const FRONTIER = {
  generation: 1,
  resolved_at: '2027-01-07T20:30:00.000Z',
  pending_operation_id: null,
  last_completed_operation_id: null,
};

function raw(id = 'CQ-TEST-1', body = 'Exact approved post body. Nothing in intake is allowed to rewrite this.') {
  return {
    content_id: id,
    pillar: 'A',
    title: 'test',
    body,
    source_ref: 'test/fixture',
  };
}

function planFor(input = raw()) {
  const normalized = normalizeIntakeInput(input, { mode: 'single' });
  return planIntake({
    normalized,
    frontier: FRONTIER,
    policy: POLICY,
    baselineAssignmentHash: 'a'.repeat(64),
  });
}

function exactReadback(item, intakeState = 'scheduled') {
  return {
    content: {
      content_id: item.content_id,
      pillar: item.pillar,
      current_revision: 1,
      status: 'active',
      intake_state: intakeState,
    },
    revision: {
      content_id: item.content_id,
      revision: 1,
      title: item.title,
      body: item.body,
      publication_text: item.publication_text,
      content_digest: item.content_digest,
      figure: null,
      source_ref: item.source_ref,
    },
    assignment: intakeState === 'scheduled' ? {
      assignment_id: item.assignment_id,
      assignment_version: 1,
      content_id: item.content_id,
      content_revision: 1,
      content_digest: item.content_digest,
      target_account: item.target_account,
      policy_version: item.policy_version,
      resolved_at: item.resolved_at,
      scheduled_date: item.scheduled_date,
      scheduled_time: item.scheduled_time,
      timezone: item.timezone,
      slot_label: item.slot_label,
      status: 'active',
      superseded_by_version: null,
    } : null,
  };
}

function makeTransport(plan, {
  frontier = structuredClone(FRONTIER),
  ambiguousClaim = false,
  ambiguousPut = false,
  staleBeforeClaim = false,
} = {}) {
  let operation = null;
  const itemStates = new Map();
  let putCalls = 0;

  if (staleBeforeClaim) {
    frontier.generation = 2;
    frontier.resolved_at = '2027-01-08T04:15:00.000Z';
  }

  return {
    get putCalls() {
      return putCalls;
    },
    readOperation: async () => operation,
    createOperation: async () => {
      operation = {
        operation_id: plan.operation_id,
        plan_digest: plan.plan_digest,
        batch_digest: plan.batch_digest,
        item_count: plan.count,
        expected_frontier_generation: plan.expected_frontier_generation,
        expected_frontier_resolved_at: plan.expected_frontier_resolved_at,
        proposed_frontier_resolved_at: plan.proposed_frontier_resolved_at,
        baseline_assignment_hash: plan.baseline_assignment_hash,
        target_account: plan.target_account,
        policy_version: plan.policy_version,
        status: 'planned',
      };
    },
    readFrontier: async () => structuredClone(frontier),
    claimFrontier: async () => {
      frontier.generation = plan.expected_frontier_generation + 1;
      frontier.resolved_at = plan.proposed_frontier_resolved_at;
      frontier.pending_operation_id = plan.operation_id;
      if (ambiguousClaim) throw new Error('lost response');
    },
    markOperation: async (_id, status) => {
      operation.status = status;
    },
    readItem: async (item) => itemStates.get(item.content_id) ?? {
      content: null,
      revision: null,
      assignment: null,
    },
    putItem: async (_plan, item) => {
      putCalls++;
      itemStates.set(item.content_id, exactReadback(item));
      if (ambiguousPut) throw new Error('lost response');
    },
    hashAssignmentsExcluding: async () => plan.baseline_assignment_hash,
    releaseFrontier: async () => {
      frontier.pending_operation_id = null;
      frontier.last_completed_operation_id = plan.operation_id;
    },
  };
}

test('single intake preserves exact approved bytes and stable digest/id allocation', () => {
  const body = 'Approved bytes\nremain exactly\nas supplied.';
  const normalizedA = normalizeIntakeInput({ pillar: 'A', body }, { mode: 'single' });
  const normalizedB = normalizeIntakeInput({ pillar: 'A', body }, { mode: 'single' });

  assert.equal(normalizedA.items[0].body, body);
  assert.equal(normalizedA.items[0].publication_text, body);
  assert.equal(normalizedA.items[0].content_digest, sha256Hex(body));
  assert.equal(normalizedA.items[0].content_id, normalizedB.items[0].content_id);
  assert.match(normalizedA.items[0].content_id, /^CQ-[A-F0-9]{20}$/);
});

test('intake rejects rewrite-needing or ambiguous inputs before planning', () => {
  assert.throws(
    () => normalizeIntakeInput({
      content_id: 'B-NEW',
      pillar: 'B',
      body: 'Legal content without the already-approved disclaimer.',
    }, { mode: 'single' }),
    /already include the approved legal disclaimer/,
  );

  assert.throws(
    () => normalizeIntakeInput([
      raw('SAME'),
      raw('SAME', 'Another exact approved body for the same identity.'),
    ]),
    /duplicate content_id/,
  );

  assert.throws(
    () => normalizeIntakeInput({
      pillar: 'A',
      body: 'x'.repeat(25001),
    }, { mode: 'single' }),
    /too long/,
  );

  assert.throws(
    () => normalizeIntakeInput({
      pillar: 'A',
      body: 'Automated handoff without explicit owner approval evidence.',
      source_mode: 'automated',
    }, { mode: 'single' }),
    /owner_approval_digest/,
  );
});

test('append allocation starts strictly after the durable frontier without filling old gaps', () => {
  const slots = allocateAppendSlots({
    frontierResolvedAt: FRONTIER.resolved_at,
    count: 3,
    policy: POLICY,
  });

  assert.deepEqual(slots, [
    {
      resolved_at: '2027-01-08T04:15:00.000Z',
      scheduled_date: '2027-01-07',
      scheduled_time: '22:15',
      timezone: 'America/Chicago',
      slot_label: 'post-close',
    },
    {
      resolved_at: '2027-01-08T20:30:00.000Z',
      scheduled_date: '2027-01-08',
      scheduled_time: '14:30',
      timezone: 'America/Chicago',
      slot_label: 'lull',
    },
    {
      resolved_at: '2027-01-09T04:15:00.000Z',
      scheduled_date: '2027-01-08',
      scheduled_time: '22:15',
      timezone: 'America/Chicago',
      slot_label: 'post-close',
    },
  ]);
});

test('bulk planning is deterministic and refuses existing identity/digest conflicts', () => {
  const normalized = normalizeIntakeInput([
    raw('CQ-B1', 'First exact approved bulk body.'),
    raw('CQ-B2', 'Second exact approved bulk body.'),
  ]);

  const args = {
    normalized,
    frontier: FRONTIER,
    policy: POLICY,
    baselineAssignmentHash: 'b'.repeat(64),
  };

  const a = planIntake(args);
  const b = planIntake(args);
  assert.equal(a.plan_digest, b.plan_digest);
  assert.equal(a.operation_id, b.operation_id);
  assert.deepEqual(a.items.map((item) => item.resolved_at), [
    '2027-01-08T04:15:00.000Z',
    '2027-01-08T20:30:00.000Z',
  ]);

  assert.throws(
    () => planIntake({
      ...args,
      existingContent: [{ content_id: 'CQ-B1' }],
    }),
    /content_id already exists/,
  );
  assert.throws(
    () => planIntake({
      ...args,
      existingDigests: [{
        content_id: 'OLD',
        content_digest: normalized.items[0].content_digest,
      }],
    }),
    /exact content digest already exists/,
  );
});

test('item readback distinguishes approved-unscheduled from complete and conflict', () => {
  const item = planFor().items[0];
  assert.equal(
    classifyItemReadback(item, exactReadback(item, 'approved_unscheduled')),
    'approved_unscheduled',
  );
  assert.equal(classifyItemReadback(item, exactReadback(item)), 'complete');

  const conflict = exactReadback(item);
  conflict.revision.body = 'changed';
  assert.equal(classifyItemReadback(item, conflict), 'conflict');
});

test('executor completes one plan and releases the pending frontier lock', async () => {
  const plan = planFor();
  const transport = makeTransport(plan);
  const result = await executeIntakePlan({
    plan,
    transport,
    recordedAt: '2026-09-19T18:30:00.000Z',
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.count, 1);
  assert.equal(result.frontier_generation, 2);
  assert.equal(transport.putCalls, 1);
});

test('stale frontier refuses before content or assignment writes', async () => {
  const plan = planFor();
  const transport = makeTransport(plan, { staleBeforeClaim: true });

  await assert.rejects(
    executeIntakePlan({
      plan,
      transport,
      recordedAt: '2026-09-19T18:30:00.000Z',
    }),
    /frontier changed after dry run/,
  );
  assert.equal(transport.putCalls, 0);
});

test('ambiguous frontier CAS is reconciled by readback, not blindly repeated', async () => {
  const plan = planFor();
  const transport = makeTransport(plan, { ambiguousClaim: true });

  const result = await executeIntakePlan({
    plan,
    transport,
    recordedAt: '2026-09-19T18:30:00.000Z',
  });

  assert.equal(result.status, 'applied');
  assert.equal(transport.putCalls, 1);
});

test('ambiguous item mutation is accepted only after exact readback', async () => {
  const plan = planFor();
  const transport = makeTransport(plan, { ambiguousPut: true });

  const result = await executeIntakePlan({
    plan,
    transport,
    recordedAt: '2026-09-19T18:30:00.000Z',
  });

  assert.equal(result.status, 'applied');
  assert.equal(transport.putCalls, 1);
});


test('exact completed-plan replay is idempotent and performs no second item write', async () => {
  const plan = planFor();
  const transport = makeTransport(plan);

  const first = await executeIntakePlan({
    plan,
    transport,
    recordedAt: '2026-09-19T18:30:00.000Z',
  });
  const second = await executeIntakePlan({
    plan,
    transport,
    recordedAt: '2026-09-19T18:31:00.000Z',
  });

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'already_applied');
  assert.equal(transport.putCalls, 1);
});
