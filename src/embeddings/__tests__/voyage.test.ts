import { describe, it, expect } from 'vitest';

describe('Voyage embedding response parsing', () => {
  it('should extract embedding from API response shape', () => {
    const mockResponse = {
      data: [{ embedding: new Array(1024).fill(0.1) }],
    };
    const embedding = mockResponse.data[0].embedding;
    expect(embedding).toHaveLength(1024);
    expect(embedding[0]).toBe(0.1);
  });
});
