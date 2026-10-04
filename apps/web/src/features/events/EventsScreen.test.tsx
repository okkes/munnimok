// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID, isoDaysAgo } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

// happy-dom has no canvas — the downscaler is covered by lib/image.test.ts,
// here we care about the flow around it (#446)
const FAKE_PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';
vi.mock('@/lib/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image')>()),
  downscaleImage: vi.fn(async () => FAKE_PHOTO),
}));

async function createEvent(name: string, from?: string, to?: string, budget?: string) {
  fireEvent.click(await screen.findByTestId('events-add'));
  await screen.findByTestId('eventform-name');
  fireEvent.change(screen.getByTestId('eventform-name'), { target: { value: name } });
  if (from) fireEvent.change(screen.getByTestId('eventform-from'), { target: { value: from } });
  if (to) fireEvent.change(screen.getByTestId('eventform-to'), { target: { value: to } });
  if (budget) fireEvent.change(screen.getByTestId('eventform-budget'), { target: { value: budget } });
  fireEvent.click(screen.getByTestId('eventform-save'));
  await waitFor(() => {
    expect(document.querySelector('[data-testid^="event-card-"]')).toBeTruthy();
  });
  return document.querySelector('[data-testid^="event-card-"]')!;
}

describe('Events (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('an edited form asks before a stray dismissal drops it (dirty guard)', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    fireEvent.click(await screen.findByTestId('events-add'));
    fireEvent.change(await screen.findByTestId('eventform-name'), { target: { value: 'Ski trip' } });

    // Escape = a dismissal gesture: the guard asks instead of dropping
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByTestId('sheet-discard');
    fireEvent.click(screen.getByTestId('sheet-keep-editing'));
    // the form survived the gesture (test-mode sheets stay mounted, so
    // the retained value is the observable, not the confirm's absence)
    expect((screen.getByTestId('eventform-name') as HTMLInputElement).value).toBe('Ski trip');

    // choosing Discard really closes the form: the host clears `initial`,
    // dirty drops, and the guard subtree unmounts with it
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('sheet-discard'));
    await waitFor(() => expect(screen.queryByTestId('sheet-discard')).toBeNull());
    expect(document.querySelector('[data-testid^="event-card-"]')).toBeNull();
  }, 15_000);

  it('#366: an ask whose edits settle underneath it still answers — Discard closes, nothing is left hidden', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    fireEvent.click(await screen.findByTestId('events-add'));
    fireEvent.change(await screen.findByTestId('eventform-name'), { target: { value: 'Ski trip' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByTestId('sheet-discard');
    // the draft goes back to its baseline while the ask is up
    fireEvent.change(screen.getByTestId('eventform-name'), { target: { value: '' } });
    expect(screen.getByTestId('sheet-discard')).toBeTruthy();
    fireEvent.click(screen.getByTestId('sheet-discard'));
    await waitFor(() => expect(screen.queryByTestId('sheet-discard')).toBeNull());
    // the form is closed for real — the add door opens a fresh one
    fireEvent.click(await screen.findByTestId('events-add'));
    expect((await screen.findByTestId('eventform-name') as HTMLInputElement).value).toBe('');
  }, 15_000);

  it('creates an event; the card shows range and a zero total', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    await screen.findByTestId('events-empty');

    const card = await createEvent('Rome trip', isoDaysAgo(180), isoDaysAgo(160), '500');
    expect(card.textContent).toContain('Rome trip');
    // nothing attached yet
    expect(card.textContent).toMatch(/€0[.,]00/);
  }, 15_000);

  it('#446 (user): an uploaded picture is dragged into frame; the focus is saved and every rendering crops at it', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    fireEvent.click(await screen.findByTestId('events-add'));
    await screen.findByTestId('eventform-name');
    fireEvent.change(screen.getByTestId('eventform-name'), { target: { value: 'Framed' } });
    // a bundled picture has no frame — it was composed for the centre
    expect(screen.queryByTestId('eventform-focus')).toBeNull();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('eventform-upload-input'), { target: { files: [file] } });
    const frame = await screen.findByTestId('eventform-focus');
    // a loaded 1200×400 picture in a 300×112 frame overhangs 36px sideways
    frame.getBoundingClientRect = () => ({ width: 300, height: 112, x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 112, toJSON: () => ({}) });
    const img = screen.getByTestId('eventform-focus-img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1200, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 400, configurable: true });
    fireEvent.load(img);
    // dragging the picture 18px left (half the overhang) reveals its right edge
    fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(frame, { pointerId: 1, clientX: 82, clientY: 50 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    await waitFor(() => expect(img.style.objectPosition).toBe('100% 50%'));

    fireEvent.click(screen.getByTestId('eventform-save'));
    const card = await waitFor(() => {
      const found = document.querySelector('[data-testid^="event-card-"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    // the card crops at the chosen focus…
    expect((card.querySelector('img') as HTMLElement).style.objectPosition).toBe('100% 50%');
    // …and so does the hero
    fireEvent.click(card);
    const hero = await screen.findByTestId('eventdetail-hero');
    expect((hero.querySelector('img') as HTMLElement).style.objectPosition).toBe('100% 50%');
    // stored on the row as two percentages
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const rows = await db.events.toArray();
      expect(rows.find((r) => r.name === 'Framed')?.pictureFocus).toEqual({ x: 100, y: 50 });
    });
    db.close();
  }, 20_000);

  it('#195: a nameless save is refused with the blocker; typing clears it', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    await screen.findByTestId('events-empty');

    fireEvent.click(await screen.findByTestId('events-add'));
    await screen.findByTestId('eventform-name');
    // the save stays tappable — the invalid tap names what's missing
    expect((screen.getByTestId('eventform-save') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('eventform-save'));
    expect(await screen.findByTestId('eventform-save-blocker')).toBeTruthy();
    expect(screen.getByTestId('eventform-name').getAttribute('aria-invalid')).toBe('true');
    // nothing saved
    expect(document.querySelector('[data-testid^="event-card-"]')).toBeNull();

    // fixing the input clears the blocker live — no second tap needed
    fireEvent.change(screen.getByTestId('eventform-name'), { target: { value: 'Ski trip' } });
    await waitFor(() => expect(screen.queryByTestId('eventform-save-blocker')).toBeNull());
    expect(screen.getByTestId('eventform-name').getAttribute('aria-invalid')).toBe('false');
  }, 15_000);

  it('detail suggests txs in the date range and attach-all adopts them', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const card = await createEvent('Rome trip', isoDaysAgo(180), isoDaysAgo(160));

    fireEvent.click(card);
    await screen.findByTestId('eventdetail-hero');
    // the one-boot type-core chain (typed-splits v2: migrations, mirror
    // mints, the enriched pair matcher) keeps writing behind this test
    // longer than before, and a warm worker slows every emission — the
    // waits get real headroom instead of racing the burst
    const banner = await screen.findByTestId('eventdetail-suggest', {}, { timeout: 15_000 });
    expect(banner.textContent).toMatch(/[1-9]/);

    // the picker opens pre-checked; unticking one keeps it out — a REAL
    // row, by id: the old prefix query grabbed the eventpick-list
    // CONTAINER (first in document order), so the exclusion never
    // toggled and the flow silently attached everything
    fireEvent.click(screen.getByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');
    fireEvent.click(await screen.findByTestId('eventpick-dm2')); // exclude the rent
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('eventpick-attach'));
    await waitFor(() => expect(screen.getByTestId('eventdetail-total').textContent).toMatch(/€[1-9]/), { timeout: 15_000 });
    // #379: with payments attached the loud card yields to the quiet
    // "find more" — the excluded transaction keeps it alive with exactly one
    await waitFor(() => expect(screen.getByTestId('eventdetail-find-more').textContent).toMatch(/1/), { timeout: 8000 });
    expect(screen.queryByTestId('eventdetail-suggest')).toBeNull();
    expect(screen.getByTestId('eventdetail-cats')).toBeTruthy();
    expect(screen.getByTestId('eventdetail-txs')).toBeTruthy();
    // the quiet door opens the same picker
    fireEvent.click(screen.getByTestId('eventdetail-find-more'));
    await screen.findByTestId('eventpick-list');
  }, 45_000);

  it('#143: a split offers its parts one by one — the container itself is never a pick', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-partpick'), { trackOutbox: false });
    await repo.upsert('transaction', DEMO_SPACE_ID, 'evsplit', {
      accountId: 'demo_main', date: isoDaysAgo(170), amountCents: -6000, currency: 'EUR',
      merchant: 'Split Dinner', catId: 'restaurants', needsReview: 0,
      // #211: the explicit cats null marks these as PARTS for the boot fold
      cats: null as never,
      splits: [
        { id: 'p1', catId: 'restaurants', amountCents: 4500 },
        { id: 'p2', catId: 'groceries', amountCents: 1500 },
      ],
    });
    const card = await createEvent('Parts trip', isoDaysAgo(180), isoDaysAgo(160));
    fireEvent.click(card);
    await screen.findByTestId('eventdetail-hero');
    await screen.findByTestId('eventdetail-suggest', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');

    // the parts pick individually; the container has no checkbox of its own
    await screen.findByTestId('eventpick-evsplit-part-0');
    expect(screen.queryByTestId('eventpick-evsplit')).toBeNull();
    // leave the groceries part out of the event
    fireEvent.click(screen.getByTestId('eventpick-evsplit-part-1'));
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('eventpick-attach'));
    await waitFor(async () => {
      const rowNow = await db.transactions.get('evsplit');
      expect(rowNow?.splits?.[0]?.eventId).toBeTruthy();
      expect(rowNow?.splits?.[1]?.eventId).toBeUndefined();
      expect(rowNow?.eventId ?? undefined).toBeUndefined(); // container stays bare
    }, { timeout: 15_000 });
    // the attached payments list shows the member part as its own row
    await screen.findByTestId('tx-part-solo-evsplit-0', {}, { timeout: 8000 });
    db.close();
  }, 45_000);

  it('#447 (user): money received inside the range is offered too — only the person’s own movements stay out', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const card = await createEvent('Graduation', isoDaysAgo(180), isoDaysAgo(160));
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');
    // the demo salary (dm1, +€2,200) falls in the range: it is a pick now
    await screen.findByTestId('eventpick-dm1');
    // the savings transfer (dm12) is the person’s own money moving — never event money
    expect(screen.queryByTestId('eventpick-dm12')).toBeNull();
    // the button sums the picks the way the event will show them: the
    // salary alone is a surplus, so it wears a plus
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('eventpick-all')); // a full pick clears
    fireEvent.click(screen.getByTestId('eventpick-dm1'));
    await waitFor(() => expect(screen.getByTestId('eventpick-attach').textContent).toMatch(/[+]€2[.,]200/));
  }, 20_000);

  it('#448 (user): money received shows as a surplus with a plus, and a credit’s detail offers the event row', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const card = await createEvent('Graduation gift', isoDaysAgo(180), isoDaysAgo(160), '100');
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('eventpick-all')); // a full pick clears
    fireEvent.click(screen.getByTestId('eventpick-dm1')); // the salary: +€2,200
    fireEvent.click(screen.getByTestId('eventpick-dm9')); // a coffee: −€4.50
    fireEvent.click(screen.getByTestId('eventpick-attach'));
    // the hero: in surplus, so a plus — and the flows line says what went
    // out and what came in
    await waitFor(() => expect(screen.getByTestId('eventdetail-total').textContent).toMatch(/[+]€2[.,]195/), { timeout: 15_000 });
    const flows = screen.getByTestId('eventdetail-flows').textContent ?? '';
    expect(flows).toMatch(/4[.,]50/);
    expect(flows).toMatch(/2[.,]200/);
    // the breakdown stays about spending: the coffee, never the salary
    expect(screen.getByTestId('eventdetail-cats').textContent).toMatch(/4[.,]50/);
    expect(screen.getByTestId('eventdetail-cats').textContent).not.toMatch(/2[.,]200/);
    // the credit’s own detail offers the event row (it was gated to expenses)
    fireEvent.click(await screen.findByTestId('tx-row-dm1'));
    const row = await screen.findByTestId('tx-detail-event-row');
    expect(row.textContent).toContain('Graduation gift');
  }, 30_000);

  it('#144: select/deselect-all sweep the whole pick list in one tap', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const card = await createEvent('Sweep trip', isoDaysAgo(180), isoDaysAgo(160));
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });

    // #378: one row toggles — a full pick clears, an empty pick selects all
    expect(screen.getByTestId('eventpick-all').dataset.state).toBe('all');
    fireEvent.click(screen.getByTestId('eventpick-all'));
    expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('eventpick-all').dataset.state).toBe('none');
    fireEvent.click(screen.getByTestId('eventpick-all'));
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false));
  }, 20_000);

  it('tapping a breakdown category unfolds subs and filters the payments (user request)', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const card = await createEvent('Rome trip', isoDaysAgo(180), isoDaysAgo(160));
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('eventpick-attach')); // everything pre-checked
    await screen.findByTestId('eventdetail-txs', {}, { timeout: 8000 });
    // attach-all writes one tx at a time — the suggestion banner goes before
    // the last row lands, so the count is sampled only once it has held
    // still for a beat (a slow CI runner saw 9, then 10)
    await waitFor(() => expect(screen.queryByTestId('eventdetail-suggest')).toBeNull(), { timeout: 8000 });
    const rows = () => document.querySelectorAll('[data-testid="eventdetail-txs"] [data-testid^="tx-row-"]').length;
    let allCount = -1;
    await waitFor(
      () => {
        const now = rows();
        const settled = now === allCount;
        allCount = now;
        expect(settled).toBe(true);
      },
      { timeout: 8000, interval: 250 },
    );
    const mainRow = document.querySelector('[data-testid^="eventdetail-cat-"]')!;
    fireEvent.click(mainRow);
    // subs unfold under the tapped main…
    await waitFor(() => expect(document.querySelector('[data-testid^="eventdetail-subcat-"]')).toBeTruthy());
    // …and the payments list narrows to that main (never grows)
    const filtered = document.querySelectorAll('[data-testid="eventdetail-txs"] [data-testid^="tx-row-"]').length;
    expect(filtered).toBeGreaterThan(0);
    expect(filtered).toBeLessThanOrEqual(allCount);

    // the sub narrows further; the clear chip restores everything
    fireEvent.click(document.querySelector('[data-testid^="eventdetail-subcat-"]')!);
    fireEvent.click(await screen.findByTestId('eventdetail-filter-clear'));
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid="eventdetail-txs"] [data-testid^="tx-row-"]').length).toBe(allCount),
    );
  }, 20_000);

  it('a transaction can leave the event through the tx-detail picker', async () => {
    renderApp('/events');
    await screen.findByTestId('screen-events');
    const card = await createEvent('Rome trip', isoDaysAgo(180), isoDaysAgo(160));
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('eventdetail-attach-all'));
    await screen.findByTestId('eventpick-list');
    await waitFor(() => expect((screen.getByTestId('eventpick-attach') as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(screen.getByTestId('eventpick-attach')); // everything pre-checked
    const txList = await screen.findByTestId('eventdetail-txs', {}, { timeout: 8000 });

    // into the transaction: the event row names the event, None clears it
    fireEvent.click(txList.querySelector('button')!);
    const row = await screen.findByTestId('tx-detail-event-row');
    expect(row.textContent).toContain('Rome trip');
    fireEvent.click(row);
    await screen.findByTestId('tx-event-list');
    fireEvent.click(screen.getByTestId('tx-event-none'));
    await waitFor(() => expect(screen.getByTestId('tx-detail-event-row').textContent).toContain('None'));
  }, 20_000);

  it('settings row reaches events; archiving dims the card', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-events-row'));
    await screen.findByTestId('screen-events');

    const card = await createEvent('Old party');
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('eventdetail-edit'));
    fireEvent.click(await screen.findByTestId('eventform-archive'));
    // the button unmounts via onClose only after the write resolved —
    // unmounting earlier would close the db under the in-flight put
    await waitFor(() => expect(screen.queryByTestId('eventform-archive')).toBeNull());

    cleanup();
    renderApp('/events');
    await waitFor(
      () => {
        const archived = document.querySelector('[data-testid^="event-card-"]');
        expect(archived?.className).toContain('opacity-60');
      },
      { timeout: 5000 },
    );
  }, 15_000);
});
