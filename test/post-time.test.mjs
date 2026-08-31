import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scheduledAt,
  isDue,
} from '../src/post-time.mjs';

test('Chicago summer time converts using CDT', () => {
  const at = scheduledAt({
    scheduledDate: '2026-08-31',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
  });

  assert.equal(
    at.toISOString(),
    '2026-08-31T19:30:00.000Z',
  );
});

test('Chicago winter time converts using CST', () => {
  const at = scheduledAt({
    scheduledDate: '2026-12-01',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
  });

  assert.equal(
    at.toISOString(),
    '2026-12-01T20:30:00.000Z',
  );
});

test('post is not due before scheduled time', () => {
  const post = {
    scheduledDate: '2026-08-31',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
  };

  assert.equal(
    isDue(post, new Date('2026-08-31T19:29:59Z')),
    false,
  );
});

test('post becomes due at scheduled time', () => {
  const post = {
    scheduledDate: '2026-08-31',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
  };

  assert.equal(
    isDue(post, new Date('2026-08-31T19:30:00Z')),
    true,
  );
});
