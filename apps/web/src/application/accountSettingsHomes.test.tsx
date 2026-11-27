// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/test/harness';
import { ThemeProvider, useTheme } from '@/app/theme';
import { LangProvider, useLang } from '@/i18n';
import { useHideSensitive } from '@/features/privacy/sensitive';
import { setReceiptAiChoice, setReceiptAutoCategorise, setReceiptAutoRead, setReceiptPhotoCleanup } from '@/features/shopping/receiptAi';
import { onSettingChanged, settingsArrived } from '@/lib/settingsBus';
import { setGlobalWeekStart } from '@/lib/weekStart';

let theme: ReturnType<typeof useTheme>;
let lang: ReturnType<typeof useLang>;

function Probe() {
  theme = useTheme();
  lang = useLang();
  const hidden = useHideSensitive((s) => s.on);
  return (
    <span data-testid="probe">
      {theme.mode}/{lang.lang}/{hidden ? 'hidden' : 'shown'}
    </span>
  );
}

const mount = () =>
  render(
    <LangProvider>
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    </LangProvider>,
  );

describe('#700: each setting says when it changed here and reads its home again when one arrives', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => useHideSensitive.setState({ on: false }));
  });

  it('every setter of a setting the account carries reports the change', () => {
    mount();
    const heard = vi.fn();
    const off = onSettingChanged(heard);
    const changes: (() => void)[] = [
      () => theme.setMode('dark'),
      () => theme.toggle(),
      () => lang.setLang('nl'),
      () => lang.followDeviceLang(),
      () => useHideSensitive.getState().set(true),
      () => setGlobalWeekStart('sunday'),
      () => setReceiptAiChoice('yes'),
      () => setReceiptAutoRead(true),
      () => setReceiptAutoCategorise(true, '2026-11-27'),
      () => setReceiptPhotoCleanup('certain'),
    ];
    for (const [i, change] of changes.entries()) {
      act(change);
      expect(heard).toHaveBeenCalledTimes(i + 1);
    }
    off();
  });

  it('a choice written by another device shows without a reload', () => {
    mount();
    expect(screen.getByTestId('probe').textContent).toBe('system/en/shown');
    localStorage.setItem('munni_theme', 'dark');
    localStorage.setItem('munni_lang', 'tr');
    localStorage.setItem('munni_hide_sensitive', '1');
    act(() => settingsArrived());
    expect(screen.getByTestId('probe').textContent).toBe('dark/tr/hidden');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(lang.langOverridden).toBe(true);

    // back to the defaults on the other device
    localStorage.clear();
    act(() => settingsArrived());
    expect(screen.getByTestId('probe').textContent).toBe('system/en/shown');
    expect(lang.langOverridden).toBe(false);
  });
});
