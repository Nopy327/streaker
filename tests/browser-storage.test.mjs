import assert from 'node:assert/strict';
import test from 'node:test';
import { CARD_STORAGE, migrateCardStorage } from '../lib/browser-storage.ts';

class MemoryStorage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}

test('migration preserves remaining and archived cards and removes purged data from old keys', () => {
  const storage = new MemoryStorage();
  const kept = { nopy: { date: 4 }, void: { date: 2 }, 'archived-card': { date: 1 } };
  for (const [field, key] of Object.entries(CARD_STORAGE)) {
    const entries = { ...kept, 'deleted-card': { date: 9 } };
    storage.setItem(key.replace('streak-tracker-', 'nopy-old-void-'), JSON.stringify(field === 'dayHistory' ? { outcomes: entries } : entries));
  }
  migrateCardStorage(storage, Object.keys(kept));
  for (const [field, key] of Object.entries(CARD_STORAGE)) {
    const result = JSON.parse(storage.getItem(key));
    assert.deepEqual(field === 'dayHistory' ? result.outcomes : result, kept);
  }
  assert.equal([...storage.data.keys()].some(key => key.startsWith('nopy-')), false);
  assert.doesNotMatch(JSON.stringify([...storage.data]), /deleted-card/);
});

test('new keys win over stale copies, and offline migration does not discard unknown cards', () => {
  const storage = new MemoryStorage();
  storage.setItem(CARD_STORAGE.notes, JSON.stringify({ nopy: 'new', custom: 'retained' }));
  storage.setItem('nopy-old-void-notes-v1', JSON.stringify({ nopy: 'old' }));
  migrateCardStorage(storage);
  assert.deepEqual(JSON.parse(storage.getItem(CARD_STORAGE.notes)), { nopy: 'new', custom: 'retained' });
  assert.equal(storage.getItem('nopy-old-void-notes-v1'), null);
});

test('a storage write failure preserves the original data for recovery', () => {
  const storage = new MemoryStorage();
  const key = 'nopy-old-void-notes-v1';
  storage.setItem(key, '{"nopy":"keep me"}');
  storage.setItem = () => { throw new Error('storage full'); };
  assert.throws(() => migrateCardStorage(storage, ['nopy']), /storage full/);
  assert.equal(storage.getItem(key), '{"nopy":"keep me"}');
});

test('malformed legacy data does not prevent migration of other fields', () => {
  const storage = new MemoryStorage();
  storage.setItem('nopy-old-void-notes-v1', 'broken');
  storage.setItem('nopy-old-void-day-anchors-v1', '{"nopy":{"completedDays":5}}');
  migrateCardStorage(storage, ['nopy']);
  assert.deepEqual(JSON.parse(storage.getItem(CARD_STORAGE.dayAnchors)), { nopy: { completedDays: 5 } });
});
