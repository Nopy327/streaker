'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Eye, EyeOff, FileText, PencilLine } from 'lucide-react';

import { CardManager } from '@/components/card-manager';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import {
  MILESTONES,
  PEOPLE,
  PERSON_IDS,
  applyPeople,
  formatCountdown,
  formatDayEnd,
  getAnchoredCompletedDays,
  getCompletedDays,
  getCountdownSeconds,
  getCurrentMilestone,
  getEarnedMilestone,
  getNextMilestone,
  getProgress,
  type PersonId,
} from '@/lib/streak-engine';
import {
  INITIAL_OCCURRENCE_RECORDS,
  getXRate,
  isValidDateKey,
  isValidOccurrenceTotal,
  migrateCalendarRecordsToCutoffWindows,
  setOccurrenceTotal,
  type OccurrenceRecords,
} from '@/lib/streak-storage';
import {
  activeDateKey,
  emptyDayHistory,
  monthDateKeys,
  parseDayHistory,
  setDayOutcome,
  shortDateLabel,
  visibleDayOutcome,
  type DayHistory,
  type DayOutcome,
} from '@/lib/day-outcomes';
import { CARD_STORAGE, LEGACY_RECORDS_KEYS, migrateCardStorage } from '@/lib/browser-storage';

const REFERENCE_NOW = new Date('2026-09-10T13:03:00.000Z');
const RECORDS_STORAGE_KEY = CARD_STORAGE.records;
const DAY_ANCHORS_STORAGE_KEY = CARD_STORAGE.dayAnchors;
const NOTES_STORAGE_KEY = CARD_STORAGE.notes;
const FAVICON_STORAGE_KEY = 'streak-tracker-tab-icon-v1';
const BACKGROUND_VISIBILITY_STORAGE_KEY = 'streak-tracker-background-visibility-v1';
// The v1 history mixed guesses with manual edits. Keep it untouched, but do not display it.
const DAY_HISTORY_STORAGE_KEY = CARD_STORAGE.dayHistory;
const DISCORD_COMPANION_STATE_URL = 'http://127.0.0.1:3211/state';
const DISCORD_COMPANION_ATTACHMENT_URL = 'http://127.0.0.1:3211/attachment';
const DISCORD_COMPANION_BACKGROUND_URL = 'http://127.0.0.1:3211/background';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_ICON_BYTES = 5 * 1024 * 1024;
const LEGACY_RECORDS_STORAGE_KEYS = LEGACY_RECORDS_KEYS;


type DayAnchor = {
  completedDays: number;
  anchoredAt: string;
};

type DayAnchors = Partial<Record<PersonId, DayAnchor>>;
type PersonNotes = Record<PersonId, string>;
const EMPTY_NOTES: PersonNotes = { nopy: '', void: '' };
type CardAttachment = { name: string; mimeType: string; thumbnailDataUrl: string | null };
type PersonAttachments = Record<PersonId, CardAttachment | null>;
const EMPTY_ATTACHMENTS: PersonAttachments = { nopy: null, void: null };
type PersonBackgrounds = Record<PersonId, string | null>;
type BackgroundVisibility = Record<PersonId, boolean>;
const EMPTY_BACKGROUNDS: PersonBackgrounds = { nopy: null, void: null };
const DEFAULT_BACKGROUND_VISIBILITY: BackgroundVisibility = {
  nopy: true,
  void: true,
};

function attachmentDisplayName(name: string): string {
  const characters = Array.from(name);
  return characters.length > 6 ? `${characters.slice(0, 6).join('')}...` : name;
}

type WebMCPContext = {
  registerTool: (
    tool: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: { readOnlyHint?: boolean };
      execute: (input: unknown) => unknown;
    },
    options?: { signal?: AbortSignal },
  ) => Promise<void> | void;
};

const STREAK_DAYS = Array.from({ length: 90 }, (_, index) => index + 1);

type MedalMaterial =
  | 'none'
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'diamond'
  | 'platinum';

const MEDAL_MATERIAL_BY_DAY: Record<number, MedalMaterial> = {
  3: 'bronze',
  7: 'silver',
  14: 'gold',
  31: 'diamond',
  90: 'platinum',
};

const MILESTONE_BLOCK_STYLES: Record<number, string> = {
  3: 'hover:relative hover:z-10 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-[#a97142]',
  7: 'hover:relative hover:z-10 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-slate-300',
  14: 'hover:relative hover:z-10 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-amber-300',
  31: 'hover:relative hover:z-10 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-cyan-100',
  90: 'hover:relative hover:z-10 hover:outline hover:outline-2 hover:outline-offset-1 hover:outline-sky-300 hover:shadow-[0_0_18px_rgba(125,211,252,0.9)]',
};

function StreakBlocks({
  personName,
  currentDay,
}: {
  personName: string;
  currentDay: number;
}) {
  const current = Math.min(90, Math.max(0, currentDay));
  const completed = current > 0 ? current - 1 : 0;
  const ongoing = current > 0 && currentDay <= 90 ? current : null;

  return (
    <div
      className="mt-5 grid grid-cols-[repeat(18,minmax(0,1fr))] gap-1"
      role="img"
      aria-label={`${personName}: ${completed} of 90 streak days completed${ongoing ? `; day ${ongoing} ongoing` : ''}. Milestones are on days 3, 7, 14, 31, and 90.`}
    >
      {STREAK_DAYS.map((streakDay) => {
        const milestone = MILESTONES.find(
          (item) => item.day === streakDay,
        );
        const milestoneStyle = MILESTONE_BLOCK_STYLES[streakDay] ?? '';
        const isCompleted = streakDay < current || currentDay > 90;
        const isOngoing = streakDay === ongoing;
        const status = isCompleted
          ? 'Completed'
          : isOngoing
            ? 'Ongoing'
            : 'Upcoming';
        const milestoneLabel = milestone
          ? ` · ${milestone.name}${milestone.courseCompletion ? ' + Course Completion' : ''}`
          : '';
        const title = `Day ${streakDay}${milestoneLabel} · ${status}`;

        return (
          <span
            key={streakDay}
            aria-hidden="true"
            title={title}
            className={`aspect-square min-w-0 rounded-[3px] border transition-[outline-color,box-shadow] duration-150 motion-reduce:transition-none ${
              isCompleted
                ? 'border-violet-300/80 bg-violet-400'
                : isOngoing
                  ? 'border-violet-300/50 bg-violet-400/30 shadow-[inset_0_0_0_1px_rgba(196,181,253,0.12)]'
                : 'border-[#2b3e52] bg-[#17283b]'
            } ${milestoneStyle}`}
          />
        );
      })}
    </div>
  );
}

function MonthDayBlocks({
  personId,
  now,
  history,
  onSelectDate,
}: {
  personId: PersonId;
  now: Date;
  history: DayHistory;
  onSelectDate: (personId: PersonId, dateKey: string) => void;
}) {
  const currentKey = activeDateKey(personId, now);
  const dates = monthDateKeys(currentKey);

  return (
    <ol
      className="month-day-grid"
      aria-label={`${PEOPLE[personId].name} ${new Date(`${currentKey}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })} outcomes`}
    >
      {dates.map((dateKey) => {
        const outcome = visibleDayOutcome(history, personId, dateKey, currentKey);
        const label = shortDateLabel(dateKey);
        const status = outcome === 'completed'
          ? 'completed'
          : outcome === 'reset'
            ? 'reset'
            : dateKey === currentKey
              ? 'ongoing'
              : dateKey > currentKey
                ? 'upcoming'
                : 'unmarked';

        return (
          <li
            key={dateKey}
          >
            <button
              type="button"
              className={`month-day month-day--${status}`}
              title={`${label} · ${status}${dateKey > currentKey ? '' : ' · click to edit'}`}
              aria-label={`${PEOPLE[personId].name} ${label}: ${status}${dateKey > currentKey ? '' : '. Edit date'}`}
              disabled={dateKey > currentKey}
              onClick={() => onSelectDate(personId, dateKey)}
            >
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function CurrentMedalPlate({
  personName,
  completedDays,
}: {
  personName: string;
  completedDays: number;
}) {
  const medal = getCurrentMilestone(completedDays);
  const material = medal
    ? MEDAL_MATERIAL_BY_DAY[medal.day]
    : 'none';
  const label = medal?.name ?? 'No Medal Yet';

  return (
    <div className="medal-plate-stage">
      <div
        className={`medal-plate medal-plate--${material}`}
        role="status"
        aria-label={`${personName} current medal: ${label}`}
      >
        <span aria-hidden="true">{label}</span>
      </div>
    </div>
  );
}

function isPersonId(value: unknown): value is PersonId {
  return typeof value === 'string' && PERSON_IDS.includes(value);
}

function isDayAnchor(value: unknown): value is DayAnchor {
  if (!value || typeof value !== 'object') return false;
  const anchor = value as Partial<DayAnchor>;
  return (
    Number.isInteger(anchor.completedDays) &&
    Number(anchor.completedDays) >= 0 &&
    typeof anchor.anchoredAt === 'string' &&
    !Number.isNaN(Date.parse(anchor.anchoredAt))
  );
}

function loadDayAnchors(): DayAnchors {
  try {
    const saved = window.localStorage.getItem(DAY_ANCHORS_STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved) as Record<string, unknown>;
    const anchors: DayAnchors = {};
    for (const personId of Object.keys(parsed)) {
      if (isDayAnchor(parsed[personId])) anchors[personId] = parsed[personId];
    }
    return anchors;
  } catch {
    return {};
  }
}

function isOccurrenceRecords(value: unknown): value is OccurrenceRecords {
  if (!value || typeof value !== 'object') return false;
  const records = value as Partial<OccurrenceRecords>;
  return PERSON_IDS.every(id => records[id] && typeof records[id] === 'object');
}

function migrateLegacyRecords(value: unknown): OccurrenceRecords | null {
  if (!value || typeof value !== 'object') return null;
  const records = value as Partial<OccurrenceRecords>;
  if (!records.nopy) return null;
  return { ...INITIAL_OCCURRENCE_RECORDS, ...records } as OccurrenceRecords;
}

function loadRecords(now: Date): OccurrenceRecords {
  try {
    const saved = window.localStorage.getItem(RECORDS_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as unknown;
      if (isOccurrenceRecords(parsed)) return parsed;
    }

    for (const key of LEGACY_RECORDS_STORAGE_KEYS) {
      const legacy = window.localStorage.getItem(key);
      if (!legacy) continue;
      const parsed = JSON.parse(legacy) as unknown;
      const records = isOccurrenceRecords(parsed)
        ? parsed
        : migrateLegacyRecords(parsed);
      if (records) return migrateCalendarRecordsToCutoffWindows(records, now);
    }

    return INITIAL_OCCURRENCE_RECORDS;
  } catch {
    return INITIAL_OCCURRENCE_RECORDS;
  }
}

function loadNotes(): PersonNotes {
  try {
    const saved = window.localStorage.getItem(NOTES_STORAGE_KEY);
    if (!saved) return EMPTY_NOTES;
    const parsed = JSON.parse(saved) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string').map(([id, value]) => [id, (value as string).slice(0, 500)]));
  } catch {
    return EMPTY_NOTES;
  }
}

function loadDayHistory(): DayHistory {
  try {
    const saved = window.localStorage.getItem(DAY_HISTORY_STORAGE_KEY);
    return saved ? parseDayHistory(JSON.parse(saved)) : emptyDayHistory();
  } catch {
    return emptyDayHistory();
  }
}

function loadFavicon(): string | null {
  try {
    const saved = window.localStorage.getItem(FAVICON_STORAGE_KEY);
    return saved?.startsWith('data:image/png;base64,') && saved.length < 100_000
      ? saved
      : null;
  } catch {
    return null;
  }
}

function loadBackgroundVisibility(): BackgroundVisibility {
  try {
    const saved = window.localStorage.getItem(BACKGROUND_VISIBILITY_STORAGE_KEY);
    if (!saved) return DEFAULT_BACKGROUND_VISIBILITY;
    const parsed = JSON.parse(saved) as Record<string, unknown>;
    return { ...DEFAULT_BACKGROUND_VISIBILITY, ...Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'boolean')) } as BackgroundVisibility;
  } catch {
    return DEFAULT_BACKGROUND_VISIBILITY;
  }
}

function createFaviconDataUrl(file: File): Promise<string> {
  if (file.size > MAX_ICON_BYTES) {
    return Promise.reject(new Error('Choose an image under 5 MB.'));
  }
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
    return Promise.reject(new Error('Choose a PNG, JPG, WebP, or GIF image.'));
  }
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        if (
          !image.naturalWidth ||
          !image.naturalHeight ||
          image.naturalWidth > 4096 ||
          image.naturalHeight > 4096
        ) {
          throw new Error('Choose an image no larger than 4096 × 4096 pixels.');
        }
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not prepare the tab icon.');
        const scale = Math.min(64 / image.naturalWidth, 64 / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.clearRect(0, 0, 64, 64);
        context.drawImage(image, (64 - width) / 2, (64 - height) / 2, width, height);
        resolve(canvas.toDataURL('image/png'));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not open that image.'));
    };
    image.src = objectUrl;
  });
}

function getPersonCompletedDays(
  personId: PersonId,
  now: Date,
  anchors: DayAnchors,
): number {
  const person = PEOPLE[personId];
  const anchor = anchors[personId];
  if (anchor) {
    return getAnchoredCompletedDays(
      anchor.completedDays,
      new Date(anchor.anchoredAt),
      now,
      person.dayEnd,
      person.timeZone,
    );
  }
  return getCompletedDays(
    person.startDate,
    now,
    person.dayEnd,
    person.timeZone,
  );
}

function PersonCard({
  personId,
  now,
  records,
  dayHistory,
  note,
  attachment,
  backgroundImage,
  showBackground,
  day,
  onEdit,
  onToggleBackground,
  onSelectDate,
}: {
  personId: PersonId;
  now: Date;
  records: OccurrenceRecords;
  dayHistory: DayHistory;
  note: string;
  attachment: CardAttachment | null;
  backgroundImage: string | null;
  showBackground: boolean;
  day: number;
  onEdit: (personId: PersonId) => void;
  onToggleBackground: (personId: PersonId) => void;
  onSelectDate: (personId: PersonId, dateKey: string) => void;
}) {
  const person = PEOPLE[personId];
  const countdown = formatCountdown(
    getCountdownSeconds(now, person.dayEnd, person.timeZone),
  );
  const dayEndLabel = formatDayEnd(person.dayEnd);
  const completedDays = Math.max(0, day - 1);
  const progress = getProgress(completedDays);
  const xRate = getXRate(records, personId, now, person.timeZone, person.dayEnd);
  const earned = getEarnedMilestone(completedDays);
  const next = getNextMilestone(completedDays);
  const progressColor =
    '[&_[data-slot=progress-indicator]]:bg-violet-400';
  const displayBackground = Boolean(backgroundImage && showBackground);

  return (
    <article className="relative isolate min-h-[260px] overflow-hidden rounded-2xl border border-[#20364c] bg-[#0d1b2a] p-6 text-slate-100 shadow-[0_20px_60px_rgba(0,0,0,0.2)] sm:p-7">
      {displayBackground && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div
            className="absolute -inset-5 bg-cover bg-center opacity-65 blur-xl"
            style={{ backgroundImage: `url("${backgroundImage}")` }}
          />
          <div
            className="absolute inset-0 bg-contain bg-center bg-no-repeat opacity-90"
            style={{ backgroundImage: `url("${backgroundImage}")` }}
          />
          <div className="absolute inset-0 bg-[#07111c]/75" />
        </div>
      )}
      <div className="relative z-10 grid min-h-[204px] gap-6 lg:grid-cols-[0.85fr_1fr_1.35fr] lg:gap-0">
        <section className="flex flex-col lg:pr-7">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-violet-300">
            {person.name}
          </p>
          <div className="mt-3 flex items-end gap-3">
            <h2 className="text-4xl font-semibold tracking-tight text-white">
              Day {day}
            </h2>
            <p className="pb-1 text-sm text-slate-400">Ongoing</p>
          </div>

          <MonthDayBlocks
            personId={personId}
            now={now}
            history={dayHistory}
            onSelectDate={onSelectDate}
          />

          <div className="mt-auto pt-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Progress</span>
              <span className="font-mono tabular-nums text-slate-200">
                {progress.toFixed(1)}%
              </span>
            </div>
            <Progress
              value={progress}
              aria-label={`${person.name} progress`}
              className={`mt-2 [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:bg-[#203247] ${progressColor}`}
            />
          </div>
        </section>

        <section className="flex flex-col border-[#20364c] lg:border-x lg:px-7">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-400">X-Rate</p>
              <p className="mt-1 text-4xl font-semibold text-white">
                {xRate.value}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {backgroundImage && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-slate-300 hover:bg-[#172a3e] hover:text-white"
                  onClick={() => onToggleBackground(personId)}
                  aria-pressed={showBackground}
                >
                  {showBackground ? (
                    <EyeOff data-icon="inline-start" />
                  ) : (
                    <Eye data-icon="inline-start" />
                  )}
                  {showBackground ? 'Hide BG' : 'Show BG'}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-slate-300 hover:bg-[#172a3e] hover:text-white"
                onClick={() => onEdit(personId)}
              >
                <PencilLine data-icon="inline-start" />
                Edit
              </Button>
            </div>
          </div>
          <div className="mt-6 space-y-2 text-sm">
            {([['Today', xRate.today], ['Yesterday', xRate.yesterday]] as const).map(([label, entry]) => (
              <div key={label} className="flex justify-between gap-6">
                <span className="text-slate-400">{label}</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {entry.value}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-5 flex min-h-28 flex-1 flex-col overflow-hidden rounded-xl border border-[#20364c] bg-[#122438] p-4">
            <p className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-[15px] leading-relaxed text-slate-100">
              {note}
            </p>
            {attachment && (
              <div className="mt-3 flex min-w-0 items-center gap-3 border-t border-[#29425c] pt-3">
                {attachment.thumbnailDataUrl ? (
                  <img
                    src={attachment.thumbnailDataUrl}
                    alt=""
                    className="h-12 w-16 shrink-0 rounded-md border border-[#36506a] object-cover"
                  />
                ) : (
                  <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-[#36506a] bg-[#0d1b2a] text-slate-400" aria-hidden="true">
                    <FileText className="size-5" />
                  </span>
                )}
                <span className="min-w-0 truncate text-sm text-slate-200" title={attachment.name}>
                  {attachmentDisplayName(attachment.name)}
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="flex flex-col lg:pl-7">
          <div>
            {earned && (
              <p className="mb-2 text-sm font-medium text-emerald-300">
                Earned: {earned.name}
                {earned.courseCompletion ? ' + Course Completion' : ''}
              </p>
            )}
            {next ? (
              <>
                <p className="text-sm text-slate-300">
                  Next Milestone - {next.day - completedDays} Days remaining
                </p>
                <p className="mt-2 text-xl font-semibold text-white">
                  {next.name} · Day {next.day}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm text-slate-300">
                  Next Milestone - Complete
                </p>
                <p className="mt-2 text-xl font-semibold text-emerald-300">
                  Platinum Medal + Course Completion
                </p>
              </>
            )}
          </div>

          <StreakBlocks
            personName={person.name}
            currentDay={day}
          />

          <div className="mt-auto flex items-end justify-between gap-5 pt-8">
            <CurrentMedalPlate
              personName={person.name}
              completedDays={completedDays}
            />
            <div className="min-w-0 text-right">
              <p className="text-xs text-slate-500">
                Time remaining until {dayEndLabel} {person.timeZoneLabel}
              </p>
              <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white">
                {countdown}
              </p>
              <p className="mt-1 text-sm text-slate-400">
                Day {day} → Day {day + 1}
              </p>
            </div>
          </div>
        </section>
      </div>
    </article>
  );
}

function RecordDialog({
  personId,
  now,
  records,
  note,
  attachment,
  favicon,
  completedDay,
  onOpenChange,
  onSaveDay,
  onSaveTotal,
  onSaveNote,
  onUploadAttachment,
  onRemoveAttachment,
  onChangeFavicon,
  onResetFavicon,
}: {
  personId: PersonId;
  now: Date;
  records: OccurrenceRecords;
  note: string;
  attachment: CardAttachment | null;
  favicon: string | null;
  completedDay: number;
  onOpenChange: (open: boolean) => void;
  onSaveDay: (personId: PersonId, completedDays: number) => void;
  onSaveTotal: (personId: PersonId, dateKey: string, total: number) => void;
  onSaveNote: (personId: PersonId, note: string) => void;
  onUploadAttachment: (personId: PersonId, file: File) => Promise<void>;
  onRemoveAttachment: (personId: PersonId) => Promise<void>;
  onChangeFavicon: (file: File) => Promise<void>;
  onResetFavicon: () => void;
}) {
  const xRate = getXRate(
    records,
    personId,
    now,
    PEOPLE[personId].timeZone,
    PEOPLE[personId].dayEnd,
  );
  const dateOptions = [xRate.today, xRate.yesterday];
  const initialDate = xRate.today.key;
  const [selectedDate, setSelectedDate] = useState(initialDate);
  const [totalInput, setTotalInput] = useState(
    String(xRate.today.value),
  );
  const [dayInput, setDayInput] = useState(String(completedDay));
  const [noteInput, setNoteInput] = useState(note);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [iconBusy, setIconBusy] = useState(false);
  const [iconError, setIconError] = useState('');
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const parsedDay = Number(dayInput);
  const parsedTotal = Number(totalInput);
  const validTotal =
    totalInput.trim() !== '' && isValidOccurrenceTotal(parsedTotal);
  const validDay =
    dayInput.trim() !== '' &&
    Number.isInteger(parsedDay) &&
    parsedDay >= 0;

  function selectDate(dateKey: string) {
    setSelectedDate(dateKey);
    setTotalInput(String(records[personId]?.[dateKey] ?? 0));
  }

  async function handleAttachmentUpload(file: File | undefined) {
    if (!file) return;
    setAttachmentError('');
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachmentError('Choose a file under 20 MB.');
      return;
    }
    setAttachmentBusy(true);
    try {
      await onUploadAttachment(personId, file);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not attach file.');
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function handleAttachmentRemove() {
    setAttachmentError('');
    setAttachmentBusy(true);
    try {
      await onRemoveAttachment(personId);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Could not remove file.');
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function handleIconUpload(file: File | undefined) {
    if (!file) return;
    setIconError('');
    setIconBusy(true);
    try {
      await onChangeFavicon(file);
    } catch (error) {
      setIconError(error instanceof Error ? error.message : 'Could not change the tab icon.');
    } finally {
      setIconBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto border-[#29425c] bg-[#0d1b2a] text-slate-100">
        <DialogHeader>
          <DialogTitle>Update {PEOPLE[personId].name}</DialogTitle>
          <DialogDescription className="text-slate-400">
            Edit the day, X-Rate, or card text.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-xl border border-[#29425c] bg-[#091522] p-4">
          <Label htmlFor="completed-day">Completed streak day</Label>
          <p className="mt-1 text-sm text-slate-400">
            Progress and medals update from this number.
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              id="completed-day"
              type="number"
              min="0"
              step="1"
              value={dayInput}
              onChange={(event) => setDayInput(event.target.value)}
            />
            <Button
              disabled={!validDay}
              onClick={() =>
                validDay && onSaveDay(personId, parsedDay)
              }
            >
              <Check data-icon="inline-start" /> Save day
            </Button>
          </div>
        </div>

        <p className="text-sm font-medium text-slate-200">
          X-Rate records · reset at {formatDayEnd(PEOPLE[personId].dayEnd)}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {dateOptions.map((entry, index) => (
            <Button
              key={entry.key}
              variant={selectedDate === entry.key ? 'default' : 'outline'}
              onClick={() => selectDate(entry.key)}
            >
              {index === 0 ? 'Today' : 'Yesterday'}: {entry.value}
            </Button>
          ))}
        </div>

        <div className="mt-2">
          <Label htmlFor="daily-total">Confirmed total</Label>
          <div className="mt-2 flex gap-2">
            <Input
              id="daily-total"
              type="number"
              min="0"
              step="1"
              value={totalInput}
              onChange={(event) => setTotalInput(event.target.value)}
              placeholder="0 or more"
            />
            <Button
              disabled={!validTotal}
              onClick={() =>
                validTotal && onSaveTotal(personId, selectedDate, parsedTotal)
              }
            >
              <Check data-icon="inline-start" /> Save
            </Button>
          </div>
        </div>

        <div className="mt-2 border-t border-[#29425c] pt-4">
          <Label htmlFor="person-note">Card text</Label>
          <Textarea
            id="person-note"
            maxLength={500}
            value={noteInput}
            onChange={(event) => setNoteInput(event.target.value)}
            className="mt-2 min-h-28 resize-y border-[#20364c] bg-[#122438] text-[15px] leading-relaxed text-slate-100 caret-violet-300 selection:bg-violet-400/30 focus-visible:border-violet-300/70 focus-visible:ring-violet-400/20"
          />
          <Button
            className="mt-3"
            variant="outline"
            onClick={() => onSaveNote(personId, noteInput)}
          >
            <Check data-icon="inline-start" /> Save text
          </Button>
          <div className="mt-4 border-t border-[#29425c] pt-4">
            <Label htmlFor={`person-attachment-${personId}`}>File attachment</Label>
            <div className="mt-2 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={attachmentBusy}
                onClick={() => attachmentInputRef.current?.click()}
              >
                {attachment ? 'Replace file' : 'Attach file'}
              </Button>
              <input
                id={`person-attachment-${personId}`}
                ref={attachmentInputRef}
                type="file"
                accept=".gif,.png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.csv,.docx,.xlsx,.pptx"
                disabled={attachmentBusy}
                className="hidden"
                onChange={(event) => {
                  const input = event.currentTarget;
                  void handleAttachmentUpload(input.files?.[0]).finally(() => {
                    input.value = '';
                  });
                }}
              />
              {attachment && (
                <Button variant="ghost" size="sm" disabled={attachmentBusy} onClick={() => void handleAttachmentRemove()}>
                  Remove
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-400">GIF, PNG, JPG, WebP, PDF, TXT, MD, CSV, DOCX, XLSX, PPTX · 20 MB max</p>
            {attachment && (
              <p className="mt-2 truncate text-sm text-slate-300" title={attachment.name}>
                {attachmentDisplayName(attachment.name)}
              </p>
            )}
            {attachmentError && <p className="mt-2 text-sm text-rose-300" role="alert">{attachmentError}</p>}
          </div>
        </div>

        <div className="border-t border-[#29425c] pt-4">
          <Label htmlFor="website-tab-icon">Website tab icon</Label>
          <p className="mt-1 text-sm text-slate-400">Changes the small icon beside this website’s tab name.</p>
          <div className="mt-3 flex items-center gap-3">
            <img
              src={favicon ?? '/favicon.svg?v=4'}
              alt="Current website tab icon"
              className="h-10 w-10 shrink-0 rounded-md border border-[#36506a] bg-[#122438] object-contain p-1"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={iconBusy}
              onClick={() => iconInputRef.current?.click()}
            >
              Choose image
            </Button>
            <input
              id="website-tab-icon"
              ref={iconInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
              disabled={iconBusy}
              className="hidden"
              onChange={(event) => {
                const input = event.currentTarget;
                void handleIconUpload(input.files?.[0]).finally(() => {
                  input.value = '';
                });
              }}
            />
            {favicon && (
              <Button variant="ghost" size="sm" disabled={iconBusy} onClick={onResetFavicon}>
                Reset
              </Button>
            )}
          </div>
          {iconError && <p className="mt-2 text-sm text-rose-300" role="alert">{iconError}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DateOutcomeDialog({
  personId,
  dateKey,
  now,
  history,
  onSave,
  onClose,
}: {
  personId: PersonId;
  dateKey: string;
  now: Date;
  history: DayHistory;
  onSave: (personId: PersonId, dateKey: string, outcome: DayOutcome | null) => void;
  onClose: () => void;
}) {
  const currentKey = activeDateKey(personId, now);
  const selected = visibleDayOutcome(history, personId, dateKey, currentKey);
  const isOngoing = dateKey === currentKey;
  const dateLabel = new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

  function choose(outcome: DayOutcome | null) {
    onSave(personId, dateKey, outcome);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm border-[#29425c] bg-[#0d1b2a] text-slate-100">
        <DialogHeader>
          <DialogTitle>{PEOPLE[personId].name} · {dateLabel}</DialogTitle>
          <DialogDescription className="text-slate-400">
            Mark this date yourself. Purple means completed; red means reset.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-2">
          <Button
            type="button"
            variant="outline"
            className={selected === null ? 'border-slate-300 text-white' : 'border-[#314458] text-slate-200'}
            onClick={() => choose(null)}
          >
            Unmarked
          </Button>
          <Button
            type="button"
            variant="outline"
            className={selected === 'reset' ? 'border-rose-300 bg-[#a43643] text-white' : 'border-[#a43643] text-rose-200'}
            onClick={() => choose('reset')}
          >
            Red
          </Button>
          <Button
            type="button"
            variant="outline"
            className={selected === 'completed' ? 'border-violet-200 bg-violet-400 text-[#170f29]' : 'border-violet-400 text-violet-200'}
            disabled={isOngoing}
            onClick={() => choose('completed')}
          >
            Purple
          </Button>
        </div>
        {isOngoing && (
          <p className="text-xs text-slate-400">
            This date is still ongoing. Purple becomes available after its 22:05 cutoff.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Home() {
  const [now, setNow] = useState<Date | null>(null);
  const [records, setRecords] = useState<OccurrenceRecords>(
    INITIAL_OCCURRENCE_RECORDS,
  );
  const [dayAnchors, setDayAnchors] = useState<DayAnchors>({});
  const [dayHistory, setDayHistory] = useState<DayHistory>(emptyDayHistory);
  const [notes, setNotes] = useState<PersonNotes>(EMPTY_NOTES);
  const [attachments, setAttachments] = useState<PersonAttachments>(EMPTY_ATTACHMENTS);
  const [backgrounds, setBackgrounds] = useState<PersonBackgrounds>(EMPTY_BACKGROUNDS);
  const [backgroundVisibility, setBackgroundVisibility] = useState<BackgroundVisibility>(
    DEFAULT_BACKGROUND_VISIBILITY,
  );
  const [favicon, setFavicon] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [editorPerson, setEditorPerson] = useState<PersonId | null>(null);
  const [selectedDateBox, setSelectedDateBox] = useState<{ personId: PersonId; dateKey: string } | null>(null);
  const displayNow = now ?? REFERENCE_NOW;
  const completedDays = Object.fromEntries(PERSON_IDS.map(id => [id, getPersonCompletedDays(id, displayNow, dayAnchors)]));
  const editorDateKey = editorPerson
    ? getXRate(
        records,
        editorPerson,
        displayNow,
        PEOPLE[editorPerson].timeZone,
        PEOPLE[editorPerson].dayEnd,
      ).today.key
    : null;

  useEffect(() => {
    const update = () => setNow(new Date());
    const initializeTimer = window.setTimeout(async () => {
      let retainedIds: string[] | undefined;
      try {
        const response = await fetch('http://127.0.0.1:3211/management', { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const data = await response.json() as { people: typeof PEOPLE; archived?: typeof PEOPLE };
          retainedIds = [...Object.keys(data.people), ...Object.keys(data.archived ?? {})];
          window.localStorage.setItem('streak-card-registry', JSON.stringify(data.people));
          applyPeople(data.people);
        }
      } catch {
        const cached = window.localStorage.getItem('streak-card-registry');
        if (cached) applyPeople(JSON.parse(cached));
      }
      migrateCardStorage(window.localStorage, retainedIds);
      const initialNow = new Date();
      const initialRecords = loadRecords(initialNow);
      const initialAnchors = loadDayAnchors();
      let initialHistory = loadDayHistory();
      let initialNotes = loadNotes();
      let hasSavedState = Boolean(window.localStorage.getItem(RECORDS_STORAGE_KEY));
      try {
        const response = await fetch(DISCORD_COMPANION_STATE_URL, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const state = await response.json() as { records?: OccurrenceRecords; dayAnchors?: DayAnchors; dayHistory?: DayHistory; notes?: PersonNotes };
          hasSavedState = true;
          if (!window.localStorage.getItem(RECORDS_STORAGE_KEY)) {
            Object.assign(initialRecords, state.records ?? {});
            initialHistory = state.dayHistory ? parseDayHistory(state.dayHistory) : initialHistory;
            initialNotes = state.notes ?? initialNotes;
          }
          for (const id of PERSON_IDS) {
            if (!(id in initialRecords)) initialRecords[id] = state.records?.[id] ?? {};
            if (!(id in initialAnchors) && state.dayAnchors?.[id]) initialAnchors[id] = state.dayAnchors[id];
          }
        }
      } catch {}
      // A new browser must not upload defaults while the companion is unavailable.
      if (!hasSavedState) return;
      setRecords(initialRecords);
      setDayAnchors(initialAnchors);
      setDayHistory(initialHistory);
      setNotes(initialNotes);
      setFavicon(loadFavicon());
      setBackgroundVisibility(loadBackgroundVisibility());
      setHydrated(true);
      update();
    }, 0);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearTimeout(initializeTimer);
      window.clearInterval(timer);
    };
  }, []);

  // Let a restored tab wait for the local server instead of getting stuck on
  // Zen's network-error page when the browser opens before the login service.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/startup-retry-sw.js', { scope: '/' })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (hydrated) {
      window.localStorage.setItem(RECORDS_STORAGE_KEY, JSON.stringify(records));
    }
  }, [records, hydrated]);

  useEffect(() => {
    if (hydrated) {
      window.localStorage.setItem(
        DAY_ANCHORS_STORAGE_KEY,
        JSON.stringify(dayAnchors),
      );
    }
  }, [dayAnchors, hydrated]);

  useEffect(() => {
    if (hydrated) {
      window.localStorage.setItem(
        DAY_HISTORY_STORAGE_KEY,
        JSON.stringify(dayHistory),
      );
    }
  }, [dayHistory, hydrated]);

  useEffect(() => {
    if (hydrated) {
      window.localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notes));
    }
  }, [notes, hydrated]);

  useEffect(() => {
    if (hydrated) {
      window.localStorage.setItem(
        BACKGROUND_VISIBILITY_STORAGE_KEY,
        JSON.stringify(backgroundVisibility),
      );
    }
  }, [backgroundVisibility, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const iconUrl = favicon ?? '/favicon.svg?v=4';
    const iconType = favicon ? 'image/png' : 'image/svg+xml';
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    if (links.length === 0) {
      const link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
      links.push(link);
    }
    for (const link of links) {
      link.type = iconType;
      link.href = iconUrl;
    }
  }, [favicon, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    const syncState = () => {
      void fetch(DISCORD_COMPANION_STATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 3, records, dayAnchors, dayHistory, notes }),
        signal: controller.signal,
      }).catch(() => undefined);
    };
    syncState();
    const timer = window.setInterval(syncState, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [records, dayAnchors, dayHistory, notes, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    const loadAttachments = () => {
      for (const personId of PERSON_IDS) {
        void fetch(`${DISCORD_COMPANION_ATTACHMENT_URL}/${personId}`)
          .then(async (response) => {
            if (!response.ok) return;
            const data = await response.json() as { attachment?: CardAttachment | null };
            if (active) {
              setAttachments((current) => ({ ...current, [personId]: data.attachment ?? null }));
            }
          })
          .catch(() => undefined);
      }
    };
    loadAttachments();
    const timer = window.setInterval(loadAttachments, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    const loadBackgrounds = () => {
      for (const personId of PERSON_IDS) {
        const url = `${DISCORD_COMPANION_BACKGROUND_URL}/${personId}`;
        void fetch(url, { method: 'HEAD', cache: 'no-store' })
          .then((response) => {
            const next = response.ok
              ? `${url}?v=${encodeURIComponent(response.headers.get('etag') ?? response.headers.get('last-modified') ?? String(Date.now()))}`
              : null;
            if (active) {
              setBackgrounds((current) =>
                current[personId] === next
                  ? current
                  : { ...current, [personId]: next },
              );
            }
          })
          .catch(() => {
            if (active) {
              setBackgrounds((current) =>
                current[personId] === null
                  ? current
                  : { ...current, [personId]: null },
              );
            }
          });
      }
    };
    loadBackgrounds();
    const timer = window.setInterval(loadBackgrounds, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hydrated]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: WebMCPContext })
      .modelContext;
    if (!context) return;
    const controller = new AbortController();
    const registration = context.registerTool(
      {
        name: 'record_daily_occurrence_total',
        description:
          "Set the exact occurrence total for an active card in one streak-day window, named for its local cutoff date. Replaces the prior total to avoid double-counting.",
        inputSchema: {
          type: 'object',
          properties: {
            person: { type: 'string', enum: PERSON_IDS },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            total: { type: 'integer', minimum: 0 },
          },
          required: ['person', 'date', 'total'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: (input: unknown) => {
          const value = input as {
            person?: unknown;
            date?: unknown;
            total?: unknown;
          };
          if (
            !isPersonId(value.person) ||
            !isValidDateKey(value.date) ||
            !isValidOccurrenceTotal(value.total)
          ) {
            throw new Error('Invalid person, date, or total.');
          }
          const person = value.person;
          const date = value.date;
          const total = value.total;
          setRecords((current) =>
            setOccurrenceTotal(current, person, date, total),
          );
          return { person, date, confirmedTotal: total };
        },
      },
      { signal: controller.signal },
    );
    Promise.resolve(registration).catch(() => undefined);
    return () => controller.abort();
  }, []);

  function saveTotal(personId: PersonId, dateKey: string, total: number) {
    setRecords((current) =>
      setOccurrenceTotal(current, personId, dateKey, total),
    );
  }

  function saveDay(personId: PersonId, completedDay: number) {
    if (!Number.isInteger(completedDay) || completedDay < 0) return;
    setDayAnchors((current) => ({
      ...current,
      [personId]: {
        completedDays: completedDay,
        anchoredAt: new Date().toISOString(),
      },
    }));
  }

  function saveOutcome(personId: PersonId, dateKey: string, outcome: DayOutcome | null) {
    const currentKey = activeDateKey(personId, new Date());
    if (!isValidDateKey(dateKey) || dateKey > currentKey) return;
    if (outcome === 'completed' && dateKey === currentKey) return;
    setDayHistory((current) => setDayOutcome(current, personId, dateKey, outcome));
  }

  function saveNote(personId: PersonId, note: string) {
    setNotes((current) => ({ ...current, [personId]: note.slice(0, 500) }));
  }

  async function uploadAttachment(personId: PersonId, file: File) {
    let response: Response;
    try {
      response = await fetch(`${DISCORD_COMPANION_ATTACHMENT_URL}/${personId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: file,
      });
    } catch {
      throw new Error('Streaker needs to be running to attach a file.');
    }
    const data = await response.json() as { attachment?: CardAttachment; error?: string };
    if (!response.ok || !data.attachment) throw new Error(data.error || 'Could not attach file.');
    setAttachments((current) => ({ ...current, [personId]: data.attachment ?? null }));
  }

  async function removeAttachedFile(personId: PersonId) {
    let response: Response;
    try {
      response = await fetch(`${DISCORD_COMPANION_ATTACHMENT_URL}/${personId}`, {
        method: 'DELETE',
      });
    } catch {
      throw new Error('Streaker needs to be running to remove the file.');
    }
    if (!response.ok) throw new Error('Could not remove file.');
    setAttachments((current) => ({ ...current, [personId]: null }));
  }

  async function changeFavicon(file: File) {
    const iconUrl = await createFaviconDataUrl(file);
    try {
      window.localStorage.setItem(FAVICON_STORAGE_KEY, iconUrl);
    } catch {
      throw new Error('Could not save the tab icon in this browser.');
    }
    setFavicon(iconUrl);
  }

  function resetFavicon() {
    window.localStorage.removeItem(FAVICON_STORAGE_KEY);
    setFavicon(null);
  }

  function toggleWebsiteBackground(personId: PersonId) {
    setBackgroundVisibility((current) => ({
      ...current,
      [personId]: !current[personId],
    }));
  }

  return (
    <main className="min-h-screen bg-[#050b14] p-4 sm:p-6 lg:p-8">
      <section className="mx-auto grid max-w-6xl gap-4">
        {PERSON_IDS.map(personId => <PersonCard
          key={personId}
          personId={personId}
          now={displayNow}
          records={records}
          dayHistory={dayHistory}
          note={notes[personId] ?? ''}
          attachment={attachments[personId] ?? null}
          backgroundImage={backgrounds[personId] ?? null}
          showBackground={backgroundVisibility[personId] ?? true}
          day={completedDays[personId]}
          onEdit={setEditorPerson}
          onToggleBackground={toggleWebsiteBackground}
          onSelectDate={(personId, dateKey) => setSelectedDateBox({ personId, dateKey })}
        />)}
      </section>

      <CardManager />
      {editorPerson && PEOPLE[editorPerson] && (
        <RecordDialog
          key={`${editorPerson}-${editorDateKey}`}
          personId={editorPerson}
          now={displayNow}
          records={records}
          note={notes[editorPerson] ?? ''}
          attachment={attachments[editorPerson] ?? null}
          favicon={favicon}
          completedDay={completedDays[editorPerson]}
          onOpenChange={(open) => !open && setEditorPerson(null)}
          onSaveDay={saveDay}
          onSaveTotal={saveTotal}
          onSaveNote={saveNote}
          onUploadAttachment={uploadAttachment}
          onRemoveAttachment={removeAttachedFile}
          onChangeFavicon={changeFavicon}
          onResetFavicon={resetFavicon}
        />
      )}
      {selectedDateBox && (
        <DateOutcomeDialog
          key={`${selectedDateBox.personId}-${selectedDateBox.dateKey}`}
          personId={selectedDateBox.personId}
          dateKey={selectedDateBox.dateKey}
          now={displayNow}
          history={dayHistory}
          onSave={saveOutcome}
          onClose={() => setSelectedDateBox(null)}
        />
      )}
    </main>
  );
}
