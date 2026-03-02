# Time Management Improvements Design

## Context

The Second Brain Telegram bot captures messages, classifies them via Claude into 4 Notion databases (People, Projects, Ideas, Admin), and generates daily/weekly digests. While capture works well, the system lacks proactive time management features: no due-date awareness, no priority for admin tasks, no reminders, no interactive review, no cross-category connections.

## Decisions

- **Scope**: All 7 features in one pass
- **Approach**: Feature-by-feature, no upfront refactor
- **Afternoon Reminder**: 14:00, today + overdue
- **Weekly Review**: Interactive with inline buttons, separate from digest
- **Idea Curation**: Integrated into weekly review
- **Relations**: Suggested with confirmation buttons
- **Review timing**: 30 min after weekly digest

---

## Feature 1: Due-Date Sorting in Daily Digest & Overview

### Problem
Admin tasks appear unsorted. Overdue tasks get no special treatment.

### Changes
- `databases.ts`: New function `queryPendingAdminWithDueDates()` — queries all pending admin tasks, sorts by Due Date ascending (overdue first, then today, then future, then no date).
- `summarizePage()`: Include Due Date in summary string (e.g. `"Sterilisator suchen [fällig: 2026-03-01]"`) so the Claude prompt sees urgency.
- `daily.ts` + `overview.ts`: Use new function instead of `queryByProperty('Status', 'pending')`.
- `prompt.ts`: Daily prompt gets instruction: "Sort Action Items by urgency — overdue first, with warning."

### No new Notion properties needed
Due Date already exists on Admin.

---

## Feature 2: Priority Field for Admin Tasks

### Problem
Admin tasks have no priority. Projects do (high/medium/low), but admin doesn't.

### Changes
- `schemas.ts`: Add `priority: z.enum(['high', 'medium', 'low'])` to admin extracted fields.
- `classifier/index.ts`: Prompt instructs classifier to set priority. Heuristic: appointments/deadlines → high, errands → medium, notes → low.
- `databases.ts` → `createAdminPage()`: Pass Priority property to Notion.
- **Notion DB**: Add Priority select property to Admin database (manual or via setup.ts).
- `summarizePage()`: Show priority in summary string.
- `prompt.ts`: Daily/Overview prompts: "Group/sort tasks by priority."

### Migration
Existing admin entries without Priority are unaffected — Notion shows empty select.

---

## Feature 3: Afternoon Reminder (14:00)

### Problem
Morning briefing is the only proactive notification. Tasks due today get no reminder.

### Changes
- `digest/reminder.ts` (new): `generateAfternoonReminder()` function. Queries Admin DB with compound filter: Status = pending AND (Due Date = today OR Due Date < today). **No LLM call** — templated message:
  ```
  ⏰ Reminder: X Tasks heute fällig, Y überfällig

  Heute fällig:
  • Task A [high]
  • Task B [medium]

  Überfällig:
  • Task C (seit 2 Tagen) [high]
  ```
  If nothing due/overdue → no message sent.

- `scheduler.ts`: New cron job `0 14 * * *` with timezone.
- `config.ts`: New optional `AFTERNOON_REMINDER_HOUR` (default 14).
- `databases.ts`: New function `queryDueAdmin(onOrBefore: Date)` — filters Status = pending + Due Date <= date. Reused by Feature 1.

### Design decision
No LLM call. Reminder should be fast, cheap, and deterministic.

---

## Feature 4: Next Actions for Projects

### Problem
Projects have status but no concrete next step. Projects without a defined next action stall.

### Changes
- `schemas.ts`: Add `next_action: z.string().nullable()` to projects extracted fields. Description: "Concrete next physical action to move this project forward, null if not mentioned."
- `classifier/index.ts`: Prompt: "Extract the concrete next step if mentioned. E.g. 'Landing Page Projekt — muss noch Hosting aussuchen' → next_action = 'Hosting aussuchen'."
- `databases.ts` → `createProjectsPage()`: New Notion property `Next Action` (rich_text).
- **Intent handler for updates**: When a project update comes in, next_action is also written.
- `summarizePage()`: Show next action in summary (`"Landing Page [active] → Hosting aussuchen"`).
- `prompt.ts`: Overview prompt: "Show next step for each project. If none defined, point it out."

### Nudge effect
Existing projects without Next Action → Overview highlights the gap ("Kein nächster Schritt definiert").

---

## Feature 5: Interactive Weekly Review

### Problem
Weekly digest reports but doesn't prompt action. Stale projects and old tasks accumulate silently.

### Changes
- `digest/weekly-review.ts` (new): `generateWeeklyReview()` function. Runs 30 minutes after weekly digest. Deterministic, no LLM call.

- **Review items** (max 5 per category):
  1. **Stale Projects**: Status = active, last_edited_time > 7 days ago.
     Message per project with buttons: `[Ja, noch relevant]` `[Archivieren]` `[Blockiert]`
  2. **Old Pending Admin**: Status = pending, created > 14 days ago.
     Message per task with buttons: `[Erledigt]` `[Behalten]` `[Abbrechen]`
  3. **Projects without Next Action**: Active projects where Next Action is empty.
     Message: "Was ist der nächste Schritt für X?" — no buttons, user replies as text (intent handler recognizes update).

- `bot/handlers/review.ts` (new): Callback query handler. Pattern: `review:<action>:<pageId>`:
  - `review:keep:<id>` → Edit message to "✓ Behalten"
  - `review:archive:<id>` → `updatePageStatus(id, 'archived')`, edit message
  - `review:done:<id>` → `updatePageStatus(id, 'done'/'completed')`, edit message
  - `review:blocked:<id>` → `updatePageStatus(id, 'blocked')`, edit message
  - `review:cancel:<id>` → `updatePageStatus(id, 'cancelled')`, edit message

- `scheduler.ts`: New cron job 30 min after weekly digest.
- `config.ts`: `WEEKLY_REVIEW_ENABLED` (default true).

### Design decision
No in-memory state needed — page ID encoded directly in callback data. No expiry logic.

---

## Feature 6: Idea Curation in Weekly Review

### Problem
Ideas with Potential = "unknown" accumulate without review. No mechanism to curate them.

### Changes
- Integrated into `weekly-review.ts` (Feature 5): After stale projects and old admin questions, a section "Ideen bewerten" with max 5 uncurated ideas.

- **Per idea**: Message with inline keyboard:
  ```
  💡 "Podcast über Produktivität starten"
  Kategorie: business | Erstellt: vor 12 Tagen
  → Buttons: [High] [Medium] [Low] [Archivieren]
  ```

- `bot/handlers/review.ts`: Extended with curation callbacks. Pattern: `curate:<potential>:<pageId>`:
  - `curate:high:<id>` → Update Potential property to "high"
  - `curate:medium:<id>` → Update to "medium"
  - `curate:low:<id>` → Update to "low"
  - `curate:archive:<id>` → Archive the page

- `databases.ts`: New function `updatePageProperty(pageId, propertyName, selectValue)` — generic enough for Potential updates without complicating `updatePageStatus()`.

- If no uncurated ideas exist → no message.
- `prompt.ts`: Remove hint about uncurated ideas from weekly digest prompt — the interactive review handles it now.

---

## Feature 7: Relations Between Categories (with Confirmation)

### Problem
People, Projects, Ideas, Admin are isolated silos. A person mentioned in a project context has no link.

### Changes
- `schemas.ts`: New optional field in ClassificationOutput:
  ```typescript
  related_entries: z.array(z.object({
    search_query: z.string(),       // 1-3 words to find related entry
    target_category: z.enum(['people', 'projects', 'ideas', 'admin']),
    relationship: z.string(),       // e.g. "works on this project"
  })).max(3).default([])
  ```

- `classifier/index.ts`: Prompt extension: "If the message references existing people, projects, ideas, or tasks, extract them as related_entries."

- **Notion setup**: Add `Related` relation property to each DB, linking to the other DBs. One-time manual setup or via setup.ts.

- `bot/handlers/message.ts`: After creating the page, if related_entries is not empty:
  1. For each entry: `searchByTitle(targetDb, query)`
  2. On single match: send suggestion message:
     ```
     🔗 Verknüpfung erkannt:
     "Meeting mit Lisa" → Lisa (Kontakte)
     → Buttons: [Verknüpfen] [Ignorieren]
     ```
  3. On 0 or multiple matches: silently skip (no spam on uncertain matches).

- `bot/handlers/relations.ts` (new): Callback handler. Pattern: `relate:<sourcePageId>:<targetPageId>`:
  - `relate:<src>:<tgt>` → Notion API call to set relation property
  - `skip-relate:<src>` → Edit message to "Übersprungen"

- `databases.ts`: New function `addRelation(pageId, relationPropertyName, targetPageId)`.

### Constraints
- Max 3 relations per message
- Only suggest on single match (1 search result)
- No retroactive linking of existing entries — only on new messages

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `src/classifier/schemas.ts` | Add priority to admin, next_action to projects, related_entries |
| `src/classifier/index.ts` | Prompt updates for priority, next_action, related_entries |
| `src/notion/databases.ts` | New: queryPendingAdminWithDueDates, queryDueAdmin, updatePageProperty, addRelation. Modified: createAdminPage (priority), createProjectsPage (next_action), summarizePage (due date, priority, next action) |
| `src/digest/daily.ts` | Use new due-date-aware query |
| `src/digest/overview.ts` | Use new due-date-aware query |
| `src/digest/prompt.ts` | Update daily/overview/weekly prompts for urgency, priority, next actions |
| `src/digest/reminder.ts` | **New** — afternoon reminder |
| `src/digest/weekly-review.ts` | **New** — interactive review + idea curation |
| `src/digest/scheduler.ts` | Add afternoon reminder + weekly review cron jobs |
| `src/bot/handlers/review.ts` | **New** — callback handlers for review + curation buttons |
| `src/bot/handlers/relations.ts` | **New** — callback handlers for relation buttons |
| `src/bot/handlers/message.ts` | Add relation suggestion logic after page creation |
| `src/bot/index.ts` | Register new callback query handlers |
| `src/config.ts` | Add AFTERNOON_REMINDER_HOUR, WEEKLY_REVIEW_ENABLED |
