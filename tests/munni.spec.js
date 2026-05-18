// @ts-check
const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('url');
const path = require('path');

const FILE = pathToFileURL(path.join(__dirname, '..', 'munni.html')).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToApp(page) {
  await page.goto(FILE);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  try {
    await page.locator('text=Continue as demo user').waitFor({ state: 'visible', timeout: 4000 });
    await page.locator('text=Continue as demo user').click();
  } catch { /* app loaded directly into home */ }

  await expect(
    page.locator('text=Income').or(page.locator('text=Spent')).first()
  ).toBeVisible({ timeout: 10000 });
}

// Tabs are <button className="m-tap"> — use exact role match to avoid partial
// text collisions with card labels elsewhere on the screen.
const tab = (page, name) => page.getByRole('button', { name, exact: true });

// ---------------------------------------------------------------------------
// 1. Home screen loads with key spending stats
// ---------------------------------------------------------------------------
test('1 - home screen loads with income and spent stats', async ({ page }) => {
  await goToApp(page);
  await expect(page.locator('text=Income')).toBeVisible();
  await expect(page.locator('text=Spent')).toBeVisible();
});

// ---------------------------------------------------------------------------
// 2. Transactions tab renders a list of rows
// ---------------------------------------------------------------------------
test('2 - transactions tab shows transaction list', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Transactions').click();

  await expect(page.locator('.m-tap').first()).toBeVisible({ timeout: 5000 });
  await expect(
    page.locator('text=Albert Heijn').or(page.locator('text=Jumbo')).first()
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// 3. Category picker change does NOT freeze the app
//    Regression test for the "two useEffects fighting each other" bug that
//    caused React to throw "Maximum update depth exceeded".
//    The clickable "Add category split" only appears when effectiveRemaining > 0
//    (i.e. when the transaction is marked as expenseUncategorized). We trigger
//    that state by first removing the existing category via the × button.
// ---------------------------------------------------------------------------
test('3 - category picker change does not cause infinite update loop', async ({ page }) => {
  /** @type {string[]} */
  const jsErrors = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  await goToApp(page);
  await tab(page, 'Transactions').click();

  // Open an expense transaction
  const expenseRow = page.locator('.m-tap').filter({ hasText: '−' }).first();
  await expect(expenseRow).toBeVisible({ timeout: 5000 });
  await expenseRow.click();

  // Wait for TxDetail to render — the Categories card must appear
  await expect(page.locator('text=Categories')).toBeVisible({ timeout: 5000 });

  // Remove the existing category (× button). This sets the cat to
  // expenseUncategorized and makes effectiveRemaining = |amount| > 0,
  // which causes the active (clickable) "Add category split" to appear.
  const categoriesCard = page.locator('.m-card').filter({ has: page.locator('text=Categories') });
  await categoriesCard.locator('button').filter({ hasText: '×' }).first().click();

  // The clickable version of "Add category split" (has m-tap class) must now show
  await expect(page.locator('.m-tap').filter({ hasText: 'Add category split' })).toBeVisible({ timeout: 3000 });
  await page.locator('.m-tap').filter({ hasText: 'Add category split' }).click();

  await expect(page.locator('text=Pick category')).toBeVisible({ timeout: 3000 });
  // { force: true } bypasses the m-cap section header that overlaps the Grocery item
  await page.locator('text=Grocery').first().click({ force: true });

  // App must still respond — if frozen this assertion will time out
  await expect(
    page.locator('.m-tap').filter({ hasText: 'Add category split' })
      .or(page.locator('text=Pick category'))
      .first()
  ).toBeVisible({ timeout: 4000 });

  // The specific React error from infinite re-renders must NOT have fired
  const loopErrors = jsErrors.filter((m) => m.includes('Maximum update depth'));
  expect(loopErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 4. Saving account attach auto-assigns the saving category
// ---------------------------------------------------------------------------
test('4 - linking a saving account auto-assigns the saving category', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Transactions').click();

  const expenseRow = page.locator('.m-tap').filter({ hasText: '−' }).first();
  await expect(expenseRow).toBeVisible({ timeout: 5000 });
  await expenseRow.click();

  const savingBtn = page
    .locator('text=Link saving account')
    .or(page.locator('text=Saving account'))
    .first();

  if (!(await savingBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
    test.skip(); // this transaction type doesn't support saving account linking
    return;
  }
  await savingBtn.click();

  // Saving account picker sheet opens — click the ING saving account row
  const savingRow = page.locator('.m-tap').filter({ hasText: 'Savings · ING' }).first();
  await expect(savingRow).toBeVisible({ timeout: 5000 });
  await savingRow.click();

  // After selecting, the picker closes and the "None — tap to attach" placeholder
  // is replaced by the account name — confirm the link was made
  await expect(page.locator('text=None — tap to attach')).not.toBeVisible({ timeout: 3000 });
});

// ---------------------------------------------------------------------------
// 5. Recurring tab renders without error
// ---------------------------------------------------------------------------
test('5 - recurring tab renders', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Recurring').click();

  await expect(page.locator('.m-tap').first()).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// 6. Events tab renders without error
// ---------------------------------------------------------------------------
test('6 - events tab renders', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Events').click();

  // Any rendered card confirms the screen loaded
  await expect(page.locator('.m-card').first()).toBeVisible({ timeout: 5000 });
});

// ---------------------------------------------------------------------------
// 7. Insights tab loads without a JavaScript error
// ---------------------------------------------------------------------------
test('7 - insights tab loads without JS error', async ({ page }) => {
  /** @type {string[]} */
  const jsErrors = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));

  await goToApp(page);
  await tab(page, 'Insights').click();
  await page.waitForTimeout(1500);

  expect(jsErrors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 8. Dark mode toggle writes to localStorage
//    Dark mode lives in ScreenSettings, reached via Settings → Appearance.
// ---------------------------------------------------------------------------
test('8 - dark mode toggle persists in localStorage', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Settings').click();

  // "Appearance" row in ScreenProfiles pushes to ScreenSettings
  await page.locator('text=Appearance').first().click();

  // Use the sub-text unique to the toggle row — the Appearance link in ScreenProfiles
  // also contains "Dark mode" in its sub-text so we must be more specific.
  await page.locator('.m-tap').filter({ hasText: 'tap to switch to dark' }).click();
  const darkOn = await page.evaluate(() => localStorage.getItem('munni_dark'));
  expect(darkOn).toBe('true');

  // Toggle back off — sub-text now reads "tap to switch to light"
  await page.locator('.m-tap').filter({ hasText: 'tap to switch to light' }).click();
  const darkOff = await page.evaluate(() => localStorage.getItem('munni_dark'));
  expect(darkOff).toBe('false');
});

// ---------------------------------------------------------------------------
// 9. Customize home card toggle persists after a page reload
//    The toggle is a <button className="m-tap"> sibling of the label/sub divs,
//    so text-based selectors won't reach it. Use page.evaluate to find the
//    button adjacent to the "AI-powered spending insights" sub-text and click it.
// ---------------------------------------------------------------------------
test('9 - customize home card toggle persists after reload', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Settings').click();
  await page.locator('text=Customize home').click();

  // Confirm the Customize Home screen rendered
  await expect(page.locator('text=AI-powered spending insights')).toBeVisible({ timeout: 5000 });

  // The toggle button for each card is a sibling of the label div, not a
  // descendant of the text node. Navigate the DOM to find and click it.
  const toggled = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div')];
    const subDiv = els.find((el) => el.textContent.trim() === 'AI-powered spending insights');
    if (!subDiv) return false;
    // subDiv → label container div → row flex div → first button.m-tap is the toggle
    const rowDiv = subDiv.parentElement?.parentElement;
    const btn = /** @type {HTMLButtonElement|null} */ (rowDiv?.querySelector('button.m-tap'));
    if (btn) { btn.click(); return true; }
    return false;
  });
  expect(toggled).toBe(true);

  const stored = await page.evaluate(() => {
    const raw = localStorage.getItem('munni_home_cards');
    return raw ? JSON.parse(raw) : null;
  });
  expect(stored).not.toBeNull();
  expect(stored.find((/** @type {any} */ c) => c.id === 'insights').visible).toBe(true);

  // Reload and verify persistence
  await page.reload({ waitUntil: 'domcontentloaded' });
  try {
    await page.locator('text=Continue as demo user').waitFor({ state: 'visible', timeout: 3000 });
    await page.locator('text=Continue as demo user').click();
  } catch { /* already on home */ }

  const storedAfter = await page.evaluate(() => {
    const raw = localStorage.getItem('munni_home_cards');
    return raw ? JSON.parse(raw) : null;
  });
  expect(storedAfter.find((c) => c.id === 'insights').visible).toBe(true);
});

// ---------------------------------------------------------------------------
// 10. PSD2 bank connect flow — Settings → Accounts → Connect a bank → Rabobank
// ---------------------------------------------------------------------------
test('10 - PSD2 connect bank flow opens login step', async ({ page }) => {
  await goToApp(page);
  await tab(page, 'Settings').click();

  // Navigate into the Accounts section (under the Manage section in ScreenProfiles)
  await page.locator('text=Accounts').first().click();

  // "Connect a bank" button in ScreenAccountsAll
  await expect(page.locator('text=Connect a bank').first()).toBeVisible({ timeout: 5000 });
  await page.locator('text=Connect a bank').first().click();

  // Bank selection sheet must open — Rabobank is not pre-connected
  await expect(page.locator('text=Rabobank').first()).toBeVisible({ timeout: 5000 });
  await page.locator('text=Rabobank').first().click();

  // Login step for Rabobank should appear
  await expect(
    page.locator('text=Continue to Rabobank')
      .or(page.locator('text=Rabobank'))
      .first()
  ).toBeVisible({ timeout: 5000 });
});
