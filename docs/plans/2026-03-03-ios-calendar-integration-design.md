# iOS Calendar Integration — CalDAV Server

## Summary

Add a CalDAV server to the existing Express app so Apple Calendar can natively two-way sync with dated admin tasks in Notion.

## Requirements

- **Scope:** Only admin tasks with a Due Date
- **Direction:** Two-way — read tasks in Calendar, sync date changes + completion back to Notion
- **Latency:** Near real-time (~60s for Notion→Calendar, immediate for Calendar→Notion)
- **Delete semantics:** Deleting an event in Calendar marks the task as "done" in Notion

## Architecture

CalDAV endpoints mount at `/caldav/` on the existing Express server. Caddy proxies CalDAV traffic alongside existing webhook/bot traffic. No new database or external service — Notion remains the single source of truth.

```
Apple Calendar ──CalDAV──▶ Caddy ──▶ Express ──▶ src/caldav/ ──▶ Notion API
                                         │
                                     src/bot/  (existing)
                                     src/digest/ (existing)
```

### New Env Vars

| Variable | Purpose | Default |
|----------|---------|---------|
| `CALDAV_ENABLED` | Toggle CalDAV on/off | `false` |
| `CALDAV_USERNAME` | Basic Auth username | (required if enabled) |
| `CALDAV_PASSWORD` | Basic Auth password | (required if enabled) |

## CalDAV Protocol — Minimal Subset

Only the endpoints Apple Calendar needs:

| Method | Path | Purpose |
|--------|------|---------|
| `PROPFIND` | `/.well-known/caldav` | Service discovery → redirect to principal |
| `PROPFIND` | `/caldav/principal/` | Returns calendar-home-set URL |
| `PROPFIND` | `/caldav/calendars/` | Lists available calendars |
| `PROPFIND` | `/caldav/calendars/admin/` | Calendar properties (ctag, display-name) |
| `REPORT` | `/caldav/calendars/admin/` | Fetch events (calendar-query / calendar-multiget) |
| `GET` | `/caldav/calendars/admin/{uid}.ics` | Single event |
| `PUT` | `/caldav/calendars/admin/{uid}.ics` | Create/update event → writes to Notion |
| `DELETE` | `/caldav/calendars/admin/{uid}.ics` | Delete event → marks done in Notion |
| `OPTIONS` | `/caldav/*` | Advertise DAV capabilities |

Skipped: MKCALENDAR, ACL, free-busy, scheduling, MOVE.

### Change Detection

- **ctag:** Derived from `max(last_edited_time)` of all cached admin pages. Apple Calendar re-fetches events when ctag changes.
- **ETags:** Per-event, derived from Notion `last_edited_time`. Used for conflict detection on PUT.

## Data Model — Notion ↔ iCalendar Mapping

### Read Direction (Notion → VEVENT)

| Notion Property | iCalendar Field | Notes |
|----------------|-----------------|-------|
| Page ID | UID | Stable unique identifier |
| Name | SUMMARY | Task title |
| Due Date | DTSTART / DTEND | All-day event (DATE format), DTEND = DTSTART + 1 day |
| Type | CATEGORIES | task, appointment, reminder, errand, note |
| Priority (high/medium/low) | PRIORITY | 1 / 5 / 9 |
| Status pending | STATUS:NEEDS-ACTION | |
| Status done | STATUS:COMPLETED | |
| Status cancelled | STATUS:CANCELLED | |
| Tags | CATEGORIES (appended) | |
| last_edited_time | LAST-MODIFIED + ETag | |

All events are all-day since admin tasks only have dates, not times.

### Write Direction (VEVENT → Notion)

| Calendar Action | Notion Update |
|----------------|---------------|
| Move event (DTSTART changed) | Update Due Date |
| Rename event (SUMMARY changed) | Update Name |
| Delete event | Set status to "done" |
| Create new event | Create admin task (type: "task", status: "pending") |

Priority and tag changes from Calendar are NOT synced back (too error-prone with freeform iCal fields).

## Caching

In-memory cache of all dated admin tasks, keyed by Notion page ID.

- **TTL:** 60 seconds — background refresh from Notion API
- **Write-through:** PUT/DELETE from Calendar updates cache immediately + writes to Notion
- **Bot invalidation:** When Telegram bot creates/updates an admin task, cache is invalidated
- **Scope:** Pending tasks + done/cancelled from last 30 days
- **Steady-state API cost:** ~1 Notion query per 60 seconds

CalDAV reads are served entirely from the in-memory cache. No Notion API calls on the read path.

## Authentication

HTTP Basic Auth over HTTPS (Caddy terminates TLS).

- Credentials from `CALDAV_USERNAME` / `CALDAV_PASSWORD` env vars
- All `/caldav/*` routes require valid credentials
- Standard for personal CalDAV servers; Apple Calendar handles it natively

### iPhone Setup

Settings → Calendar → Accounts → Add Account → Other → Add CalDAV Account:
- Server: `yourdomain.com`
- Username / Password: CalDAV credentials
- Path: `/caldav/principal/`

## Error Handling

- **Stale ETag on PUT:** Return `412 Precondition Failed`. Apple Calendar re-fetches and prompts user.
- **Notion API down:** Reads serve from cache (stale but available). Writes return `503 Service Unavailable`.
- **Task loses due date in Notion:** Disappears from calendar on next cache refresh.
- **Task marked done in Telegram:** Cache refreshes → ctag changes → Calendar removes/updates event.

## Module Structure

```
src/caldav/
├── index.ts          — barrel export, Express router setup
├── router.ts         — CalDAV route handlers (PROPFIND, REPORT, PUT, DELETE, etc.)
├── auth.ts           — Basic Auth middleware
├── ical.ts           — Notion page ↔ VEVENT conversion (generate/parse iCalendar)
├── cache.ts          — In-memory cache with TTL refresh from Notion
├── xml.ts            — WebDAV XML request parsing & response building
└── constants.ts      — CalDAV/WebDAV property names, namespaces
```

### New Dependencies

- `ical-generator` — build .ics output
- `ical.js` — parse incoming .ics from PUT requests
- `fast-xml-parser` — WebDAV XML parsing & building

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Integration approach | CalDAV server | Native Apple Calendar support, no intermediary |
| Scope | Dated admin items only | Clean mapping, other DBs lack dates |
| Delete semantics | Mark as "done" | Deleting = completing the task |
| Cache TTL | 60 seconds | Near real-time without excessive API calls |
| Auth | Basic Auth over HTTPS | Simple, Apple Calendar native support |
| Write-back scope | Date + name + completion | Priority/tags too error-prone from Calendar |
