import type { NotionPage } from '../notion/schemas.js';
import {
  extractTitle,
  extractSelect,
  extractDate,
  extractMultiSelect,
  extractLastEdited,
} from './notion-helpers.js';

const STATUS_MAP: Record<string, string> = {
  pending: 'NEEDS-ACTION',
  done: 'COMPLETED',
  cancelled: 'CANCELLED',
};

const PRIORITY_MAP: Record<string, number> = {
  high: 1,
  medium: 5,
  low: 9,
};

/** Format a Date as iCalendar UTC timestamp: 20260302T153000Z */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Format a date string (YYYY-MM-DD) as iCalendar DATE: 20260305 */
function formatDate(isoDate: string): string {
  return isoDate.replace(/-/g, '');
}

/** Add one day to a YYYY-MM-DD string, return as YYYYMMDD */
function nextDay(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Escape special chars in iCalendar text values */
function escapeIcal(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Convert a NotionPage (admin task with due date) to a VEVENT string */
export function pageToVEvent(page: NotionPage): string {
  const title = extractTitle(page);
  const dueDate = extractDate(page, 'Due Date')!;
  const status = extractSelect(page, 'Status') ?? 'pending';
  const priority = extractSelect(page, 'Priority') ?? 'medium';
  const type = extractSelect(page, 'Type') ?? 'task';
  const tags = extractMultiSelect(page, 'Tags');
  const lastEdited = extractLastEdited(page);

  const categories = [type, ...tags].join(',');
  const now = formatTimestamp(new Date());

  const lines = [
    'BEGIN:VEVENT',
    `UID:${page.id}`,
    `DTSTART;VALUE=DATE:${formatDate(dueDate)}`,
    `DTEND;VALUE=DATE:${nextDay(dueDate)}`,
    `SUMMARY:${escapeIcal(title)}`,
    `STATUS:${STATUS_MAP[status] ?? 'NEEDS-ACTION'}`,
    `PRIORITY:${PRIORITY_MAP[priority] ?? 5}`,
    `CATEGORIES:${categories}`,
    `LAST-MODIFIED:${formatTimestamp(lastEdited)}`,
    `DTSTAMP:${now}`,
    'END:VEVENT',
  ];

  return lines.join('\r\n');
}

export interface ParsedVEvent {
  uid: string;
  dtstart: string; // YYYY-MM-DD
  summary: string;
  status: string | null;
}

/** Unfold iCalendar line folding (RFC 5545 §3.1) */
function unfold(text: string): string {
  return text.replace(/\r?\n([ \t])/g, '$1');
}

/** Parse a YYYY-MM-DD from various DTSTART formats */
function parseDtstart(value: string): string {
  // VALUE=DATE:20260305 → already date-only
  // TZID=..:20260305T100000 → extract date portion
  // Plain: 20260305 or 20260305T100000Z
  const dateStr = value.replace(/^.*[:=]/, '').trim();
  const digits = dateStr.replace(/T.*$/, '');
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return digits;
}

/** Parse incoming iCalendar text from a PUT request */
export function parseVEvent(icalText: string): ParsedVEvent {
  const unfolded = unfold(icalText);
  const lines = unfolded.split(/\r?\n/);

  let uid = '';
  let dtstart = '';
  let summary = '';
  let status: string | null = null;
  let inVevent = false;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inVevent = true; continue; }
    if (line === 'END:VEVENT') break;
    if (!inVevent) continue;

    if (line.startsWith('UID:')) {
      uid = line.slice(4).trim();
    } else if (line.startsWith('DTSTART')) {
      dtstart = parseDtstart(line);
    } else if (line.startsWith('SUMMARY:')) {
      summary = line.slice(8).trim().replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    } else if (line.startsWith('STATUS:')) {
      status = line.slice(7).trim();
    }
  }

  return { uid, dtstart, summary, status };
}

/** Wrap one or more VEVENT strings in a VCALENDAR envelope */
export function wrapCalendar(vevents: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Second Brain//CalDAV//EN',
    'CALSCALE:GREGORIAN',
    vevents,
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}
