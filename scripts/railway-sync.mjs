import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
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

const token = process.env.STREAKER_SYNC_TOKEN;
if (!token || token.length < 32) throw Error('Set STREAKER_SYNC_TOKEN to a strong secret.');
mkdirSync(STORAGE, { recursive: true, mode: 0o700 });
if (!existsSync(CURRENT) && existsSync(PREVIOUS)) renameSync(PREVIOUS, CURRENT);
let bot = null;
let busy = false;
let stopping = false;

function startBot() {
  if (bot || !existsSync(join(CURRENT, MARKER))) return;
  bot = spawn(process.execPath, ['--experimental-strip-types', 'scripts/discord-streak-bot.mjs'], {
    cwd: ROOT, stdio: 'inherit', env: process.env
  });
  const child = bot;
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

function reply(response, status, body) {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}).end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return reply(response, 200, {ok: true});
  if (request.method !== 'POST' || request.url !== '/sync') return reply(response, 404, {error: 'Not found.'});
  const supplied = String(request.headers.authorization || '');
  if (!timingSafeEqual(Buffer.from(sha(supplied)), Buffer.from(sha(`Bearer ${token}`)))) return reply(response, 401, {error: 'Unauthorized.'});
  if (busy) return reply(response, 409, {error: 'An import is already running.'});
  if (!String(request.headers['content-type']).startsWith('application/json')) return reply(response, 415, {error: 'Use application/json.'});
  busy = true;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX) { reply(response, 413, {error: 'Package too large.'}); return; }
      chunks.push(chunk);
    }
    let pkg;
    try { pkg = validate(Buffer.concat(chunks)); }
    catch { return reply(response, 400, {error: 'Invalid or incomplete package.'}); }
    try { await install(pkg); }
    catch (error) {
      if (error.message === 'Package is not newer than current data.') return reply(response, 409, {error: error.message});
      console.error('Package installation failed.');
      return reply(response, 500, {error: 'Import failed.'});
    }
    reply(response, 200, {ok: true, files: pkg.files.size, exportedAt: pkg.exportedAt});
  } catch { if (!response.headersSent) reply(response, 400, {error: 'Upload interrupted.'}); }
  finally { busy = false; }
});
server.requestTimeout = 120000;
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
startBot();
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => { await stopBot(); server.close(() => process.exit(0)); });
