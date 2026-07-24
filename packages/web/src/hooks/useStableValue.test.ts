import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useStableValueWhile } from './useStableValue';

describe('useStableValueWhile', () => {
  it('keeps the displayed value stable until the pending work finishes', () => {
    const { result, rerender } = renderHook(
      ({ items, frozen }: { items: string[]; frozen: boolean }) =>
        useStableValueWhile(items, frozen),
      { initialProps: { items: ['owned', 'shared'], frozen: false } },
    );

    rerender({ items: ['shared'], frozen: true });
    expect(result.current).toEqual(['owned', 'shared']);

    rerender({ items: [], frozen: true });
    expect(result.current).toEqual(['owned', 'shared']);

    rerender({ items: [], frozen: false });
    expect(result.current).toEqual([]);
  });
});
