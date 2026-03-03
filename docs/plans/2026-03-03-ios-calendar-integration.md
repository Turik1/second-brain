# iOS Calendar Integration (CalDAV Server) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a CalDAV server to the Express app so Apple Calendar can natively two-way sync with dated admin tasks in Notion.

**Architecture:** CalDAV endpoints mount at `/caldav/` on the existing Express server. Notion is the single source of truth. An in-memory cache with 60s TTL serves CalDAV reads; writes go through to Notion immediately. Basic Auth over HTTPS protects all CalDAV routes.

**Tech Stack:** Express 5, TypeScript (ESM/NodeNext), Vitest (new), no new runtime dependencies — iCalendar and WebDAV XML are templated manually.

**Design doc:** `docs/plans/2026-03-03-ios-calendar-integration-design.md`

---

## Task 1: Set Up Vitest

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (add vitest dev dep + test script)

**Step 1: Install vitest**

Run: `npm install -D vitest`

**Step 2: Create vitest config**

Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

**Step 3: Add test script to package.json**

Add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4: Verify vitest runs**

Run: `npx vitest run`
Expected: "No test files found" (success, no errors)

**Step 5: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: add vitest test framework"
```

---

## Task 2: Config Vars + CalDavError

**Files:**
- Modify: `src/config.ts`
- Modify: `src/utils/errors.ts`
- Modify: `.env.example`

**Step 1: Add CalDAV env vars to config schema**

In `src/config.ts`, add to `ConfigSchema` after the `BOUNCE_THRESHOLD` line:

```typescript
  // CalDAV
  CALDAV_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v !== 'false'),
  CALDAV_USERNAME: z.string().optional(),
  CALDAV_PASSWORD: z.string().optional(),
```

**Step 2: Add CalDavError class**

In `src/utils/errors.ts`, add:

```typescript
export class CalDavError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'CalDavError';
  }
}
```

**Step 3: Update .env.example**

Add to `.env.example`:

```
# CalDAV (iOS Calendar integration)
# CALDAV_ENABLED=true
# CALDAV_USERNAME=your_caldav_username
# CALDAV_PASSWORD=your_caldav_password
```

**Step 4: Verify type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/config.ts src/utils/errors.ts .env.example
git commit -m "feat(caldav): add config vars and error class"
```

---

## Task 3: Notion Page Property Extractors (TDD)

Extract typed data from the raw `NotionPage.properties` record. These helpers are used by the iCalendar converter.

**Files:**
- Create: `src/caldav/notion-helpers.ts`
- Create: `src/caldav/notion-helpers.test.ts`

**Step 1: Write the failing tests**

Create `src/caldav/notion-helpers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  extractTitle,
  extractSelect,
  extractDate,
  extractMultiSelect,
  extractLastEdited,
} from './notion-helpers.js';
import type { NotionPage } from '../notion/schemas.js';

const mockPage: NotionPage = {
  id: 'page-id-abc123',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Buy groceries' }] },
    Type: { type: 'select', select: { name: 'task' } },
    Status: { type: 'select', select: { name: 'pending' } },
    Priority: { type: 'select', select: { name: 'high' } },
    'Due Date': { type: 'date', date: { start: '2026-03-05' } },
    Tags: {
      type: 'multi_select',
      multi_select: [{ name: 'personal' }, { name: 'urgent' }],
    },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-02T15:30:00.000Z',
};

describe('extractTitle', () => {
  it('extracts the Name title', () => {
    expect(extractTitle(mockPage)).toBe('Buy groceries');
  });

  it('returns empty string for missing title', () => {
    const page = { ...mockPage, properties: {} };
    expect(extractTitle(page)).toBe('');
  });
});

describe('extractSelect', () => {
  it('extracts a select value', () => {
    expect(extractSelect(mockPage, 'Status')).toBe('pending');
    expect(extractSelect(mockPage, 'Priority')).toBe('high');
    expect(extractSelect(mockPage, 'Type')).toBe('task');
  });

  it('returns null for missing select', () => {
    expect(extractSelect(mockPage, 'Nonexistent')).toBeNull();
  });
});

describe('extractDate', () => {
  it('extracts the Due Date start value', () => {
    expect(extractDate(mockPage, 'Due Date')).toBe('2026-03-05');
  });

  it('returns null for missing date', () => {
    expect(extractDate(mockPage, 'Nonexistent')).toBeNull();
  });

  it('returns null for null date value', () => {
    const page: NotionPage = {
      ...mockPage,
      properties: { 'Due Date': { type: 'date', date: null } },
    };
    expect(extractDate(page, 'Due Date')).toBeNull();
  });
});

describe('extractMultiSelect', () => {
  it('extracts multi_select values', () => {
    expect(extractMultiSelect(mockPage, 'Tags')).toEqual(['personal', 'urgent']);
  });

  it('returns empty array for missing property', () => {
    expect(extractMultiSelect(mockPage, 'Nonexistent')).toEqual([]);
  });
});

describe('extractLastEdited', () => {
  it('returns last_edited_time as Date', () => {
    const date = extractLastEdited(mockPage);
    expect(date.toISOString()).toBe('2026-03-02T15:30:00.000Z');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/caldav/notion-helpers.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/caldav/notion-helpers.ts`:

```typescript
import type { NotionPage } from '../notion/schemas.js';

function extractText(prop: unknown): string {
  if (!Array.isArray(prop)) return '';
  return (prop as Array<{ plain_text?: string }>)
    .map((t) => t.plain_text ?? '')
    .join('');
}

export function extractTitle(page: NotionPage): string {
  for (const val of Object.values(page.properties)) {
    if (typeof val !== 'object' || val === null) continue;
    const v = val as Record<string, unknown>;
    if (v['type'] === 'title' && Array.isArray(v['title'])) {
      return extractText(v['title']);
    }
  }
  return '';
}

export function extractSelect(page: NotionPage, propertyName: string): string | null {
  const prop = page.properties[propertyName] as Record<string, unknown> | undefined;
  if (!prop || prop['type'] !== 'select' || !prop['select']) return null;
  return (prop['select'] as Record<string, unknown>)['name'] as string;
}

export function extractDate(page: NotionPage, propertyName: string): string | null {
  const prop = page.properties[propertyName] as Record<string, unknown> | undefined;
  if (!prop || prop['type'] !== 'date' || !prop['date']) return null;
  return (prop['date'] as Record<string, unknown>)['start'] as string;
}

export function extractMultiSelect(page: NotionPage, propertyName: string): string[] {
  const prop = page.properties[propertyName] as Record<string, unknown> | undefined;
  if (!prop || prop['type'] !== 'multi_select' || !Array.isArray(prop['multi_select'])) return [];
  return (prop['multi_select'] as Array<{ name: string }>).map((s) => s.name);
}

export function extractLastEdited(page: NotionPage): Date {
  return new Date(page.last_edited_time);
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/caldav/notion-helpers.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/caldav/notion-helpers.ts src/caldav/notion-helpers.test.ts
git commit -m "feat(caldav): add Notion page property extractors with tests"
```

---

## Task 4: iCalendar Generation (TDD)

Convert a NotionPage to a VEVENT iCalendar string.

**Files:**
- Create: `src/caldav/ical.ts`
- Create: `src/caldav/ical.test.ts`

**Step 1: Write the failing tests**

Create `src/caldav/ical.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { pageToVEvent, wrapCalendar } from './ical.js';
import type { NotionPage } from '../notion/schemas.js';

const mockPage: NotionPage = {
  id: 'abc123-def456',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Buy groceries' }] },
    Type: { type: 'select', select: { name: 'task' } },
    Status: { type: 'select', select: { name: 'pending' } },
    Priority: { type: 'select', select: { name: 'high' } },
    'Due Date': { type: 'date', date: { start: '2026-03-05' } },
    Tags: { type: 'multi_select', multi_select: [{ name: 'personal' }] },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-02T15:30:00.000Z',
};

describe('pageToVEvent', () => {
  it('generates a valid VEVENT string', () => {
    const vevent = pageToVEvent(mockPage);
    expect(vevent).toContain('BEGIN:VEVENT');
    expect(vevent).toContain('END:VEVENT');
    expect(vevent).toContain('UID:abc123-def456');
    expect(vevent).toContain('SUMMARY:Buy groceries');
    expect(vevent).toContain('DTSTART;VALUE=DATE:20260305');
    expect(vevent).toContain('DTEND;VALUE=DATE:20260306');
    expect(vevent).toContain('PRIORITY:1');
    expect(vevent).toContain('STATUS:NEEDS-ACTION');
    expect(vevent).toContain('CATEGORIES:task,personal');
    expect(vevent).toContain('LAST-MODIFIED:20260302T153000Z');
  });

  it('maps done status to COMPLETED', () => {
    const donePage = {
      ...mockPage,
      properties: {
        ...mockPage.properties,
        Status: { type: 'select', select: { name: 'done' } },
      },
    };
    expect(pageToVEvent(donePage)).toContain('STATUS:COMPLETED');
  });

  it('maps cancelled status to CANCELLED', () => {
    const cancelledPage = {
      ...mockPage,
      properties: {
        ...mockPage.properties,
        Status: { type: 'select', select: { name: 'cancelled' } },
      },
    };
    expect(pageToVEvent(cancelledPage)).toContain('STATUS:CANCELLED');
  });

  it('maps medium priority to 5', () => {
    const medPage = {
      ...mockPage,
      properties: {
        ...mockPage.properties,
        Priority: { type: 'select', select: { name: 'medium' } },
      },
    };
    expect(pageToVEvent(medPage)).toContain('PRIORITY:5');
  });

  it('maps low priority to 9', () => {
    const lowPage = {
      ...mockPage,
      properties: {
        ...mockPage.properties,
        Priority: { type: 'select', select: { name: 'low' } },
      },
    };
    expect(pageToVEvent(lowPage)).toContain('PRIORITY:9');
  });
});

describe('wrapCalendar', () => {
  it('wraps VEVENTs in VCALENDAR', () => {
    const vevent = 'BEGIN:VEVENT\r\nEND:VEVENT';
    const cal = wrapCalendar(vevent);
    expect(cal).toContain('BEGIN:VCALENDAR');
    expect(cal).toContain('END:VCALENDAR');
    expect(cal).toContain('VERSION:2.0');
    expect(cal).toContain('PRODID:-//Second Brain//CalDAV//EN');
    expect(cal).toContain(vevent);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/caldav/ical.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/caldav/ical.ts`:

```typescript
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
    `CATEGORIES:${escapeIcal(categories)}`,
    `LAST-MODIFIED:${formatTimestamp(lastEdited)}`,
    `DTSTAMP:${now}`,
    'END:VEVENT',
  ];

  return lines.join('\r\n');
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/caldav/ical.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/caldav/ical.ts src/caldav/ical.test.ts
git commit -m "feat(caldav): add iCalendar VEVENT generation with tests"
```

---

## Task 5: iCalendar Parsing (TDD)

Parse incoming iCalendar data from Apple Calendar PUT requests to extract changed fields.

**Files:**
- Modify: `src/caldav/ical.ts`
- Modify: `src/caldav/ical.test.ts`

**Step 1: Add failing tests for parsing**

Append to `src/caldav/ical.test.ts`:

```typescript
import { parseVEvent } from './ical.js';

describe('parseVEvent', () => {
  const ical = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:abc123-def456',
    'DTSTART;VALUE=DATE:20260310',
    'DTEND;VALUE=DATE:20260311',
    'SUMMARY:Updated title',
    'STATUS:COMPLETED',
    'PRIORITY:1',
    'DTSTAMP:20260303T120000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('extracts UID', () => {
    expect(parseVEvent(ical).uid).toBe('abc123-def456');
  });

  it('extracts DTSTART as YYYY-MM-DD', () => {
    expect(parseVEvent(ical).dtstart).toBe('2026-03-10');
  });

  it('extracts SUMMARY', () => {
    expect(parseVEvent(ical).summary).toBe('Updated title');
  });

  it('extracts STATUS', () => {
    expect(parseVEvent(ical).status).toBe('COMPLETED');
  });

  it('handles unfolded long lines', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:test-uid',
      'DTSTART;VALUE=DATE:20260305',
      'SUMMARY:A very long task name that was',
      ' folded by the client',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parseVEvent(folded).summary).toBe(
      'A very long task name that was folded by the client',
    );
  });

  it('handles DTSTART with TZID parameter', () => {
    const withTz = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:tz-test',
      'DTSTART;TZID=Europe/Berlin:20260305T100000',
      'SUMMARY:Meeting',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parseVEvent(withTz).dtstart).toBe('2026-03-05');
  });
});
```

**Step 2: Run tests to verify new tests fail**

Run: `npx vitest run src/caldav/ical.test.ts`
Expected: FAIL — parseVEvent not exported

**Step 3: Implement parseVEvent**

Add to `src/caldav/ical.ts`:

```typescript
export interface ParsedVEvent {
  uid: string;
  dtstart: string; // YYYY-MM-DD
  summary: string;
  status: string | null;
}

/** Unfold iCalendar line folding (RFC 5545 §3.1) */
function unfold(text: string): string {
  return text.replace(/\r?\n[ \t]/g, '');
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/caldav/ical.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/caldav/ical.ts src/caldav/ical.test.ts
git commit -m "feat(caldav): add iCalendar parsing with tests"
```

---

## Task 6: In-Memory Cache (TDD)

Cache dated admin tasks with 60s TTL. CalDAV reads serve from cache; writes update cache + Notion.

**Files:**
- Create: `src/caldav/cache.ts`
- Create: `src/caldav/cache.test.ts`

**Step 1: Write the failing tests**

Create `src/caldav/cache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalDavCache } from './cache.js';
import type { NotionPage } from '../notion/schemas.js';

const datedPage: NotionPage = {
  id: 'page-1',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Task 1' }] },
    Status: { type: 'select', select: { name: 'pending' } },
    Priority: { type: 'select', select: { name: 'medium' } },
    Type: { type: 'select', select: { name: 'task' } },
    'Due Date': { type: 'date', date: { start: '2026-03-05' } },
    Tags: { type: 'multi_select', multi_select: [] },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-02T15:30:00.000Z',
};

const undatedPage: NotionPage = {
  id: 'page-2',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Task 2' }] },
    Status: { type: 'select', select: { name: 'pending' } },
    'Due Date': { type: 'date', date: null },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-01T10:00:00.000Z',
};

describe('CalDavCache', () => {
  let cache: CalDavCache;
  const mockFetcher = vi.fn<() => Promise<NotionPage[]>>();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetcher.mockResolvedValue([datedPage, undatedPage]);
    cache = new CalDavCache(mockFetcher, 60_000);
  });

  it('fetches and filters to dated pages on first access', async () => {
    await cache.refresh();
    const pages = cache.getAllDated();
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('page-1');
  });

  it('returns a page by ID', async () => {
    await cache.refresh();
    expect(cache.getById('page-1')).toBeDefined();
    expect(cache.getById('nonexistent')).toBeUndefined();
  });

  it('computes ctag from max last_edited_time', async () => {
    await cache.refresh();
    expect(cache.getCtag()).toBe('2026-03-02T15:30:00.000Z');
  });

  it('computes etag for a page', async () => {
    await cache.refresh();
    expect(cache.getEtag('page-1')).toBe('"2026-03-02T15:30:00.000Z"');
  });

  it('invalidate forces next refresh to re-fetch', async () => {
    await cache.refresh();
    cache.invalidate();
    await cache.refreshIfStale();
    expect(mockFetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshIfStale skips if within TTL', async () => {
    await cache.refresh();
    await cache.refreshIfStale();
    expect(mockFetcher).toHaveBeenCalledTimes(1);
  });

  it('stores UID mapping for externally created events', async () => {
    await cache.refresh();
    cache.setUidMapping('apple-uid-123', 'page-1');
    expect(cache.resolveUid('apple-uid-123')).toBe('page-1');
    expect(cache.resolveUid('page-1')).toBe('page-1');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/caldav/cache.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/caldav/cache.ts`:

```typescript
import type { NotionPage } from '../notion/schemas.js';
import { extractDate, extractLastEdited } from './notion-helpers.js';
import { logger } from '../utils/logger.js';

export class CalDavCache {
  private pages = new Map<string, NotionPage>();
  private uidToPageId = new Map<string, string>();
  private lastRefresh = 0;
  private ctag = '';

  constructor(
    private readonly fetcher: () => Promise<NotionPage[]>,
    private readonly ttlMs: number = 60_000,
  ) {}

  async refresh(): Promise<void> {
    try {
      const allPages = await this.fetcher();
      const dated = allPages.filter((p) => extractDate(p, 'Due Date') !== null);

      this.pages.clear();
      for (const page of dated) {
        this.pages.set(page.id, page);
      }

      // Compute ctag from latest edit
      let maxEdited = '';
      for (const page of dated) {
        if (page.last_edited_time > maxEdited) {
          maxEdited = page.last_edited_time;
        }
      }
      this.ctag = maxEdited || new Date().toISOString();
      this.lastRefresh = Date.now();

      logger.debug({ event: 'caldav_cache_refreshed', count: dated.length, ctag: this.ctag });
    } catch (err) {
      logger.error({ event: 'caldav_cache_refresh_failed', error: err });
      // Keep stale data on failure
    }
  }

  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
  }

  invalidate(): void {
    this.lastRefresh = 0;
  }

  getAllDated(): NotionPage[] {
    return Array.from(this.pages.values());
  }

  getById(pageId: string): NotionPage | undefined {
    return this.pages.get(pageId);
  }

  getCtag(): string {
    return this.ctag;
  }

  getEtag(pageId: string): string | undefined {
    const page = this.pages.get(pageId);
    if (!page) return undefined;
    return `"${page.last_edited_time}"`;
  }

  setUidMapping(externalUid: string, pageId: string): void {
    this.uidToPageId.set(externalUid, pageId);
  }

  /** Resolve a UID (from CalDAV URL) to a Notion page ID */
  resolveUid(uid: string): string {
    return this.uidToPageId.get(uid) ?? uid;
  }

  removePage(pageId: string): void {
    this.pages.delete(pageId);
    // Recompute ctag
    let maxEdited = '';
    for (const page of this.pages.values()) {
      if (page.last_edited_time > maxEdited) maxEdited = page.last_edited_time;
    }
    this.ctag = maxEdited || new Date().toISOString();
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/caldav/cache.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/caldav/cache.ts src/caldav/cache.test.ts
git commit -m "feat(caldav): add in-memory cache with TTL and UID mapping"
```

---

## Task 7: Auth Middleware (TDD)

Basic Auth middleware for CalDAV routes.

**Files:**
- Create: `src/caldav/auth.ts`
- Create: `src/caldav/auth.test.ts`

**Step 1: Write the failing tests**

Create `src/caldav/auth.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { validateBasicAuth } from './auth.js';

describe('validateBasicAuth', () => {
  it('returns true for valid credentials', () => {
    const header = 'Basic ' + Buffer.from('user:pass').toString('base64');
    expect(validateBasicAuth(header, 'user', 'pass')).toBe(true);
  });

  it('returns false for wrong password', () => {
    const header = 'Basic ' + Buffer.from('user:wrong').toString('base64');
    expect(validateBasicAuth(header, 'user', 'pass')).toBe(false);
  });

  it('returns false for missing header', () => {
    expect(validateBasicAuth(undefined, 'user', 'pass')).toBe(false);
  });

  it('returns false for non-Basic scheme', () => {
    expect(validateBasicAuth('Bearer token123', 'user', 'pass')).toBe(false);
  });

  it('returns false for malformed base64', () => {
    expect(validateBasicAuth('Basic !!!invalid!!!', 'user', 'pass')).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/caldav/auth.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/caldav/auth.ts`:

```typescript
import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/** Validate Basic Auth credentials using timing-safe comparison */
export function validateBasicAuth(
  authHeader: string | undefined,
  expectedUser: string,
  expectedPass: string,
): boolean {
  if (!authHeader || !authHeader.startsWith('Basic ')) return false;

  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) return false;

    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);

    const userBuf = Buffer.from(user);
    const passBuf = Buffer.from(pass);
    const expectedUserBuf = Buffer.from(expectedUser);
    const expectedPassBuf = Buffer.from(expectedPass);

    // Length check before timing-safe compare (timingSafeEqual requires same length)
    const userMatch =
      userBuf.length === expectedUserBuf.length &&
      timingSafeEqual(userBuf, expectedUserBuf);
    const passMatch =
      passBuf.length === expectedPassBuf.length &&
      timingSafeEqual(passBuf, expectedPassBuf);

    return userMatch && passMatch;
  } catch {
    return false;
  }
}

/** Express middleware that enforces Basic Auth on CalDAV routes */
export function caldavAuth(req: Request, res: Response, next: NextFunction): void {
  const username = config.CALDAV_USERNAME;
  const password = config.CALDAV_PASSWORD;

  if (!username || !password) {
    logger.error({ event: 'caldav_auth_misconfigured' }, 'CalDAV credentials not set');
    res.status(500).send('CalDAV not configured');
    return;
  }

  const authHeader = req.headers['authorization'] as string | undefined;

  if (validateBasicAuth(authHeader, username, password)) {
    next();
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Second Brain CalDAV"');
    res.status(401).send('Unauthorized');
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/caldav/auth.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/caldav/auth.ts src/caldav/auth.test.ts
git commit -m "feat(caldav): add Basic Auth middleware with tests"
```

---

## Task 8: WebDAV XML Response Builders (TDD)

Build the XML responses that Apple Calendar expects from PROPFIND and REPORT requests.

**Files:**
- Create: `src/caldav/xml.ts`
- Create: `src/caldav/xml.test.ts`

**Step 1: Write the failing tests**

Create `src/caldav/xml.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildPrincipalPropfind,
  buildCalendarHomePropfind,
  buildCalendarPropfind,
  buildMultigetResponse,
  extractHrefsFromMultiget,
  isMultigetReport,
} from './xml.js';

describe('buildPrincipalPropfind', () => {
  it('includes current-user-principal and calendar-home-set', () => {
    const xml = buildPrincipalPropfind('/caldav/principal/');
    expect(xml).toContain('current-user-principal');
    expect(xml).toContain('calendar-home-set');
    expect(xml).toContain('/caldav/calendars/');
  });
});

describe('buildCalendarHomePropfind', () => {
  it('lists the admin calendar', () => {
    const xml = buildCalendarHomePropfind('/caldav/calendars/');
    expect(xml).toContain('/caldav/calendars/admin/');
    expect(xml).toContain('calendar');
    expect(xml).toContain('Second Brain Admin');
  });
});

describe('buildCalendarPropfind', () => {
  it('includes ctag and calendar properties', () => {
    const xml = buildCalendarPropfind('/caldav/calendars/admin/', 'ctag-123');
    expect(xml).toContain('ctag-123');
    expect(xml).toContain('VEVENT');
    expect(xml).toContain('Second Brain Admin');
  });
});

describe('buildMultigetResponse', () => {
  it('builds response with event data and etags', () => {
    const events = [
      { href: '/caldav/calendars/admin/id1.ics', etag: '"etag1"', calendarData: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' },
    ];
    const xml = buildMultigetResponse(events);
    expect(xml).toContain('/caldav/calendars/admin/id1.ics');
    expect(xml).toContain('"etag1"');
    expect(xml).toContain('BEGIN:VCALENDAR');
    expect(xml).toContain('200 OK');
  });
});

describe('extractHrefsFromMultiget', () => {
  it('extracts href values from calendar-multiget XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data/><D:getetag/></D:prop>
  <D:href>/caldav/calendars/admin/id1.ics</D:href>
  <D:href>/caldav/calendars/admin/id2.ics</D:href>
</C:calendar-multiget>`;
    const hrefs = extractHrefsFromMultiget(xml);
    expect(hrefs).toEqual([
      '/caldav/calendars/admin/id1.ics',
      '/caldav/calendars/admin/id2.ics',
    ]);
  });
});

describe('isMultigetReport', () => {
  it('returns true for calendar-multiget', () => {
    expect(isMultigetReport('<C:calendar-multiget')).toBe(true);
  });

  it('returns false for calendar-query', () => {
    expect(isMultigetReport('<C:calendar-query')).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/caldav/xml.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

Create `src/caldav/xml.ts`:

```typescript
/** Check if a REPORT body is calendar-multiget (vs calendar-query) */
export function isMultigetReport(body: string): boolean {
  return body.includes('calendar-multiget');
}

/** Extract <D:href> values from a calendar-multiget XML body */
export function extractHrefsFromMultiget(body: string): string[] {
  const hrefs: string[] = [];
  const regex = /<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/gi;
  let match;
  while ((match = regex.exec(body)) !== null) {
    hrefs.push(match[1].trim());
  }
  return hrefs;
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** PROPFIND response for /caldav/principal/ */
export function buildPrincipalPropfind(href: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>/caldav/principal/</D:href></D:current-user-principal>
        <C:calendar-home-set><D:href>/caldav/calendars/</D:href></C:calendar-home-set>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>Second Brain</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

/** PROPFIND response for /caldav/calendars/ — lists the admin calendar */
export function buildCalendarHomePropfind(href: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>Calendars</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/caldav/calendars/admin/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Second Brain Admin</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

/** PROPFIND response for /caldav/calendars/admin/ — calendar properties with ctag */
export function buildCalendarPropfind(href: string, ctag: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Second Brain Admin</D:displayname>
        <CS:getctag>${xmlEscape(ctag)}</CS:getctag>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

export interface EventResponseEntry {
  href: string;
  etag: string;
  calendarData: string;
}

/** REPORT response with calendar data and etags (used for both multiget and query) */
export function buildMultigetResponse(events: EventResponseEntry[]): string {
  const responses = events
    .map(
      (e) => `  <D:response>
    <D:href>${xmlEscape(e.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${xmlEscape(e.etag)}</D:getetag>
        <C:calendar-data>${xmlEscape(e.calendarData)}</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${responses}
</D:multistatus>`;
}

/** PROPFIND response listing individual event resources (Depth: 1 on calendar) */
export function buildCalendarChildrenPropfind(
  calendarHref: string,
  ctag: string,
  events: Array<{ href: string; etag: string }>,
): string {
  const calendarResponse = `  <D:response>
    <D:href>${xmlEscape(calendarHref)}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Second Brain Admin</D:displayname>
        <CS:getctag>${xmlEscape(ctag)}</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;

  const eventResponses = events
    .map(
      (e) => `  <D:response>
    <D:href>${xmlEscape(e.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${xmlEscape(e.etag)}</D:getetag>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
${calendarResponse}
${eventResponses}
</D:multistatus>`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/caldav/xml.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/caldav/xml.ts src/caldav/xml.test.ts
git commit -m "feat(caldav): add WebDAV XML builders with tests"
```

---

## Task 9: Add Notion Query + Update Functions for CalDAV

Add `queryAllAdmin` (fetches all admin tasks, not just pending) and `updateAdminFromCalendar` (updates date + name).

**Files:**
- Modify: `src/notion/databases.ts`
- Modify: `src/notion/index.ts` (re-export)

**Step 1: Add queryAllAdmin to databases.ts**

Add to `src/notion/databases.ts` after `queryDueAdmin`:

```typescript
/** Query all admin tasks (pending + recently completed/cancelled) for CalDAV cache */
export async function queryAllAdmin(pageSize = 100): Promise<NotionPage[]> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const response = await callNotion('queryAllAdmin', () =>
    queryDatabase({
      database_id: config.NOTION_DB_ADMIN,
      filter: {
        or: [
          { property: 'Status', select: { equals: 'pending' } },
          {
            and: [
              { property: 'Status', select: { does_not_equal: 'pending' } },
              { timestamp: 'last_edited_time', last_edited_time: { on_or_after: thirtyDaysAgo.toISOString() } },
            ],
          },
        ],
      },
      sorts: [{ property: 'Due Date', direction: 'ascending' }],
      page_size: pageSize,
    }),
  );

  return response.results.map((page) => ({
    id: page.id,
    properties: page.properties,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  }));
}
```

**Step 2: Add updateAdminFromCalendar to databases.ts**

Add to `src/notion/databases.ts` after `updatePageStatus`:

```typescript
/** Update an admin task from CalDAV — supports title, due date, and status changes */
export async function updateAdminFromCalendar(
  pageId: string,
  updates: { name?: string; dueDate?: string; status?: string },
): Promise<void> {
  const properties: Record<string, unknown> = {};

  if (updates.name !== undefined) {
    properties['Name'] = { title: richText(updates.name) };
  }
  if (updates.dueDate !== undefined) {
    properties['Due Date'] = { date: { start: updates.dueDate } };
  }
  if (updates.status !== undefined) {
    properties['Status'] = { select: sel(updates.status) };
  }

  if (Object.keys(properties).length === 0) return;

  await callNotion('updateAdminFromCalendar', () =>
    notionClient.pages.update({
      page_id: pageId,
      properties: properties as Parameters<typeof notionClient.pages.update>[0]['properties'],
    }),
  );
  logger.info({ event: 'admin_updated_from_caldav', pageId, updates });
}
```

**Step 3: Re-export from notion/index.ts**

Add `queryAllAdmin` and `updateAdminFromCalendar` to the re-export block in `src/notion/index.ts`:

```typescript
export {
  // ... existing exports ...
  queryAllAdmin,
  updateAdminFromCalendar,
} from './databases.js';
```

**Step 4: Verify type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/notion/databases.ts src/notion/index.ts
git commit -m "feat(caldav): add Notion query and update functions for CalDAV"
```

---

## Task 10: CalDAV Route Handlers

The core request handling logic: PROPFIND, REPORT, GET, PUT, DELETE, OPTIONS.

**Files:**
- Create: `src/caldav/handlers.ts`

**Step 1: Write the handlers**

Create `src/caldav/handlers.ts`:

```typescript
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  queryAllAdmin,
  updateAdminFromCalendar,
  updatePageStatus,
  createAdminPage,
} from '../notion/index.js';
import type { CalDavCache } from './cache.js';
import { pageToVEvent, wrapCalendar, parseVEvent } from './ical.js';
import {
  buildPrincipalPropfind,
  buildCalendarHomePropfind,
  buildCalendarPropfind,
  buildCalendarChildrenPropfind,
  buildMultigetResponse,
  isMultigetReport,
  extractHrefsFromMultiget,
} from './xml.js';

const CALENDAR_PATH = '/caldav/calendars/admin/';

function sendXml(res: Response, status: number, xml: string): void {
  res.status(status).set('Content-Type', 'application/xml; charset=utf-8').send(xml);
}

export function createHandlers(cache: CalDavCache) {
  async function handlePropfind(req: Request, res: Response): Promise<void> {
    const path = req.path;
    const depth = req.headers['depth'] ?? '0';

    logger.debug({ event: 'caldav_propfind', path, depth });
    await cache.refreshIfStale();

    if (path === '/principal/' || path === '/principal') {
      sendXml(res, 207, buildPrincipalPropfind('/caldav/principal/'));
      return;
    }

    if (path === '/calendars/' || path === '/calendars') {
      sendXml(res, 207, buildCalendarHomePropfind('/caldav/calendars/'));
      return;
    }

    if (path === '/calendars/admin/' || path === '/calendars/admin') {
      if (depth === '1') {
        // List all events with etags
        const pages = cache.getAllDated();
        const events = pages.map((p) => ({
          href: `${CALENDAR_PATH}${p.id}.ics`,
          etag: cache.getEtag(p.id) ?? '""',
        }));
        sendXml(res, 207, buildCalendarChildrenPropfind(CALENDAR_PATH, cache.getCtag(), events));
      } else {
        sendXml(res, 207, buildCalendarPropfind(CALENDAR_PATH, cache.getCtag()));
      }
      return;
    }

    // Individual event PROPFIND
    const uidMatch = path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (uidMatch) {
      const uid = uidMatch[1];
      const pageId = cache.resolveUid(uid);
      const page = cache.getById(pageId);
      if (!page) {
        res.status(404).send('Not Found');
        return;
      }
      const etag = cache.getEtag(pageId) ?? '""';
      sendXml(
        res,
        207,
        buildMultigetResponse([
          {
            href: `${CALENDAR_PATH}${uid}.ics`,
            etag,
            calendarData: wrapCalendar(pageToVEvent(page)),
          },
        ]),
      );
      return;
    }

    res.status(404).send('Not Found');
  }

  async function handleReport(req: Request, res: Response): Promise<void> {
    const body = typeof req.body === 'string' ? req.body : '';

    logger.debug({ event: 'caldav_report', path: req.path, bodyLength: body.length });
    await cache.refreshIfStale();

    if (isMultigetReport(body)) {
      // Return specific events by href
      const hrefs = extractHrefsFromMultiget(body);
      const events = hrefs
        .map((href) => {
          const uidMatch = href.match(/\/([^/]+)\.ics$/);
          if (!uidMatch) return null;
          const uid = uidMatch[1];
          const pageId = cache.resolveUid(uid);
          const page = cache.getById(pageId);
          if (!page) return null;
          return {
            href,
            etag: cache.getEtag(pageId) ?? '""',
            calendarData: wrapCalendar(pageToVEvent(page)),
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);

      sendXml(res, 207, buildMultigetResponse(events));
    } else {
      // calendar-query: return all events
      const pages = cache.getAllDated();
      const events = pages.map((p) => ({
        href: `${CALENDAR_PATH}${p.id}.ics`,
        etag: cache.getEtag(p.id) ?? '""',
        calendarData: wrapCalendar(pageToVEvent(p)),
      }));
      sendXml(res, 207, buildMultigetResponse(events));
    }
  }

  async function handleGet(req: Request, res: Response): Promise<void> {
    const uidMatch = req.path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (!uidMatch) {
      res.status(404).send('Not Found');
      return;
    }

    await cache.refreshIfStale();
    const uid = uidMatch[1];
    const pageId = cache.resolveUid(uid);
    const page = cache.getById(pageId);

    if (!page) {
      res.status(404).send('Not Found');
      return;
    }

    const etag = cache.getEtag(pageId) ?? '""';
    res
      .status(200)
      .set('Content-Type', 'text/calendar; charset=utf-8')
      .set('ETag', etag)
      .send(wrapCalendar(pageToVEvent(page)));
  }

  async function handlePut(req: Request, res: Response): Promise<void> {
    const uidMatch = req.path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (!uidMatch) {
      res.status(404).send('Not Found');
      return;
    }

    const uid = uidMatch[1];
    const body = typeof req.body === 'string' ? req.body : '';
    const parsed = parseVEvent(body);

    logger.info({ event: 'caldav_put', uid, summary: parsed.summary, dtstart: parsed.dtstart });

    const pageId = cache.resolveUid(uid);
    const existingPage = cache.getById(pageId);

    if (existingPage) {
      // Update existing task
      const ifMatch = req.headers['if-match'] as string | undefined;
      const currentEtag = cache.getEtag(pageId);
      if (ifMatch && currentEtag && ifMatch !== currentEtag) {
        res.status(412).send('Precondition Failed');
        return;
      }

      const updates: { name?: string; dueDate?: string; status?: string } = {};
      if (parsed.dtstart) updates.dueDate = parsed.dtstart;
      if (parsed.summary) updates.name = parsed.summary;
      if (parsed.status === 'COMPLETED') updates.status = 'done';
      else if (parsed.status === 'CANCELLED') updates.status = 'cancelled';

      await updateAdminFromCalendar(pageId, updates);
      cache.invalidate();

      res.status(204).set('ETag', `"${new Date().toISOString()}"`).send();
    } else {
      // Create new task from Calendar
      const newPageId = await createAdminPage({
        name: parsed.summary || 'Untitled',
        type: 'task',
        dueDate: parsed.dtstart || null,
        status: 'pending',
        priority: 'medium',
        tags: [],
        sourceMessage: 'Created from Apple Calendar',
        sourceMessageId: 0,
        confidence: 1,
      });

      cache.setUidMapping(uid, newPageId);
      cache.invalidate();

      logger.info({ event: 'caldav_created', uid, pageId: newPageId });
      res.status(201).set('ETag', `"${new Date().toISOString()}"`).send();
    }
  }

  async function handleDelete(req: Request, res: Response): Promise<void> {
    const uidMatch = req.path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (!uidMatch) {
      res.status(404).send('Not Found');
      return;
    }

    const uid = uidMatch[1];
    const pageId = cache.resolveUid(uid);
    const page = cache.getById(pageId);

    if (!page) {
      res.status(404).send('Not Found');
      return;
    }

    logger.info({ event: 'caldav_delete', uid, pageId });
    await updatePageStatus(pageId, 'done');
    cache.invalidate();

    res.status(204).send();
  }

  function handleOptions(_req: Request, res: Response): void {
    res
      .status(200)
      .set('Allow', 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT')
      .set('DAV', '1, calendar-access')
      .send();
  }

  return { handlePropfind, handleReport, handleGet, handlePut, handleDelete, handleOptions };
}
```

**Step 2: Verify type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/caldav/handlers.ts
git commit -m "feat(caldav): add CalDAV route handlers"
```

---

## Task 11: Router, Barrel Export, and Mount on Express

Wire everything together: Express router, barrel export, and mount on the main app.

**Files:**
- Create: `src/caldav/router.ts`
- Create: `src/caldav/index.ts`
- Modify: `src/index.ts`

**Step 1: Create the router**

Create `src/caldav/router.ts`:

```typescript
import express from 'express';
import { caldavAuth } from './auth.js';
import { CalDavCache } from './cache.js';
import { createHandlers } from './handlers.js';
import { queryAllAdmin } from '../notion/index.js';
import { logger } from '../utils/logger.js';

export function createCaldavRouter(): express.Router {
  const router = express.Router();
  const cache = new CalDavCache(() => queryAllAdmin(100));
  const handlers = createHandlers(cache);

  // Parse text bodies for CalDAV (XML + iCalendar)
  router.use(express.text({ type: ['application/xml', 'text/xml', 'text/calendar', 'application/octet-stream'] }));

  // Auth on all routes
  router.use(caldavAuth);

  // Route all requests by HTTP method
  router.all('*', async (req, res) => {
    try {
      switch (req.method) {
        case 'PROPFIND':
          return await handlers.handlePropfind(req, res);
        case 'REPORT':
          return await handlers.handleReport(req, res);
        case 'GET':
          return await handlers.handleGet(req, res);
        case 'PUT':
          return await handlers.handlePut(req, res);
        case 'DELETE':
          return await handlers.handleDelete(req, res);
        case 'OPTIONS':
          return handlers.handleOptions(req, res);
        default:
          res.status(405).set('Allow', 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT').send();
      }
    } catch (err) {
      logger.error({ event: 'caldav_error', method: req.method, path: req.path, error: err });
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  });

  // Start background cache refresh
  const refreshInterval = setInterval(() => void cache.refreshIfStale(), 60_000);

  // Initial cache load
  void cache.refresh();

  // Expose cache for external invalidation (e.g., from bot handlers)
  (router as express.Router & { cache: CalDavCache }).cache = cache;

  logger.info({ event: 'caldav_router_created' }, 'CalDAV router initialized');
  return router;
}

export type { CalDavCache };
```

**Step 2: Create barrel export**

Create `src/caldav/index.ts`:

```typescript
export { createCaldavRouter } from './router.js';
export { CalDavCache } from './cache.js';
```

**Step 3: Mount on Express in src/index.ts**

In `src/index.ts`, add import at the top (after existing imports):

```typescript
import { createCaldavRouter } from './caldav/index.js';
```

Then add the CalDAV mount right after the health check endpoint (after `app.get('/health', ...)`):

```typescript
  // CalDAV server for iOS Calendar integration
  if (config.CALDAV_ENABLED) {
    const caldavRouter = createCaldavRouter();
    app.use('/caldav', caldavRouter);

    // .well-known/caldav discovery (RFC 6764)
    app.all('/.well-known/caldav', (_req, res) => {
      res.redirect(301, '/caldav/principal/');
    });

    logger.info({ event: 'caldav_enabled' }, 'CalDAV server mounted at /caldav');
  }
```

**Step 4: Verify type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add src/caldav/router.ts src/caldav/index.ts src/index.ts
git commit -m "feat(caldav): mount CalDAV router on Express app"
```

---

## Task 12: Cache Invalidation from Bot

When the Telegram bot creates/updates an admin task, invalidate the CalDAV cache so Calendar picks up changes quickly.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/bot/handlers/message.ts`

**Step 1: Export cache reference from index.ts**

In `src/index.ts`, make the CalDAV cache accessible. After mounting the router, store the cache reference:

```typescript
  // Inside the if (config.CALDAV_ENABLED) block, after mounting:
  // Make cache accessible for bot handlers to invalidate
  const caldavCache = (caldavRouter as express.Router & { cache: import('./caldav/cache.js').CalDavCache }).cache;
  // Store on app.locals for access from other modules
  app.locals.caldavCache = caldavCache;
```

**Step 2: Add invalidation helper to utils/state.ts**

In `src/utils/state.ts`, add a CalDAV cache invalidation callback:

```typescript
let _caldavInvalidate: (() => void) | null = null;

export function setCaldavInvalidator(fn: () => void): void {
  _caldavInvalidate = fn;
}

export function invalidateCaldavCache(): void {
  _caldavInvalidate?.();
}
```

**Step 3: Wire up the invalidator in index.ts**

In `src/index.ts`, inside the `if (config.CALDAV_ENABLED)` block:

```typescript
  import { setCaldavInvalidator } from './utils/state.js';
  // ... after creating caldavCache:
  setCaldavInvalidator(() => caldavCache.invalidate());
```

(Move the import to the top of the file with other imports.)

**Step 4: Call invalidation in message handler**

In `src/bot/handlers/message.ts`, add import:

```typescript
import { invalidateCaldavCache } from '../../utils/state.js';
```

Then add `invalidateCaldavCache()` after successful `fileToDatabase()` calls (when category is 'admin') and after `updatePageStatus()` calls. Find the lines after these Notion operations and add:

```typescript
invalidateCaldavCache();
```

**Step 5: Verify type-check**

Run: `npx -p typescript tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add src/index.ts src/utils/state.ts src/bot/handlers/message.ts
git commit -m "feat(caldav): add cache invalidation from bot handlers"
```

---

## Task 13: Infrastructure + E2E Verification

Update Caddy config, .env.example, and verify with curl.

**Files:**
- Modify: `Caddyfile` (if it exists)
- Modify: `docker-compose.yml` (if CALDAV env vars need passing)

**Step 1: Check and update Caddyfile**

CalDAV traffic goes to the same Express backend, so Caddy just needs to proxy it. The existing `reverse_proxy app:3000` should already cover `/caldav/*`.

However, CalDAV uses HTTP methods that Caddy might not proxy by default (PROPFIND, REPORT). **Verify Caddy proxies all methods** — by default, Caddy's `reverse_proxy` does proxy all HTTP methods, so no change should be needed.

If there's a `.well-known` redirect in Caddy, it might conflict. Check and ensure Express handles `/.well-known/caldav`.

**Step 2: Add CalDAV env vars to docker-compose.yml**

If `docker-compose.yml` has explicit `environment` entries, add:

```yaml
      - CALDAV_ENABLED=${CALDAV_ENABLED:-false}
      - CALDAV_USERNAME=${CALDAV_USERNAME:-}
      - CALDAV_PASSWORD=${CALDAV_PASSWORD:-}
```

**Step 3: Run the app and verify with curl**

Set test env vars and run in dev mode:

```bash
CALDAV_ENABLED=true CALDAV_USERNAME=test CALDAV_PASSWORD=test npm run dev
```

Then test the CalDAV endpoints:

```bash
# Service discovery
curl -v http://localhost:3000/.well-known/caldav

# Should redirect to /caldav/principal/

# Principal PROPFIND
curl -X PROPFIND \
  -H "Depth: 0" \
  -H "Content-Type: application/xml" \
  -u test:test \
  http://localhost:3000/caldav/principal/

# Calendar home PROPFIND
curl -X PROPFIND \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  -u test:test \
  http://localhost:3000/caldav/calendars/

# Calendar PROPFIND (should show ctag)
curl -X PROPFIND \
  -H "Depth: 0" \
  -u test:test \
  http://localhost:3000/caldav/calendars/admin/

# List events (Depth: 1)
curl -X PROPFIND \
  -H "Depth: 1" \
  -u test:test \
  http://localhost:3000/caldav/calendars/admin/

# Calendar query REPORT
curl -X REPORT \
  -H "Content-Type: application/xml" \
  -u test:test \
  -d '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-data/><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>' \
  http://localhost:3000/caldav/calendars/admin/

# OPTIONS
curl -X OPTIONS -u test:test http://localhost:3000/caldav/calendars/admin/
```

Expected: All return 207 (multistatus) with correct XML, except OPTIONS (200) and .well-known (301).

**Step 4: Test on iPhone**

Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account:
- Server: your-domain.com (or local IP for testing)
- Username: your CALDAV_USERNAME
- Password: your CALDAV_PASSWORD

Expected: "Second Brain Admin" calendar appears with dated tasks as all-day events.

**Step 5: Commit any config changes**

```bash
git add Caddyfile docker-compose.yml .env.example
git commit -m "feat(caldav): add infrastructure config for CalDAV"
```

---

## Task Summary

| # | Task | New Files | Tests |
|---|------|-----------|-------|
| 1 | Set up Vitest | `vitest.config.ts` | framework setup |
| 2 | Config + CalDavError | — | — |
| 3 | Notion property extractors | `src/caldav/notion-helpers.ts` | 8 tests |
| 4 | iCalendar generation | `src/caldav/ical.ts` | 6 tests |
| 5 | iCalendar parsing | (extend ical.ts) | 5 tests |
| 6 | In-memory cache | `src/caldav/cache.ts` | 7 tests |
| 7 | Auth middleware | `src/caldav/auth.ts` | 5 tests |
| 8 | WebDAV XML builders | `src/caldav/xml.ts` | 5 tests |
| 9 | Notion query + update | — | — |
| 10 | CalDAV handlers | `src/caldav/handlers.ts` | — |
| 11 | Router + barrel + mount | `src/caldav/router.ts`, `src/caldav/index.ts` | — |
| 12 | Cache invalidation | — | — |
| 13 | Infrastructure + E2E | — | curl verification |

**Total: 13 tasks, ~36 tests, 8 new files, 0 new runtime dependencies**
