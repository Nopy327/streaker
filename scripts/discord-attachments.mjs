import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { PERSON_IDS } from '../lib/streak-engine.ts';
import { getGifForPerson, getGifMeta, getGifBytes } from './discord-gif.mjs';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TYPES = {
  '.gif': ['image/gif', 'GIF'],
  '.png': ['image/png', '\x89PNG\r\n\x1a\n'],
  '.jpg': ['image/jpeg', '\xff\xd8\xff'],
  '.jpeg': ['image/jpeg', '\xff\xd8\xff'],
  '.webp': ['image/webp', 'RIFF'],
  '.pdf': ['application/pdf', '%PDF-'],
  '.txt': ['text/plain'],
  '.md': ['text/markdown'],
  '.csv': ['text/csv'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK\x03\x04'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK\x03\x04'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PK\x03\x04'],
};
const HASH = /^[a-f0-9]{64}$/;
const directory = dataDir => join(dataDir, 'attachments');
const indexPath = dataDir => join(dataDir, 'attachment-state.json');
function safeName(value) {
  return String(value || 'attachment').split(/[\\/]/).at(-1)
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'attachment';
}
function index(dataDir) {
  try { return JSON.parse(readFileSync(indexPath(dataDir), 'utf8')); } catch { return { version: 1, byPerson: {} }; }
}
function saveIndex(dataDir, value) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(indexPath(dataDir) + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(indexPath(dataDir) + '.tmp', indexPath(dataDir));
}
export async function saveAttachment(dataDir, personId, fileName, bytes) {
  if (!PERSON_IDS.includes(personId)) throw new Error('Unknown card.');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('Choose a file under 20 MB.');
  const name = safeName(fileName);
  const extension = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  const type = TYPES[extension];
  if (!type) throw new Error('Supported files: GIF, PNG, JPG, WebP, PDF, TXT, MD, CSV, DOCX, XLSX, and PPTX.');
  const [mimeType, signature] = type;
  if (signature) {
    const matches = extension === '.webp'
      ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
      : bytes.subarray(0, Buffer.byteLength(signature, 'binary')).equals(Buffer.from(signature, 'binary'));
    if (!matches) throw new Error('The file contents do not match its extension.');
  }
  if (['.txt', '.md', '.csv'].includes(extension) && bytes.subarray(0, Math.min(512, bytes.length)).includes(0)) {
    throw new Error('That text file contains binary data.');
  }
  let thumbnailDataUrl = null;
  if (mimeType.startsWith('image/')) {
    try {
      const thumbnail = await sharp(bytes, { animated: false, limitInputPixels: 20_000_000 })
        .resize(112, 80, { fit: 'cover', position: 'centre' }).png().toBuffer();
      thumbnailDataUrl = 'data:image/png;base64,' + thumbnail.toString('base64');
    } catch { throw new Error('The selected image could not be read.'); }
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(directory(dataDir), { recursive: true, mode: 0o700 });
  const asset = join(directory(dataDir), hash + '.bin');
  if (!existsSync(asset)) writeFileSync(asset, bytes, { mode: 0o600, flag: 'wx' });
  const saved = index(dataDir);
  saved.byPerson[personId] = { hash, name, mimeType, thumbnailDataUrl };
  saveIndex(dataDir, saved);
  return { name, mimeType, thumbnailDataUrl };
}
export function getAttachmentMeta(dataDir, personId) {
  if (!PERSON_IDS.includes(personId)) return null;
  const entry = index(dataDir).byPerson?.[personId];
  if (entry && HASH.test(entry.hash) && typeof entry.name === 'string') {
    return { name: entry.name, mimeType: entry.mimeType ?? 'application/octet-stream', thumbnailDataUrl: entry.thumbnailDataUrl ?? null };
  }
  const legacyGif = getGifMeta(dataDir, personId);
  return legacyGif ? { ...legacyGif, mimeType: 'image/gif' } : null;
}
export function getAttachment(dataDir, personId) {
  const entry = index(dataDir).byPerson?.[personId];
  if (entry && HASH.test(entry.hash) && typeof entry.name === 'string') {
    return { ...getAttachmentMeta(dataDir, personId), hash: entry.hash };
  }
  const legacyGif = getGifForPerson(dataDir, personId);
  const meta = getGifMeta(dataDir, personId);
  return legacyGif && meta ? { ...legacyGif, ...meta, mimeType: 'image/gif' } : null;
}
export function getAttachmentBytes(dataDir, hash) {
  if (!HASH.test(hash)) throw new Error('Invalid attachment.');
  const path = join(directory(dataDir), hash + '.bin');
  return existsSync(path) ? readFileSync(path) : getGifBytes(dataDir, hash);
}
export function pruneAttachmentAssets(dataDir, pendingHashes = []) {
  const keep = new Set([
    ...Object.values(index(dataDir).byPerson ?? {}).map(value => value.hash),
    ...pendingHashes,
  ]);
  for (const filename of existsSync(directory(dataDir)) ? readdirSync(directory(dataDir)) : []) {
    const match = /^([a-f0-9]{64})\.bin$/.exec(filename);
    if (match && !keep.has(match[1])) unlinkSync(join(directory(dataDir), filename));
  }
}
export function removeAttachment(dataDir, personId, pendingHashes = []) {
  // Permanent deletion happens after the card has left the active registry.
  if (typeof personId !== 'string' || !/^[a-z0-9-]+$/.test(personId)) throw new Error('Unknown card.');
  const saved = index(dataDir);
  delete saved.byPerson[personId];
  saveIndex(dataDir, saved);
  pruneAttachmentAssets(dataDir, pendingHashes);
}
