import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '../../test-utils/render';
import { ChoiceGroup, Dropdown, TextBox } from './FormControls';

describe('Dropdown keyboard controls', () => {
  it('opens, moves, and selects without a pointer', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState<'view' | 'edit'>('view');
      return (
        <Dropdown
          value={value}
          onChange={setValue}
          options={[
            { value: 'view', label: 'View' },
            { value: 'edit', label: 'Edit' },
          ]}
          ariaLabel="Permission"
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: 'Permission' });
    trigger.focus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{ArrowDown}{Enter}');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent('Edit');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the selected option highlighted when opened with a pointer', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState<'view' | 'edit'>('edit');
      return (
        <Dropdown
          value={value}
          onChange={setValue}
          options={[
            { value: 'view', label: 'View' },
            { value: 'edit', label: 'Edit' },
          ]}
          ariaLabel="Permission"
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: 'Permission' });
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Edit' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(trigger).toHaveTextContent('Edit');
  });
});

describe('form control semantics', () => {
  it('forwards native input attributes to TextBox', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('');
      return (
        <TextBox
          value={value}
          onChange={setValue}
          name="invitee"
          autoComplete="email"
          required
          data-testid="invitee-input"
          aria-label="Invitee email"
        />
      );
    }

    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Invitee email' });
    expect(input).toHaveAttribute('data-testid', 'invitee-input');
    expect(input).toHaveAttribute('name', 'invitee');
    expect(input).toHaveAttribute('autocomplete', 'email');
    expect(input).toBeRequired();
    await user.type(input, 'person@example.com');
    expect(input).toHaveValue('person@example.com');
  });

  it('exposes and keyboard-updates the selected link choice', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState<'private' | 'view'>('private');
      return (
        <ChoiceGroup
          value={value}
          onChange={setValue}
          ariaLabel="Public access"
          options={[
            { value: 'private', label: 'Restricted' },
            { value: 'view', label: 'Anyone Can View' },
          ]}
        />
      );
    }

    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Public access' });
    const restricted = screen.getByRole('button', { name: 'Restricted', pressed: true });
    expect(group).toContainElement(restricted);
    restricted.focus();
    await user.keyboard('{Tab}{Enter}');
    expect(screen.getByRole('button', { name: 'Anyone Can View', pressed: true })).toBeVisible();
  });
});
