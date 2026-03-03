import { describe, it, expect } from 'vitest';
import { pageToVEvent, wrapCalendar, parseVEvent } from './ical.js';
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
      'SUMMARY:A very long task name that was ',
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
