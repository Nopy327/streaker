import {
  fromDateKey,
  getActiveStreakDate,
  PEOPLE,
  PERSON_IDS,
  toDateKey,
  type PersonId,
} from './streak-engine.ts';
import { isValidDateKey } from './streak-storage.ts';

export type DayOutcome = 'completed' | 'reset' | 'unmarked';
export type DayOutcomes = Record<PersonId, Record<string, DayOutcome>>;
export type DayHistory = {
  outcomes: DayOutcomes;
};


const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function emptyDayHistory(): DayHistory {
  return {
    outcomes: Object.fromEntries(PERSON_IDS.map((id) => [id, {}])),
  };
}

export function parseDayHistory(value: unknown): DayHistory {
  const history = emptyDayHistory();
  if (!value || typeof value !== 'object') return history;
  const parsed = value as Partial<DayHistory>;

  for (const personId of new Set([...PERSON_IDS, ...Object.keys(parsed.outcomes ?? {})])) {
    history.outcomes[personId] = {};
    const savedOutcomes = parsed.outcomes?.[personId];
    if (savedOutcomes && typeof savedOutcomes === 'object') {
      for (const [dateKey, outcome] of Object.entries(savedOutcomes)) {
        // Unmarked means there is no manual correction. Past eligible dates
        // still receive their automatic completed state below.
        if (isValidDateKey(dateKey) && (outcome === 'completed' || outcome === 'reset')) {
          history.outcomes[personId][dateKey] = outcome;
        }
      }
    }
  }
  return history;
}

export function activeDateKey(personId: PersonId, now: Date): string {
  const person = PEOPLE[personId];
  return toDateKey(getActiveStreakDate(now, person.dayEnd, person.timeZone));
}

export function monthDateKeys(activeKey: string): string[] {
  const active = fromDateKey(activeKey);
  const daysInMonth = new Date(Date.UTC(active.year, active.month, 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, index) =>
    toDateKey({ year: active.year, month: active.month, day: index + 1 }),
  );
}

export function shortDateLabel(dateKey: string): string {
  const date = fromDateKey(dateKey);
  return `${MONTHS[date.month - 1]}${date.day}`;
}

export function visibleDayOutcome(
  history: DayHistory,
  personId: PersonId,
  dateKey: string,
  currentActiveDateKey: string,
): DayOutcome | null {
  if (dateKey > currentActiveDateKey) return null;
  const saved = history.outcomes[personId]?.[dateKey] ?? null;
  if (saved === 'reset') return 'reset';
  const from = PEOPLE[personId]?.automaticFrom;
  if (from && dateKey >= from && dateKey < currentActiveDateKey) return 'completed';
  // The active day has not finished, even if a saved correction says completed.
  return dateKey === currentActiveDateKey && saved === 'completed' ? null : saved;
}

export function setDayOutcome(
  history: DayHistory,
  personId: PersonId,
  dateKey: string,
  outcome: DayOutcome | null,
): DayHistory {
  if (!isValidDateKey(dateKey)) return history;
  const nextOutcomes = { ...history.outcomes[personId] };
  if (outcome === null || outcome === 'unmarked') delete nextOutcomes[dateKey];
  else nextOutcomes[dateKey] = outcome;
  return {
    ...history,
    outcomes: { ...history.outcomes, [personId]: nextOutcomes },
  };
}
