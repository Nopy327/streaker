import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { sendCardImage } from '../scripts/discord-card-message.mjs';
import { renderStreakCardPng } from '../scripts/discord-card.mjs';
import { createSpectateStore } from '../scripts/discord-spectate.mjs';

test('scheduled spectator receives the owner card and title once, with no note or extra file', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'spectate-image-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createSpectateStore(directory);
  const subscriptions = { byPerson: {} };
  store.setCode('1234');
  store.watch('spectator', 'nopy', '1234', subscriptions, new Date('2026-11-20T20:00:00Z'));
  const now = new Date('2026-11-21T12:00:00Z');
  const trackerState = {
    dayAnchors: { nopy: { completedDays: 2, anchoredAt: now.toISOString() } },
    notes: { nopy: 'PRIVATE COMMENTARY: never send this to a spectator' },
  };
  const background = await sharp({
    create: { width: 1200, height: 480, channels: 3, background: '#6f3b83' },
  }).jpeg().toBuffer();
  const backgroundDataUri = `data:image/jpeg;base64,${background.toString('base64')}`;
  const calls = [];
  let result;
  const deliveryOptions = {
    subscriptions,
    delivery: { lastCutoffByPerson: {}, pendingTextByPerson: {}, pendingGifByPerson: {} },
    loadTrackerState: () => trackerState,
    now,
    sendCard: async card => {
      assert.match(card.deduplicateKey, /^spectate:spectator:/);
      result = await sendCardImage({
        ...card, backgroundDataUri, nonce: 'stable-cycle-nonce',
        request: async (path, options) => {
          calls.push({ path, options });
          return path === '/users/@me/channels' ? { id: 'spectator-dm' } : { id: 'image-message' };
        },
      });
    },
  };
  await store.deliverScheduled(deliveryOptions);
  await store.deliverScheduled(deliveryOptions);

  assert.equal(calls.length, 2, 'open one DM and post exactly one message');
  assert.deepEqual(JSON.parse(calls[0].options.body), { recipient_id: 'spectator' });
  assert.equal(calls[1].path, '/channels/spectator-dm/messages');
  assert.equal(calls[1].options.method, 'POST');
  const form = calls[1].options.body;
  assert.deepEqual([...form.keys()], ['payload_json', 'files[0]']);
  const payload = JSON.parse(form.get('payload_json'));
  assert.equal(payload.content, 'Nopy — Day 2 Ongoing');
  assert.equal(payload.nonce, 'stable-cycle-nonce');
  assert.equal(payload.enforce_nonce, true);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.attachments.length, 1);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE COMMENTARY|\.gif/i);
  const image = form.get('files[0]');
  assert.equal(image.type, 'image/png');
  assert.equal(image.name, payload.attachments[0].filename);
  const bytes = Buffer.from(await image.arrayBuffer());
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, 2400);
  assert.equal(metadata.height, 960);
  const ownerCardWithoutNote = await renderStreakCardPng(
    'nopy', { ...trackerState, notes: {} }, now, backgroundDataUri,
  );
  assert.deepEqual(bytes, ownerCardWithoutNote, 'identical owner image, including background, without commentary');
  assert.equal(result.channelId, 'spectator-dm');
  assert.equal(result.messageId, 'image-message');
});

test('a failed image send rejects so the spectator scheduler can retry the cycle', async () => {
  let requests = 0;
  await assert.rejects(sendCardImage({
    personId: 'void', userId: 'guest', trackerState: {},
    now: new Date('2026-11-21T12:00:00Z'),
    request: async path => {
      requests++;
      if (path === '/users/@me/channels') return { id: 'dm' };
      throw new Error('Discord unavailable');
    },
  }), /Discord unavailable/);
  assert.equal(requests, 2);
});
