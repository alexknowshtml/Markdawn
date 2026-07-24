import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorReadOnlyProvider } from '../../contexts/EditorReadOnlyContext';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
}));

vi.mock('../../hooks/use-pages', () => ({
  useUpdatePage: () => ({ mutate: mocks.mutate }),
}));

vi.mock('../../hooks/usePropertyMetadata', () => ({
  usePropertyMetadata: () => ({
    allKeys: ['status', 'owner'],
    allTags: [],
    refreshTags: vi.fn(),
  }),
}));

import { PropertiesPanel } from './PropertiesPanel';

function panel(readOnly: boolean) {
  return (
    <EditorReadOnlyProvider readOnly={readOnly}>
      <PropertiesPanel pageId="page-1" properties={{ status: 'Draft' }} />
    </EditorReadOnlyProvider>
  );
}

describe('PropertiesPanel permission changes', () => {
  beforeEach(() => mocks.mutate.mockReset());

  afterEach(() => vi.useRealTimers());

  it('cancels a value edit when the page becomes read-only without persisting', async () => {
    const rendered = render(panel(false));
    fireEvent.click(await screen.findByRole('button', { name: 'Draft' }));
    const valueInput = screen.getByTestId('value-input');
    fireEvent.change(valueInput, { target: { value: 'Private draft' } });

    rendered.rerender(panel(true));

    expect(screen.queryByTestId('value-input')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Draft' })).toBeInTheDocument();
    expect(screen.queryByTestId('delete-property')).not.toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('cancels a pending key blur save when the page becomes read-only', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const rendered = render(panel(false));
    fireEvent.click(await screen.findByRole('button', { name: 'status' }));
    const keyInput = screen.getByTestId('key-input');
    fireEvent.change(keyInput, { target: { value: 'owner' } });
    fireEvent.blur(keyInput);

    rendered.rerender(panel(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(screen.queryByTestId('key-input')).not.toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
