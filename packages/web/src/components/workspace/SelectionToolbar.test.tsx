import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
        trashCount={8}
        removeFromViewCount={6}
        isRemoving
        {...handlers}
      />,
    );

    expect(screen.getByText('Removing 14 items…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'Deselect all' })) {
      expect(button).toBeDisabled();
    }
  });

  it('confirms the exact Trash and personal-removal outcomes', async () => {
    const user = userEvent.setup();
    render(
      <SelectionToolbar
        selectedCount={3}
        totalCount={5}
        clipboardCount={0}
        trashCount={1}
        removeFromViewCount={2}
        {...handlers}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.getByText(/1 item will be moved to Trash/)).toBeInTheDocument();
    expect(screen.getByText(/2 items will be removed from your view/)).toBeInTheDocument();
    expect(handlers.onDelete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove items' }));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
  });
});
