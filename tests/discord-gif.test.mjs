import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';
import { PEOPLE, applyPeople } from '../lib/streak-engine.ts';

import {
  getGifBytes,
  getGifForPerson,
  getGifMeta,
  pruneGifAssets,
  removeGif,
  saveGif,
} from '../scripts/discord-gif.mjs';

test('GIF attachment stores animation and exposes a still thumbnail', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'streak-gif-test-'));
  try {
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 4, background: '#a78bfa' },
    }).gif().toBuffer();
    const preview = await saveGif(directory, 'nopy', 'test.gif', bytes);
    assert.equal(preview.name, 'test.gif');
    assert.match(preview.thumbnailDataUrl, /^data:image\/png;base64,/);
    const stored = getGifForPerson(directory, 'nopy');
    assert.deepEqual(getGifBytes(directory, stored.hash), bytes);
    const original = structuredClone(PEOPLE);
    try {
      const active = structuredClone(PEOPLE);
      delete active.nopy;
      applyPeople(active);
      await saveGif(directory, 'void', 'another.gif', bytes);
      pruneGifAssets(directory);
      assert.deepEqual(getGifBytes(directory, stored.hash), bytes);
    } finally { applyPeople(original); }
    assert.equal(getGifMeta(directory, 'nopy').name, 'test.gif');
    removeGif(directory, 'nopy');
    pruneGifAssets(directory);
    assert.equal(getGifMeta(directory, 'nopy'), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
