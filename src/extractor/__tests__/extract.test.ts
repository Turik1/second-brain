import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Mirror the schema here for testing (avoids importing module that needs config)
const ThoughtMetadataSchema = z.object({
  title: z.string().max(80),
  thought_type: z.enum([
    'task', 'person_note', 'idea', 'project', 'insight', 'decision', 'meeting',
  ]),
  topics: z.array(z.string()).max(5),
  people: z.array(z.string()),
  action_items: z.array(z.string()),
});

describe('ThoughtMetadata schema', () => {
  it('should validate a complete metadata object', () => {
    const result = ThoughtMetadataSchema.parse({
      title: 'Meeting mit Sarah über Redesign',
      thought_type: 'meeting',
      topics: ['design', 'redesign', 'frontend'],
      people: ['Sarah'],
      action_items: ['API-Spec bis Freitag schicken'],
    });
    expect(result.thought_type).toBe('meeting');
    expect(result.people).toContain('Sarah');
  });

  it('should reject invalid thought_type', () => {
    expect(() =>
      ThoughtMetadataSchema.parse({
        title: 'Test',
        thought_type: 'invalid',
        topics: [],
        people: [],
        action_items: [],
      })
    ).toThrow();
  });

  it('should reject title over 80 chars', () => {
    expect(() =>
      ThoughtMetadataSchema.parse({
        title: 'a'.repeat(81),
        thought_type: 'task',
        topics: [],
        people: [],
        action_items: [],
      })
    ).toThrow();
  });
});
