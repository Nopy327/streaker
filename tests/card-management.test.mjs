import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCardManagement } from '../scripts/card-management.mjs';
import { PEOPLE, PERSON_IDS, applyPeople } from '../lib/streak-engine.ts';
import { normalizeTrackerState, createCardModel, renderStreakCardPng } from '../scripts/discord-card.mjs';
import { saveAttachment, removeAttachment, getAttachment, getAttachmentBytes } from '../scripts/discord-attachments.mjs';

test('custom card persists, renders, archives and restores without losing identity', async () => {
  const original = structuredClone(PEOPLE);
  const dir = mkdtempSync(join(tmpdir(), 'streak-management-test-'));
  try {
    const manager = createCardManagement(dir);
    assert.throws(() => manager.add('Test', 'bad/zone'));
    const id = manager.add('Test Person', 'America/Santiago');
    assert.ok(PERSON_IDS.includes(id));
    const state = normalizeTrackerState({ dayAnchors: { [id]: { completedDays: 3, anchoredAt: new Date().toISOString() } }, records: { [id]: {} } });
    assert.equal(createCardModel(id, state, new Date()).name, 'Test Person');
    assert.ok((await renderStreakCardPng(id, state, new Date())).length > 100);
    manager.activity(id, { lastDeliveredAt: new Date().toISOString() });
    const snapshot = manager.snapshot({ byPerson: { [id]: { userId: '123456789123456789' } } }, { lastCutoffByPerson: {}, lastMessageByPerson: {} });
    assert.equal(snapshot.cards.find(card => card.id === id).status, 'Receiving cards');
    manager.remove(id);
    assert.ok(!PERSON_IDS.includes(id));
    const restarted = createCardManagement(dir);
    assert.equal(restarted.state.archived[id].name, 'Test Person');
    restarted.restore(id);
    assert.equal(PEOPLE[id].name, 'Test Person');
    assert.ok(restarted.state.activity[id].lastDeliveredAt);
    assert.throws(() => restarted.purge(id), /Archived card not found/);
    const bytes = Buffer.from('shared attachment');
    await saveAttachment(dir, id, 'sample.txt', bytes);
    const attachment = getAttachment(dir, id);
    await saveAttachment(dir, 'nopy', 'sample.txt', bytes);
    restarted.remove(id);
    assert.doesNotThrow(() => removeAttachment(dir, id));
    assert.deepEqual(getAttachmentBytes(dir, attachment.hash), bytes, 'shared attachment remains available to the retained card');
    restarted.purge(id);
    assert.ok(!restarted.state.archived[id]);
    assert.ok(!restarted.state.activity[id]);
    assert.throws(() => restarted.restore(id), /Card not found/);
    const zones = restarted.snapshot({byPerson: {}}, {lastCutoffByPerson: {}, lastMessageByPerson: {}}).timeZones;
    assert.ok(zones.length > 400);
    assert.ok(zones.includes('UTC'));
    assert.ok(zones.includes('Europe/Berlin'));
    for (const timeZone of zones) assert.doesNotThrow(() => new Intl.DateTimeFormat('en', {timeZone}).format());
  } finally {
    applyPeople(original);
    rmSync(dir, { recursive: true, force: true });
  }
});
