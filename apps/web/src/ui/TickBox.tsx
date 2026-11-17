import type { KeyboardEvent } from 'react';
import { Icon } from './Icon';

export type TickState = 'checked' | 'half' | 'off';

/** a pick row's native checkbox takes its dash only as a property — the ref sets it on every render */
export const halfRef = (half: boolean) => (box: HTMLInputElement | null) => {
  if (box) box.indeterminate = half;
};

/** Enter ticks a pick row too, as it did while the rows were buttons */
export const enterToggles = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.currentTarget.click();
};

/** #374: a parent only partly picked wears a dash, never a full check */
export function TickBox({ state }: Readonly<{ state: TickState }>) {
  return (
    <span
      aria-hidden
      data-tick={state}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
        state === 'off' ? 'border-line bg-surface' : 'border-accent bg-accent text-white'
      }`}
    >
      {state === 'checked' && <Icon name="check" size={12} />}
      {state === 'half' && <Icon name="minus" size={12} />}
    </span>
  );
}
