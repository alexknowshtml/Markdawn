import { describe, expect, it } from 'vitest';
import { aggregateIndexedPageConnections } from './pageConnections';

describe('aggregateIndexedPageConnections', () => {
  it('retains every occurrence while aggregating the connection row', () => {
    const connections = aggregateIndexedPageConnections([
      {
        targetType: 'page',
        targetSlug: 'roadmap',
        targetLabel: 'Roadmap',
        connectionType: 'wikilink',
        linkContext: 'First context',
      },
      {
        targetType: 'page',
        targetSlug: 'roadmap',
        targetLabel: 'Roadmap',
        connectionType: 'wikilink',
        linkContext: 'Second context',
      },
    ]);

    expect(connections).toEqual([
      expect.objectContaining({
        occurrenceCount: 2,
        occurrences: [{ context: 'First context' }, { context: 'Second context' }],
      }),
    ]);
  });
});
