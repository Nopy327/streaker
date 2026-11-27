import sharp from 'sharp';

import {
  PEOPLE,
  addCalendarDays,
  formatDayEnd,
  getAnchoredCompletedDays,
  getCompletedDays,
  getCurrentMilestone,
  getNextMilestone,
  getProgress,
  getZonedDateTime,
  isAtOrAfterDayEnd,
  toDateKey,
} from '../lib/streak-engine.ts';
import {
  INITIAL_OCCURRENCE_RECORDS,
  getXRate,
} from '../lib/streak-storage.ts';
import {
  activeDateKey,
  monthDateKeys,
  parseDayHistory,
  shortDateLabel,
  visibleDayOutcome,
} from '../lib/day-outcomes.ts';

import { PERSON_IDS } from '../lib/streak-engine.ts';
export { PERSON_IDS };

const MEDAL_MATERIAL_BY_DAY = {
  3: 'bronze',
  7: 'silver',
  14: 'gold',
  31: 'diamond',
  90: 'platinum',
};

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDayAnchor(value) {
  return (
    isObject(value) &&
    Number.isInteger(value.completedDays) &&
    value.completedDays >= 0 &&
    typeof value.anchoredAt === 'string' &&
    !Number.isNaN(Date.parse(value.anchoredAt))
  );
}

export function normalizeTrackerState(value) {
  const source = isObject(value) ? value : {};
  const sourceRecords = isObject(source.records) ? source.records : {};
  const sourceAnchors = isObject(source.dayAnchors) ? source.dayAnchors : {};
  const sourceNotes = isObject(source.notes) ? source.notes : {};
  const records = {};
  const dayAnchors = {};
  const notes = {};

  for (const personId of PERSON_IDS) {
    records[personId] = { ...INITIAL_OCCURRENCE_RECORDS[personId] };
    const personRecords = sourceRecords[personId];
    if (isObject(personRecords)) {
      for (const [dateKey, total] of Object.entries(personRecords)) {
        if (
          /^\d{4}-\d{2}-\d{2}$/.test(dateKey) &&
          Number.isInteger(total) &&
          total >= 0
        ) {
          records[personId][dateKey] = total;
        }
      }
    }
    if (isDayAnchor(sourceAnchors[personId])) {
      dayAnchors[personId] = sourceAnchors[personId];
    }
    notes[personId] = typeof sourceNotes[personId] === 'string'
      ? sourceNotes[personId].slice(0, 500)
      : '';
  }

  return {
    version: source.version === 3 ? 3 : source.version === 2 ? 2 : 1,
    savedAt:
      typeof source.savedAt === 'string'
        ? source.savedAt
        : new Date().toISOString(),
    records,
    dayAnchors,
    dayHistory: parseDayHistory(source.dayHistory),
    notes,
  };
}

export function getPersonDay(personId, now, state) {
  const person = PEOPLE[personId];
  const anchor = state.dayAnchors[personId];
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

export function getLatestCutoffKey(personId, now) {
  const person = PEOPLE[personId];
  const local = getZonedDateTime(now, person.timeZone);
  const cutoffDate = isAtOrAfterDayEnd(local, person.dayEnd)
    ? local
    : addCalendarDays(local, -1);
  return toDateKey(cutoffDate);
}

export function createCardModel(personId, rawState, now = new Date()) {
  const state = normalizeTrackerState(rawState);
  const person = PEOPLE[personId];
  const day = Math.max(0, getPersonDay(personId, now, state));
  const completedDays = Math.max(0, day - 1);
  const progress = getProgress(completedDays);
  const xRate = getXRate(state.records, personId, now, person.timeZone, person.dayEnd);
  const next = getNextMilestone(completedDays);
  const medal = getCurrentMilestone(completedDays);
  const currentDateKey = activeDateKey(personId, now);
  const dateBoxes = monthDateKeys(currentDateKey).map((dateKey) => ({
    dateKey,
    label: shortDateLabel(dateKey),
    status: visibleDayOutcome(state.dayHistory, personId, dateKey, currentDateKey)
      ?? (dateKey === currentDateKey ? 'ongoing' : dateKey > currentDateKey ? 'upcoming' : 'unmarked'),
  }));

  return {
    personId,
    name: person.name,
    day,
    completedDays,
    progress,
    xRate,
    dateBoxes,
    note: state.notes[personId],
    next,
    medal,
    cutoffKey: getLatestCutoffKey(personId, now),
    dayEnd: formatDayEnd(person.dayEnd),
    timeZoneLabel: person.timeZoneLabel,
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderDateBoxes(dateBoxes) {
  const colors = {
    completed: { fill: '#a78bfa', stroke: '#c4b5fd', text: '#170f29' },
    reset: { fill: '#a43643', stroke: '#e17a7a', text: '#fff7f7' },
    ongoing: { fill: '#0d1b2a', stroke: '#73859a', text: '#dce5ee' },
    unmarked: { fill: '#0d1b2a', stroke: '#314458', text: '#96a8ba' },
    upcoming: { fill: '#0d1b2a', stroke: '#314458', text: '#718096' },
  };

  return dateBoxes.map(({ dateKey, label, status }, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    const x = 42 + column * 44;
    const y = 195 + row * 29;
    const color = colors[status] ?? colors.unmarked;
    return `<g data-date-key="${escapeXml(dateKey)}" data-status="${escapeXml(status)}">
      <rect x="${x}" y="${y}" width="40" height="24" rx="4" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1"/>
      <text x="${x + 20}" y="${y + 16.5}" fill="${color.text}" font-size="12" font-weight="600" text-anchor="middle">${escapeXml(label)}</text>
    </g>`;
  }).join('');
}

function renderBlocks(currentDay) {
  const size = 20;
  const gap = 5;
  const startX = 657;
  const startY = 126;
  const blocks = [];

  for (let streakDay = 1; streakDay <= 90; streakDay += 1) {
    const column = (streakDay - 1) % 18;
    const row = Math.floor((streakDay - 1) / 18);
    const isCompleted = streakDay < currentDay || currentDay > 90;
    const isOngoing = streakDay === currentDay && currentDay <= 90;
    const fill = isCompleted
      ? '#a78bfa'
      : isOngoing
        ? '#493b65'
        : '#17283b';
    const stroke = isCompleted
      ? '#c4b5fd'
      : isOngoing
        ? '#9b87c8'
        : '#2b3e52';

    blocks.push(
      `<rect x="${startX + column * (size + gap)}" y="${startY + row * (size + gap)}" width="${size}" height="${size}" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
    );
  }

  return blocks.join('');
}

export function renderStreakCardSvg(model, { backgroundDataUri = null } = {}) {
  const nextLine = model.next
    ? `Next Milestone - ${model.next.day - model.completedDays} Days remaining`
    : 'Next Milestone - Complete';
  const nextTitle = model.next
    ? `${model.next.name} · Day ${model.next.day}`
    : 'Platinum Medal + Course Completion';
  const medalLabel = model.medal?.name ?? 'No Medal Yet';
  const medalMaterial = model.medal
    ? MEDAL_MATERIAL_BY_DAY[model.medal.day]
    : 'none';
  const progressWidth = Math.max(0, Math.min(260, model.progress * 2.6));
  const nextTitleSize = nextTitle.length > 30 ? 24 : nextTitle.length > 22 ? 26 : 28;
  const dayFontSize = model.day < 10 ? 53 : model.day < 100 ? 47 : 41;

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 1200 480">
  <defs>
    <clipPath id="card-clip">
      <rect x="8" y="8" width="1184" height="464" rx="22"/>
    </clipPath>
    <linearGradient id="medal-none" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22364b"/><stop offset="1" stop-color="#101d2b"/>
    </linearGradient>
    <linearGradient id="medal-bronze" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6f3f22"/><stop offset="0.48" stop-color="#b87842"/><stop offset="1" stop-color="#623619"/>
    </linearGradient>
    <linearGradient id="medal-silver" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#657487"/><stop offset="0.48" stop-color="#d7e0e8"/><stop offset="1" stop-color="#697789"/>
    </linearGradient>
    <linearGradient id="medal-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8f671c"/><stop offset="0.5" stop-color="#e8bf55"/><stop offset="1" stop-color="#805811"/>
    </linearGradient>
    <linearGradient id="medal-diamond" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#527c99"/><stop offset="0.48" stop-color="#d8f3ff"/><stop offset="1" stop-color="#4b718c"/>
    </linearGradient>
    <linearGradient id="medal-platinum" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6bb9df"/><stop offset="0.5" stop-color="#e8f9ff"/><stop offset="1" stop-color="#73c9ee"/>
    </linearGradient>
    <filter id="platinum-glow" x="-30%" y="-80%" width="160%" height="260%">
      <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#7dd3fc" flood-opacity="0.75"/>
    </filter>
  </defs>

  <rect width="1200" height="480" fill="#050b14"/>
  <rect x="8" y="8" width="1184" height="464" rx="22" fill="#0d1b2a"/>
  ${backgroundDataUri ? `<image href="${backgroundDataUri}" x="8" y="8" width="1184" height="464" preserveAspectRatio="none" clip-path="url(#card-clip)"/>` : ''}
  ${backgroundDataUri ? '<rect x="8" y="8" width="1184" height="464" rx="22" fill="#07111c" fill-opacity="0.7"/>' : ''}
  <rect x="8" y="8" width="1184" height="464" rx="22" fill="none" stroke="#20364c" stroke-width="2"/>
  <path d="M334 35V445M630 35V445" stroke="#20364c" stroke-width="1.5"/>

  <g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
    <text x="42" y="62" fill="#c4b5fd" font-size="19" font-weight="700" letter-spacing="2.4">${escapeXml(model.name.toUpperCase())}</text>
    <text x="42" y="138" fill="#f8fafc" font-size="${dayFontSize}" font-weight="700">Day ${model.day}</text>
    <text x="42" y="170" fill="#94a3b8" font-size="18">Ongoing</text>
    ${renderDateBoxes(model.dateBoxes)}

    <text x="42" y="411" fill="#94a3b8" font-size="18">Progress</text>
    <text x="302" y="411" fill="#e2e8f0" font-size="18" text-anchor="end">${model.progress.toFixed(1)}%</text>
    <rect x="42" y="430" width="260" height="8" rx="4" fill="#203247"/>
    <rect x="42" y="430" width="${progressWidth}" height="8" rx="4" fill="#a78bfa"/>

    <text x="359" y="62" fill="#94a3b8" font-size="19">X-Rate</text>
    <text x="359" y="139" fill="#f8fafc" font-size="59" font-weight="700">${model.xRate.value}</text>
    <text x="359" y="201" fill="#94a3b8" font-size="18">Today</text>
    <text x="595" y="201" fill="#e2e8f0" font-size="19" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" text-anchor="end">${model.xRate.today.value}</text>
    <text x="359" y="238" fill="#94a3b8" font-size="18">Yesterday</text>
    <text x="595" y="238" fill="#e2e8f0" font-size="19" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" text-anchor="end">${model.xRate.yesterday.value}</text>

    <text x="657" y="60" fill="#cbd5e1" font-size="18">${escapeXml(nextLine)}</text>
    <text x="657" y="98" fill="#f8fafc" font-size="${nextTitleSize}" font-weight="700">${escapeXml(nextTitle)}</text>
    ${renderBlocks(model.day)}

    <g transform="translate(664 329) skewX(-7)"${medalMaterial === 'platinum' ? ' filter="url(#platinum-glow)"' : ''}>
      <rect width="242" height="64" rx="10" fill="url(#medal-${medalMaterial})" stroke="${medalMaterial === 'none' ? '#334a61' : '#ffffff'}" stroke-opacity="0.42" stroke-width="2"/>
      <path d="M14 17H228" stroke="#ffffff" stroke-opacity="0.2" stroke-width="1.5"/>
      ${medalMaterial === 'bronze' ? '<path d="M35 8L28 57M179 7L171 59M213 10L206 57" stroke="#2e160b" stroke-opacity="0.2" stroke-width="1.5"/>' : ''}
      ${medalMaterial === 'silver' || medalMaterial === 'diamond' || medalMaterial === 'platinum' ? '<path d="M50 7H124L84 57H36Z" fill="#ffffff" fill-opacity="0.12"/>' : ''}
      <text x="121" y="40" fill="${medalMaterial === 'silver' || medalMaterial === 'diamond' || medalMaterial === 'platinum' ? '#132235' : '#ffffff'}" font-size="18" font-weight="800" letter-spacing="1" text-anchor="middle" transform="skewX(7)">${escapeXml(medalLabel.toUpperCase())}</text>
    </g>

    <text x="1152" y="415" fill="#f8fafc" font-size="19" font-weight="600" text-anchor="end">Day ${model.day} → Day ${model.day + 1}</text>
    <text x="1152" y="443" fill="#94a3b8" font-size="16" text-anchor="end">${escapeXml(model.dayEnd)} · ${escapeXml(model.timeZoneLabel)}</text>
  </g>
</svg>`;
}

export async function renderStreakCardPng(
  personId,
  state,
  now = new Date(),
  backgroundDataUri = null,
) {
  const model = createCardModel(personId, state, now);
  const svg = renderStreakCardSvg(model, { backgroundDataUri });
  return sharp(Buffer.from(svg), { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
}
