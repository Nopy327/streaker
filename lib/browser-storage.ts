export const CARD_STORAGE = {
  records: 'streak-tracker-occurrence-records-v4-cutoff',
  dayAnchors: 'streak-tracker-day-anchors-v1',
  notes: 'streak-tracker-notes-v1',
  dayHistory: 'streak-tracker-day-history-v2-manual',
};

export const LEGACY_RECORDS_KEYS = [
  'streak-tracker-occurrence-records-v3',
  'streak-tracker-occurrence-records-v2',
  'streak-tracker-occurrence-records-v1',
];

type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

// Rename the old person-named keys without resetting any remaining card. Only
// prune deleted cards when the companion supplies the full active/archive list.
export function migrateCardStorage(storage: StorageLike, retainedIds?: string[]) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null);
  const destinations = [
    ...Object.values(CARD_STORAGE), ...LEGACY_RECORDS_KEYS,
    'streak-tracker-day-history-v1',
    'streak-tracker-background-visibility-v1',
  ];
  const retained = retainedIds ? new Set(retainedIds) : null;
  for (const destination of destinations) {
    const suffix = destination.replace(/^streak-tracker-/, '');
    const legacyKeys = keys.filter(key => key.startsWith('nopy-') && key.endsWith('-' + suffix));
    const source = [destination, ...legacyKeys].find(key => storage.getItem(key) !== null);
    if (!source) continue;
    let parsed;
    try { parsed = JSON.parse(storage.getItem(source)!); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const isHistory = suffix.startsWith('day-history-');
    const entries = isHistory ? parsed.outcomes : parsed;
    const filtered = retained && entries && typeof entries === 'object'
      ? Object.fromEntries(Object.entries(entries).filter(([id]) => retained.has(id)))
      : entries;
    storage.setItem(destination, JSON.stringify(isHistory ? { ...parsed, outcomes: filtered } : filtered));
    // Remove old keys only after saving successfully, including on quota errors.
    for (const key of legacyKeys) storage.removeItem(key);
  }
}
