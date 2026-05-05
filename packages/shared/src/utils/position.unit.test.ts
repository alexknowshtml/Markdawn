import { describe, expect, it } from 'vitest';
import { generatePosition } from './position';

describe('generatePosition', () => {
  it('generates midpoint for empty bounds', () => {
    expect(generatePosition(null, null)).toBe('V');
  });

  it('generates position after a single char', () => {
    expect(generatePosition('V', null)).toBe('VV');
  });

  it('generates position before a single char', () => {
    expect(generatePosition(null, 'V')).toBe('F');
  });

  it('generates position between two chars', () => {
    const result = generatePosition('a', 'b');
    expect(result > 'a').toBe(true);
    expect(result < 'b').toBe(true);
  });

  it('handles deep nesting when previous >= next', () => {
    expect(generatePosition('zzz', null)).toBe('zzzV');
  });

  it('handles inserting at the very beginning', () => {
    const result = generatePosition(null, 'a');
    expect(result < 'a').toBe(true);
  });

  it('produces sortable results', () => {
    const p1 = generatePosition(null, null);
    const p2 = generatePosition(p1, null);
    const p3 = generatePosition(p1, p2);
    expect(p1 < p2).toBe(true);
    expect(p1 < p3).toBe(true);
    expect(p3 < p2).toBe(true);
  });

  it('handles many sequential insertions', () => {
    let prev: string | null = null;
    const positions: string[] = [];
    for (let i = 0; i < 100; i++) {
      const pos = generatePosition(prev, null);
      positions.push(pos);
      prev = pos;
    }
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      expect(prev !== undefined && curr !== undefined && prev < curr).toBe(true);
    }
  });

  it('handles inserting between existing positions', () => {
    const p1 = generatePosition(null, null);
    const p3 = generatePosition(p1, null);
    const p2 = generatePosition(p1, p3);
    expect(p1 < p2).toBe(true);
    expect(p2 < p3).toBe(true);
  });

  it('throws on invalid character in previous', () => {
    expect(() => generatePosition('!', '0')).toThrow('Invalid position character');
  });

  it('throws on invalid character in next', () => {
    expect(() => generatePosition('0', '0!')).toThrow('Invalid position character');
  });

  it('handles empty string same as null', () => {
    expect(generatePosition('', '')).toBe('V');
    expect(generatePosition('', null)).toBe('V');
    expect(generatePosition(null, '')).toBe('V');
  });

  it('handles inserting before a multi-char position', () => {
    const result = generatePosition(null, 'zzz');
    expect(result < 'zzz').toBe(true);
  });

  it('handles inserting after a multi-char position', () => {
    const result = generatePosition('zzz', null);
    expect(result > 'zzz').toBe(true);
  });

  it('maintains sort order with random interleaved insertions', () => {
    const positions: string[] = [generatePosition(null, null)];

    for (let i = 0; i < 50; i++) {
      const idx = Math.floor(Math.random() * (positions.length + 1));
      const prev = positions[idx - 1] ?? null;
      const next = positions[idx] ?? null;
      const pos = generatePosition(prev, next);
      positions.splice(idx, 0, pos);
    }

    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1];
      const curr = positions[i];
      expect(prev !== undefined && curr !== undefined && prev < curr).toBe(true);
    }
  });
});
