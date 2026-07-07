// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/harness';
import { LockScreen } from './LockScreen';
import { hashPin, useLock, writeLockConfig } from './lock';

describe('LockScreen (PIN path — no platform authenticator in tests)', () => {
  beforeEach(async () => {
    localStorage.clear();
    writeLockConfig({ enabled: true, pinSalt: 's', pinHash: await hashPin('1234', 's'), timeoutSec: 60 });
    useLock.setState({ locked: true });
  });

  it('without a credential it goes straight to PIN mode and unlocks on the right PIN', async () => {
    renderWithProviders(<LockScreen />);
    const pin = await screen.findByTestId('lock-pin');
    fireEvent.change(pin, { target: { value: '1234' } });
    fireEvent.click(screen.getByTestId('lock-pin-submit'));
    await waitFor(() => expect(useLock.getState().locked).toBe(false));
  });

  it('a wrong PIN shows the error and stays locked', async () => {
    renderWithProviders(<LockScreen />);
    const pin = await screen.findByTestId('lock-pin');
    fireEvent.change(pin, { target: { value: '9999' } });
    fireEvent.click(screen.getByTestId('lock-pin-submit'));
    expect(await screen.findByTestId('lock-pin-error')).toBeTruthy();
    expect(useLock.getState().locked).toBe(true);
  });

  it('non-digits are stripped and short PINs cannot submit', async () => {
    renderWithProviders(<LockScreen />);
    const pin = (await screen.findByTestId('lock-pin')) as HTMLInputElement;
    fireEvent.change(pin, { target: { value: '12ab' } });
    expect(pin.value).toBe('12');
    expect((screen.getByTestId('lock-pin-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});
