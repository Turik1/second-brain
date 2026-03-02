# Time Management Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 7 time management features to the Second Brain bot: due-date sorting, admin priority, afternoon reminder, project next actions, interactive weekly review, idea curation, and cross-category relations.

**Architecture:** Feature-by-feature implementation. Each feature touches 2-4 files, docks onto existing patterns. No shared abstractions — each feature is self-contained. New callback handlers follow the existing `bounce:` / `i:` pattern.

**Tech Stack:** TypeScript, grammY (Telegram), Notion API, node-cron, Zod schemas

---

## Task 1: Due-Date Sorting — Query Function

**Files:**
- Modify: `src/notion/databases.ts` (after line 286, add new function)
- Modify: `src/notion/index.ts` (add re-export)

**Step 1: Add `queryPendingAdmin()` to databases.ts**

Add after the existing `queryByProperty` function (line 286):

```typescript
export async function queryPendingAdmin(pageSize = 50): Promise<NotionPage[]> {
  const response = await callNotion('queryPendingAdmin', () =>
    queryDatabase({
      database_id: config.NOTION_DB_ADMIN,
      filter: {
        property: 'Status',
        select: { equals: 'pending' },
      },
      sorts: [
        { property: 'Due Date', direction: 'ascending' },
        { timestamp: 'created_time', direction: 'descending' },
      ],
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

**Step 2: Add `queryDueAdmin()` to databases.ts**

Add right after `queryPendingAdmin`:

```typescript
export async function queryDueAdmin(onOrBefore: Date, pageSize = 50): Promise<NotionPage[]> {
  const response = await callNotion('queryDueAdmin', () =>
    queryDatabase({
      database_id: config.NOTION_DB_ADMIN,
      filter: {
        and: [
          { property: 'Status', select: { equals: 'pending' } },
          { property: 'Due Date', date: { on_or_before: onOrBefore.toISOString().split('T')[0] } },
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

**Step 3: Re-export from `src/notion/index.ts`**

Add `queryPendingAdmin` and `queryDueAdmin` to the re-export block (line 166 area).

**Step 4: Commit**

```bash
git add src/notion/databases.ts src/notion/index.ts
git commit -m "feat: add queryPendingAdmin and queryDueAdmin functions"
```

---

## Task 2: Due-Date Sorting — Enhance summarizePage

**Files:**
- Modify: `src/notion/databases.ts:431-448` (the `summarizePage` function)

**Step 1: Update `summarizePage` to include Due Date, Priority, and Status**

Replace the existing `summarizePage` function:

```typescript
export function summarizePage(page: NotionPage): string {
  const props = page.properties;
  let title = '';
  let body = '';
  const meta: string[] = [];

  for (const [key, val] of Object.entries(props)) {
    if (typeof val !== 'object' || val === null) continue;
    const v = val as Record<string, unknown>;

    if (v['type'] === 'title' && Array.isArray(v['title'])) {
      title = extractText(v['title']);
    } else if (v['type'] === 'rich_text' && Array.isArray(v['rich_text']) && !body) {
      const text = extractText(v['rich_text']);
      if (text) body = text.slice(0, 200);
    } else if (v['type'] === 'select' && v['select']) {
      const selectVal = (v['select'] as Record<string, unknown>)['name'] as string | undefined;
      if (selectVal && (key === 'Priority' || key === 'Status')) {
        meta.push(`${key}: ${selectVal}`);
      }
    } else if (v['type'] === 'date' && v['date'] && key === 'Due Date') {
      const dateObj = v['date'] as Record<string, unknown>;
      const start = dateObj['start'] as string | undefined;
      if (start) meta.push(`fällig: ${start}`);
    }
  }

  const metaStr = meta.length > 0 ? ` [${meta.join(', ')}]` : '';
  return body ? `${title}${metaStr}: ${body}` : `${title}${metaStr}`;
}
```

**Step 2: Commit**

```bash
git add src/notion/databases.ts
git commit -m "feat: enrich summarizePage with due date, priority, status"
```

---

## Task 3: Due-Date Sorting — Wire into Daily + Overview

**Files:**
- Modify: `src/digest/daily.ts:4,46-56`
- Modify: `src/digest/overview.ts:5,70`

**Step 1: Update daily.ts**

Change the import (line 4) to add `queryPendingAdmin`:

```typescript
import { queryRecentEntries, queryByProperty, queryPendingAdmin, summarizePage } from '../notion/index.js';
```

Replace the admin query in the `Promise.all` block (line 50) — change `queryByProperty(config.NOTION_DB_ADMIN, 'Status', 'pending', PAGE_SIZE)` to `queryPendingAdmin(PAGE_SIZE)`.

**Step 2: Update overview.ts**

Change the import (line 5) to add `queryPendingAdmin`:

```typescript
import { queryRecentEntries, queryByProperty, queryPendingAdmin, summarizePage } from '../notion/index.js';
```

Replace line 70 — change `queryByProperty(config.NOTION_DB_ADMIN, 'Status', 'pending', PAGE_SIZE)` to `queryPendingAdmin(PAGE_SIZE)`.

**Step 3: Update daily digest prompt**

In `src/digest/prompt.ts`, update `DAILY_DIGEST_SYSTEM_PROMPT` — change the Action Items line to:

```
2. <b>Action Items</b> - Admin tasks that need attention. OVERDUE tasks (past due date) should be highlighted with a warning. Sort by urgency: overdue first, then due today, then no deadline.
```

**Step 4: Commit**

```bash
git add src/digest/daily.ts src/digest/overview.ts src/digest/prompt.ts
git commit -m "feat: use due-date-sorted admin queries in daily digest and overview"
```

---

## Task 4: Admin Priority — Schema + Classifier

**Files:**
- Modify: `src/classifier/schemas.ts:33-37`
- Modify: `src/classifier/prompt.ts`

**Step 1: Add priority to admin extracted fields in schemas.ts**

Replace the admin object in the discriminated union (lines 33-37):

```typescript
    z.object({
      category: z.literal('admin'),
      type: z.enum(['task', 'reminder', 'appointment', 'errand', 'note']),
      due_date: z.string().nullable().describe('ISO date string if mentioned, null otherwise'),
      status: z.literal('pending'),
      priority: z.enum(['high', 'medium', 'low']).describe(
        'Priority: high for appointments/deadlines/urgent items, medium for standard tasks/errands, low for notes/non-urgent items',
      ),
    }),
```

**Step 2: Update classifier prompt**

In `src/classifier/prompt.ts`, add to the admin category description (after "Key signal: something that needs to be DONE"):

```
For admin entries, also assess priority:
- **high**: appointments, items with explicit deadlines, urgent requests, time-sensitive errands
- **medium**: standard tasks, shopping/errands, reminders without urgency
- **low**: notes, non-urgent observations, "someday" items
```

**Step 3: Commit**

```bash
git add src/classifier/schemas.ts src/classifier/prompt.ts
git commit -m "feat: add priority field to admin classification schema"
```

---

## Task 5: Admin Priority — Wire into Notion + Classifier Output

**Files:**
- Modify: `src/notion/schemas.ts:35-44` (AdminEntry interface)
- Modify: `src/notion/databases.ts:140-166` (createAdminPage function)
- Modify: `src/classifier/index.ts:91-94` (toClassificationResult admin block)
- Modify: `src/notion/index.ts:262-275` (fileToDatabase admin case)

**Step 1: Add priority to AdminEntry interface**

In `src/notion/schemas.ts`, add `priority` to AdminEntry (after line 39, the `status` field):

```typescript
export interface AdminEntry {
  name: string;
  type: 'task' | 'reminder' | 'appointment' | 'errand' | 'note';
  dueDate: string | null;
  status: 'pending' | 'done' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  tags: string[];
  sourceMessage: string;
  sourceMessageId: number;
  confidence: number;
}
```

**Step 2: Update createAdminPage to include Priority property**

In `src/notion/databases.ts`, add Priority to the properties object inside `createAdminPage` (line 148 area, after Status):

```typescript
    Priority: { select: sel(data.priority) },
```

**Step 3: Update toClassificationResult in classifier/index.ts**

In `src/classifier/index.ts`, add priority extraction in the admin block (line 91-94):

```typescript
  } else if (fields.category === 'admin') {
    extras['type'] = fields.type;
    extras['due_date'] = fields.due_date;
    extras['status'] = fields.status;
    extras['priority'] = fields.priority;
  }
```

**Step 4: Update fileToDatabase admin case**

In `src/notion/index.ts`, add priority to the admin case (line 262-275 area):

```typescript
    case 'admin':
      return createAdminPage({
        name: classification.title,
        type:
          (extras['type'] as
            | 'task'
            | 'reminder'
            | 'appointment'
            | 'errand'
            | 'note') ?? 'task',
        dueDate: (extras['due_date'] as string | null) ?? null,
        status: 'pending',
        priority: (extras['priority'] as 'high' | 'medium' | 'low') ?? 'medium',
        ...base,
      });
```

**Step 5: Commit**

```bash
git add src/notion/schemas.ts src/notion/databases.ts src/classifier/index.ts src/notion/index.ts
git commit -m "feat: wire admin priority through classifier to Notion"
```

**Step 6: Manually add Priority select property to Admin Notion database**

Go to the Admin database in Notion → Add property → Select → Name: "Priority" → Options: high, medium, low.

---

## Task 6: Afternoon Reminder

**Files:**
- Create: `src/digest/reminder.ts`
- Modify: `src/config.ts:27` (add AFTERNOON_REMINDER_HOUR)
- Modify: `src/digest/scheduler.ts`
- Modify: `src/digest/index.ts` (if barrel exists, otherwise skip)

**Step 1: Add config field**

In `src/config.ts`, add after `WEEKLY_DIGEST_DAY` (line 28):

```typescript
  AFTERNOON_REMINDER_HOUR: z.coerce.number().int().min(0).max(23).default(14),
```

**Step 2: Create `src/digest/reminder.ts`**

```typescript
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { queryDueAdmin, summarizePage } from '../notion/index.js';

export async function generateAfternoonReminder(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();
  const today = new Date();

  logger.info({ event: 'reminder_start' });

  let pages;
  try {
    pages = await queryDueAdmin(today);
  } catch (err) {
    logger.error({ event: 'reminder_error', error: String(err) }, 'Afternoon reminder failed');
    return;
  }

  if (pages.length === 0) {
    logger.info({ event: 'reminder_skip', reason: 'no_due_tasks', durationMs: Date.now() - startMs });
    return;
  }

  const todayStr = today.toISOString().split('T')[0];
  const overdue: string[] = [];
  const dueToday: string[] = [];

  for (const page of pages) {
    const summary = summarizePage(page).slice(0, 120);
    const dateProp = page.properties['Due Date'] as Record<string, unknown> | undefined;
    const dateObj = dateProp?.['date'] as Record<string, unknown> | undefined;
    const dueDate = dateObj?.['start'] as string | undefined;

    if (dueDate && dueDate < todayStr) {
      const daysAgo = Math.floor((today.getTime() - new Date(dueDate).getTime()) / (86400000));
      overdue.push(`• ${summary} (seit ${daysAgo} Tag${daysAgo > 1 ? 'en' : ''})`);
    } else {
      dueToday.push(`• ${summary}`);
    }
  }

  const lines: string[] = [];
  lines.push(`⏰ <b>Reminder: ${dueToday.length} heute fällig, ${overdue.length} überfällig</b>`);
  lines.push('');

  if (dueToday.length > 0) {
    lines.push('<b>Heute fällig:</b>');
    lines.push(...dueToday);
    lines.push('');
  }

  if (overdue.length > 0) {
    lines.push('<b>Überfällig:</b>');
    lines.push(...overdue);
  }

  await sendFn(lines.join('\n'));

  logger.info({
    event: 'reminder_sent',
    dueToday: dueToday.length,
    overdue: overdue.length,
    durationMs: Date.now() - startMs,
  });
}
```

**Step 3: Add cron job to scheduler.ts**

In `src/digest/scheduler.ts`, import `generateAfternoonReminder`:

```typescript
import { generateAfternoonReminder } from './reminder.js';
```

Add after the weeklyJob definition (around line 48):

```typescript
  const reminderSchedule = `0 ${config.AFTERNOON_REMINDER_HOUR} * * *`;

  const reminderJob = cron.schedule(
    reminderSchedule,
    async () => {
      logger.info({ event: 'cron_fire', type: 'reminder' });
      try {
        await generateAfternoonReminder(sendFn);
      } catch (err) {
        logger.error({ event: 'reminder_error', error: err }, 'Afternoon reminder failed');
      }
    },
    { timezone },
  );
```

Update the logger.info and stop function to include `reminderSchedule` and `reminderJob.stop()`.

**Step 4: Commit**

```bash
git add src/config.ts src/digest/reminder.ts src/digest/scheduler.ts
git commit -m "feat: add afternoon reminder for due/overdue admin tasks"
```

---

## Task 7: Project Next Actions — Schema + Classifier

**Files:**
- Modify: `src/classifier/schemas.ts:19-26` (projects extracted fields)
- Modify: `src/classifier/prompt.ts`

**Step 1: Add next_action to projects schema**

In `src/classifier/schemas.ts`, update the projects object (lines 19-26):

```typescript
    z.object({
      category: z.literal('projects'),
      status: z.enum(['idea', 'active', 'blocked', 'completed', 'archived']),
      description: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      next_action: z.string().nullable().describe(
        'Concrete next physical action to move this project forward. Extract if mentioned, null otherwise.',
      ),
    }),
```

**Step 2: Update classifier prompt**

In `src/classifier/prompt.ts`, add to the projects category description:

```
For projects, also extract the **next action** if mentioned — the concrete next physical step to move the project forward. For example, if the user says "Landing Page Projekt — muss noch Hosting aussuchen", the next_action is "Hosting aussuchen". If no next step is mentioned, set to null.
```

**Step 3: Commit**

```bash
git add src/classifier/schemas.ts src/classifier/prompt.ts
git commit -m "feat: add next_action field to project classification schema"
```

---

## Task 8: Project Next Actions — Wire to Notion

**Files:**
- Modify: `src/notion/schemas.ts:13-22` (ProjectEntry)
- Modify: `src/notion/databases.ts:94-115` (createProjectsPage)
- Modify: `src/classifier/index.ts:83-86` (toClassificationResult projects block)
- Modify: `src/notion/index.ts:231-244` (fileToDatabase projects case)

**Step 1: Add nextAction to ProjectEntry**

In `src/notion/schemas.ts`:

```typescript
export interface ProjectEntry {
  name: string;
  status: 'idea' | 'active' | 'blocked' | 'completed' | 'archived';
  description: string;
  tags: string[];
  priority: 'high' | 'medium' | 'low';
  nextAction: string | null;
  sourceMessage: string;
  sourceMessageId: number;
  confidence: number;
}
```

**Step 2: Update createProjectsPage**

In `src/notion/databases.ts`, add Next Action to the properties in `createProjectsPage` (after Priority):

```typescript
  ...(data.nextAction ? { 'Next Action': { rich_text: richText(data.nextAction) } } : {}),
```

**Step 3: Update toClassificationResult**

In `src/classifier/index.ts`, add to the projects block (line 83-86):

```typescript
  } else if (fields.category === 'projects') {
    extras['status'] = fields.status;
    extras['description'] = fields.description;
    extras['priority'] = fields.priority;
    extras['next_action'] = fields.next_action;
  }
```

**Step 4: Update fileToDatabase**

In `src/notion/index.ts`, add nextAction to the projects case:

```typescript
    case 'projects':
      return createProjectsPage({
        name: classification.title,
        status:
          (extras['status'] as
            | 'idea'
            | 'active'
            | 'blocked'
            | 'completed'
            | 'archived') ?? 'active',
        description: (extras['description'] as string) ?? classification.summary,
        priority: (extras['priority'] as 'high' | 'medium' | 'low') ?? 'medium',
        nextAction: (extras['next_action'] as string | null) ?? null,
        ...base,
      });
```

**Step 5: Update Overview prompt**

In `src/digest/prompt.ts`, update the OVERVIEW_SYSTEM_PROMPT Active Projects section:

```
2. <b>Active Projects</b> - List each active/blocked project with its status, description, and next action. If a project has no next action defined, note it as "⚠️ Kein nächster Schritt definiert".
```

**Step 6: Commit**

```bash
git add src/notion/schemas.ts src/notion/databases.ts src/classifier/index.ts src/notion/index.ts src/digest/prompt.ts
git commit -m "feat: wire project next actions through classifier to Notion"
```

**Step 7: Manually add Next Action property to Projects Notion database**

Go to Projects database in Notion → Add property → Rich Text → Name: "Next Action".

---

## Task 9: Interactive Weekly Review — Query Helpers

**Files:**
- Modify: `src/notion/databases.ts` (add two new query functions)
- Modify: `src/notion/index.ts` (add re-exports)

**Step 1: Add `queryStaleProjects()` to databases.ts**

Add after the `queryDueAdmin` function:

```typescript
export async function queryStaleProjects(olderThan: Date, pageSize = 5): Promise<NotionPage[]> {
  const response = await callNotion('queryStaleProjects', () =>
    queryDatabase({
      database_id: config.NOTION_DB_PROJECTS,
      filter: {
        and: [
          { property: 'Status', select: { equals: 'active' } },
          { timestamp: 'last_edited_time', last_edited_time: { before: olderThan.toISOString() } },
        ],
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
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

**Step 2: Add `queryOldPendingAdmin()` to databases.ts**

```typescript
export async function queryOldPendingAdmin(olderThan: Date, pageSize = 5): Promise<NotionPage[]> {
  const response = await callNotion('queryOldPendingAdmin', () =>
    queryDatabase({
      database_id: config.NOTION_DB_ADMIN,
      filter: {
        and: [
          { property: 'Status', select: { equals: 'pending' } },
          { timestamp: 'created_time', created_time: { before: olderThan.toISOString() } },
        ],
      },
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
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

**Step 3: Add `updatePageProperty()` to databases.ts**

```typescript
export async function updatePageProperty(
  pageId: string,
  propertyName: string,
  selectValue: string,
): Promise<void> {
  await callNotion('updatePageProperty', () =>
    notionClient.pages.update({
      page_id: pageId,
      properties: {
        [propertyName]: { select: sel(selectValue) },
      } as Parameters<typeof notionClient.pages.update>[0]['properties'],
    }),
  );
  logger.info({ event: 'page_property_updated', pageId, propertyName, selectValue });
}
```

**Step 4: Re-export from `src/notion/index.ts`**

Add `queryStaleProjects`, `queryOldPendingAdmin`, `updatePageProperty` to the export block.

**Step 5: Commit**

```bash
git add src/notion/databases.ts src/notion/index.ts
git commit -m "feat: add query helpers for weekly review (stale projects, old admin, property update)"
```

---

## Task 10: Interactive Weekly Review — Review Generator

**Files:**
- Create: `src/digest/weekly-review.ts`

**Step 1: Create weekly-review.ts**

```typescript
import { InlineKeyboard } from 'grammy';
import { logger } from '../utils/logger.js';
import {
  queryStaleProjects,
  queryOldPendingAdmin,
  queryByProperty,
  summarizePage,
} from '../notion/index.js';
import { config } from '../config.js';

interface ReviewMessage {
  text: string;
  keyboard?: InlineKeyboard;
}

export async function generateWeeklyReview(
  sendFn: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const startMs = Date.now();

  logger.info({ event: 'weekly_review_start' });

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [staleProjects, oldAdmin, uncuratedIdeas] = await Promise.all([
    queryStaleProjects(sevenDaysAgo, 5),
    queryOldPendingAdmin(fourteenDaysAgo, 5),
    queryByProperty(config.NOTION_DB_IDEAS, 'Potential', 'unknown', 5),
  ]);

  const messages: ReviewMessage[] = [];

  if (staleProjects.length > 0 || oldAdmin.length > 0 || uncuratedIdeas.length > 0) {
    messages.push({ text: '<b>📋 Weekly Review</b>\n\nZeit für eine kurze Bestandsaufnahme:' });
  }

  // Stale projects
  for (const page of staleProjects) {
    const title = summarizePage(page).slice(0, 80);
    const daysSince = Math.floor((Date.now() - new Date(page.last_edited_time).getTime()) / 86400000);

    const keyboard = new InlineKeyboard()
      .text('Noch relevant', `review:keep:${page.id}`)
      .text('Archivieren', `review:archive:${page.id}`)
      .row()
      .text('Blockiert', `review:blocked:${page.id}`);

    messages.push({
      text: `🔹 <b>Projekt inaktiv seit ${daysSince} Tagen:</b>\n${title}\n\nNoch relevant?`,
      keyboard,
    });
  }

  // Old pending admin
  for (const page of oldAdmin) {
    const title = summarizePage(page).slice(0, 80);
    const daysSince = Math.floor((Date.now() - new Date(page.created_time).getTime()) / 86400000);

    const keyboard = new InlineKeyboard()
      .text('Erledigt', `review:done:${page.id}`)
      .text('Behalten', `review:keep:${page.id}`)
      .row()
      .text('Abbrechen', `review:cancel:${page.id}`);

    messages.push({
      text: `🔸 <b>Admin-Task offen seit ${daysSince} Tagen:</b>\n${title}\n\nNoch offen?`,
      keyboard,
    });
  }

  // Uncurated ideas
  for (const page of uncuratedIdeas) {
    const title = summarizePage(page).slice(0, 80);
    const daysSince = Math.floor((Date.now() - new Date(page.created_time).getTime()) / 86400000);

    const keyboard = new InlineKeyboard()
      .text('High', `curate:high:${page.id}`)
      .text('Medium', `curate:medium:${page.id}`)
      .row()
      .text('Low', `curate:low:${page.id}`)
      .text('Archivieren', `curate:archive:${page.id}`);

    messages.push({
      text: `💡 <b>Idee bewerten</b> (${daysSince} Tage alt):\n${title}`,
      keyboard,
    });
  }

  // Projects without next action (just a nudge, no buttons)
  // Only check if we already have active projects data; query active ones without Next Action
  // We use queryByProperty for active projects and filter client-side for missing Next Action
  if (staleProjects.length === 0) {
    // If no stale projects, check for active ones without next action
    try {
      const activeProjects = await queryByProperty(config.NOTION_DB_PROJECTS, 'Status', 'active', 10);
      const missingNextAction = activeProjects.filter((p) => {
        const naProp = p.properties['Next Action'] as Record<string, unknown> | undefined;
        if (!naProp || naProp['type'] !== 'rich_text') return true;
        const rt = naProp['rich_text'] as Array<{ plain_text?: string }> | undefined;
        return !rt || rt.length === 0 || rt.every((t) => !t.plain_text?.trim());
      });

      if (missingNextAction.length > 0) {
        const names = missingNextAction
          .slice(0, 3)
          .map((p) => `• ${summarizePage(p).slice(0, 60)}`)
          .join('\n');
        messages.push({
          text: `⚠️ <b>Projekte ohne nächsten Schritt:</b>\n${names}\n\nSchick mir ein Update wie z.B. "Landing Page — als nächstes DNS konfigurieren"`,
        });
      }
    } catch (err) {
      logger.warn({ error: String(err) }, 'Failed to check projects without next action');
    }
  }

  if (messages.length === 0) {
    logger.info({ event: 'weekly_review_skip', reason: 'nothing_to_review', durationMs: Date.now() - startMs });
    return;
  }

  for (const msg of messages) {
    await sendFn(msg.text, msg.keyboard);
  }

  logger.info({
    event: 'weekly_review_sent',
    staleProjects: staleProjects.length,
    oldAdmin: oldAdmin.length,
    uncuratedIdeas: uncuratedIdeas.length,
    durationMs: Date.now() - startMs,
  });
}
```

**Step 2: Commit**

```bash
git add src/digest/weekly-review.ts
git commit -m "feat: add interactive weekly review generator"
```

---

## Task 11: Interactive Weekly Review — Callback Handlers

**Files:**
- Create: `src/bot/handlers/review.ts`
- Modify: `src/bot/index.ts`

**Step 1: Create `src/bot/handlers/review.ts`**

```typescript
import type { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import {
  updatePageStatus,
  updatePageProperty,
} from '../../notion/index.js';
import { archiveNotionPage } from '../../notion/index.js';

export function registerReviewHandler(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    // Handle review callbacks: review:<action>:<pageId>
    if (data.startsWith('review:')) {
      const parts = data.split(':');
      if (parts.length !== 3) return;

      const [, action, pageId] = parts;
      await ctx.answerCallbackQuery();

      try {
        let confirmText: string;

        switch (action) {
          case 'keep':
            confirmText = '✓ Behalten';
            break;
          case 'archive':
            await updatePageStatus(pageId, 'archived');
            confirmText = '🗄️ Archiviert';
            break;
          case 'done':
            await updatePageStatus(pageId, 'done');
            confirmText = '✅ Erledigt';
            break;
          case 'blocked':
            await updatePageStatus(pageId, 'blocked');
            confirmText = '🚧 Blockiert';
            break;
          case 'cancel':
            await updatePageStatus(pageId, 'cancelled');
            confirmText = '❌ Abgebrochen';
            break;
          default:
            return;
        }

        // Edit the original message to show result (remove keyboard)
        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text ?? ''}\n\n→ ${confirmText}`,
          { parse_mode: 'HTML' },
        );

        logger.info({ event: 'review_action', action, pageId });
      } catch (err) {
        logger.error({ event: 'review_action_failed', action, pageId, error: String(err) });
        await ctx.reply('Fehler beim Aktualisieren. Bitte versuche es nochmal.');
      }
      return;
    }

    // Handle curation callbacks: curate:<potential>:<pageId>
    if (data.startsWith('curate:')) {
      const parts = data.split(':');
      if (parts.length !== 3) return;

      const [, value, pageId] = parts;
      await ctx.answerCallbackQuery();

      try {
        let confirmText: string;

        if (value === 'archive') {
          await archiveNotionPage(pageId);
          confirmText = '🗄️ Archiviert';
        } else {
          await updatePageProperty(pageId, 'Potential', value);
          confirmText = `Bewertet: ${value}`;
        }

        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text ?? ''}\n\n→ ${confirmText}`,
          { parse_mode: 'HTML' },
        );

        logger.info({ event: 'curate_action', value, pageId });
      } catch (err) {
        logger.error({ event: 'curate_action_failed', value, pageId, error: String(err) });
        await ctx.reply('Fehler beim Aktualisieren. Bitte versuche es nochmal.');
      }
      return;
    }
  });
}
```

**Step 2: Register handler in bot/index.ts**

In `src/bot/index.ts`, add import:

```typescript
import { registerReviewHandler } from './handlers/review.js';
```

Add after `registerIntentCallbackHandler(bot)` (line 26):

```typescript
  registerReviewHandler(bot);
```

**Step 3: Commit**

```bash
git add src/bot/handlers/review.ts src/bot/index.ts
git commit -m "feat: add review and curation callback handlers"
```

---

## Task 12: Interactive Weekly Review — Wire into Scheduler

**Files:**
- Modify: `src/config.ts`
- Modify: `src/digest/scheduler.ts`

**Step 1: Add config for weekly review**

In `src/config.ts`, add after `BOUNCE_THRESHOLD` (line 31):

```typescript
  WEEKLY_REVIEW_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),
```

**Step 2: Update scheduler**

In `src/digest/scheduler.ts`, import:

```typescript
import { generateWeeklyReview } from './weekly-review.js';
import type { InlineKeyboard } from 'grammy';
```

The `sendFn` parameter needs to support an optional keyboard. Update the function signature:

```typescript
export function initializeScheduler(
  sendFn: (text: string) => Promise<void>,
  sendWithKeyboardFn: (text: string, keyboard?: InlineKeyboard) => Promise<void>,
  bot?: Bot,
): { stop: () => void }
```

Add the weekly review cron job after the reminderJob (from Task 6):

```typescript
  const reviewSchedule = `30 ${config.DAILY_DIGEST_HOUR} * * ${config.WEEKLY_DIGEST_DAY}`;

  const reviewJob = config.WEEKLY_REVIEW_ENABLED
    ? cron.schedule(
        reviewSchedule,
        async () => {
          logger.info({ event: 'cron_fire', type: 'weekly_review' });
          try {
            await generateWeeklyReview(sendWithKeyboardFn);
          } catch (err) {
            logger.error({ event: 'weekly_review_error', error: err }, 'Weekly review failed');
          }
        },
        { timezone },
      )
    : null;
```

Update the stop function to include `reviewJob?.stop()`.

**Step 3: Update caller in `src/index.ts`**

Find where `initializeScheduler` is called and update to pass a `sendWithKeyboardFn`. Read `src/index.ts` to see the exact call site.

In `src/index.ts`, update the scheduler initialization to pass a second function:

```typescript
const sendMessage = async (text: string) => {
  await bot.api.sendMessage(config.ALLOWED_CHAT_ID, text, { parse_mode: 'HTML' });
};

const sendWithKeyboard = async (text: string, keyboard?: InlineKeyboard) => {
  await bot.api.sendMessage(config.ALLOWED_CHAT_ID, text, {
    parse_mode: 'HTML',
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
};

const scheduler = initializeScheduler(sendMessage, sendWithKeyboard, bot);
```

Add the `InlineKeyboard` import from grammy in `src/index.ts` if needed.

**Step 4: Commit**

```bash
git add src/config.ts src/digest/scheduler.ts src/index.ts
git commit -m "feat: wire weekly review and afternoon reminder into scheduler"
```

---

## Task 13: Relations — Schema + Classifier

**Files:**
- Modify: `src/classifier/schemas.ts` (add related_entries)
- Modify: `src/classifier/prompt.ts`
- Modify: `src/classifier/index.ts`

**Step 1: Add related_entries to ClassificationSchema**

In `src/classifier/schemas.ts`, add after `search_query` (line 44-46):

```typescript
  related_entries: z.array(z.object({
    search_query: z.string().describe('1-3 distinctive words to find the related entry in Notion'),
    target_category: z.enum(['people', 'projects', 'ideas', 'admin']),
    relationship: z.string().describe('Brief description of the relationship, e.g. "works on this project"'),
  })).max(3).default([]).describe(
    'References to existing entries in other categories. Only include if the message clearly references known people, projects, ideas, or tasks by name.',
  ),
```

**Step 2: Update classifier prompt**

In `src/classifier/prompt.ts`, add a new section before the closing backtick:

```
## Cross-Category Relations

If the message references entries that likely exist in OTHER categories, extract them as related_entries. Only include clear, named references:

- "Meeting mit Lisa über das Landing Page Projekt" → related_entries: [{search_query: "Lisa", target_category: "people", relationship: "discussed project"}, {search_query: "Landing Page", target_category: "projects", relationship: "discussed in meeting"}]
- "Idee für das Podcast-Projekt: Sponsoren suchen" → related_entries: [{search_query: "Podcast", target_category: "projects", relationship: "idea for project"}]
- "Muss Sonnenschutz für Fiona bestellen" → related_entries: [{search_query: "Fiona", target_category: "people", relationship: "task for person"}]

Rules:
- Only include references to entries that likely ALREADY EXIST in the database
- Do NOT create self-references (don't reference the same category as the classified entry)
- Max 3 related entries
- Empty array if no cross-references are detected
```

**Step 3: Update toClassificationResult in classifier/index.ts**

In `src/classifier/index.ts`, add after `extras['reasoning'] = output.reasoning;` (line 97):

```typescript
  return {
    category: output.category as Category,
    confidence: output.confidence,
    title: output.title,
    summary: output.reasoning,
    tags: output.tags,
    extras,
    intent: output.intent,
    searchQuery: output.search_query,
    relatedEntries: output.related_entries,
  };
```

**Step 4: Update ClassificationResult type**

In `src/types.ts`, add to the `ClassificationResult` interface:

```typescript
  relatedEntries: Array<{
    search_query: string;
    target_category: 'people' | 'projects' | 'ideas' | 'admin';
    relationship: string;
  }>;
```

**Step 5: Commit**

```bash
git add src/classifier/schemas.ts src/classifier/prompt.ts src/classifier/index.ts src/types.ts
git commit -m "feat: add related_entries to classification schema for cross-category relations"
```

---

## Task 14: Relations — Notion Setup + Handler

**Files:**
- Modify: `src/notion/databases.ts` (add addRelation function)
- Modify: `src/notion/index.ts` (re-export + add relation logic to fileToDatabase)
- Create: `src/bot/handlers/relations.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/message.ts`

**Step 1: Add `addRelation()` to databases.ts**

```typescript
export async function addRelation(
  pageId: string,
  relationPropertyName: string,
  targetPageId: string,
): Promise<void> {
  await callNotion('addRelation', () =>
    notionClient.pages.update({
      page_id: pageId,
      properties: {
        [relationPropertyName]: {
          relation: [{ id: targetPageId }],
        },
      } as Parameters<typeof notionClient.pages.update>[0]['properties'],
    }),
  );
  logger.info({ event: 'relation_added', pageId, relationPropertyName, targetPageId });
}
```

Re-export from `src/notion/index.ts`.

**Step 2: Create `src/bot/handlers/relations.ts`**

```typescript
import type { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import { addRelation } from '../../notion/index.js';

// Map category to Notion relation property name
const RELATION_PROPERTY: Record<string, string> = {
  people: 'Related People',
  projects: 'Related Projects',
  ideas: 'Related Ideas',
  admin: 'Related Admin',
};

export function registerRelationsHandler(bot: Bot): void {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith('relate:')) {
      const parts = data.split(':');
      if (parts.length !== 4) return;

      const [, sourcePageId, targetPageId, targetCategory] = parts;
      await ctx.answerCallbackQuery();

      const propertyName = RELATION_PROPERTY[targetCategory];
      if (!propertyName) return;

      try {
        await addRelation(sourcePageId, propertyName, targetPageId);

        await ctx.editMessageText(
          `${ctx.callbackQuery.message?.text ?? ''}\n\n→ ✓ Verknüpft`,
          { parse_mode: 'HTML' },
        );

        logger.info({ event: 'relation_created', sourcePageId, targetPageId, targetCategory });
      } catch (err) {
        logger.error({ event: 'relation_failed', error: String(err) });
        await ctx.reply('Fehler beim Verknüpfen. Bitte versuche es nochmal.');
      }
      return;
    }

    if (data.startsWith('skip-relate:')) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `${ctx.callbackQuery.message?.text ?? ''}\n\n→ Übersprungen`,
        { parse_mode: 'HTML' },
      );
      return;
    }
  });
}
```

**Step 3: Register in bot/index.ts**

```typescript
import { registerRelationsHandler } from './handlers/relations.js';
```

Add after `registerReviewHandler(bot)`:

```typescript
  registerRelationsHandler(bot);
```

**Step 4: Add relation suggestion logic to message handler**

In `src/bot/handlers/message.ts`, add a helper function and call it after `fileAndReceipt`:

```typescript
import { searchByTitle } from '../../notion/index.js';
import type { InlineKeyboard as IKType } from 'grammy';

async function suggestRelations(
  ctx: any,
  classification: ClassificationResult,
  sourcePageId: string,
): Promise<void> {
  if (!classification.relatedEntries || classification.relatedEntries.length === 0) return;

  const DB_MAP: Record<string, string> = {
    people: config.NOTION_DB_PEOPLE,
    projects: config.NOTION_DB_PROJECTS,
    ideas: config.NOTION_DB_IDEAS,
    admin: config.NOTION_DB_ADMIN,
  };

  const CATEGORY_LABELS: Record<string, string> = {
    people: 'Kontakte',
    projects: 'Projekte',
    ideas: 'Ideen',
    admin: 'Admin',
  };

  for (const entry of classification.relatedEntries) {
    // Skip self-referencing category
    if (entry.target_category === classification.category) continue;

    const dbId = DB_MAP[entry.target_category];
    if (!dbId) continue;

    try {
      const results = await searchByTitle(dbId, entry.search_query, 3);

      // Only suggest if exactly 1 match (unambiguous)
      if (results.length === 1) {
        const { summarizePage } = await import('../../notion/index.js');
        const targetTitle = summarizePage(results[0]).slice(0, 60);
        const targetCategory = CATEGORY_LABELS[entry.target_category] ?? entry.target_category;

        // callback_data has 64-byte limit, so we need short IDs
        // Use first 8 chars of each page ID (Notion IDs are UUIDs)
        const keyboard = new InlineKeyboard()
          .text('Verknüpfen', `relate:${sourcePageId}:${results[0].id}:${entry.target_category}`)
          .text('Ignorieren', `skip-relate:${sourcePageId}`);

        await ctx.reply(
          `🔗 Verknüpfung erkannt:\n→ ${targetTitle} (${targetCategory})\n<i>${entry.relationship}</i>`,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
      }
    } catch (err) {
      logger.warn({ event: 'relation_search_failed', query: entry.search_query, error: String(err) });
    }
  }
}
```

Then update `fileAndReceipt` to call it after sending the receipt. After line 312 (`await ctx.reply(buildReceipt(...))`), add:

```typescript
  // Suggest relations if any were detected
  try {
    await suggestRelations(ctx, classification, targetPageId);
  } catch (err) {
    logger.warn({ event: 'relation_suggestion_failed', error: String(err) });
  }
```

**Note about callback_data 64-byte limit**: Notion page IDs are 36-char UUIDs. The callback pattern `relate:<36>:<36>:<category>` can exceed 64 bytes. If this is an issue, use a short in-memory map (like the existing bouncer/intent patterns). Test with real data first — if it fits, keep it simple.

**Step 5: Commit**

```bash
git add src/notion/databases.ts src/notion/index.ts src/bot/handlers/relations.ts src/bot/handlers/message.ts src/bot/index.ts
git commit -m "feat: add cross-category relation suggestions with confirmation"
```

**Step 6: Manually add Relation properties to Notion databases**

In each of the 4 Notion databases, add Relation properties:
- People DB: `Related Projects` (→ Projects), `Related Ideas` (→ Ideas), `Related Admin` (→ Admin)
- Projects DB: `Related People` (→ People), `Related Ideas` (→ Ideas), `Related Admin` (→ Admin)
- Ideas DB: `Related People` (→ People), `Related Projects` (→ Projects), `Related Admin` (→ Admin)
- Admin DB: `Related People` (→ People), `Related Projects` (→ Projects), `Related Ideas` (→ Ideas)

---

## Task 15: Final Integration — Verify Build + Manual Testing

**Step 1: Install dependencies and build**

```bash
npm install
npm run build
```

Fix any TypeScript errors.

**Step 2: Test locally with `npm run dev`**

Send test messages to the bot:
1. "Milch kaufen bis morgen" → Should classify as Admin with priority, due date
2. "Landing Page Projekt — als nächstes DNS konfigurieren" → Should classify as Project with next_action
3. "Meeting mit Lisa über das Podcast-Projekt" → Should suggest relations to Lisa (People) and Podcast (Projects) if they exist
4. `/digest` → Should show due-date-sorted admin tasks
5. `/overview` → Should show projects with next actions, highlight missing ones

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration fixes from manual testing"
```

---

## Notion Manual Setup Checklist

These must be done in Notion UI before testing:

1. **Admin DB**: Add `Priority` select property (options: high, medium, low)
2. **Projects DB**: Add `Next Action` rich_text property
3. **All 4 DBs**: Add Relation properties linking to each other:
   - `Related People`, `Related Projects`, `Related Ideas`, `Related Admin`
   (Each DB gets 3 relation properties pointing to the other 3 DBs)

---

## Summary of New Files

| File | Purpose |
|------|---------|
| `src/digest/reminder.ts` | Afternoon reminder (14:00), no LLM |
| `src/digest/weekly-review.ts` | Interactive review with buttons |
| `src/bot/handlers/review.ts` | Callback handlers for review + curation |
| `src/bot/handlers/relations.ts` | Callback handlers for relation confirmation |

## Summary of Modified Files

| File | Changes |
|------|---------|
| `src/classifier/schemas.ts` | Admin priority, project next_action, related_entries |
| `src/classifier/prompt.ts` | Priority heuristic, next_action extraction, relations |
| `src/classifier/index.ts` | Extract new fields in toClassificationResult |
| `src/types.ts` | Add relatedEntries to ClassificationResult |
| `src/notion/schemas.ts` | AdminEntry priority, ProjectEntry nextAction |
| `src/notion/databases.ts` | 6 new functions, enhanced summarizePage, createAdminPage priority, createProjectsPage nextAction |
| `src/notion/index.ts` | Re-exports, fileToDatabase updates |
| `src/config.ts` | AFTERNOON_REMINDER_HOUR, WEEKLY_REVIEW_ENABLED |
| `src/digest/scheduler.ts` | Reminder + review cron jobs |
| `src/digest/daily.ts` | Use queryPendingAdmin |
| `src/digest/overview.ts` | Use queryPendingAdmin |
| `src/digest/prompt.ts` | Urgency sorting, next action nudge |
| `src/bot/index.ts` | Register review + relations handlers |
| `src/bot/handlers/message.ts` | Add relation suggestion after filing |
| `src/index.ts` | Pass sendWithKeyboard to scheduler |
