// @vitest-environment happy-dom
import { useEffect, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { MDI_NAMES } from '@/generated/mdiNames';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { IconPicker, iconNeedle, searchIcons } from './IconPicker';

function Host({
  onChange = () => undefined,
  taken,
  disabled,
  saved,
}: Readonly<{ onChange?: (name: string) => void; taken?: ReadonlySet<string>; disabled?: boolean; saved?: string }>) {
  const [value, setValue] = useState('cart-outline');
  const [query, setQuery] = useState('');
  // an edit form mounts on its default and sets the row's icon once the row has loaded
  useEffect(() => {
    if (saved) setValue(saved);
  }, [saved]);
  return (
    <IconPicker
      value={value}
      onChange={(name) => {
        setValue(name);
        onChange(name);
      }}
      featured={['cart-outline', 'bike', 'tent']}
      query={query}
      onQuery={setQuery}
      testIdPrefix="pick"
      taken={taken}
      disabled={disabled}
    />
  );
}

const renderHost = (props: Parameters<typeof Host>[0] = {}) => {
  localStorage.setItem('munni_lang', 'en');
  return render(
    <LangProvider>
      <Host {...props} />
    </LangProvider>,
  );
};

describe('#563: searching the whole icon font', () => {
  it('lists every match — the exact name first, then names and words that start with it', () => {
    const hits = searchIcons('cart');
    expect(hits[0]).toBe('cart');
    expect(hits).toHaveLength(MDI_NAMES.filter((name) => name.includes('cart')).length);
    const firstWordMatch = hits.findIndex((name) => !name.startsWith('cart'));
    expect(hits.slice(0, firstWordMatch).every((name) => name.startsWith('cart'))).toBe(true);
    expect(hits[firstWordMatch]).toMatch(/-cart/);
  });

  it('reads spaces as the hyphens the font names its glyphs with', () => {
    expect(iconNeedle('  Credit Card ')).toBe('credit-card');
    expect(searchIcons(iconNeedle('credit card'))[0]).toBe('credit-card');
  });
});

describe('#563 / #389: the icon picker', () => {
  it('leads with the suggestions, follows with the whole font, and a search narrows to its matches', () => {
    renderHost();
    expect(screen.getByTestId('pick-bike')).toBeTruthy();
    expect(screen.getByTestId('pick-all')).toBeTruthy();
    expect(screen.getByTestId(`pick-${MDI_NAMES[0]}`)).toBeTruthy();
    fireEvent.change(screen.getByTestId('pick-search'), { target: { value: 'campfire' } });
    expect(screen.getByTestId('pick-campfire')).toBeTruthy();
    expect(screen.queryByTestId('pick-bike')).toBeNull();
    expect(screen.queryByTestId('pick-all')).toBeNull();
    fireEvent.change(screen.getByTestId('pick-search'), { target: { value: 'zzqx' } });
    expect(screen.getByTestId('pick-none')).toBeTruthy();
  });

  it('a pick from deep in the font leads the list once the search is cleared', () => {
    renderHost();
    fireEvent.change(screen.getByTestId('pick-search'), { target: { value: 'campfire' } });
    fireEvent.click(screen.getByTestId('pick-campfire'));
    fireEvent.change(screen.getByTestId('pick-search'), { target: { value: '' } });
    const firstTile = screen.getByTestId('picks').querySelector('button');
    expect(firstTile?.dataset.testid).toBe('pick-campfire');
    expect(firstTile?.getAttribute('aria-pressed')).toBe('true');
  });

  it('an icon the form sets after it opened — the saved one of the row being edited — leads the list as the pick', () => {
    renderHost({ saved: 'campfire' });
    const firstTile = screen.getByTestId('picks').querySelector('button');
    expect(firstTile?.dataset.testid).toBe('pick-campfire');
    expect(firstTile?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a tap while browsing selects the tile where it stands — the grid does not reshuffle under the finger', () => {
    renderHost();
    fireEvent.click(screen.getByTestId(`pick-${MDI_NAMES[0]}`));
    expect(screen.getByTestId(`pick-${MDI_NAMES[0]}`).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('picks').querySelector('button')?.dataset.testid).toBe('pick-cart-outline');
  });

  it('refuses the icons a sibling wears: shown, asleep, untappable', () => {
    const onChange = vi.fn();
    renderHost({ onChange, taken: new Set(['bike']) });
    const bike = screen.getByTestId('pick-bike') as HTMLButtonElement;
    expect(bike.disabled).toBe(true);
    expect(bike.dataset.taken).toBe('1');
    fireEvent.click(bike);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('pick-tent'));
    expect(onChange).toHaveBeenCalledWith('tent');
  });

  it('a disabled picker takes no tap and greys every glyph', () => {
    renderHost({ disabled: true });
    const tent = screen.getByTestId('pick-tent') as HTMLButtonElement;
    expect(tent.disabled).toBe(true);
    expect((tent.querySelector('i') as HTMLElement).style.color).toBe('var(--m-ink-4)');
  });
});
