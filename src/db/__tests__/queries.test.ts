import { describe, it, expect } from 'vitest';
import type { ThoughtInsert } from '../queries.js';

describe('ThoughtInsert validation', () => {
  it('should have required content field', () => {
    const thought: ThoughtInsert = {
      content: 'Test thought',
      embedding: new Array(1024).fill(0),
    };
    expect(thought.content).toBe('Test thought');
    expect(thought.embedding).toHaveLength(1024);
  });

  it('should allow optional metadata fields', () => {
    const thought: ThoughtInsert = {
      content: 'Meeting with Sarah about the project',
      embedding: new Array(1024).fill(0),
      title: 'Sarah meeting',
      thought_type: 'meeting',
      topics: ['project', 'design'],
      people: ['Sarah'],
      action_items: ['Send spec by Friday'],
      source: 'telegram',
      source_id: '12345',
      chat_id: 67890,
    };
    expect(thought.thought_type).toBe('meeting');
    expect(thought.people).toContain('Sarah');
  });
});
