import { describe, expect, it } from 'vitest';
import { findRenderedHeading, getMilkdownHeadingId } from './headingNavigation';

describe('heading navigation', () => {
  it('matches Milkdown heading IDs without stripping punctuation or Unicode', () => {
    expect(getMilkdownHeadingId('  Résumé: Q&A  ')).toBe('résumé:-q&a');
    expect(getMilkdownHeadingId('Release   Milestones')).toBe('release-milestones');
  });

  it('prefers an actual rendered ID', () => {
    const editor = document.createElement('div');
    editor.innerHTML = '<h2 id="custom-id">Different text</h2>';

    expect(findRenderedHeading(editor, 'custom-id')?.textContent).toBe('Different text');
  });

  it('finds an explicitly identified heading by its Milkdown-generated text ID', () => {
    const editor = document.createElement('div');
    editor.innerHTML = '<h2 id="explicit-id">Résumé: Q&amp;A</h2>';

    expect(findRenderedHeading(editor, 'résumé:-q&a')?.id).toBe('explicit-id');
  });
});
