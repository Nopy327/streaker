import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STORAGE = process.env.SYNC_STORAGE || '/data';
const CURRENT = join(STORAGE, 'current');
const PREVIOUS = join(STORAGE, 'previous');
const MARKER = '.sync-exported-at';
const MAX = 64 * 1024 * 1024;
const JSON_FILES = new Set([
  'card-management.json', 'tracker-state.json', 'subscriptions.json',
  'delivery-state.json', 'spectate-state.json', 'attachment-state.json', 'gif-state.json'
]);
const RUNTIME = ['subscriptions.json', 'delivery-state.json', 'spectate-state.json'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function permitted(path) {
  return JSON_FILES.has(path) ||
    /^(attachments\/[a-f0-9]{64}\.bin|gifs\/[a-f0-9]{64}\.gif|card-backgrounds\/[a-z0-9-]{1,100}\.jpg)$/.test(path);
}

function validate(bytes) {
  if (bytes.length > MAX) throw Error('Package exceeds 64 MiB.');
  const pkg = JSON.parse(bytes.toString('utf8'));
  if (pkg.format !== 'streaker-data-package' || pkg.version !== 1 ||
      !Array.isArray(pkg.files) || pkg.files.length > 500 ||
      typeof pkg.exportedAt !== 'string' || !Number.isFinite(Date.parse(pkg.exportedAt))) {
    throw Error('Unsupported package format.');
  }
  const files = new Map();
  for (const item of pkg.files) {
    if (typeof item.path !== 'string' || !permitted(item.path) || files.has(item.path) ||
        item.encoding !== 'base64' || typeof item.data !== 'string') throw Error('Invalid package file.');
    const data = Buffer.from(item.data, 'base64');
    if (data.toString('base64') !== item.data || data.length !== item.byteLength || sha(data) !== item.sha256) {
      throw Error('Package checksum mismatch.');
    }
    if (JSON_FILES.has(item.path) && !object(JSON.parse(data.toString('utf8')))) throw Error('Invalid JSON state.');
    if (/^(attachments|gifs)\//.test(item.path) && item.path.split('/')[1].split('.')[0] !== sha(data)) {
      throw Error('Media filename does not match its checksum.');
    }
    files.set(item.path, data);
  }
  for (const name of JSON_FILES) if (!files.has(name)) throw Error('Incomplete package.');
  const state = JSON.parse(files.get('tracker-state.json'));
  const management = JSON.parse(files.get('card-management.json'));
  if (state.version !== 3 || !object(state.records) || !object(state.dayAnchors) ||
      !object(state.notes) || !object(state.dayHistory?.outcomes) ||
      !object(management.people) || !object(management.archived) || !object(management.activity)) {
    throw Error('Invalid tracker or card data.');
  }
  for (const [id, person] of Object.entries({...management.people, ...management.archived})) {
    if (!/^[a-z0-9-]{1,100}$/.test(id) || !object(person) || typeof person.name !== 'string' ||
        !object(person.startDate) || !object(person.dayEnd) || !Number.isInteger(person.dayEnd.hour) ||
        person.dayEnd.hour < 0 || person.dayEnd.hour > 23 || !Number.isInteger(person.dayEnd.minute) ||
        person.dayEnd.minute < 0 || person.dayEnd.minute > 59 || typeof person.timeZone !== 'string') throw Error('Invalid card settings.');
    new Intl.DateTimeFormat('en', { timeZone: person.timeZone }).format();
  }
  for (const [name, folder, extension] of [['attachment-state.json','attachments','bin'], ['gif-state.json','gifs','gif']]) {
    const index = JSON.parse(files.get(name));
    if (!object(index.byPerson)) throw Error('Invalid media index.');
    for (const entry of Object.values(index.byPerson)) {
      if (!entry || typeof entry.hash !== 'string' ||
          (!files.has(`${folder}/${entry.hash}.${extension}`) && !files.has(`gifs/${entry.hash}.gif`))) throw Error('Missing media file.');
    }
  }
  return { files, exportedAt: pkg.exportedAt };
}

if (process.argv[2] === '--check') {
  const result = validate(readFileSync(process.argv[3]));
  console.log(`Valid package: ${result.files.size} files.`);
  process.exit(0);
}

const owner = process.env.STREAKER_OWNER_ID?.trim();
const token = process.env.DISCORD_TOKEN?.trim();
if (!/^\d{17,20}$/.test(owner ?? '')) throw Error('Set STREAKER_OWNER_ID to your Discord user ID.');
if (!token) throw Error('Set DISCORD_TOKEN.');
mkdirSync(STORAGE, { recursive: true, mode: 0o700 });
if (!existsSync(CURRENT) && existsSync(PREVIOUS)) renameSync(PREVIOUS, CURRENT);
let bot = null;
let busy = false;
let stopping = false;

function startBot() {
  if (bot) return;
  mkdirSync(CURRENT, { recursive: true, mode: 0o700 });
  bot = spawn(process.execPath, ['--experimental-strip-types', 'scripts/discord-streak-bot.mjs'], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, STREAKER_DATA_DIR: CURRENT }
  });
  const child = bot;
  child.on('message', message => { if (child === bot) void handleImport(message); });
  child.on('error', () => { console.error('Bot failed to start.'); process.exit(1); });
  child.on('exit', () => {
    if (bot === child) bot = null;
    if (!stopping) process.exit(1);
  });
}

async function stopBot() {
  if (!bot) return;
  stopping = true;
  const child = bot;
  const done = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.kill('SIGTERM');
  try { await done; } finally { clearTimeout(timer); stopping = false; }
}

function write(dir, path, data) {
  const destination = join(dir, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, data, { mode: 0o600 });
}

async function install(pkg) {
  const old = existsSync(join(CURRENT, MARKER)) ? readFileSync(join(CURRENT, MARKER), 'utf8') : null;
  if (old && Date.parse(pkg.exportedAt) <= Date.parse(old)) throw Error('Package is not newer than current data.');
  const stage = mkdtempSync(join(STORAGE, '.incoming-'));
  try {
    for (const [path, data] of pkg.files) write(stage, path, data);
    write(stage, MARKER, pkg.exportedAt);
    await stopBot();
    if (old) {
      // Keep Railway's live Discord connections and delivery history after the first import.
      for (const path of RUNTIME) if (existsSync(join(CURRENT, path))) copyFileSync(join(CURRENT, path), join(stage, path));
      const management = readJson(join(stage, 'card-management.json'));
      const live = readJson(join(CURRENT, 'card-management.json'));
      management.activity = { ...management.activity, ...live.activity };
      write(stage, 'card-management.json', JSON.stringify(management));
      // Preserve blobs potentially referenced by pending deliveries.
      for (const folder of ['attachments', 'gifs']) {
        const source = join(CURRENT, folder);
        if (!existsSync(source)) continue;
        for (const filename of readdirSync(source)) {
          const path = `${folder}/${filename}`;
          if (permitted(path) && !existsSync(join(stage, path))) write(stage, path, readFileSync(join(CURRENT, path)));
        }
      }
    }
    rmSync(PREVIOUS, { recursive: true, force: true });
    if (existsSync(CURRENT)) renameSync(CURRENT, PREVIOUS);
    try { renameSync(stage, CURRENT); }
    catch (error) { if (existsSync(PREVIOUS)) renameSync(PREVIOUS, CURRENT); throw error; }
  } finally {
    rmSync(stage, { recursive: true, force: true });
    startBot();
  }
}

async function reply(channel, content) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (https://discord.com/developers/applications, 1.0.0)' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw Error(`Discord reply failed: ${res.status}`);
}

async function download(attachment) {
  if (!attachment || typeof attachment.filename !== 'string' || !attachment.filename.endsWith('.streaker.json') ||
      !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > MAX) throw Error('Invalid or oversized package.');
  const url = new URL(attachment.url);
  if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
      url.port || url.username || url.password || !url.pathname.startsWith('/attachments/')) throw Error('Invalid attachment URL.');
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw Error('Download failed.');
  const chunks = []; let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX || size > attachment.size) throw Error('Package exceeds size limit.');
    chunks.push(chunk);
  }
  if (size !== attachment.size) throw Error('Incomplete download.');
  return Buffer.concat(chunks, size);
}

async function handleImport(message) {
  if (message?.type !== 'streaker-import' || message.authorId !== owner || !/^\d{17,20}$/.test(message.channelId ?? '')) return;
  const channel = message.channelId;
  if (busy) { await reply(channel, 'An import is already running.').catch(() => {}); return; }
  busy = true;
  try {
    const bytes = await download(message.attachment);
    let pkg;
    try { pkg = validate(bytes); } catch { throw Error('Invalid or incomplete Streaker package.'); }
    await install(pkg);
    await reply(channel, `Synchronization successful. Imported ${pkg.files.size} files. Streaker is restarting.`).catch(() => console.error('Import completed, but confirmation failed.'));
  } catch (error) {
    const safe = ['Package is not newer than current data.', 'Invalid or incomplete Streaker package.', 'Invalid or oversized package.', 'Download failed.', 'Incomplete download.', 'Package exceeds size limit.', 'Invalid attachment URL.'];
    await reply(channel, `Synchronization failed: ${safe.includes(error.message) ? error.message : 'Import failed.'}`).catch(() => {});
    console.error('Synchronization failed.');
  } finally { busy = false; }
}

startBot();
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await stopBot(); process.exit(0); });
