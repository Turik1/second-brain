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
