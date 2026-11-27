import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PEOPLE } from '../lib/streak-engine.ts';
import { createCardManagement } from './card-management.mjs';
import {
  PERSON_IDS,
  getLatestCutoffKey,
  normalizeTrackerState,
} from './discord-card.mjs';
import { sendCardImage } from './discord-card-message.mjs';
import {
  MAX_BACKGROUND_BYTES,
  getCardBackgroundDataUri,
  getCardBackgroundFile,
  removeCardBackground,
  saveCardBackground,
} from './discord-background.mjs';
import { createNoteMessagePayload } from './discord-note.mjs';
import { resolvePeekTarget, sendPeekCardReply } from './discord-peek.mjs';
import { createSpectateStore } from './discord-spectate.mjs';
import {
  MAX_GIF_BYTES,
  getGifBytes,
  getGifForPerson,
  getGifMeta,
  pruneGifAssets,
  removeGif,
  saveGif,
} from './discord-gif.mjs';
import {
  MAX_ATTACHMENT_BYTES,
  getAttachment,
  getAttachmentBytes,
  getAttachmentMeta,
  pruneAttachmentAssets,
  removeAttachment,
  saveAttachment,
} from './discord-attachments.mjs';

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(APP_DIR, '.discord-bot');
const management = createCardManagement(DATA_DIR);
const spectators = createSpectateStore(DATA_DIR);
let gatewayOnline = false;
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const TRACKER_STATE_PATH = join(DATA_DIR, 'tracker-state.json');
const DELIVERY_STATE_PATH = join(DATA_DIR, 'delivery-state.json');
const SUBSCRIPTIONS_PATH = join(DATA_DIR, 'subscriptions.json');
const DISCORD_API = 'https://discord.com/api/v10';
const LOCAL_PORT = 3211;
const ALLOWED_ORIGINS = new Set([
  'http://localhost:3210',
  'http://127.0.0.1:3210',
]);

class DiscordApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'DiscordApiError';
    this.status = status;
    this.code = code;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

function loadConfig() {
  const value = readJson(CONFIG_PATH, null);
  if (!value || typeof value !== 'object') return null;
  if (typeof value.botToken !== 'string' || value.botToken.length < 20) {
    return null;
  }
  return { botToken: value.botToken };
}

function loadSubscriptions() {
  const value = readJson(SUBSCRIPTIONS_PATH, null);
  const byPerson = {};
  for (const personId of PERSON_IDS) {
    const entry = value?.byPerson?.[personId];
    if (entry && /^\d{15,25}$/.test(entry.userId)) {
      byPerson[personId] = { userId: entry.userId, connectedAt: entry.connectedAt };
    }
  }
  return { version: 1, byPerson };
}

function saveSubscriptions(value) {
  writeJsonAtomic(SUBSCRIPTIONS_PATH, value);
}

function loadTrackerState() {
  return normalizeTrackerState(readJson(TRACKER_STATE_PATH, null));
}

function loadDeliveryState() {
  const value = readJson(DELIVERY_STATE_PATH, null);
  return {
    version: 2,
    lastCutoffByPerson:
      value?.lastCutoffByPerson && typeof value.lastCutoffByPerson === 'object'
        ? value.lastCutoffByPerson
        : {},
    dmChannelByUser:
      value?.dmChannelByUser && typeof value.dmChannelByUser === 'object'
        ? value.dmChannelByUser
        : {},
    lastMessageByPerson:
      value?.lastMessageByPerson && typeof value.lastMessageByPerson === 'object'
        ? value.lastMessageByPerson
        : {},
    pendingTextByPerson:
      value?.pendingTextByPerson && typeof value.pendingTextByPerson === 'object'
        ? value.pendingTextByPerson
        : {},
    pendingGifByPerson:
      value?.pendingGifByPerson && typeof value.pendingGifByPerson === 'object'
        ? value.pendingGifByPerson
        : {},
  };
}

function pruneUnusedGifs(deliveryState = loadDeliveryState()) {
  const pendingHashes = Object.values(deliveryState.pendingGifByPerson)
    .map((entry) => entry?.hash)
    .filter((hash) => typeof hash === 'string');
  pruneGifAssets(DATA_DIR, pendingHashes);
}

function pruneUnusedAttachments(deliveryState = loadDeliveryState()) {
  const pendingHashes = Object.values(deliveryState.pendingGifByPerson)
    .map((entry) => entry?.hash)
    .filter((hash) => typeof hash === 'string');
  pruneAttachmentAssets(DATA_DIR, pendingHashes);
}

async function discordRequest(config, path, options = {}, attempt = 0) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bot ${config.botToken}`);
  headers.set(
    'User-Agent',
    'DiscordBot (https://discord.com/developers/applications, 1.0.0)',
  );

  let response;
  try {
    response = await fetch(`${DISCORD_API}${path}`, { signal: AbortSignal.timeout(20_000), ...options, headers });
  } catch (error) {
    if (attempt < 3) {
      await delay(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      return discordRequest(config, path, options, attempt + 1);
    }
    throw error;
  }

  const responseText = await response.text();
  let body = null;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    body = responseText;
  }

  if (response.ok) return body;

  if (response.status === 429 && attempt < 4) {
    const retrySeconds = Number(
      body?.retry_after ?? response.headers.get('retry-after') ?? 1,
    );
    await delay(Math.max(1000, retrySeconds * 1000) + 150);
    return discordRequest(config, path, options, attempt + 1);
  }

  if (response.status >= 500 && attempt < 3) {
    await delay(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
    return discordRequest(config, path, options, attempt + 1);
  }

  throw new DiscordApiError(
    body?.message || `Discord request failed with status ${response.status}.`,
    response.status,
    body?.code,
  );
}

function reportNonce(reportKey) {
  return createHash('sha256').update(reportKey).digest('hex').slice(0, 25);
}

async function sendCard(config, personId, userId, trackerState, now, options = {}) {
  try {
    const result = await sendCardUnchecked(config, personId, userId, trackerState, now, options);
    management.activity(personId, { lastDeliveredAt: new Date().toISOString(), lastError: null, retryAfter: null });
    return result;
  } catch (error) {
    management.activity(personId, { retryAfter: new Date(Date.now() + 15 * 60_000).toISOString(), lastError: error?.code === 50007
      ? 'Discord cannot deliver DMs. They may have blocked the bot, disabled DMs, or removed access; removal is not confirmed.'
      : 'Card delivery failed. The bot will retry. Check the bot connection.' });
    throw error;
  }
}
async function sendCardUnchecked(config, personId, userId, trackerState, now, options = {}) {
  return sendCardImage({
    request: (path, requestOptions) => discordRequest(config, path, requestOptions),
    personId,
    userId,
    trackerState,
    now,
    backgroundDataUri: getCardBackgroundDataUri(DATA_DIR, personId),
    nonce: options.deduplicateKey ? reportNonce(options.deduplicateKey) : null,
  });
}

async function sendTextMessage(config, channelId, note, deduplicateKey = null) {
  const payload = createNoteMessagePayload(
    note,
    deduplicateKey ? reportNonce(deduplicateKey) : null,
  );
  if (!payload) return null;
  return discordRequest(config, `/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function sendAttachmentMessage(config, channelId, attachment, deduplicateKey = null) {
  if (!attachment) return null;
  const bytes = getAttachmentBytes(DATA_DIR, attachment.hash);
  const mimeType = attachment.mimeType || 'image/gif';
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    ...(deduplicateKey
      ? { nonce: reportNonce(deduplicateKey), enforce_nonce: true }
      : {}),
    allowed_mentions: { parse: [] },
    attachments: [{ id: 0, filename: attachment.name }],
  }));
  form.append('files[0]', new Blob([bytes], { type: mimeType }), attachment.name);
  return discordRequest(config, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: form,
  });
}

async function sendCardTextAndGif(config, personId, userId, trackerState, now) {
  const result = await sendCard(config, personId, userId, trackerState, now);
  try {
    await sendTextMessage(config, result.channelId, result.model.note);
  } catch (error) {
    console.error(friendlyDiscordError(error, 'text'));
    return result;
  }
  try {
    await sendAttachmentMessage(config, result.channelId, getAttachment(DATA_DIR, personId));
  } catch (error) {
    console.error(friendlyDiscordError(error, 'file attachment'));
  }
  const targetId = spectators.target(userId, loadSubscriptions(), new Date());
  if (targetId) {
    // A spectator's DM result must not change the watched owner's delivery status.
    try {
      await sendCardUnchecked(config, targetId, userId, loadTrackerState(), new Date());
    } catch (error) {
      console.error(friendlyDiscordError(error, 'spectated card'));
    }
  }
  return result;
}

async function flushPendingText(config, deliveryState, deliveryKey) {
  const pending = deliveryState.pendingTextByPerson[deliveryKey];
  if (!pending) return;
  await sendTextMessage(
    config,
    pending.channelId,
    pending.content,
    `${deliveryKey}:${pending.cutoffKey}:text`,
  );
  delete deliveryState.pendingTextByPerson[deliveryKey];
  writeJsonAtomic(DELIVERY_STATE_PATH, deliveryState);
}

async function flushPendingGif(config, deliveryState, deliveryKey) {
  const pending = deliveryState.pendingGifByPerson[deliveryKey];
  if (!pending) return;
  await sendAttachmentMessage(
    config,
    pending.channelId,
    pending,
    `${deliveryKey}:${pending.cutoffKey}:gif`,
  );
  delete deliveryState.pendingGifByPerson[deliveryKey];
  writeJsonAtomic(DELIVERY_STATE_PATH, deliveryState);
  pruneUnusedGifs(deliveryState);
  pruneUnusedAttachments(deliveryState);
}

let checkInProgress = false;
let lastLogMessage = '';
let blockedConfigFingerprint = null;

function logOnce(message) {
  if (message === lastLogMessage) return;
  lastLogMessage = message;
  console.log(message);
}

function friendlyDiscordError(error, item = 'card') {
  if (error instanceof DiscordApiError) {
    if (error.status === 401) return 'Discord rejected the bot token. Run setup again.';
    if (error.status === 403 || error.code === 50007 || error.code === 50278) {
      return 'Discord could not open the DM. Share a private server with the bot, allow DMs, and message the bot once.';
    }
    return `Discord could not send the ${item}: ${error.message}`;
  }
  return `The Discord ${item} could not be sent. The bot will try again later.`;
}

const COMMANDS = [
  {
    name: 'spectate',
    description: 'Receive one other card’s image each streak cycle',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      { type: 3, name: 'action', description: 'Watch a card or stop spectating', required: true,
        choices: [{name: 'Watch', value: 'watch'}, {name: 'Stop', value: 'stop'}] },
      { type: 3, name: 'card', description: 'Card to spectate', required: false,
        choices: PERSON_IDS.map(id => ({name: PEOPLE[id].name, value: id})) },
      { type: 3, name: 'code', description: 'Four-digit access code (required without your own card)', required: false, min_length: 4, max_length: 4 },
    ],
  },
  {
    name: 'connect',
    description: 'Privately link your Discord account to a streak card',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        type: 3,
        name: 'card',
        description: 'Your streak card',
        required: true,
        choices: PERSON_IDS.map((id) => ({ name: PEOPLE[id].name, value: id })),
      },
    ],
  },
  {
    name: 'status',
    description: 'DM me my current streak card',
    integration_types: [1],
    contexts: [0, 1, 2],
  },
  {
    name: 'peek',
    description: 'See one other card’s current image',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        type: 3,
        name: 'card',
        description: 'One other streak card',
        required: true,
        choices: PERSON_IDS.map((id) => ({ name: PEOPLE[id].name, value: id })),
      },
    ],
  },
  {
    name: 'background',
    description: 'Set or reset your streak card background',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        type: 3,
        name: 'action',
        description: 'Set a custom image or restore the original background',
        required: true,
        choices: [
          { name: 'Set', value: 'set' },
          { name: 'Reset', value: 'reset' },
        ],
      },
      {
        type: 11,
        name: 'image',
        description: 'PNG, JPEG, or WebP; at least 1200×480px and under 20 MB',
        required: false,
      },
    ],
  },
  {
    name: 'disconnect',
    description: 'Stop my reports and release my streak card',
    integration_types: [1],
    contexts: [0, 1, 2],
  },
];

function interactionUserId(interaction) {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

async function replyToInteraction(config, interaction, content) {
  await discordRequest(
    config,
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 4,
        data: {
          content,
          ...(interaction.context !== 1 ? { flags: 64 } : {}),
          allowed_mentions: { parse: [] },
        },
      }),
    },
  );
}

async function deferInteraction(config, interaction) {
  await discordRequest(
    config,
    `/interactions/${interaction.id}/${interaction.token}/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 5,
        data: interaction.context !== 1 ? { flags: 64 } : {},
      }),
    },
  );
}

async function editInteractionReply(config, interaction, content) {
  await discordRequest(
    config,
    `/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    },
  );
}

async function downloadBackgroundAttachment(attachment) {
  if (!attachment || typeof attachment.url !== 'string') {
    throw new Error('Attach one image when using Set.');
  }
  if (attachment.size > MAX_BACKGROUND_BYTES) {
    throw new Error('Choose an image under 20 MB.');
  }
  const url = new URL(attachment.url);
  if (
    url.protocol !== 'https:' ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
  ) {
    throw new Error('That attachment did not come from Discord.');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Discord could not download that image.');
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BACKGROUND_BYTES) {
    throw new Error('Choose an image under 20 MB.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BACKGROUND_BYTES) {
    throw new Error('Choose an image under 20 MB.');
  }
  return bytes;
}

async function handleInteraction(config, interaction) {
  if (interaction.type !== 2) return;
  const userId = interactionUserId(interaction);
  const command = interaction.data?.name;
  if (!userId) return;

  if (command === 'spectate') {
    const option = name => interaction.data.options?.find(item => item.name === name)?.value;
    try {
      if (option('action') === 'stop') {
        spectators.stop(userId);
        await replyToInteraction(config, interaction, 'Spectating stopped.');
      } else if (option('action') === 'watch') {
        const targetId = option('card');
        const subscriptions = loadSubscriptions();
        spectators.watch(userId, targetId, option('code'), subscriptions);
        const linked = Object.values(subscriptions.byPerson).some(entry => entry.userId === userId);
        await replyToInteraction(config, interaction, `Spectating ${PEOPLE[targetId].name}. ${linked ? 'Their card image will follow your card.' : 'Their card image will arrive at their next streak rollover.'}`);
      } else await replyToInteraction(config, interaction, 'Choose Watch or Stop.');
    } catch (error) {
      await replyToInteraction(config, interaction, error.message);
    }
    return;
  }

  if (command === 'connect') {
    const personId = interaction.data.options?.find((option) => option.name === 'card')?.value;
    if (!PERSON_IDS.includes(personId)) {
      await replyToInteraction(config, interaction, 'Please choose an available card.');
      return;
    }
    const subscriptions = loadSubscriptions();
    const claimed = subscriptions.byPerson[personId];
    if (claimed && claimed.userId !== userId) {
      await replyToInteraction(config, interaction, `${PEOPLE[personId].name} is already connected to another account.`);
      return;
    }
    for (const [otherId, entry] of Object.entries(subscriptions.byPerson)) {
      if (entry.userId === userId && otherId !== personId) {
        delete subscriptions.byPerson[otherId];
        management.activity(otherId, { disconnectedAt: new Date().toISOString() });
      }
    }
    subscriptions.byPerson[personId] = { userId, connectedAt: new Date().toISOString() };
    saveSubscriptions(subscriptions);
    management.activity(personId, { lastInteractionAt: new Date().toISOString(), disconnectedAt: null, lastError: null });
    blockedConfigFingerprint = null;
    await replyToInteraction(
      config,
      interaction,
      `Connected to ${PEOPLE[personId].name}. I am sending your first card by DM now.`,
    );
    try {
      await sendCardTextAndGif(config, personId, userId, loadTrackerState(), new Date());
    } catch (error) {
      console.error(friendlyDiscordError(error));
    }
    return;
  }

  const subscriptions = loadSubscriptions();
  const linked = Object.entries(subscriptions.byPerson).find(([, entry]) => entry.userId === userId);
  if (command === 'peek') {
    let targetId;
    try {
      targetId = resolvePeekTarget(
        userId,
        interaction.data.options?.find(option => option.name === 'card')?.value,
        subscriptions,
        spectators,
      );
    } catch (error) {
      await replyToInteraction(config, interaction, error.message);
      return;
    }
    if (linked) management.activity(linked[0], { lastInteractionAt: new Date().toISOString() });
    try {
      await sendPeekCardReply({
        request: (path, options) => discordRequest(config, path, options),
        interaction,
        userId,
        personId: targetId,
        loadTrackerState,
        loadBackground: id => getCardBackgroundDataUri(DATA_DIR, id),
      });
    } catch (error) {
      console.error(friendlyDiscordError(error, 'peek card'));
    }
    return;
  }
  if (!linked) {
    await replyToInteraction(config, interaction, 'You are not connected yet. Use /connect first.');
    return;
  }
  const [personId] = linked;
  management.activity(personId, { lastInteractionAt: new Date().toISOString() });

  if (command === 'background') {
    const action = interaction.data.options?.find((option) => option.name === 'action')?.value;
    const attachmentId = interaction.data.options?.find((option) => option.name === 'image')?.value;
    if (action === 'reset') {
      const removed = removeCardBackground(DATA_DIR, personId);
      await replyToInteraction(
        config,
        interaction,
        removed
          ? `Restored ${PEOPLE[personId].name}’s original card background.`
          : `${PEOPLE[personId].name} is already using the original card background.`,
      );
      return;
    }
    if (action !== 'set') {
      await replyToInteraction(config, interaction, 'Choose Set or Reset.');
      return;
    }
    const attachment = interaction.data.resolved?.attachments?.[attachmentId];
    if (!attachment) {
      await replyToInteraction(config, interaction, 'Attach one image when using Set.');
      return;
    }

    await deferInteraction(config, interaction);
    try {
      const bytes = await downloadBackgroundAttachment(attachment);
      await saveCardBackground(DATA_DIR, personId, bytes);
      await editInteractionReply(
        config,
        interaction,
        `${PEOPLE[personId].name}’s card background is updated. Use /status to see it.`,
      );
    } catch (error) {
      await editInteractionReply(
        config,
        interaction,
        error instanceof Error ? error.message : 'The background could not be updated.',
      );
    }
    return;
  }

  if (command === 'disconnect') {
    management.activity(personId, { disconnectedAt: new Date().toISOString() });
    delete subscriptions.byPerson[personId];
    saveSubscriptions(subscriptions);
    await replyToInteraction(config, interaction, `Disconnected from ${PEOPLE[personId].name}.`);
    return;
  }

  if (command === 'status') {
    await replyToInteraction(config, interaction, `Sending your ${PEOPLE[personId].name} card by DM…`);
    try {
      await sendCardTextAndGif(config, personId, userId, loadTrackerState(), new Date());
    } catch (error) {
      console.error(friendlyDiscordError(error));
    }
  }
}

async function registerCommands(config) {
  const application = await discordRequest(config, '/oauth2/applications/@me');
  await discordRequest(config, `/applications/${application.id}/commands`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS.filter(command => PERSON_IDS.length || !command.options?.some(option => option.name === 'card')).map(command => ({ ...command, options: command.options?.map(option =>
      option.name === 'card' ? { ...option, choices: PERSON_IDS.map(id => ({ name: PEOPLE[id].name, value: id })) } : option
    ) }))),
  });
  console.log('Discord commands ready: /connect, /status, /peek, /spectate, /background, /disconnect.');
}

async function startDiscordGateway(config) {
  await registerCommands(config);
  const gateway = await discordRequest(config, '/gateway/bot');
  let stopped = false;
  let socket;
  let heartbeatTimer;
  let reconnectTimer;
  let sequence = null;

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(`${gateway.url}/?v=10&encoding=json`);
    socket.addEventListener('message', (event) => {
      const packet = JSON.parse(event.data);
      if (packet.s !== null) sequence = packet.s;
      if (packet.op === 10) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(
          () => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ op: 1, d: sequence })),
          packet.d.heartbeat_interval,
        );
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: config.botToken,
            intents: 0,
            properties: { os: 'macos', browser: 'streak-tracker', device: 'streak-tracker' },
            presence: {
              since: null,
              activities: [{ name: 'your streaks', type: 3 }],
              status: 'online',
              afk: false,
            },
          },
        }));
      }
      if (packet.op === 1 && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: 1, d: sequence }));
      }
      if (packet.t === 'READY') { gatewayOnline = true; console.log(`Discord bot connected as ${packet.d.user.username}.`); }
      if (packet.t === 'INTERACTION_CREATE') {
        void handleInteraction(config, packet.d).catch((error) => console.error(friendlyDiscordError(error)));
      }
    });
    socket.addEventListener('close', () => {
      gatewayOnline = false;
      clearInterval(heartbeatTimer);
      if (!stopped) reconnectTimer = setTimeout(connect, 5000);
    });
    socket.addEventListener('error', () => socket.close());
  };
  connect();
  return () => {
    stopped = true;
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    socket?.close();
  };
}

async function checkScheduledReports(now = new Date()) {
  if (checkInProgress) return;
  checkInProgress = true;
  try {
    const config = loadConfig();
    if (!config) {
      logOnce('Discord reports are waiting for setup.');
      return;
    }
    const subscriptions = loadSubscriptions();
    const configFingerprint = createHash('sha256')
      .update(`${config.botToken}:${JSON.stringify(subscriptions.byPerson)}`)
      .digest('hex');
    if (blockedConfigFingerprint === configFingerprint) return;
    const trackerState = loadTrackerState();
    const deliveryState = loadDeliveryState();
    let changed = false;

    for (const [personId, subscription] of Object.entries(subscriptions.byPerson)) {
      if (Date.parse(management.state.activity[personId]?.retryAfter ?? '') > now.getTime()) continue;
      const cutoffKey = getLatestCutoffKey(personId, now);
      const deliveryKey = `${subscription.userId}:${personId}`;
      if (deliveryState.pendingTextByPerson[deliveryKey]) {
        try {
          await flushPendingText(config, deliveryState, deliveryKey);
        } catch (error) {
          logOnce(friendlyDiscordError(error, 'text'));
          continue;
        }
      }
      if (deliveryState.pendingGifByPerson[deliveryKey]) {
        try {
          await flushPendingGif(config, deliveryState, deliveryKey);
        } catch (error) {
          logOnce(friendlyDiscordError(error, 'GIF'));
          continue;
        }
      }
      const lastCutoff = deliveryState.lastCutoffByPerson[deliveryKey];
      if (!lastCutoff) {
        deliveryState.lastCutoffByPerson[deliveryKey] = cutoffKey;
        changed = true;
        continue;
      }
      if (cutoffKey <= lastCutoff) continue;

      try {
        const result = await sendCard(
          config,
          personId,
          subscription.userId,
          trackerState,
          now,
          { deduplicateKey: `${deliveryKey}:${cutoffKey}` },
        );
        deliveryState.lastCutoffByPerson[deliveryKey] = cutoffKey;
        deliveryState.dmChannelByUser[subscription.userId] = result.channelId;
        deliveryState.lastMessageByPerson[deliveryKey] = result.messageId;
        if (result.model.note !== '') {
          deliveryState.pendingTextByPerson[deliveryKey] = {
            cutoffKey,
            channelId: result.channelId,
            content: result.model.note,
          };
        }
        const attachment = getAttachment(DATA_DIR, personId);
        if (attachment) {
          deliveryState.pendingGifByPerson[deliveryKey] = {
            cutoffKey,
            channelId: result.channelId,
            ...attachment,
          };
        }
        changed = true;
        // Save the card's delivery and follow-up queue before sending either
        // follow-up, so retries never post the card a second time.
        writeJsonAtomic(DELIVERY_STATE_PATH, deliveryState);
        logOnce(`${PEOPLE[personId].name} streak card sent for ${cutoffKey}.`);
      } catch (error) {
        if (
          error instanceof DiscordApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          // A recipient's DM settings must not block deliveries to everyone else.
        }
        logOnce(friendlyDiscordError(error));
        continue;
      }

      if (deliveryState.pendingTextByPerson[deliveryKey]) {
        try {
          await flushPendingText(config, deliveryState, deliveryKey);
        } catch (error) {
          logOnce(friendlyDiscordError(error, 'text'));
          continue;
        }
      }
      if (deliveryState.pendingGifByPerson[deliveryKey]) {
        try {
          await flushPendingGif(config, deliveryState, deliveryKey);
        } catch (error) {
          logOnce(friendlyDiscordError(error, 'file attachment'));
        }
      }
    }

    if (changed) writeJsonAtomic(DELIVERY_STATE_PATH, deliveryState);
    await spectators.deliverScheduled({
      subscriptions: loadSubscriptions(),
      delivery: deliveryState,
      loadTrackerState,
      now: new Date(),
      sendCard: ({ userId, personId, trackerState, now, deduplicateKey }) =>
        sendCardUnchecked(config, personId, userId, trackerState, now, { deduplicateKey }),
    });
  } finally {
    checkInProgress = false;
  }
}

function setCorsHeaders(response, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Expose-Headers', 'ETag, Last-Modified');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gif-Name, X-File-Name');
  response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,DELETE,OPTIONS');
}

function readRequestBuffer(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    request.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > maxBytes) {
        exceeded = true;
        reject(new Error('Payload is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!exceeded) resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  response
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify(value));
}

function startStateServer() {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    setCorsHeaders(response, origin);

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, { ok: true, configured: Boolean(loadConfig()) });
      return;
    }
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (pathname === '/management') {
      if (request.method === 'GET') {
        sendJson(response, 200, { ...management.snapshot(loadSubscriptions(), loadDeliveryState()), gatewayOnline, spectatorCode: spectators.state.code });
        return;
      }
      if (request.method === 'POST') {
        if (!ALLOWED_ORIGINS.has(origin) || !String(request.headers['content-type']).startsWith('application/json')) {
          sendJson(response, 403, { error: 'Open management from the local website.' });
          return;
        }
        try {
          const input = JSON.parse((await readRequestBuffer(request, 4096)).toString('utf8'));
          if (input.action === 'spectate-code') {
            spectators.setCode(input.code);
            sendJson(response, 200, { ...management.snapshot(loadSubscriptions(), loadDeliveryState()), gatewayOnline, spectatorCode: spectators.state.code });
            return;
          }
          if (input.action === 'add') {
            const id = management.add(input.name, input.timeZone);
            const state = readJson(TRACKER_STATE_PATH, {});
            state.dayAnchors = { ...state.dayAnchors, [id]: { completedDays: 0, anchoredAt: new Date().toISOString() } };
            writeJsonAtomic(TRACKER_STATE_PATH, state);
          } else if (input.action === 'delete') {
            management.remove(input.id);
            spectators.removeCard(input.id);
            const subscriptions = loadSubscriptions();
            delete subscriptions.byPerson[input.id];
            saveSubscriptions(subscriptions);
            management.activity(input.id, { disconnectedAt: new Date().toISOString() });
          } else if (input.action === 'restore') management.restore(input.id);
          else if (input.action === 'purge') {
            if (input.confirm !== true || !Object.hasOwn(management.state.archived, input.id)) throw new Error('Confirm deletion of an archived card.');
            const state = readJson(TRACKER_STATE_PATH, {});
            for (const field of ['records', 'dayAnchors', 'notes']) {
              if (state[field]) delete state[field][input.id];
            }
            if (state.dayHistory?.outcomes) delete state.dayHistory.outcomes[input.id];
            writeJsonAtomic(TRACKER_STATE_PATH, state);
            const delivery = loadDeliveryState();
            for (const field of ['lastCutoffByPerson', 'lastMessageByPerson', 'pendingTextByPerson', 'pendingGifByPerson']) {
              for (const key of Object.keys(delivery[field])) {
                if (key.endsWith(':' + input.id)) delete delivery[field][key];
              }
            }
            writeJsonAtomic(DELIVERY_STATE_PATH, delivery);
            removeAttachment(
              DATA_DIR,
              input.id,
              Object.values(delivery.pendingGifByPerson).map((entry) => entry?.hash),
            );
            removeGif(DATA_DIR, input.id);
            removeCardBackground(DATA_DIR, input.id);
            management.purge(input.id);
            spectators.removeCard(input.id);
            pruneUnusedGifs(delivery);
            pruneUnusedAttachments(delivery);
          }
          else throw new Error('Unknown action.');
          const config = loadConfig();
          let warning = null;
          if (config) {
            try { await registerCommands(config); }
            catch { warning = 'Card saved. Discord command refresh failed; it will retry when the bot reconnects.'; }
          }
          sendJson(response, 200, { ...management.snapshot(loadSubscriptions(), loadDeliveryState()), gatewayOnline, warning,
            restoredState: input.action === 'restore' ? readJson(TRACKER_STATE_PATH, {}) : null });
        } catch (error) { sendJson(response, 400, { error: error.message }); }
        return;
      }
    }
    if (pathname === '/state' && request.method === 'GET') {
      sendJson(response, 200, readJson(TRACKER_STATE_PATH, {}));
      return;
    }
    const backgroundMatch = /^\/background\/([a-z0-9-]+)$/.exec(pathname);
    if (backgroundMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const background = getCardBackgroundFile(DATA_DIR, backgroundMatch[1]);
      if (!background) {
        response.writeHead(404, { 'Cache-Control': 'no-store' }).end();
        return;
      }
      if (request.headers['if-none-match'] === background.etag) {
        response.writeHead(304, {
          ETag: background.etag,
          'Cache-Control': 'no-cache',
        }).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': background.bytes.length,
        'Last-Modified': background.modifiedAt,
        ETag: background.etag,
        'Cache-Control': 'no-cache',
      });
      response.end(request.method === 'HEAD' ? undefined : background.bytes);
      return;
    }
    const attachmentMatch = /^\/attachment\/([a-z0-9-]+)$/.exec(pathname);
    if (attachmentMatch) {
      const personId = attachmentMatch[1];
      if (request.method === 'GET') {
        sendJson(response, 200, { attachment: getAttachmentMeta(DATA_DIR, personId) });
        return;
      }
      if (request.method === 'PUT') {
        try {
          const encodedName = request.headers['x-file-name'];
          const name = typeof encodedName === 'string'
            ? decodeURIComponent(encodedName)
            : 'attachment';
          const bytes = await readRequestBuffer(request, MAX_ATTACHMENT_BYTES);
          const attachment = await saveAttachment(DATA_DIR, personId, name, bytes);
          removeGif(DATA_DIR, personId);
          const delivery = loadDeliveryState();
          pruneUnusedGifs(delivery);
          pruneUnusedAttachments(delivery);
          sendJson(response, 200, { attachment });
        } catch (error) {
          const status = error?.message === 'Payload is too large.' ? 413 : 400;
          sendJson(response, status, { error: error?.message || 'Could not attach file.' });
        }
        return;
      }
      if (request.method === 'DELETE') {
        removeAttachment(DATA_DIR, personId, Object.values(loadDeliveryState().pendingGifByPerson).map(entry => entry?.hash));
        removeGif(DATA_DIR, personId);
        pruneUnusedGifs();
        sendJson(response, 200, { attachment: null });
        return;
      }
    }
    const gifMatch = /^\/gif\/([a-z0-9-]+)$/.exec(request.url || '');
    if (gifMatch) {
      const personId = gifMatch[1];
      if (request.method === 'GET') {
        sendJson(response, 200, { gif: getGifMeta(DATA_DIR, personId) });
        return;
      }
      if (request.method === 'PUT') {
        try {
          const encodedName = request.headers['x-gif-name'];
          const name = typeof encodedName === 'string'
            ? decodeURIComponent(encodedName)
            : 'attached.gif';
          const bytes = await readRequestBuffer(request, MAX_GIF_BYTES);
          const gif = await saveGif(DATA_DIR, personId, name, bytes);
          pruneUnusedGifs();
          sendJson(response, 200, { gif });
        } catch (error) {
          const status = error?.message === 'Payload is too large.' ? 413 : 400;
          sendJson(response, status, { error: error?.message || 'Could not attach GIF.' });
        }
        return;
      }
      if (request.method === 'DELETE') {
        removeGif(DATA_DIR, personId);
        pruneUnusedGifs();
        sendJson(response, 200, { gif: null });
        return;
      }
    }
    if (request.method === 'POST' && request.url === '/state') {
      try {
        const body = await readRequestBuffer(request, 1_000_000);
        const incoming = JSON.parse(body.toString('utf8'));
        const previous = readJson(TRACKER_STATE_PATH, null);
        if (
          (previous?.version === 3 && incoming?.version !== 3) ||
          (previous?.version === 2 && incoming?.version !== 2 && incoming?.version !== 3)
        ) {
          response
            .writeHead(409, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ ok: false, reason: 'outdated tracker tab' }));
          return;
        }
        for (const id of PERSON_IDS) {
          if (!Object.hasOwn(incoming.records ?? {}, id) && previous?.records?.[id]) {
            sendJson(response, 409, { error: 'Card list changed. Refresh the website.' });
            return;
          }
        }
        const state = normalizeTrackerState(incoming);
        state.savedAt = new Date().toISOString();
        // Keep archived cards recoverable and reject destructive stale-tab omission.
        for (const field of ['records', 'dayAnchors', 'notes']) {
          state[field] = { ...previous?.[field], ...state[field] };
        }
        state.dayHistory.outcomes = { ...previous?.dayHistory?.outcomes,
          ...Object.fromEntries(Object.entries(state.dayHistory.outcomes).filter(([id]) => PERSON_IDS.includes(id))) };
        writeJsonAtomic(TRACKER_STATE_PATH, state);
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: true }));
      } catch {
        response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: false }));
      }
      return;
    }
    response.writeHead(404).end('Not found');
  });

  server.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`Discord streak companion is running locally on port ${LOCAL_PORT}.`);
  });
  return server;
}

async function sendTestCard(personId) {
  const config = loadConfig();
  if (!config) throw new Error('Run Configure Discord Bot.command first.');
  if (!PERSON_IDS.includes(personId)) {
    throw new Error('Choose an available card: ' + PERSON_IDS.join(', ') + '.');
  }
  const subscription = loadSubscriptions().byPerson[personId];
  if (!subscription) throw new Error(`${PEOPLE[personId].name} is not connected. Use /connect in Discord first.`);
  const result = await sendCardTextAndGif(
    config,
    personId,
    subscription.userId,
    loadTrackerState(),
    new Date(),
  );
  console.log(`${result.model.name} test card sent successfully.`);
}

const sendNowIndex = process.argv.indexOf('--send-now');
if (sendNowIndex >= 0) {
  try {
    await sendTestCard(process.argv[sendNowIndex + 1] ?? 'nopy');
  } catch (error) {
    console.error(friendlyDiscordError(error));
    process.exitCode = 1;
  }
} else {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const server = startStateServer();
  const config = loadConfig();
  let stopGateway = () => {};
  if (config) {
    try {
      stopGateway = await startDiscordGateway(config);
    } catch (error) {
      console.error(friendlyDiscordError(error));
    }
  }
  void checkScheduledReports();
  const schedule = setInterval(() => void checkScheduledReports(), 15_000);

  function shutdown() {
    clearInterval(schedule);
    stopGateway();
    server.close(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
