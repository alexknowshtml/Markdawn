import { screen } from '@testing-library/react';
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
});
