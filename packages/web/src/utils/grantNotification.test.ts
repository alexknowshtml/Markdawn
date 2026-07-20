import { describe, expect, it } from 'vitest';
import { formatGrantNotification } from './grantNotification';

describe('formatGrantNotification', () => {
  it('uses the verified sharer and entity title, not actor-provided message text', () => {
    expect(formatGrantNotification('Owner', 'Shared page')).toBe(
      'Owner shared Shared page with you',
    );
  });
});
