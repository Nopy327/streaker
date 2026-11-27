import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import sharp from 'sharp';

export const MAX_BACKGROUND_BYTES = 20 * 1024 * 1024;
export const MIN_BACKGROUND_WIDTH = 1200;
export const MIN_BACKGROUND_HEIGHT = 480;

const BACKGROUND_WIDTH = 2400;
const BACKGROUND_HEIGHT = 960;
const BACKGROUND_DIRECTORY = 'card-backgrounds';

function backgroundPath(dataDirectory, personId) {
  return join(dataDirectory, BACKGROUND_DIRECTORY, `${personId}.jpg`);
}

export async function prepareCardBackground(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('Choose a PNG, JPEG, or WebP image.');
  }
  if (bytes.length > MAX_BACKGROUND_BYTES) {
    throw new Error('Choose an image under 20 MB.');
  }

  let metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: 60_000_000 }).metadata();
  } catch {
    throw new Error('Discord could not read that image. Use PNG, JPEG, or WebP.');
  }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new Error('Use a PNG, JPEG, or WebP image.');
  }

  const swapsDimensions = [5, 6, 7, 8].includes(metadata.orientation ?? 1);
  const width = swapsDimensions ? metadata.height : metadata.width;
  const height = swapsDimensions ? metadata.width : metadata.height;
  if (!width || !height || width < MIN_BACKGROUND_WIDTH || height < MIN_BACKGROUND_HEIGHT) {
    throw new Error(`Use an image at least ${MIN_BACKGROUND_WIDTH}×${MIN_BACKGROUND_HEIGHT}px so the card stays sharp.`);
  }

  const base = sharp(bytes, { limitInputPixels: 60_000_000 }).rotate();
  const blurredBackdrop = await base
    .clone()
    .resize(BACKGROUND_WIDTH, BACKGROUND_HEIGHT, {
      fit: 'cover',
      position: 'attention',
      kernel: sharp.kernel.lanczos3,
    })
    .blur(28)
    .modulate({ brightness: 0.72, saturation: 0.88 })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const containedImage = await base
    .clone()
    .resize(BACKGROUND_WIDTH, BACKGROUND_HEIGHT, {
      fit: 'contain',
      kernel: sharp.kernel.lanczos3,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return sharp(blurredBackdrop)
    .composite([{ input: containedImage, gravity: 'center' }])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

export async function saveCardBackground(dataDirectory, personId, bytes) {
  const prepared = await prepareCardBackground(bytes);
  const directory = join(dataDirectory, BACKGROUND_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = backgroundPath(dataDirectory, personId);
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, prepared, { mode: 0o600 });
  renameSync(temporary, destination);
}

export function removeCardBackground(dataDirectory, personId) {
  const path = backgroundPath(dataDirectory, personId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function getCardBackgroundDataUri(dataDirectory, personId) {
  const path = backgroundPath(dataDirectory, personId);
  if (!existsSync(path)) return null;
  return `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`;
}

export function getCardBackgroundFile(dataDirectory, personId) {
  const path = backgroundPath(dataDirectory, personId);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    return {
      bytes: readFileSync(path),
      modifiedAt: stat.mtime.toUTCString(),
      etag: `"${stat.size}-${Math.trunc(stat.mtimeMs)}"`,
    };
  } catch {
    return null;
  }
}
