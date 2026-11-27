import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = join(APP_DIR, '.discord-bot', 'config.json');

const input = await new Promise((resolve) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
});

const [botToken = ''] = input
  .split(/\r?\n/)
  .map((value) => value.trim());

if (botToken.length < 20) throw new Error('The bot token looks incomplete.');

mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
writeFileSync(
  CONFIG_PATH,
  `${JSON.stringify({ version: 2, botToken }, null, 2)}\n`,
  { mode: 0o600 },
);

console.log('Bot token saved. Friends can now use /connect in Discord.');
