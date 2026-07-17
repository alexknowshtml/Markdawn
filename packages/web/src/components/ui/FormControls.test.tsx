import { describe, expect, it } from 'vitest';
import { calculateDropdownMenuPosition } from './FormControls';

describe('calculateDropdownMenuPosition', () => {
  it('opens above a trigger when the menu would fall below the viewport', () => {
    const position = calculateDropdownMenuPosition(
      { bottom: 504, left: 760, top: 480, width: 72 },
      { height: 122, width: 96 },
      { height: 577, width: 1280 },
    );

    expect(position.top).toBe(354);
    expect(position.top + 122).toBeLessThanOrEqual(480);
    expect(position.maxHeight).toBe(468);
  });

  it('keeps a menu below the trigger when there is enough room', () => {
    const position = calculateDropdownMenuPosition(
      { bottom: 104, left: 20, top: 80, width: 72 },
      { height: 122, width: 96 },
      { height: 577, width: 1280 },
    );

    expect(position.top).toBe(108);
    expect(position.left).toBe(20);
  });
});
