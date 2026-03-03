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
