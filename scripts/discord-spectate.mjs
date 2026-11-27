import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PEOPLE } from '../lib/streak-engine.ts';
import { getLatestCutoffKey } from './discord-card.mjs';

export function createSpectateStore(directory) {
  const path = join(directory, 'spectate-state.json');
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  state ??= { code: String(randomInt(10000)).padStart(4, '0'), version: 1, viewers: {}, attempts: {} };
  function save() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  save();
  function ownerFor(userId, subscriptions) {
    return Object.entries(subscriptions.byPerson).find(([, entry]) => entry.userId === userId)?.[0];
  }
  function sourceFor(userId, entry, subscriptions, now) {
    const owner = ownerFor(userId, subscriptions);
    if (!PEOPLE[entry.targetId] || owner === entry.targetId) return null;
    if (!owner && (entry.authorization !== 'code' || entry.codeVersion !== state.version)) return null;
    return { owner, key: (owner ? 'owner:' + owner : 'guest:' + entry.targetId), cutoff: getLatestCutoffKey(owner ?? entry.targetId, now) };
  }
  return {
    state,
    setCode(code) {
      if (typeof code !== 'string' || !/^\d{4}$/.test(code)) throw new Error('Enter exactly four digits.');
      if (code === state.code) return;
      state.code = code;
      state.version++;
      state.attempts = {};
      save();
    },
    stop(userId) { delete state.viewers[userId]; save(); },
    removeCard(id) {
      for (const [userId, entry] of Object.entries(state.viewers)) {
        if (entry.targetId === id) delete state.viewers[userId];
      }
      save();
    },
    watch(userId, targetId, code, subscriptions, now = new Date()) {
      if (!Object.hasOwn(PEOPLE, targetId)) throw new Error('Choose an available card.');
      const owner = ownerFor(userId, subscriptions);
      if (owner === targetId) throw new Error('Choose another card.');
      if (!owner) {
        const time = now.getTime();
        const attempt = state.attempts[userId] ?? { count: 0, until: time + 15 * 60_000 };
        if (attempt.until <= time) { attempt.count = 0; attempt.until = time + 15 * 60_000; }
        if (attempt.count >= 5) throw new Error('Too many attempts. Try again in 15 minutes.');
        if (typeof code !== 'string' || code !== state.code) {
          attempt.count++;
          state.attempts[userId] = attempt;
          save();
          throw new Error('Enter the four-digit spectator code from the card owner.');
        }
        delete state.attempts[userId];
      }
      const entry = { targetId, authorization: owner ? 'owner' : 'code', codeVersion: state.version, generation: randomUUID() };
      const source = sourceFor(userId, entry, subscriptions, now);
      state.viewers[userId] = { ...entry, source: source.key, lastCutoff: source.cutoff };
      save();
    },
    target(userId, subscriptions, now = new Date()) {
      const entry = state.viewers[userId];
      if (!entry || !sourceFor(userId, entry, subscriptions, now)) return null;
      return entry.targetId;
    },
    async deliverScheduled({ subscriptions, delivery, loadTrackerState, sendCard, now = new Date() }) {
      for (const [userId, entry] of Object.entries(state.viewers)) {
        const source = sourceFor(userId, entry, subscriptions, now);
        if (!source) continue;
        if (source.key !== entry.source) {
          entry.source = source.key; entry.lastCutoff = source.cutoff;
          delete entry.retryAfter; save(); continue;
        }
        if (entry.lastCutoff >= source.cutoff || (entry.retryAfter ?? 0) > now.getTime()) continue;
        if (source.owner) {
          const key = userId + ':' + source.owner;
          if (delivery.lastCutoffByPerson[key] !== source.cutoff ||
              delivery.pendingTextByPerson[key] || delivery.pendingGifByPerson[key]) continue;
        }
        try {
          // Use the current state at delivery time, including offline catch-up.
          await sendCard({
            userId,
            personId: entry.targetId,
            trackerState: loadTrackerState(),
            now,
            deduplicateKey: 'spectate:' + userId + ':' + entry.generation + ':' + source.key + ':' + source.cutoff,
          });
          if (state.viewers[userId] !== entry) continue;
          entry.lastCutoff = source.cutoff;
          delete entry.retryAfter;
          save();
        } catch {
          if (state.viewers[userId] !== entry) continue;
          entry.retryAfter = now.getTime() + 15 * 60_000;
          save();
        }
      }
    },
  };
}
