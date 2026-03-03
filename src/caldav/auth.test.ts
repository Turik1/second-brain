import { describe, it, expect } from 'vitest';
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
