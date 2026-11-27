import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PEOPLE, applyPeople, getActiveStreakDate, toDateKey } from '../lib/streak-engine.ts';

export function createCardManagement(dataDir) {
  const path = join(dataDir, 'card-management.json');
  let saved;
  try { saved = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const state = saved ?? { people: structuredClone(PEOPLE), archived: {}, activity: {} };
  for (const person of [...Object.values(state.people), ...Object.values(state.archived)]) {
    person.automaticFrom ??= toDateKey(getActiveStreakDate(new Date(), person.dayEnd, person.timeZone));
  }
  applyPeople(state.people);
  function save() {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  save();
  return {
    state,
    activity(id, patch) {
      state.activity[id] = { ...state.activity[id], ...patch };
      save();
    },
    add(name, timeZone) {
      name = String(name ?? '').trim();
      if (!name || name.length > 40) throw new Error('Use a name between 1 and 40 characters.');
      if (Object.keys(state.people).length >= 25) throw new Error('Up to 25 cards are supported.');
      if (typeof timeZone !== 'string' || !timeZone) throw new Error('Choose a time zone.');
      new Intl.DateTimeFormat('en', { timeZone }).format();
      if (Object.values(state.people).some(p => p.name.toLowerCase() === name.toLowerCase())) throw new Error('That card name already exists.');
      const id = 'card-' + randomUUID();
      const dayEnd = { hour: 22, minute: 5 };
      state.people[id] = { name, timeZone, timeZoneLabel: timeZone, dayEnd, startDate: getActiveStreakDate(new Date(), dayEnd, timeZone) };
      state.people[id].automaticFrom = toDateKey(state.people[id].startDate);
      applyPeople(state.people);
      save();
      return id;
    },
    remove(id) {
      if (!Object.hasOwn(state.people, id)) throw new Error('Card not found.');
      state.archived[id] = state.people[id];
      delete state.people[id];
      applyPeople(state.people);
      save();
    },
    restore(id) {
      if (!Object.hasOwn(state.archived, id)) throw new Error('Card not found.');
      if (Object.keys(state.people).length >= 25) throw new Error('Up to 25 cards are supported.');
      state.people[id] = state.archived[id];
      delete state.archived[id];
      applyPeople(state.people);
      save();
    },
    purge(id) {
      if (!Object.hasOwn(state.archived, id)) throw new Error('Archived card not found.');
      delete state.archived[id];
      delete state.activity[id];
      save();
    },
    snapshot(subscriptions, delivery) {
      return {
        people: state.people,
        archived: state.archived,
        timeZones: ['UTC', ...Intl.supportedValuesOf('timeZone'), ...Array.from({length: 27}, (_, i) => i - 14).filter(n => n !== 0).map(n => 'Etc/GMT' + (n > 0 ? '+' : '') + n)].filter(zone => { try { new Intl.DateTimeFormat('en', {timeZone: zone}); return true; } catch { return false; } }),
        cards: Object.entries(state.people).map(([id, person]) => {
          const connection = subscriptions.byPerson[id];
          const activity = state.activity[id] ?? {};
          const deliveryKey = connection ? connection.userId + ':' + id : '';
          const messageId = delivery.lastMessageByPerson[deliveryKey];
          const lastDeliveredAt = activity.lastDeliveredAt ?? (/^\d{15,25}$/.test(messageId ?? '')
            ? new Date(Number((BigInt(messageId) >> 22n) + 1420070400000n)).toISOString() : null);
          return {
            id, name: person.name, connected: !!connection,
            status: !connection ? (activity.disconnectedAt ? 'Disconnected' : 'Not connected')
              : activity.lastError ? 'Delivery problem'
              : lastDeliveredAt ? (Date.now() - Date.parse(lastDeliveredAt) > 26 * 60 * 60_000 ? 'Connected · delivery overdue' : 'Receiving cards') : 'Connected · delivery unverified',
            connectedAt: connection?.connectedAt ?? null,
            lastDeliveredAt,
            lastDeliveredCutoff: delivery.lastCutoffByPerson[deliveryKey] ?? null,
            lastInteractionAt: activity.lastInteractionAt ?? null,
            disconnectedAt: activity.disconnectedAt ?? null,
            lastError: activity.lastError ?? null,
          };
        }),
      };
    },
  };
}
