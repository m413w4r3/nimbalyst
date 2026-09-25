// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

import { EffortLevelSelector } from '../EffortLevelSelector';
import { ThinkingModeSelector } from '../ThinkingModeSelector';
import { collectModelEffortLevels, modelEffortLevelsAtom } from '../../../store/atoms/modelEffortLevels';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));

afterEach(() => cleanup());

describe('reasoning selector menu positioning', () => {
  it.each([
    {
      name: 'effort',
      triggerLabel: 'Effort level: High',
      optionLabel: 'xHigh',
      optionRole: 'menuitemradio',
      renderSelector: () => <EffortLevelSelector level="high" modelId="openai-codex/gpt-6-astra" onLevelChange={vi.fn()} />,
    },
    {
      name: 'thinking',
      triggerLabel: 'Extended thinking: Extended: On',
      optionLabel: 'Extended: Off',
      optionRole: 'button',
      renderSelector: () => <ThinkingModeSelector mode="enabled" onModeChange={vi.fn()} />,
    },
  ])('portals the $name menu outside an overflow boundary', ({ triggerLabel, optionLabel, optionRole, renderSelector }) => {
    const { container } = render(
      <div data-testid="overflow-boundary" style={{ overflow: 'hidden' }}>
        {renderSelector()}
      </div>
    );

    fireEvent.click(screen.getByRole('button', { name: triggerLabel }));

    const option = screen.getByRole(optionRole, { name: optionLabel });
    const menu = option.closest('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
  });
});

describe('effort selector with catalog-declared levels', () => {
  it('offers exactly the levels the model listing declares and picks max unchanged', () => {
    const store = createStore();
    store.set(modelEffortLevelsAtom, collectModelEffortLevels({
      'openai-codex': [
        { id: 'openai-codex:deepseek-flash', supportedEffortLevels: ['low', 'high', 'max'] },
        { id: 'openai-codex:gpt-6-sol' },
      ],
    }));
    const onLevelChange = vi.fn();
    render(
      <Provider store={store}>
        <EffortLevelSelector level="high" modelId="openai-codex:deepseek-flash" onLevelChange={onLevelChange} />
      </Provider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Effort level: High' }));
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual(['Low', 'High', 'Max']);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Max' }));
    expect(onLevelChange).toHaveBeenCalledWith('max');
  });
});
