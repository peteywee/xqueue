import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scheduledAt,
  isDue,
} from '../src/post-time.mjs';

test('Chicago summer time converts using CDT during migration fallback', () => {
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

test('Chicago winter time converts using CST during migration fallback', () => {
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

test('committed scheduledAt is authoritative over wall-clock metadata', () => {
  const at = scheduledAt({
    scheduledAt: '2026-08-31T19:30:00.000Z',
    scheduledDate: '2099-01-01',
    scheduledTime: '00:00',
    timezone: 'America/Chicago',
  });

  assert.equal(at.toISOString(), '2026-08-31T19:30:00.000Z');
});

test('invalid committed scheduledAt fails closed', () => {
  for (const value of [
    '2026-08-31T19:30:00Z',
    'not-an-instant',
    '',
  ]) {
    assert.throws(
      () => scheduledAt({
        scheduledAt: value,
        scheduledDate: '2026-08-31',
        scheduledTime: '14:30',
        timezone: 'America/Chicago',
      }),
      /scheduledAt must/,
    );
  }
});

test('migration fallback rejects nonexistent spring-forward wall clocks', () => {
  assert.throws(
    () => scheduledAt({
      scheduledDate: '2027-03-14',
      scheduledTime: '02:30',
      timezone: 'America/Chicago',
    }),
    /nonexistent local wall-clock time/,
  );
});

test('migration fallback rejects ambiguous fall-back wall clocks without an offset', () => {
  assert.throws(
    () => scheduledAt({
      scheduledDate: '2027-11-07',
      scheduledTime: '01:30',
      timezone: 'America/Chicago',
    }),
    /ambiguous local wall-clock time/,
  );

  assert.equal(
    scheduledAt({
      scheduledDate: '2027-11-07',
      scheduledTime: '01:30',
      timezone: 'America/Chicago',
      utcOffsetMinutes: -360,
    }).toISOString(),
    '2027-11-07T07:30:00.000Z',
  );
});

test('post is not due before committed scheduled time', () => {
  const post = {
    scheduledAt: '2026-08-31T19:30:00.000Z',
    scheduledDate: '2026-08-31',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
  };

  assert.equal(
    isDue(post, new Date('2026-08-31T19:29:59Z')),
    false,
  );
});

test('post becomes due at committed scheduled time', () => {
  const post = {
    scheduledAt: '2026-08-31T19:30:00.000Z',
    scheduledDate: '2026-08-31',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
  };

  assert.equal(
    isDue(post, new Date('2026-08-31T19:30:00Z')),
    true,
  );
});
