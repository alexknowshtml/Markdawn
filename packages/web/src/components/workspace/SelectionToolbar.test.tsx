import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SelectionToolbar } from './SelectionToolbar';

const handlers = {
  onDelete: vi.fn(),
  onCopy: vi.fn(),
  onCut: vi.fn(),
  onMove: vi.fn(),
  onPaste: vi.fn(),
  onSelectAll: vi.fn(),
  onClear: vi.fn(),
};

describe('SelectionToolbar', () => {
  it('shows removal progress and disables actions', () => {
    render(
      <SelectionToolbar
        selectedCount={14}
        totalCount={14}
        clipboardCount={2}
        isRemoving
        {...handlers}
      />,
    );

    expect(screen.getByText('Removing 14 items…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'Deselect all' })) {
      expect(button).toBeDisabled();
    }
  });
});
