import assert from 'node:assert/strict';
import test from 'node:test';
import { PEOPLE } from '../lib/streak-engine.ts';

import {
  activeDateKey,
  emptyDayHistory,
  monthDateKeys,
  parseDayHistory,
  setDayOutcome,
  visibleDayOutcome,
} from '../lib/day-outcomes.ts';

test('date boxes follow each local 22:05 cutoff and switch to the new month', () => {
  assert.equal(activeDateKey('nopy', new Date('2026-09-17T20:04:59Z')), '2026-09-17');
  assert.equal(activeDateKey('nopy', new Date('2026-09-17T20:05:00Z')), '2026-09-18');
  assert.equal(activeDateKey('void', new Date('2026-09-18T01:04:59Z')), '2026-09-17');
  assert.equal(activeDateKey('void', new Date('2026-09-18T01:05:00Z')), '2026-09-18');
  assert.equal(activeDateKey('void', new Date('2026-09-18T01:05:00Z')), '2026-09-18');
  assert.deepEqual(monthDateKeys('2026-12-01').slice(0, 2), ['2026-12-01', '2026-12-02']);
  assert.equal(monthDateKeys('2026-12-01').length, 31);
});

test('legacy dates stay unchanged before automatic marking is enabled', () => {
  const history = emptyDayHistory();
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-15', '2026-09-17'), null);
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-16', '2026-09-17'), null);
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-17', '2026-09-17'), null);
});

test('automatic purple begins only at completion and keeps red overrides while unmarked days complete', () => {
  const previous = PEOPLE.nopy.automaticFrom;
  PEOPLE.nopy.automaticFrom = '2026-10-23';
  try {
    let history = emptyDayHistory();
    assert.equal(visibleDayOutcome(history, 'nopy', '2026-10-22', '2026-10-24'), null);
    assert.equal(visibleDayOutcome(history, 'nopy', '2026-10-23', '2026-10-23'), null);
    assert.equal(visibleDayOutcome(history, 'nopy', '2026-10-23', '2026-10-24'), 'completed');
    assert.equal(visibleDayOutcome(history, 'nopy', '2026-10-25', '2026-10-24'), null);
    history = setDayOutcome(history, 'nopy', '2026-10-23', null);
    history = parseDayHistory(JSON.parse(JSON.stringify(history)));
    assert.equal(history.outcomes.nopy['2026-10-23'], undefined);
    assert.equal(visibleDayOutcome(history, 'nopy', '2026-10-23', '2026-10-24'), 'completed');
    history = setDayOutcome(history, 'nopy', '2026-10-23', 'reset');
    assert.equal(visibleDayOutcome(history, 'nopy', '2026-10-23', '2026-10-24'), 'reset');
  } finally { PEOPLE.nopy.automaticFrom = previous; }
});

test('manual red and purple stay attached to their exact dates', () => {
  let history = setDayOutcome(emptyDayHistory(), 'nopy', '2026-09-15', 'reset');
  history = setDayOutcome(history, 'nopy', '2026-09-17', 'completed');
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-15', '2026-09-17'), 'reset');
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-16', '2026-09-17'), null);
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-17', '2026-09-17'), null);
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-17', '2026-09-18'), 'completed');
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-18', '2026-09-17'), null);
  history = setDayOutcome(history, 'nopy', '2026-09-15', null);
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-15', '2026-09-17'), null);
});

test('stored manual dates are validated and unrelated people remain separate', () => {
  const history = parseDayHistory({
    outcomes: {
      nopy: { '2026-09-14': 'completed', '2026-99-99': 'reset' },
      void: { '2026-09-14': 'reset' },
    },
  });
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-09-14', '2026-09-17'), 'completed');
  assert.equal(visibleDayOutcome(history, 'void', '2026-09-14', '2026-09-17'), 'reset');
  assert.equal(visibleDayOutcome(history, 'nopy', '2026-99-99', '2026-09-17'), null);
});
