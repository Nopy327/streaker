import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpectateStore } from '../scripts/discord-spectate.mjs';
import { createCardModel, normalizeTrackerState, getLatestCutoffKey } from '../scripts/discord-card.mjs';
import { resolvePeekTarget } from '../scripts/discord-peek.mjs';

const owner = { byPerson: { nopy: { userId: 'owner' } } };
const guest = { byPerson: {} };
const before = new Date('2026-10-26T20:00:00Z');
const after = new Date('2026-10-26T21:05:01Z');
function delivery() { return { lastCutoffByPerson: {}, pendingTextByPerson: {}, pendingGifByPerson: {} }; }
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'spectate-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createSpectateStore(dir) };
}

test('owners receive the watched card with fresh data after their completed delivery sequence', async t => {
  const { store, dir } = setup(t);
  const d = delivery();
  let tracker = normalizeTrackerState({});
  const sent = [];
  const options = { subscriptions: owner, delivery: d, loadTrackerState: () => tracker, sendCard: async request => sent.push(request), now: after };
  await store.deliverScheduled(options);
  assert.equal(sent.length, 0);
  store.watch('owner', 'void', undefined, owner, before);
  await store.deliverScheduled(options);
  assert.equal(sent.length, 0, 'own card has not arrived yet');
  d.lastCutoffByPerson['owner:nopy'] = getLatestCutoffKey('nopy', after);
  d.pendingTextByPerson['owner:nopy'] = { content: 'pending' };
  await store.deliverScheduled(options);
  assert.equal(sent.length, 0, 'wait for own text');
  delete d.pendingTextByPerson['owner:nopy'];
  d.pendingGifByPerson['owner:nopy'] = { hash: 'pending' };
  await store.deliverScheduled(options);
  assert.equal(sent.length, 0, 'wait for own GIF');
  delete d.pendingGifByPerson['owner:nopy'];
  tracker = normalizeTrackerState({ dayAnchors: { void: { completedDays: 4, anchoredAt: after.toISOString() } } });
  await store.deliverScheduled(options);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 'owner');
  assert.equal(sent[0].personId, 'void');
  assert.equal(sent[0].trackerState, tracker);
  assert.equal(createCardModel(sent[0].personId, sent[0].trackerState, sent[0].now).day, 4);
  await createSpectateStore(dir).deliverScheduled(options);
  assert.equal(sent.length, 1, 'restart does not repeat a delivered cycle');
  assert.throws(() => store.watch('owner', 'nopy', undefined, owner, before), /another card/);
  store.stop('owner');
  assert.equal(store.target('owner', owner, after), null);
});

test('guest access needs four digits, limits guesses, and rotation revokes guest access', async t => {
  const {store} = setup(t);
  store.setCode('0042');
  assert.throws(() => store.setCode('42'), /four digits/);
  for (let i = 0; i < 5; i++) assert.throws(() => store.watch('bad', 'void', '0000', guest, before), /four-digit/);
  assert.throws(() => store.watch('bad', 'void', '0042', guest, before), /Too many/);
  store.watch('guest', 'void', '0042', guest, before);
  const sent = [];
  const tracker = normalizeTrackerState({});
  const options = {subscriptions: guest, delivery: delivery(), loadTrackerState: () => tracker, sendCard: async request => sent.push(request)};
  await store.deliverScheduled({...options, now: after});
  assert.equal(sent.length, 0, 'Brazil has not rolled over at Berlin cutoff');
  const brazilRollover = new Date('2026-10-27T01:05:01Z');
  await store.deliverScheduled({...options, now: brazilRollover});
  assert.equal(sent[0].personId, 'void');
  assert.equal(sent[0].userId, 'guest');
  assert.equal(sent[0].trackerState, tracker);
  assert.equal(sent[0].now, brazilRollover);
  store.setCode('1234');
  assert.equal(store.target('guest', guest, brazilRollover), null);
  await store.deliverScheduled({...options, now: new Date('2026-10-28T01:05:01Z')});
  assert.equal(sent.length, 1);
});

test('offline catch-up sends the current card and retries keep the same deduplication key', async t => {
  const {store} = setup(t);
  store.setCode('1234');
  store.watch('guest', 'void', '1234', guest, before);
  const attempts = [];
  let fail = true;
  const now = new Date('2026-10-30T01:05:01Z');
  let tracker = normalizeTrackerState({});
  const options = {subscriptions: guest, delivery: delivery(), loadTrackerState: () => tracker, sendCard: async request => { attempts.push(request); if (fail) throw Error('offline'); }};
  await store.deliverScheduled({...options, now});
  await store.deliverScheduled({...options, now: new Date(now.getTime() + 1000)});
  assert.equal(attempts.length, 1);
  fail = false;
  const retry = new Date(now.getTime() + 16 * 60_000);
  tracker = normalizeTrackerState({dayAnchors: {void: {completedDays: 0, anchoredAt: retry.toISOString()}}});
  await store.deliverScheduled({...options, now: retry});
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].deduplicateKey, attempts[1].deduplicateKey);
  assert.equal(attempts[1].trackerState, tracker);
  assert.equal(createCardModel(attempts[1].personId, attempts[1].trackerState, attempts[1].now).day, 0);
  store.removeCard('void');
  assert.equal(store.target('guest', guest, retry), null);
});

test('disconnecting an owner never silently grants guest access', t => {
  const {store} = setup(t);
  store.watch('owner', 'void', undefined, owner, before);
  assert.equal(store.target('owner', guest, after), null);
});

test('manual status resolves just the currently authorized spectated card', t => {
  const {store} = setup(t);
  assert.equal(store.target('owner', owner, before), null);
  store.watch('owner', 'void', undefined, owner, before);
  assert.equal(store.target('owner', owner, after), 'void');
  assert.throws(() => store.watch('owner', 'missing', undefined, owner, after), /available card/);
  assert.equal(store.target('owner', owner, after), 'void');
  store.stop('owner');
  assert.equal(store.target('owner', owner, after), null);
});

test('guest peek access follows the watched card and is revoked by code rotation or stopping', t => {
  const {store} = setup(t);
  const peek = id => resolvePeekTarget('guest', id, guest, store, after);
  assert.throws(() => peek('void'), /actively spectating/);
  store.setCode('0042');
  store.watch('guest', 'void', '0042', guest, before);
  assert.equal(peek('void'), 'void');
  assert.throws(() => peek('nopy'), /actively spectating/);
  store.setCode('1234');
  assert.throws(() => peek('void'), /actively spectating/);
  store.watch('guest', 'nopy', '1234', guest, after);
  assert.throws(() => peek('void'), /actively spectating/);
  assert.equal(peek('nopy'), 'nopy');
  store.stop('guest');
  assert.throws(() => peek('nopy'), /actively spectating/);
});
