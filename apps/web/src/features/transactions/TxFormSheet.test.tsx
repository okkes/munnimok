// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

/** #348: the category first — a movement picked in the editor, its ask
 *  answered with `pot` (or walked away from with null) */
const pickMovement = async (catId: string, pot: string | null) => {
  fireEvent.click(screen.getByTestId('txform-category'));
  fireEvent.click(await screen.findByTestId('part-cat-0'));
  fireEvent.click(await screen.findByTestId(`catpicker-${catId}`));
  if (pot) fireEvent.click(await screen.findByTestId(`counter-pick-${pot}`));
  else {
    await screen.findByTestId('counter-accounts');
    fireEvent.keyDown(window, { key: 'Escape' });
  }
  fireEvent.click(await screen.findByTestId('part-cat-save'));
  await waitFor(() => expect((screen.getByTestId('txform-counter') as HTMLButtonElement).disabled).toBe(false));
};

/** the form's own counterparty sheet: once the category editor's ask has
 *  been open its rows stay mounted too, and the form's sheet renders first */
const formCounterSheet = (testId: string): HTMLElement => screen.getAllByTestId(testId)[0];

const openForm = async () => {
  renderApp('/transactions');
  await screen.findByTestId('tx-list');
  fireEvent.click(screen.getByTestId('tx-add'));
  await screen.findByTestId('txform-save');
  // two demo manual accounts → nothing pre-selects (user redesign
  // 2026-07-31): pick the main one through the account field + sheet
  fireEvent.click(await screen.findByTestId('txform-account'));
  fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
};

describe('TxFormSheet (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('save stays tappable — an invalid tap names the blocker until the form is whole (#195)', async () => {
    await openForm();
    const save = screen.getByTestId('txform-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false); // never disabled for validity
    fireEvent.click(save);
    // first failing requirement: the merchant name
    expect(await screen.findByTestId('txform-save-blocker')).toBeTruthy();
    expect(screen.getByTestId('txform-merchant').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker' } });
    expect(screen.getByTestId('txform-save-blocker')).toBeTruthy(); // still no amount
    expect(screen.getByTestId('txform-merchant').getAttribute('aria-invalid')).toBe('false');

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '0' } });
    expect(screen.getByTestId('txform-save-blocker')).toBeTruthy(); // zero is not a transaction

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '4,50' } });
    await waitFor(() => expect(screen.queryByTestId('txform-save-blocker')).toBeNull());
    // 15s cap: first coverage-load flake 2026-08-25 (5s default in a
    // 70s file) — a second flake means reworking, not re-timing
  }, 15_000);

  it('register-style amount entry: bare digits fill cents from the right (user request)', async () => {
    await openForm();
    const amount = screen.getByTestId('txform-amount') as HTMLInputElement;
    fireEvent.focus(amount);
    fireEvent.change(amount, { target: { value: '5' } });
    expect(amount.value).toBe('0,05');
    fireEvent.change(amount, { target: { value: '0,055' } });
    expect(amount.value).toBe('0,55');
    fireEvent.change(amount, { target: { value: '0,550' } });
    expect(amount.value).toBe('5,50');
    // the comma path stays: it promotes the digits to euros
    fireEvent.change(amount, { target: { value: '5,50,' } });
    expect(amount.value).toBe('550,');
    fireEvent.change(amount, { target: { value: '550,7' } });
    expect(amount.value).toBe('550,7');
  });

  it('#348: adding is a screen of its own — the saved expense opens as its own page', async () => {
    await openForm();
    expect(screen.getByTestId('screen-tx-create')).toBeTruthy();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '12,34' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker Bart' } });

    // the category row opens the split-categories editor (#211) —
    // pick through its per-entry picker, Done stages the single category
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('txform-category').textContent).toContain('Grocery'));

    fireEvent.click(screen.getByTestId('txform-save'));
    // the new row's own page replaces the form — every other door is there
    // (generous timeout: coverage instrumentation slows the liveQuery round-trip)
    await waitFor(
      () => {
        const detail = screen.getByTestId('screen-tx-detail');
        expect(detail.textContent).toContain('Bakker Bart');
        expect(screen.getByTestId('tx-detail-amount').textContent).toContain('12.34');
        expect(detail.textContent).toContain('Grocery');
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('screen-tx-create')).toBeNull();
    // coverage instrumentation pushes this flow past vitest's 5s default
  }, 15_000);

  it('a new entry just after midnight is dated the person’s own day — east of Greenwich the UTC day is still yesterday', async () => {
    const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const zone = env.TZ;
    env.TZ = 'Europe/Amsterdam';
    // 00:30 on 10 November in Amsterdam
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-09T23:30:00Z') });
    try {
      await openForm();
      expect((screen.getByTestId('txform-date') as HTMLInputElement).value).toBe('2026-11-10');
    } finally {
      vi.useRealTimers();
      if (zone === undefined) delete env.TZ;
      else env.TZ = zone;
    }
  }, 15_000);

  it('Add tapped twice writes the transaction once', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '12,34' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Double Tap Bakery' } });
    const add = screen.getByTestId('txform-save');
    // the screen stays up until the saved row's page is there: a second tap lands on the same button
    fireEvent.click(add);
    fireEvent.click(add);

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    const written = await waitFor(async () => {
      const rows = (await db.transactions.toArray()).filter((row) => row.merchant === 'Double Tap Bakery');
      expect(rows.length).toBeGreaterThan(0);
      return rows;
    }, { timeout: 5000 });
    expect(written).toHaveLength(1);
    await screen.findByTestId('screen-tx-detail', {}, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#348 (user): the counterparty waits for the category — an ordinary filing leaves it shut, a movement opens it', async () => {
    await openForm();
    const counter = () => screen.getByTestId('txform-counter') as HTMLButtonElement;
    // category first: nothing picked yet, so there is no other side to name
    expect(counter().disabled).toBe(true);
    fireEvent.click(counter());
    expect(screen.queryByTestId('counter-accounts')).toBeNull();
    // a movement category asks its counterparty (in the editor) and the row opens
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '25,00' } });
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    await waitFor(() => expect(counter().textContent).toContain('Demo Savings'));
    expect(counter().disabled).toBe(false);
    expect(screen.getByTestId('txform-category').textContent).toContain('Set aside');
  }, 15_000);

  it('#348 (user): the event and the note are set while adding; a reimbursement link follows the save', async () => {
    const [{ MunniDB }, { DexieBackend }, { Repo }, { HlcClock }] = await Promise.all([
      import('@/db/schema'),
      import('@/db/backend'),
      import('@/db/repo'),
      import('@/sync/hlc'),
    ]);
    await openForm();
    const seed = new MunniDB('munni_demo');
    await new Repo(new DexieBackend(seed), new HlcClock('ev348'), { trackOutbox: false }).upsert('event', 'demo_space', 'ev348', { name: 'Wedding' });
    seed.close();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '80,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Flowers for Anna' } });
    fireEvent.click(screen.getByTestId('txform-event'));
    fireEvent.click(await screen.findByTestId('txform-event-ev348'));
    await waitFor(() => expect(screen.getByTestId('txform-event').textContent).toContain('Wedding'));
    fireEvent.change(screen.getByTestId('txform-notes'), { target: { value: 'Half is Bas’s share' } });
    // the reimbursement door saves first, then opens the link picker for the new row
    fireEvent.click(screen.getByTestId('txform-link-reimb'));
    await screen.findByTestId('screen-reimb-link', {}, { timeout: 5000 });
    expect((await screen.findByTestId('reimb-link-anchor', {}, { timeout: 5000 })).textContent).toContain('Flowers for Anna');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = (await db.transactions.toArray()).find((r) => r.merchant === 'Flowers for Anna');
      expect(row).toMatchObject({ eventId: 'ev348', notes: 'Half is Bas’s share', amountCents: -8000 });
    }, { timeout: 5000 });
    db.close();
  }, 20_000);

  it('#228: a lone ◆ pick in the editor becomes the FORM\'s counterparty; save mints the row-key leg', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Mixed Save' } });

    fireEvent.click(screen.getByTestId('txform-category'));
    // the ◆ pick asks its counterparty on the spot; the pot answers —
    // the single entry spans the whole, so the ADD door shuts
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    // a loaded CI runner (coverage on) can take longer than RTL's 1 s
    // default to settle the pick — the file's other waits allow 5 s too
    // (flaked once in CI, 2026-09-09)
    await waitFor(() => expect(screen.getAllByTestId('part-cats-editor').at(-1)!.getAttribute('data-counter')).toBe('demo_save'), { timeout: 5000 });
    expect((screen.getByTestId('part-cat-add') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('part-cat-one-special')).toBeTruthy();
    fireEvent.click(screen.getByTestId('part-cat-save'));
    // the answer landed at the FORM level — the counterparty row says so
    await waitFor(() => expect(screen.getByTestId('txform-counter').textContent).toContain('Demo Savings'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('txform-save'));

    const { MunniDB } = await import('@/db/schema');
    const { mirrorTxId } = await import('@/domain/feedIds');
    const db = new MunniDB('munni_demo');
    await waitFor(
      async () => {
        const row = (await db.transactions.toArray()).find((t) => t.merchant === 'Mixed Save');
        expect(row).toBeTruthy();
        expect(row!.catId).toBe('savingDeposit');
        expect(row!.linkedAccountId).toBe('demo_save');
        expect(row!.cats ?? undefined).toBeUndefined();
        // the pot leg rides the ROW's own key, sized to the whole €50
        const mid = mirrorTxId(row!.id);
        expect(row!.transferPeerId).toBe(mid);
        expect(await db.transactions.get(mid)).toMatchObject({ accountId: 'demo_save', amountCents: 5000 });
      },
      { timeout: 5000 },
    );
    db.close();
  }, 15_000);

  it('no manual account: the form explains itself and doors to accounts', async () => {
    const { renderAppAsUser, USER_TEST_DB } = await import('@/test/harness');
    indexedDB.deleteDatabase(USER_TEST_DB);
    // a user space with ZERO writable accounts (no seed)
    renderAppAsUser('/transactions', { spaces: [{ id: 's-user', name: 'Personal' }] });
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    // #179 (user): the CTA lands on the SPACE's own accounts screen with
    // the add chooser opening on arrival — not the global overview
    expect(await screen.findByTestId('txform-no-accounts')).toBeTruthy();
    fireEvent.click(screen.getByTestId('txform-add-account'));
    expect(await screen.findByTestId('screen-space-accounts')).toBeTruthy();
    // the add chooser is open on arrival (whichever of its steps leads)
    await waitFor(() => expect(document.querySelector('[data-testid^="chooser-manual"]')).toBeTruthy(), { timeout: 5000 });
  }, 15_000);

  it('a manual expense adjusts the account balance live (user bug: it froze)', async () => {
    await openForm();
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    const before = (await db.accounts.get('demo_main'))!.balanceCents;

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Markt' } });
    fireEvent.click(screen.getByTestId('txform-save'));

    await waitFor(async () => {
      expect((await db.accounts.get('demo_main'))!.balanceCents).toBe(before - 5000);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#269: the adjustment names its impact; target mode writes the difference; category locks', async () => {
    await openForm();
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    const before = (await db.accounts.get('demo_main'))!.balanceCents;

    fireEvent.click(screen.getByTestId('txform-adjustment'));
    // the panel arrives; the category is munni's own, locked
    await screen.findByTestId('txform-adjust-panel');
    expect(screen.getByTestId('txform-adjust-cat').textContent).toContain('Balance Adjustment');
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Fix saldo' } });
    expect(screen.getByTestId('txform-adjust-impact').textContent).toContain('→');

    // target mode: the typed 50,00 is the balance to LAND ON — the row
    // gets the difference and the account ends exactly there
    fireEvent.click(screen.getByTestId('txform-adjust-mode-target'));
    fireEvent.click(screen.getByTestId('txform-save'));
    await waitFor(async () => {
      const row = (await db.transactions.toArray()).find((r) => r.merchant === 'Fix saldo');
      expect(row?.amountCents).toBe(5000 - before);
      expect(row?.catId).toBe('balanceAdjustment');
      expect((await db.accounts.get('demo_main'))!.balanceCents).toBe(5000);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('a movement keeps its story when the counterparty is re-picked; the Adjustment mark writes through', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '25,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Naar spaarpot' } });

    // #348: the category first — Set aside, its pot named on the spot
    await pickMovement('savingDeposit', 'demo_save');
    // the counterparty row re-picks the pot (the editor's ask, closed,
    // keeps its rows mounted — the form's own sheet renders first)
    fireEvent.click(screen.getByTestId('txform-counter'));
    await waitFor(() => expect(screen.getAllByTestId('counter-accounts')).toHaveLength(2));
    fireEvent.click(formCounterSheet('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('txform-counter').textContent).toContain('Demo Savings'));
    expect(screen.getByTestId('txform-category').textContent).toContain('Set aside');
    expect((screen.getByTestId('txform-save') as HTMLButtonElement).disabled).toBe(false);

    // the Adjustment toggle marks a correction; save writes the marker
    fireEvent.click(screen.getByTestId('txform-adjustment'));
    fireEvent.click(screen.getByTestId('txform-save'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = (await db.transactions.toArray()).find((r) => r.merchant === 'Naar spaarpot');
      expect(row?.adjustment).toBe(1);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('the Create door builds a missing counterparty through the full chooser', async () => {
    await openForm();
    // #348: a movement category first (its ask walked away from) opens the counterparty row
    await pickMovement('savingDeposit', null);
    fireEvent.click(screen.getByTestId('txform-counter'));
    await waitFor(() => expect(screen.getAllByTestId('counter-accounts')).toHaveLength(2));

    // one creation door now (user redesign 2026-08-01): the chooser's
    // manual path, built in place and handed straight back
    fireEvent.click(formCounterSheet('counter-full-setup'));
    fireEvent.click(await screen.findByTestId('chooser-manual'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-savings'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Vakantiepot' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));

    // the fresh manual account IS the counterparty; the leg stays a
    // plain Transfer (R2 — the pot's ledger will carry the saving story)
    await waitFor(() => expect(screen.getByTestId('txform-counter').textContent).toContain('Vakantiepot'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const made = (await db.accounts.toArray()).find((a) => a.name === 'Vakantiepot');
      expect(made).toMatchObject({ type: 'savings', source: 'manual', balanceCents: 0 });
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('a fully synced (open banking) account is never offered for manual rows', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    // make the demo checking account look bank-synced
    const [{ MunniDB }, { DexieBackend }, { Repo }, { HlcClock }] = await Promise.all([
      import('@/db/schema'),
      import('@/db/backend'),
      import('@/db/repo'),
      import('@/sync/hlc'),
    ]);
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('gc'), { trackOutbox: false });
    await repo.upsert('account', 'demo_space', 'demo_main', { source: 'connector' });
    db.close();

    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    fireEvent.click(screen.getByTestId('txform-account'));
    // #348: the cash wallet counts as writable too now, so two manual
    // targets remain; the bank-synced account is still never offered
    await screen.findByTestId('txform-account-demo_save');
    await screen.findByTestId('txform-account-defaultacct_cash_demo_space');
    // the synced flag was written through a SECOND db handle: the live
    // query may still hold the pre-write row for a tick, so the absence
    // is awaited like the presences above (flaked once in CI, 2026-09-09)
    await waitFor(() => expect(screen.queryByTestId('txform-account-demo_main')).toBeNull());
  });

  it('a manual-counter transfer writes the mirror; the list collapses the pair', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '100,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Naar spaarpot' } });
    // #348: the category first, its pot named on the spot
    await pickMovement('savingDeposit', 'demo_save');
    // the mirror checkbox retired (typed-splits v2): a MANUAL counter's
    // leg is ALWAYS minted — the pot's own ledger is the record
    expect(screen.queryByTestId('txform-mirror')).toBeNull();
    fireEvent.click(screen.getByTestId('txform-save'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    let outId = '';
    await waitFor(async () => {
      const rows = await db.transactions.filter((r) => r.merchant === 'Naar spaarpot' && r.deleted === 0).toArray();
      expect(rows).toHaveLength(2); // both legs exist…
      const out = rows.find((r) => r.amountCents < 0)!;
      const inc = rows.find((r) => r.amountCents > 0)!;
      expect(out.transferPeerId).toBe(inc.id); // …peered both ways
      expect(inc.transferPeerId).toBe(out.id);
      // the mirror wears the pot's R1 stamp + the Q8 movement sub
      expect(inc).toMatchObject({ accountId: 'demo_save', catId: 'savingDeposit', linkedAccountId: 'demo_main', needsReview: 0 });
      outId = out.id;
    }, { timeout: 5000 });

    // the LIST shows the pair as ONE row: the outgoing leg with the
    // "From → To" note; the incoming leg stays hidden (the save landed
    // on the new row's page — the list is a tab away)
    await screen.findByTestId('screen-tx-detail');
    cleanup();
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await waitFor(() => {
      const rows = [...screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]')].filter((r) =>
        r.textContent?.includes('Naar spaarpot'),
      );
      expect(rows).toHaveLength(1);
      expect(screen.getByTestId(`tx-row-pair-${outId}`).textContent).toContain('→');
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#309: a movement category refuses to SAVE bare — red counter field; the ask’s Default answers it', async () => {
    // savingDeposit: the ask is NOT mandatory (unlike the transfer
    // family, whose editor rolls a dismissed pick back), so a bare
    // movement could reach save — and used to land silently default-
    // linked by the boot fold. Now the save itself refuses.
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Spaarpot' } });
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    // the ask opens on the pick — walking away keeps the bare story
    await screen.findByTestId('counter-accounts');
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    await waitFor(() => expect(screen.getByTestId('txform-category').textContent).toContain('Set aside'));
    // #309 (user): "we should not be able to continue" — the save
    // refuses and names the field instead of writing a silent default
    fireEvent.click(await screen.findByTestId('txform-save'));
    expect((await screen.findByTestId('txform-save-blocker')).textContent).toContain('Counterparty required');
    expect(screen.getByTestId('txform-counter').className).toContain('ring-negative');

    // answering through the field: the pot is one tap away (the editor's
    // closed ask keeps its rows mounted — the form's own sheet is the last)
    fireEvent.click(screen.getByTestId('txform-counter'));
    await waitFor(() => expect(screen.getAllByTestId('counter-pick-demo_save')).toHaveLength(2));
    fireEvent.click(formCounterSheet('counter-pick-demo_save'));
    await waitFor(() => expect(screen.queryByTestId('txform-save-blocker')).toBeNull());
    fireEvent.click(screen.getByTestId('txform-save'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = (await db.transactions.toArray()).find((r) => r.merchant === 'Spaarpot');
      expect(row).toMatchObject({ catId: 'savingDeposit', needsReview: 0 });
      expect(row?.linkedAccountId).toBeTruthy();
    }, { timeout: 5000 });
    db.close();
  }, 20_000);

  it('with several manual accounts nothing pre-selects — save requires a pick', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '4,50' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker' } });
    const save = screen.getByTestId('txform-save') as HTMLButtonElement;
    expect((await screen.findByTestId('txform-account')).textContent).toContain('Pick an account');
    // valid amount+merchant, but no account: the tap names it (#195)
    fireEvent.click(save);
    expect(await screen.findByTestId('txform-save-blocker')).toBeTruthy();
    // S6811: a button carries data-invalid (aria-invalid is inputs-only)
    expect(screen.getByTestId('txform-account').getAttribute('data-invalid')).toBe('true');
    fireEvent.click(screen.getByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    await waitFor(() => expect(screen.queryByTestId('txform-save-blocker')).toBeNull());
  });

  it('a date before the space start is refused; one tap moves the start (arc 5)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    const [{ MunniDB }, { DexieBackend }, { Repo }, { HlcClock }] = await Promise.all([
      import('@/db/schema'),
      import('@/db/backend'),
      import('@/db/repo'),
      import('@/sync/hlc'),
    ]);
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('hs'), { trackOutbox: false });
    await repo.upsert('space', 'demo_space', 'demo_space', { historyStartDate: '2026-06-01' });
    // #259: an attached feed's gate must follow the move too
    const { accountLinkId } = await import('@/domain/feedIds');
    const linkId = accountLinkId('demo_space', 'feed_hs');
    await repo.upsert('accountLink', 'demo_space', linkId, {
      feedSpaceId: 'feed_hs', accountId: 'a-feed-hs', historyFrom: '2026-06-01', archived: 0,
    });

    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '9,99' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Oud bonnetje' } });
    fireEvent.change(screen.getByTestId('txform-date'), { target: { value: '2026-05-15' } });

    // refused with the way out, not a dead end — the save tap points at
    // the start-gate card's own explanation (#195)
    await screen.findByTestId('txform-before-start');
    fireEvent.click(screen.getByTestId('txform-save'));
    expect(await screen.findByTestId('txform-save-blocker')).toBeTruthy();
    fireEvent.click(screen.getByTestId('txform-move-start'));

    // the space start moved to the row's date — the error clears, save arms
    await waitFor(async () => {
      expect((await db.spaces.get('demo_space'))?.historyStartDate).toBe('2026-05-15');
    }, { timeout: 5000 });
    // …and the attachment's own gate moved WITH it (the bare space write
    // used to leave links behind — the other-device leak)
    await waitFor(async () => {
      expect((await db.accountLinks.get(linkId))?.historyFrom).toBe('2026-05-15');
    }, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('txform-before-start')).toBeNull());
    expect(screen.queryByTestId('txform-save-blocker')).toBeNull();
    db.close();
  }, 15_000);

  it('the income toggle stores a positive amount', async () => {
    await openForm();
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Refund BV' } });
    fireEvent.click(screen.getByTestId('txform-save'));
    await waitFor(() => expect(screen.getByTestId('tx-detail-amount').textContent).toContain('+€50.00'), { timeout: 5000 });
  }, 15_000);
});

describe('the create screen in a space this member only reads (#505)', () => {
  const SPACE = 's-shared';

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('has no door that saves: neither Add nor the reimbursement link that saves first', async () => {
    const [{ MunniDB }, { DexieBackend }, { Repo }, { HlcClock }] = await Promise.all([
      import('@/db/schema'),
      import('@/db/backend'),
      import('@/db/repo'),
      import('@/sync/hlc'),
    ]);
    const db = new MunniDB(USER_TEST_DB);
    await db.meta.put({ key: 'activeSpaceId', value: SPACE });
    await db.meta.put({ key: 'spaceRoles', value: { [SPACE]: 'reader' } });
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-reader'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Eukesh', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('account', SPACE, 'acc-joint', { name: 'Joint', type: 'checking', source: 'manual', balanceCents: 0, currency: 'EUR' });
    db.close();

    renderAppAsUser('/transactions/new', { spaces: [{ id: SPACE, name: 'Eukesh', kind: 'shared', role: 'reader' }] });
    await screen.findByTestId('txform-readonly-note', {}, { timeout: 8000 });
    expect(screen.getByTestId('txform-event')).toBeTruthy();
    expect(screen.queryByTestId('txform-save')).toBeNull();
    expect(screen.queryByTestId('txform-link-reimb')).toBeNull();
  }, 20_000);
});
