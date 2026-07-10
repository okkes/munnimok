// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

const DEGIRO_TX = [
  'Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Lokale waarde,,Waarde,,Wisselkoers,Transactiekosten en/of,,Totaal,Order ID',
  '02-06-2026,09:15,ASML HOLDING,NL0010273215,EAM,,2,640,,-1280,,-1280.00,,,-2.00,,-1282.00,ord-1',
].join('\n');

async function createManualHolding(name: string, price: string) {
  fireEvent.click(await screen.findByTestId('pf-add'));
  await screen.findByTestId('pf-name');
  fireEvent.change(screen.getByTestId('pf-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('pf-manual-price'), { target: { value: price } });
  fireEvent.click(screen.getByTestId('pf-save'));
  const row = await waitFor(
    () => {
      const el = document.querySelector('[data-testid^="pf-holding-"]');
      expect(el).toBeTruthy();
      return el!;
    },
    { timeout: 5000 },
  );
  return row;
}

describe('Portfolio (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a manual holding with lots values the position and totals', async () => {
    renderApp('/portfolio');
    await screen.findByTestId('screen-portfolio');
    await screen.findByTestId('pf-empty');
    // demo identity: the live symbol search never renders (no network)
    fireEvent.click(screen.getByTestId('pf-add'));
    await screen.findByTestId('pf-name');
    expect(screen.queryByTestId('pf-search')).toBeNull();
    fireEvent.click(screen.getByTestId('pf-save')); // empty name: no-op
    fireEvent.change(screen.getByTestId('pf-name'), { target: { value: 'Garage fund' } });
    fireEvent.change(screen.getByTestId('pf-manual-price'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('pf-save'));

    const row = await waitFor(() => {
      const el = document.querySelector('[data-testid^="pf-holding-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(row);
    await screen.findByTestId('pfdetail-hero');

    // buy 3 @ €40 → value 3 × €50 manual = €150, gain +€30
    fireEvent.click(screen.getByTestId('pfdetail-addlot'));
    await screen.findByTestId('pf-lot-qty');
    fireEvent.change(screen.getByTestId('pf-lot-qty'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('pf-lot-price'), { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('pf-lot-save'));
    await waitFor(() => expect(screen.getByTestId('pfdetail-value').textContent).toMatch(/€150[.,]00/), { timeout: 5000 });
    expect(screen.getByTestId('pfdetail-qty').textContent).toContain('3');

    cleanup();
    renderApp('/portfolio');
    const total = await screen.findByTestId('pf-total', {}, { timeout: 5000 });
    expect(total.textContent).toMatch(/€150[.,]00/);
  }, 15_000);

  it('the DEGIRO transactions export imports idempotently', async () => {
    renderApp('/portfolio');
    await screen.findByTestId('screen-portfolio');
    await screen.findByTestId('pf-empty');

    const file = new File([DEGIRO_TX], 'Transactions.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByTestId('pf-import-file'), { target: { files: [file] } });
    const result = await screen.findByTestId('pf-import-result', {}, { timeout: 5000 });
    expect(result.textContent).toContain('1');
    await waitFor(() => expect(document.querySelector('[data-testid^="pf-holding-"]')?.textContent).toContain('ASML'));

    // second import: nothing new (deterministic ids)
    fireEvent.change(screen.getByTestId('pf-import-file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('pf-import-result').textContent).toMatch(/0 .* 0|0 pos|0 holdings/i));
  }, 15_000);

  it('the home block and the settings row reach the portfolio', async () => {
    renderApp('/portfolio');
    await screen.findByTestId('screen-portfolio');
    await createManualHolding('Garage fund', '50');

    cleanup();
    renderApp('/home');
    fireEvent.click(await screen.findByTestId('home-portfolio', {}, { timeout: 5000 }));
    await screen.findByTestId('screen-portfolio');

    cleanup();
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-portfolio-row'));
    expect(await screen.findByTestId('screen-portfolio')).toBeTruthy();
  }, 15_000);
});
