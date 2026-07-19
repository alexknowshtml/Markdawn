import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders nothing when isOpen is false', () => {
    render(
      <ConfirmDialog
        isOpen={false}
        title="Delete?"
        message="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.queryByText('Delete?')).not.toBeInTheDocument();
  });

  it('renders dialog when isOpen is true', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Delete?"
        message="Are you sure you want to delete this?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Delete?')).toBeInTheDocument();
    expect(screen.getByText('Are you sure you want to delete this?')).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Delete?"
        message="Sure?"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Delete?"
        message="Sure?"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not bubble confirm or cancel clicks to the clickable item beneath it', async () => {
    const onItemClick = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <button type="button" onClick={onItemClick}>
        Underlying item
        <ConfirmDialog
          isOpen={true}
          title="Remove item?"
          message="Choose an action"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </button>,
    );

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onItemClick).not.toHaveBeenCalled();
  });

  it('disables buttons and shows loading text when loading', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Delete?"
        message="Sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loading={true}
      />,
    );

    expect(screen.getByRole('button', { name: 'Deleting...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('uses custom button text', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Remove item"
        message="This cannot be undone"
        confirmText="Remove"
        cancelText="Keep"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });
});
