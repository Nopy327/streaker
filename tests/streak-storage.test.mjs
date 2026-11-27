import assert from 'node:assert/strict';
import test from 'node:test';

import { PEOPLE } from '../lib/streak-engine.ts';
import {
  getXRate,
  migrateCalendarRecordsToCutoffWindows,
} from '../lib/streak-storage.ts';

function emptyRecords() {
  return { nopy: {}, chile: {}, void: {} };
}

test('missing X-Rate values immediately count as zero', () => {
  const xRate = getXRate(
    emptyRecords(),
    'nopy',
    new Date('2026-09-14T12:00:00.000Z'),
    PEOPLE.nopy.timeZone,
  );

  assert.equal(xRate.value, 0);
  assert.equal(xRate.today.value, 0);
  assert.equal(xRate.yesterday.value, 0);
});

test('yesterday is the previous local date before the cutoff', () => {
  const records = emptyRecords();
  records.nopy['2026-09-13'] = 4;

  const xRate = getXRate(
    records,
    'nopy',
    new Date('2026-09-14T12:00:00.000Z'),
    PEOPLE.nopy.timeZone,
  );

  assert.equal(xRate.today.key, '2026-09-14');
  assert.equal(xRate.today.value, 0);
  assert.equal(xRate.yesterday.key, '2026-09-13');
  assert.equal(xRate.yesterday.value, 4);
  assert.equal(xRate.value, 4);
});

test('X-Rate dates follow each person through the same instant', () => {
  const now = new Date('2026-09-13T22:30:00.000Z');
  const records = {
    nopy: { '2026-09-14': 3, '2026-09-13': 2 },
    chile: { '2026-09-13': 4, '2026-09-12': 1 },
    void: { '2026-09-13': 5, '2026-09-12': 2 },
  };

  const nopy = getXRate(records, 'nopy', now, PEOPLE.nopy.timeZone);
  const chile = getXRate(records, 'chile', now, 'America/Santiago');
  const voidRate = getXRate(records, 'void', now, PEOPLE.void.timeZone);

  assert.deepEqual(
    [nopy.today.key, nopy.yesterday.key, nopy.value],
    ['2026-09-14', '2026-09-13', 5],
  );
  assert.deepEqual(
    [chile.today.key, chile.yesterday.key, chile.value],
    ['2026-09-13', '2026-09-12', 5],
  );
  assert.deepEqual(
    [voidRate.today.key, voidRate.yesterday.key, voidRate.value],
    ['2026-09-13', '2026-09-12', 7],
  );
});

test('Santiago and Sao Paulo keep distinct winter cutoff windows', () => {
  const now = new Date('2026-07-01T01:30:00.000Z');
  const records = {
    nopy: {},
    chile: { '2026-06-30': 3, '2026-06-29': 2 },
    void: { '2026-07-01': 4, '2026-06-30': 1 },
  };

  const chile = getXRate(records, 'chile', now, 'America/Santiago');
  const voidRate = getXRate(records, 'void', now, PEOPLE.void.timeZone);

  assert.deepEqual(
    [chile.today.key, chile.yesterday.key, chile.value],
    ['2026-06-30', '2026-06-29', 5],
  );
  assert.deepEqual(
    [voidRate.today.key, voidRate.yesterday.key, voidRate.value],
    ['2026-07-01', '2026-06-30', 5],
  );
});

test('X-Rate ignores older windows and rolls at 22:05, not midnight', () => {
  const records = {
    nopy: {
      '2026-09-14': 2,
      '2026-09-13': 3,
      '2026-09-12': 99,
    },
    chile: {},
    void: {},
  };
  const beforeCutoff = getXRate(
    records,
    'nopy',
    new Date('2026-09-14T20:04:59.000Z'),
    PEOPLE.nopy.timeZone,
  );
  const atCutoff = getXRate(
    records,
    'nopy',
    new Date('2026-09-14T20:05:00.000Z'),
    PEOPLE.nopy.timeZone,
  );
  const afterMidnight = getXRate(
    records,
    'nopy',
    new Date('2026-09-14T22:00:00.000Z'),
    PEOPLE.nopy.timeZone,
  );

  assert.deepEqual(
    [beforeCutoff.today.key, beforeCutoff.yesterday.key, beforeCutoff.value],
    ['2026-09-14', '2026-09-13', 5],
  );
  assert.deepEqual(
    [atCutoff.today.key, atCutoff.yesterday.key, atCutoff.value],
    ['2026-09-15', '2026-09-14', 2],
  );
  assert.deepEqual(
    [afterMidnight.today.key, afterMidnight.yesterday.key, afterMidnight.value],
    ['2026-09-15', '2026-09-14', 2],
  );
});

test('legacy calendar entries keep their date before cutoff', () => {
  const records = emptyRecords();
  records.nopy['2026-09-15'] = 0;
  records.nopy['2026-09-16'] = 3;
  const now = new Date('2026-09-16T11:50:00.000Z');

  const migrated = migrateCalendarRecordsToCutoffWindows(records, now);
  const xRate = getXRate(migrated, 'nopy', now, PEOPLE.nopy.timeZone);

  assert.equal(migrated.nopy['2026-09-15'], 0);
  assert.equal(migrated.nopy['2026-09-16'], 3);
  assert.equal(xRate.today.key, '2026-09-16');
  assert.equal(xRate.today.value, 3);
  assert.equal(records.nopy['2026-09-16'], 3);
});
