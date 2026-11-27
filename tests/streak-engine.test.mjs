import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PEOPLE,
  formatCountdown,
  getAnchoredCompletedDays,
  getCompletedDays,
  getCountdownSeconds,
  getCurrentMilestone,
  getEarnedMilestone,
  getZonedDateTime,
  getNextMilestone,
  getProgress,
} from '../lib/streak-engine.ts';

test('shows Nopy immediately before the Sep 9 Berlin cutoff', () => {
  const before = new Date('2026-09-09T20:04:59.000Z');
  assert.equal(getCompletedDays(PEOPLE.nopy.startDate, before), 0);
  assert.equal(formatCountdown(getCountdownSeconds(before)), '00:00:01');
});

test('increments Nopy exactly once at 22:05 Berlin and targets tomorrow', () => {
  const atCutoff = new Date('2026-09-09T20:05:00.000Z');
  assert.equal(getCompletedDays(PEOPLE.nopy.startDate, atCutoff), 1);
  assert.equal(formatCountdown(getCountdownSeconds(atCutoff)), '24:00:00');
});

test('Santiago uses Santiago time and increments at 22:05 Chile time', () => {
  const sharedInstant = new Date('2026-09-11T14:10:00.000Z');
  const berlin = getZonedDateTime(sharedInstant, PEOPLE.nopy.timeZone);
  const santiago = getZonedDateTime(sharedInstant, 'America/Santiago');
  const beforeCutoff = new Date('2026-09-10T01:04:59.000Z');
  const atCutoff = new Date('2026-09-10T01:05:00.000Z');

  assert.deepEqual(
    { hour: berlin.hour, minute: berlin.minute },
    { hour: 16, minute: 10 },
  );
  assert.deepEqual(
    { hour: santiago.hour, minute: santiago.minute },
    { hour: 11, minute: 10 },
  );
  assert.equal(
    getCompletedDays(
      { year: 2026, month: 9, day: 4 },
      beforeCutoff,
      PEOPLE.nopy.dayEnd,
      'America/Santiago',
    ),
    5,
  );
  assert.equal(
    formatCountdown(
      getCountdownSeconds(
        beforeCutoff,
        PEOPLE.nopy.dayEnd,
        'America/Santiago',
      ),
    ),
    '00:00:01',
  );
  assert.equal(
    getCompletedDays(
      { year: 2026, month: 9, day: 4 },
      atCutoff,
      PEOPLE.nopy.dayEnd,
      'America/Santiago',
    ),
    6,
  );
});

test('Santiago countdown follows Chile daylight-saving changes', () => {
  const sep5Cutoff = new Date('2026-09-06T02:05:00.000Z');
  assert.equal(
    getCountdownSeconds(
      sep5Cutoff,
      PEOPLE.nopy.dayEnd,
      'America/Santiago',
    ),
    23 * 60 * 60,
  );
});

test('calculates progress and milestone remaining days precisely', () => {
  assert.equal(getProgress(0), 0);
  assert.equal(getProgress(1), 1.1);
  assert.equal(getProgress(5), 5.6);
  assert.equal(getProgress(6), 6.7);
  assert.equal(getProgress(31), 34.4);
  assert.equal(getProgress(90), 100);
  assert.deepEqual(getNextMilestone(5), { day: 7, name: 'Silver Medal' });
});

test('countdown respects Berlin daylight-saving changes', () => {
  const beforeSpringChange = new Date('2026-03-28T21:05:00.000Z');
  const beforeAutumnChange = new Date('2026-10-24T20:05:00.000Z');
  assert.equal(getCountdownSeconds(beforeSpringChange), 23 * 60 * 60);
  assert.equal(getCountdownSeconds(beforeAutumnChange), 25 * 60 * 60);
});

test('Void stays on Day 0 until Sep 11 at exactly 22:05 Brazil time', () => {
  const sep10AfterCutoff = new Date('2026-09-11T02:00:00.000Z');
  const oneSecondBefore = new Date('2026-09-12T01:04:59.000Z');
  const atCutoff = new Date('2026-09-12T01:05:00.000Z');

  assert.equal(
    getCompletedDays(
      PEOPLE.void.startDate,
      sep10AfterCutoff,
      PEOPLE.void.dayEnd,
      PEOPLE.void.timeZone,
    ),
    0,
  );
  assert.equal(
    getCompletedDays(
      PEOPLE.void.startDate,
      oneSecondBefore,
      PEOPLE.void.dayEnd,
      PEOPLE.void.timeZone,
    ),
    0,
  );
  assert.equal(
    formatCountdown(
      getCountdownSeconds(
        oneSecondBefore,
        PEOPLE.void.dayEnd,
        PEOPLE.void.timeZone,
      ),
    ),
    '00:00:01',
  );
  assert.equal(
    getCompletedDays(
      PEOPLE.void.startDate,
      atCutoff,
      PEOPLE.void.dayEnd,
      PEOPLE.void.timeZone,
    ),
    1,
  );
  assert.equal(
    formatCountdown(
      getCountdownSeconds(
        atCutoff,
        PEOPLE.void.dayEnd,
        PEOPLE.void.timeZone,
      ),
    ),
    '24:00:00',
  );
});

test('a manually edited day advances from its new value at the next cutoff', () => {
  const anchoredAt = new Date('2026-09-11T20:00:00.000Z');
  const staleClockSnapshot = new Date('2026-09-11T19:59:59.000Z');
  const beforeCutoff = new Date('2026-09-11T20:04:59.000Z');
  const atCutoff = new Date('2026-09-11T20:05:00.000Z');
  const nextDayBeforeCutoff = new Date('2026-09-12T20:04:59.000Z');

  assert.equal(getAnchoredCompletedDays(2, anchoredAt, staleClockSnapshot), 2);
  assert.equal(getAnchoredCompletedDays(2, anchoredAt, beforeCutoff), 2);
  assert.equal(getAnchoredCompletedDays(2, anchoredAt, atCutoff), 3);
  assert.equal(
    getAnchoredCompletedDays(2, anchoredAt, nextDayBeforeCutoff),
    3,
  );
});

test('rolling a day back removes later medals and restores earlier milestones', () => {
  assert.deepEqual(getEarnedMilestone(7), {
    day: 7,
    name: 'Silver Medal',
  });
  assert.equal(getEarnedMilestone(2), null);
  assert.deepEqual(getNextMilestone(2), {
    day: 3,
    name: 'Bronze Medal',
  });
  assert.deepEqual(getNextMilestone(0), {
    day: 3,
    name: 'Bronze Medal',
  });
});

test('current medal plate always shows the highest medal still held', () => {
  const cases = [
    [0, null],
    [2, null],
    [3, 'Bronze Medal'],
    [6, 'Bronze Medal'],
    [7, 'Silver Medal'],
    [13, 'Silver Medal'],
    [14, 'Gold Medal'],
    [30, 'Gold Medal'],
    [31, 'Diamond Medal'],
    [89, 'Diamond Medal'],
    [90, 'Platinum Medal'],
    [91, 'Platinum Medal'],
  ];

  for (const [day, medalName] of cases) {
    assert.equal(getCurrentMilestone(day)?.name ?? null, medalName);
  }
});
