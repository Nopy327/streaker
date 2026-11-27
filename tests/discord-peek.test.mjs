import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { resolvePeekTarget, sendPeekCardReply } from '../scripts/discord-peek.mjs';
import { renderStreakCardPng } from '../scripts/discord-card.mjs';

test('peek owners can choose one other card; guests can only choose their authorized target', () => {
  const subscriptions = { byPerson: { nopy: { userId: 'owner' } } };
  const spectators = { target: user => user === 'guest' ? 'void' : null };
  assert.equal(resolvePeekTarget('owner', 'void', subscriptions, spectators), 'void');
  assert.throws(() => resolvePeekTarget('owner', 'nopy', subscriptions, spectators), /your own/);
  assert.throws(() => resolvePeekTarget('owner', 'missing', subscriptions, spectators), /choose one/);
  assert.throws(() => resolvePeekTarget('owner', undefined, subscriptions, spectators), /choose one/);
  assert.equal(resolvePeekTarget('guest', 'void', subscriptions, spectators), 'void');
  assert.throws(() => resolvePeekTarget('guest', 'nopy', subscriptions, spectators), /actively spectating/);
  assert.throws(() => resolvePeekTarget('stranger', 'void', subscriptions, spectators), /actively spectating/);
});

for (const context of [1, 0, 2]) {
  test(`peek keeps its reply and saves one copy in bot DMs in context ${context}`, async () => {
    const now = new Date('2026-11-21T12:00:00Z');
    let days = 0;
    const calls = [];
    const background = await sharp({
      create: { width: 1200, height: 480, channels: 3, background: '#593b7c' },
    }).jpeg().toBuffer();
    const backgroundDataUri = `data:image/jpeg;base64,${background.toString('base64')}`;
    const loadTrackerState = () => {
      assert.equal(calls.length, 1, 'defer before loading and rendering the current card');
      return {
        dayAnchors: { void: { completedDays: days, anchoredAt: now.toISOString() } },
        notes: { void: 'private commentary' },
      };
    };
    const result = await sendPeekCardReply({
      interaction: { id: 'interaction', token: 'token', application_id: 'app', context },
      userId: 'requesting-spectator',
      personId: 'void',
      loadTrackerState,
      loadBackground: id => { assert.equal(id, 'void'); return backgroundDataUri; },
      getNow: () => now,
      request: async (path, options) => {
        calls.push({ path, options });
        days = 2;
        if (path === '/users/@me/channels') return { id: 'spectator-dm' };
        if (path === '/channels/spectator-dm/messages') return { id: 'saved-card' };
        return { id: 'reply' };
      },
    });
    assert.equal(calls.length, context === 1 ? 2 : 4,
      'bot DMs already persist; other contexts also open a DM and send one copy');
    assert.equal(calls[0].path, '/interactions/interaction/token/callback');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      type: 5, data: context === 1 ? {} : { flags: 64 },
    });
    assert.equal(calls[1].path, '/webhooks/app/token/messages/@original');
    assert.equal(calls[1].options.method, 'PATCH');
    const form = calls[1].options.body;
    assert.deepEqual([...form.keys()], ['payload_json', 'files[0]']);
    const payload = JSON.parse(form.get('payload_json'));
    assert.equal(payload.content, 'Void — Day 2 Ongoing');
    assert.equal(payload.attachments.length, 1);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    assert.doesNotMatch(JSON.stringify(payload), /private commentary|\.gif/);
    const file = form.get('files[0]');
    assert.equal(file.type, 'image/png');
    const bytes = Buffer.from(await file.arrayBuffer());
    const expectedImage = await renderStreakCardPng('void', {
      dayAnchors: { void: { completedDays: 2, anchoredAt: now.toISOString() } },
      notes: {},
    }, now, backgroundDataUri);
    assert.deepEqual(bytes, expectedImage, 'same image as owner, without private commentary');
    if (context !== 1) {
      assert.equal(calls[2].path, '/users/@me/channels');
      assert.deepEqual(JSON.parse(calls[2].options.body), { recipient_id: 'requesting-spectator' });
      assert.equal(calls[3].path, '/channels/spectator-dm/messages');
      assert.equal(calls[3].options.method, 'POST');
      const dmForm = calls[3].options.body;
      assert.deepEqual([...dmForm.keys()], ['payload_json', 'files[0]']);
      const dmPayload = JSON.parse(dmForm.get('payload_json'));
      assert.deepEqual(dmPayload, { ...payload, nonce: 'interaction', enforce_nonce: true });
      assert.equal(dmPayload.flags, undefined, 'DM copy is a regular, non-dismissible message');
      assert.equal(payload.nonce, undefined, 'DM nonce does not mutate the interaction reply');
      assert.deepEqual(Buffer.from(await dmForm.get('files[0]').arrayBuffer()), bytes,
        'both copies use the same rendered snapshot');
      assert.equal(dmForm.get('files[0]').name, file.name);
    }
    assert.equal(result.model.day, 2);
    assert.equal(result.messageId, 'reply');
  });
}

test('a failed image reply shows an error and does not attempt a DM copy', async () => {
  const calls = [];
  await assert.rejects(sendPeekCardReply({
    interaction: { id: 'i', token: 't', application_id: 'a', context: 2 },
    userId: 'guest',
    personId: 'nopy', loadTrackerState: () => ({}),
    getNow: () => new Date('2026-11-21T12:00:00Z'),
    request: async (path, options) => {
      calls.push({ path, options });
      if (options.body instanceof FormData) throw new Error('upload failed');
      return { id: 'error-reply' };
    },
  }), /upload failed/);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].path, '/webhooks/a/t/messages/@original');
  assert.equal(calls[2].options.method, 'PATCH');
  assert.match(JSON.parse(calls[2].options.body).content, /try \/peek again/);
});

for (const failurePath of ['/users/@me/channels', '/channels/guest-dm/messages']) {
  test(`a failed DM at ${failurePath} preserves the dismissible card and explains the failure`, async () => {
    const calls = [];
    await assert.rejects(sendPeekCardReply({
      interaction: { id: 'i', token: 't', application_id: 'a', context: 2 },
      userId: 'guest',
      personId: 'nopy', loadTrackerState: () => ({}),
      getNow: () => new Date('2026-11-21T12:00:00Z'),
      request: async (path, options) => {
        calls.push({ path, options });
        if (path === failurePath) throw new Error('DM blocked');
        return { id: path === '/users/@me/channels' ? 'guest-dm' : 'reply' };
      },
    }), /DM blocked/);
    assert.equal(calls.length, failurePath === '/users/@me/channels' ? 4 : 5);
    const successfulReply = JSON.parse(calls[1].options.body.get('payload_json'));
    const warning = calls.at(-1);
    assert.equal(warning.path, '/webhooks/a/t/messages/@original');
    assert.equal(warning.options.method, 'PATCH');
    const warningPayload = JSON.parse(warning.options.body);
    assert.ok(warningPayload.content.startsWith(successfulReply.content));
    assert.match(warningPayload.content, /Could not send a copy to your DMs/);
    assert.equal(Object.hasOwn(warningPayload, 'attachments'), false,
      'editing the text must keep the already uploaded image');
    assert.deepEqual(warningPayload.allowed_mentions, { parse: [] });
  });
}

test('a failed initial acknowledgement does not render or reply a second time', async () => {
  let calls = 0;
  await assert.rejects(sendPeekCardReply({
    interaction: { id: 'i', token: 't', application_id: 'a', context: 1 },
    personId: 'nopy', loadTrackerState: () => assert.fail('must not load the card'),
    request: async () => { calls++; throw new Error('expired interaction'); },
  }), /expired interaction/);
  assert.equal(calls, 1);
});
