import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

export const MAX_GIF_BYTES = 20 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
import { PERSON_IDS as CARD_IDS } from '../lib/streak-engine.ts';
const PERSON_IDS = { has: (id) => CARD_IDS.includes(id), [Symbol.iterator]: () => CARD_IDS[Symbol.iterator]() };

function indexPath(dataDir) {
  return join(dataDir, 'gif-state.json');
}

function assetDir(dataDir) {
  return join(dataDir, 'gifs');
}

function writeIndex(dataDir, value) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = indexPath(dataDir);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function loadGifIndex(dataDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(indexPath(dataDir), 'utf8'));
  } catch {
    return { version: 1, byPerson: {} };
  }
  const byPerson = {};
  for (const personId of Object.keys(parsed?.byPerson ?? {}).filter(id => /^[a-z0-9-]+$/.test(id))) {
    const entry = parsed?.byPerson?.[personId];
    if (
      entry &&
      HASH_PATTERN.test(entry.hash) &&
      typeof entry.name === 'string' &&
      typeof entry.thumbnailDataUrl === 'string' &&
      entry.thumbnailDataUrl.startsWith('data:image/png;base64,')
    ) {
      byPerson[personId] = entry;
    }
  }
  return { version: 1, byPerson };
}

export function normalizeGifName(name) {
  const base = String(name || 'attached.gif')
    .split(/[\\/]/)
    .at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return base.toLowerCase().endsWith('.gif') ? base : `${base || 'attached'}.gif`;
}

export async function saveGif(dataDir, personId, name, bytes) {
  if (!PERSON_IDS.has(personId)) throw new Error('Unknown card.');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_GIF_BYTES) {
    throw new Error('Choose a GIF under 20 MB.');
  }
  if (!['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    throw new Error('The selected file is not a GIF.');
  }
  const image = sharp(bytes, { animated: false, limitInputPixels: 20_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== 'gif') throw new Error('The selected file is not a GIF.');
  const thumbnail = await sharp(bytes, { animated: false, limitInputPixels: 20_000_000 })
    .resize(112, 80, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
  const hash = createHash('sha256').update(bytes).digest('hex');
  const directory = assetDir(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${hash}.gif`);
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  const index = loadGifIndex(dataDir);
  index.byPerson[personId] = {
    hash,
    name: normalizeGifName(name),
    thumbnailDataUrl: `data:image/png;base64,${thumbnail.toString('base64')}`,
  };
  writeIndex(dataDir, index);
  return getGifMeta(dataDir, personId);
}

export function getGifMeta(dataDir, personId) {
  if (!PERSON_IDS.has(personId)) return null;
  const entry = loadGifIndex(dataDir).byPerson[personId];
  if (!entry) return null;
  return { name: entry.name, thumbnailDataUrl: entry.thumbnailDataUrl };
}

export function getGifForPerson(dataDir, personId) {
  if (!PERSON_IDS.has(personId)) return null;
  const entry = loadGifIndex(dataDir).byPerson[personId];
  if (!entry) return null;
  return { hash: entry.hash, name: entry.name };
}

export function getGifBytes(dataDir, hash) {
  if (!HASH_PATTERN.test(hash)) throw new Error('Invalid GIF reference.');
  return readFileSync(join(assetDir(dataDir), `${hash}.gif`));
}

export function removeGif(dataDir, personId) {
  if (!/^[a-z0-9-]+$/.test(personId)) throw new Error('Unknown card.');
  const index = loadGifIndex(dataDir);
  delete index.byPerson[personId];
  writeIndex(dataDir, index);
}

export function pruneGifAssets(dataDir, pendingHashes = []) {
  const directory = assetDir(dataDir);
  if (!existsSync(directory)) return;
  const keep = new Set([
    ...Object.values(loadGifIndex(dataDir).byPerson).map((entry) => entry.hash),
    ...pendingHashes,
  ]);
  for (const filename of readdirSync(directory)) {
    const match = /^([a-f0-9]{64})\.gif$/.exec(filename);
    if (match && !keep.has(match[1])) unlinkSync(join(directory, filename));
  }
}
