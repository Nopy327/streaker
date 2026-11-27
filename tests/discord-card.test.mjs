import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import {
  createCardModel,
  getLatestCutoffKey,
  renderStreakCardPng,
  renderStreakCardSvg,
} from '../scripts/discord-card.mjs';

test('daily reports roll exactly at each local 22:05 cutoff', () => {
  assert.equal(
    getLatestCutoffKey('nopy', new Date('2026-09-15T20:04:59.000Z')),
    '2026-09-14',
  );
  assert.equal(
    getLatestCutoffKey('nopy', new Date('2026-09-15T20:05:00.000Z')),
    '2026-09-15',
  );
  assert.equal(
    getLatestCutoffKey('void', new Date('2026-09-16T01:05:00.000Z')),
    '2026-09-15',
  );
  assert.equal(
    getLatestCutoffKey('void', new Date('2026-09-16T01:05:00.000Z')),
    '2026-09-15',
  );
});

test('card model includes mirrored edits and person-local X-Rate dates', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const state = {
    records: {
      nopy: { '2026-09-15': 2, '2026-09-14': 3 },
      void: {},
    },
    dayAnchors: {
      nopy: { completedDays: 4, anchoredAt: now.toISOString() },
    },
    dayHistory: {
      outcomes: {
        nopy: { '2026-09-14': 'completed', '2026-09-15': 'reset' },
          void: {},
      },
    },
    notes: { nopy: 'Keep going', void: '' },
  };
  const model = createCardModel('nopy', state, now);

  assert.equal(model.day, 4);
  assert.equal(model.completedDays, 3);
  assert.equal(model.progress, 3.3);
  assert.equal(model.medal?.name, 'Bronze Medal');
  assert.equal(model.next?.name, 'Silver Medal');
  assert.equal(model.xRate.value, 5);
  assert.equal(model.xRate.today.key, '2026-09-15');
  assert.equal(model.xRate.yesterday.key, '2026-09-14');
  assert.equal(model.note, 'Keep going');
  assert.equal(model.dateBoxes.find((box) => box.dateKey === '2026-09-14')?.status, 'completed');
  assert.equal(model.dateBoxes.find((box) => box.dateKey === '2026-09-15')?.status, 'reset');
  assert.equal(model.dateBoxes.find((box) => box.dateKey === '2026-09-16')?.status, 'upcoming');
  const svg = renderStreakCardSvg(model);
  assert.match(svg, />Today<\/text>/);
  assert.match(svg, />Yesterday<\/text>/);
  assert.doesNotMatch(svg, /Keep going/);
  assert.doesNotMatch(svg, />Note<\/text>/);
  assert.match(svg, /data-date-key="2026-09-14" data-status="completed"/);
  assert.match(svg, /data-date-key="2026-09-15" data-status="reset"/);
});

test('date boxes use each person’s current 22:05-local month and do not infer history', () => {
  const now = new Date('2026-10-01T00:30:00.000Z');
  const nopy = createCardModel('nopy', {}, now);
  const brazil = createCardModel('void', {}, now);
  assert.equal(nopy.dateBoxes[0].dateKey, '2026-10-01');
  assert.equal(nopy.dateBoxes[0].status, 'ongoing');
  assert.equal(nopy.dateBoxes.length, 31);
  const svg = renderStreakCardSvg(nopy);
  assert.equal((svg.match(/data-date-key=/g) ?? []).length, 31);
  assert.match(svg, /data-date-key="2026-10-31"/);
  assert.equal(brazil.dateBoxes[0].dateKey, '2026-09-01');
  assert.equal(brazil.dateBoxes.length, 30);
  assert.equal(brazil.dateBoxes.at(-1).status, 'ongoing');
  assert.equal(brazil.dateBoxes[0].status, 'unmarked');
});

test('an ongoing milestone day does not award its medal early', () => {
  const now = new Date('2026-09-15T12:00:00.000Z');
  const model = createCardModel(
    'nopy',
    {
      records: {},
      dayAnchors: {
        nopy: { completedDays: 3, anchoredAt: now.toISOString() },
      },
    },
    now,
  );

  assert.equal(model.day, 3);
  assert.equal(model.completedDays, 2);
  assert.equal(model.medal, null);
  assert.equal(model.next?.name, 'Bronze Medal');
  assert.equal(model.next?.day - model.completedDays, 1);
});

test('horizontal Discord card renders as a compact high-resolution PNG', async () => {
  const png = await renderStreakCardPng(
    'nopy',
    { records: {}, dayAnchors: {} },
    new Date('2026-09-15T12:00:00.000Z'),
  );
  const metadata = await sharp(png).metadata();

  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2400);
  assert.equal(metadata.height, 960);
});
