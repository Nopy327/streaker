import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
  getCardBackgroundDataUri,
  getCardBackgroundFile,
  prepareCardBackground,
  removeCardBackground,
  saveCardBackground,
} from '../scripts/discord-background.mjs';
import { createCardModel, renderStreakCardPng, renderStreakCardSvg } from '../scripts/discord-card.mjs';

test('background preparation creates a sharp card-sized image without cropping the source', async () => {
  const source = await sharp({
    create: {
      width: 1200,
      height: 1600,
      channels: 3,
      background: '#a78bfa',
    },
  }).jpeg().toBuffer();
  const prepared = await prepareCardBackground(source);
  const metadata = await sharp(prepared).metadata();

  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 2400);
  assert.equal(metadata.height, 960);
});

test('low-resolution backgrounds are rejected', async () => {
  const source = await sharp({
    create: {
      width: 600,
      height: 300,
      channels: 3,
      background: '#a78bfa',
    },
  }).png().toBuffer();

  await assert.rejects(
    prepareCardBackground(source),
    /at least 1200×480px/,
  );
});

test('saved backgrounds render on the card and can be reset to the default', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'streak-card-background-'));
  try {
    const source = await sharp({
      create: {
        width: 1600,
        height: 900,
        channels: 3,
        background: '#7c3aed',
      },
    }).webp().toBuffer();
    await saveCardBackground(directory, 'nopy', source);
    const backgroundFile = getCardBackgroundFile(directory, 'nopy');
    assert.ok(backgroundFile?.bytes.length);
    assert.match(backgroundFile.modifiedAt, /GMT$/);
    assert.match(backgroundFile.etag, /^"\d+-\d+"$/);
    const dataUri = getCardBackgroundDataUri(directory, 'nopy');
    assert.match(dataUri, /^data:image\/jpeg;base64,/);

    const model = createCardModel('nopy', {}, new Date('2026-09-30T12:00:00Z'));
    const svg = renderStreakCardSvg(model, { backgroundDataUri: dataUri });
    assert.match(svg, /<image href="data:image\/jpeg;base64,/);
    const png = await renderStreakCardPng('nopy', {}, new Date('2026-09-30T12:00:00Z'), dataUri);
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 2400);
    assert.equal(metadata.height, 960);

    assert.equal(removeCardBackground(directory, 'nopy'), true);
    assert.equal(getCardBackgroundFile(directory, 'nopy'), null);
    assert.equal(getCardBackgroundDataUri(directory, 'nopy'), null);
    assert.equal(removeCardBackground(directory, 'nopy'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
