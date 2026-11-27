import {
  addCalendarDays,
  DEFAULT_DAY_END,
  fromDateKey,
  getActiveStreakDate,
  toDateKey,
  type CalendarDate,
  type DayEnd,
  type PersonId,
} from './streak-engine.ts';

export type OccurrenceRecords = Record<PersonId, Record<string, number>>;

export const INITIAL_OCCURRENCE_RECORDS: OccurrenceRecords = {
  nopy: {
    '2026-09-07': 1,
    '2026-09-08': 4,
    '2026-09-09': 0,
  },
  void: {
    '2026-09-09': 5,
  },
};

export type XRate = {
  value: number;
  today: { date: CalendarDate; key: string; value: number };
  yesterday: { date: CalendarDate; key: string; value: number };
};

export function getXRate(
  records: OccurrenceRecords,
  personId: PersonId,
  now: Date,
  timeZone: string,
  dayEnd: DayEnd = DEFAULT_DAY_END,
): XRate {
  // The active streak day is named for the local date when it completes.
  // At 22:05 the next day's window begins; before then, Today is the
  // current local calendar date, not the date the window began.
  const todayDate = getActiveStreakDate(now, dayEnd, timeZone);
  const yesterdayDate = addCalendarDays(todayDate, -1);
  const todayKey = toDateKey(todayDate);
  const yesterdayKey = toDateKey(yesterdayDate);
  const todayValue = records[personId]?.[todayKey] ?? 0;
  const yesterdayValue = records[personId]?.[yesterdayKey] ?? 0;

  return {
    value: todayValue + yesterdayValue,
    today: {
      date: fromDateKey(todayKey),
      key: todayKey,
      value: todayValue,
    },
    yesterday: {
      date: fromDateKey(yesterdayKey),
      key: yesterdayKey,
      value: yesterdayValue,
    },
  };
}

export function setOccurrenceTotal(
  records: OccurrenceRecords,
  personId: PersonId,
  dateKey: string,
  total: number,
): OccurrenceRecords {
  return {
    ...records,
    [personId]: {
      ...records[personId],
      [dateKey]: total,
    },
  };
}

// Legacy totals were already named by calendar date, which is also the end
// date of the corresponding streak-day window. Keep each saved count on its
// original date; without occurrence timestamps it cannot be split at 22:05.
export function migrateCalendarRecordsToCutoffWindows(
  records: OccurrenceRecords,
  _now: Date,
): OccurrenceRecords {
  return records;
}

export function isValidOccurrenceTotal(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = fromDateKey(value);
  const normalized = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day),
  );
  return (
    normalized.getUTCFullYear() === parsed.year &&
    normalized.getUTCMonth() + 1 === parsed.month &&
    normalized.getUTCDate() === parsed.day
  );
}
