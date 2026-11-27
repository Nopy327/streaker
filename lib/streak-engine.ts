export const BERLIN_TIME_ZONE = 'Europe/Berlin';
export const BRAZIL_TIME_ZONE = 'America/Sao_Paulo';
export const CHILE_TIME_ZONE = 'America/Santiago';
export const DAY_END_HOUR = 22;
export const DAY_END_MINUTE = 5;

export type DayEnd = {
  hour: number;
  minute: number;
};

export const DEFAULT_DAY_END: DayEnd = {
  hour: DAY_END_HOUR,
  minute: DAY_END_MINUTE,
};

export type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

export type PersonId = string;

export type Milestone = {
  day: number;
  name: string;
  courseCompletion?: boolean;
};

export const PEOPLE: Record<
  PersonId,
  {
    name: string;
    startDate: CalendarDate;
    dayEnd: DayEnd;
    timeZone: string;
    timeZoneLabel: string;
    automaticFrom?: string;
  }
> = {
  nopy: {
    name: 'Nopy',
    startDate: { year: 2026, month: 9, day: 9 },
    dayEnd: DEFAULT_DAY_END,
    timeZone: BERLIN_TIME_ZONE,
    timeZoneLabel: 'Europe/Berlin',
  },
  void: {
    name: 'Void',
    startDate: { year: 2026, month: 9, day: 11 },
    dayEnd: DEFAULT_DAY_END,
    timeZone: BRAZIL_TIME_ZONE,
    timeZoneLabel: 'Brazil (São Paulo)',
  },
};

export const PERSON_IDS: string[] = Object.keys(PEOPLE);
export function applyPeople(people: typeof PEOPLE) {
  for (const key of Object.keys(PEOPLE)) delete PEOPLE[key];
  Object.assign(PEOPLE, people);
  PERSON_IDS.splice(0, PERSON_IDS.length, ...Object.keys(people));
}

export const MILESTONES: Milestone[] = [
  { day: 3, name: 'Bronze Medal' },
  { day: 7, name: 'Silver Medal' },
  { day: 14, name: 'Gold Medal' },
  { day: 31, name: 'Diamond Medal' },
  { day: 90, name: 'Platinum Medal', courseCompletion: true },
];

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export type BerlinDateTime = CalendarDate & {
  hour: number;
  minute: number;
  second: number;
};

export function getZonedDateTime(
  date: Date,
  timeZone: string,
): BerlinDateTime {
  let formatter = dateTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dateTimeFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

export function getBerlinDateTime(date: Date): BerlinDateTime {
  return getZonedDateTime(date, BERLIN_TIME_ZONE);
}

export function toDateKey(date: CalendarDate): string {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function fromDateKey(key: string): CalendarDate {
  const [year, month, day] = key.split('-').map(Number);
  return { year, month, day };
}

export function addCalendarDays(
  date: CalendarDate,
  amount: number,
): CalendarDate {
  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day + amount),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function differenceInCalendarDays(
  later: CalendarDate,
  earlier: CalendarDate,
): number {
  const laterSerial = Date.UTC(later.year, later.month - 1, later.day);
  const earlierSerial = Date.UTC(earlier.year, earlier.month - 1, earlier.day);
  return Math.round((laterSerial - earlierSerial) / 86_400_000);
}

export function isAtOrAfterDayEnd(
  parts: BerlinDateTime,
  dayEnd: DayEnd = DEFAULT_DAY_END,
): boolean {
  return (
    parts.hour > dayEnd.hour ||
    (parts.hour === dayEnd.hour && parts.minute >= dayEnd.minute)
  );
}

export function getActiveStreakDate(
  now: Date,
  dayEnd: DayEnd = DEFAULT_DAY_END,
  timeZone: string = BERLIN_TIME_ZONE,
): CalendarDate {
  const local = getZonedDateTime(now, timeZone);
  return isAtOrAfterDayEnd(local, dayEnd)
    ? addCalendarDays(local, 1)
    : { year: local.year, month: local.month, day: local.day };
}

export function getCompletedDays(
  startDate: CalendarDate,
  now: Date,
  dayEnd: DayEnd = DEFAULT_DAY_END,
  timeZone: string = BERLIN_TIME_ZONE,
): number {
  const local = getZonedDateTime(now, timeZone);
  const elapsedCalendarDays = differenceInCalendarDays(local, startDate);
  const completed =
    elapsedCalendarDays + (isAtOrAfterDayEnd(local, dayEnd) ? 1 : 0);
  return Math.max(0, completed);
}

export function getAnchoredCompletedDays(
  anchoredDays: number,
  anchoredAt: Date,
  now: Date,
  dayEnd: DayEnd = DEFAULT_DAY_END,
  timeZone: string = BERLIN_TIME_ZONE,
): number {
  const anchorLocal = getZonedDateTime(anchoredAt, timeZone);
  const currentLocal = getZonedDateTime(now, timeZone);
  const elapsedCalendarDays = differenceInCalendarDays(
    currentLocal,
    anchorLocal,
  );
  const crossedCutoffs =
    elapsedCalendarDays +
    Number(isAtOrAfterDayEnd(currentLocal, dayEnd)) -
    Number(isAtOrAfterDayEnd(anchorLocal, dayEnd));
  return anchoredDays + Math.max(0, crossedCutoffs);
}

function zonedDateTimeToEpoch(
  parts: BerlinDateTime,
  timeZone: string,
): number {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let epoch = desiredAsUtc;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const represented = getZonedDateTime(new Date(epoch), timeZone);
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    epoch += desiredAsUtc - representedAsUtc;
  }

  return epoch;
}

export function getNextDayEnd(
  now: Date,
  dayEnd: DayEnd = DEFAULT_DAY_END,
  timeZone: string = BERLIN_TIME_ZONE,
): Date {
  const local = getZonedDateTime(now, timeZone);
  const targetDate = isAtOrAfterDayEnd(local, dayEnd)
    ? addCalendarDays(local, 1)
    : local;
  return new Date(
    zonedDateTimeToEpoch(
      {
        ...targetDate,
        hour: dayEnd.hour,
        minute: dayEnd.minute,
        second: 0,
      },
      timeZone,
    ),
  );
}

export function getCountdownSeconds(
  now: Date,
  dayEnd: DayEnd = DEFAULT_DAY_END,
  timeZone: string = BERLIN_TIME_ZONE,
): number {
  return Math.max(
    0,
    Math.ceil(
      (getNextDayEnd(now, dayEnd, timeZone).getTime() - now.getTime()) /
        1000,
    ),
  );
}

export function formatDayEnd(dayEnd: DayEnd): string {
  return `${String(dayEnd.hour).padStart(2, '0')}:${String(dayEnd.minute).padStart(2, '0')}`;
}

export function formatCountdown(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

export function getProgress(completedDays: number): number {
  return Math.min(100, Math.round((completedDays / 90) * 1000) / 10);
}

export function getNextMilestone(completedDays: number): Milestone | null {
  return MILESTONES.find((milestone) => milestone.day > completedDays) ?? null;
}

export function getEarnedMilestone(completedDays: number): Milestone | null {
  return (
    MILESTONES.find((milestone) => milestone.day === completedDays) ?? null
  );
}

export function getCurrentMilestone(completedDays: number): Milestone | null {
  for (let index = MILESTONES.length - 1; index >= 0; index -= 1) {
    if (completedDays >= MILESTONES[index].day) return MILESTONES[index];
  }
  return null;
}

export function formatShortDate(date: CalendarDate): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}
