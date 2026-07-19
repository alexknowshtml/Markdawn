import { MAX_FOLDER_NAME_LENGTH, MAX_PAGE_TITLE_LENGTH } from '@markdawn/shared';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { render } from '../../test-utils/render';

vi.mock('../ui/PageContextMenu', () => ({
  PageContextMenu: ({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) => (
    <button
      type="button"
      aria-label="Open menu"
      onClick={(event) => {
        event.stopPropagation();
        onOpenChange?.(true);
      }}
    >
      Menu
    </button>
  ),
}));

import { PageTreeRow } from './PageTreeRow';

describe('PageTreeRow keyboard actions', () => {
  it('opens the action menu without activating row navigation', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<PageTreeRow id="page-1" title="Page" onNavigate={onNavigate} />);

    const menuButton = screen.getByRole('button', { name: 'Open menu' });
    menuButton.focus();
    await user.keyboard('{Enter}');

    expect(onNavigate).not.toHaveBeenCalled();
    expect(menuButton.parentElement).toHaveClass('opacity-100');
  });

  it('limits inline names by Unicode code point without splitting emoji', () => {
    const onEditChange = vi.fn();
    const { rerender } = render(
      <PageTreeRow id="folder-1" title="Folder" isFolder isEditing onEditChange={onEditChange} />,
    );
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'maxlength',
      String(MAX_FOLDER_NAME_LENGTH * 2),
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '📁'.repeat(MAX_FOLDER_NAME_LENGTH + 1) },
    });
    expect(onEditChange).toHaveBeenLastCalledWith('📁'.repeat(MAX_FOLDER_NAME_LENGTH));

    rerender(<PageTreeRow id="page-1" title="Page" isEditing />);
    expect(screen.getByRole('textbox')).toHaveAttribute(
      'maxlength',
      String(MAX_PAGE_TITLE_LENGTH * 2),
    );
  });
});
