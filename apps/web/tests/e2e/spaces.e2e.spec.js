import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, gotoSpaces, shot, teardown } from '../helpers/base.js';

// Critical flow: per-space data — a new space starts empty and active, and
// switching back brings the first space's data back unchanged.

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`spaces-a1 a new space starts empty; switching back restores the data [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    const total = page.locator('[data-testid="home-total-balance"]');
    await expect(total).toContainText(/€[1-9]/);
    const demoTotal = (await total.textContent()) ?? '';

    await gotoSpaces(page);
    await expect(page.locator('[data-testid="space-row-demo_space"]')).toContainText('Active space');
    await shot(page, k('22-spaces-list'));
    await page.click('[data-testid="spaces-add"]');
    await page.fill('[data-testid="space-create-name"]', 'Holiday Fund');
    await shot(page, k('23-spaces-create') + '--s1');
    await page.click('[data-testid="space-create-save"]');
    await expect(page.locator('[data-testid="screen-spaces"]')).toContainText('Holiday Fund');
    await page.click('[data-testid="tab-home"]');
    await expect(total).toContainText('0.00');
    await shot(page, k('23-spaces-create') + '--s2');

    await gotoSpaces(page);
    await page.click('[data-testid="space-row-demo_space"]');
    await page.click('[data-testid="tab-home"]');
    await expect(total).toHaveText(demoTotal);
    await shot(page, k('23-spaces-create'));
    await teardown(page, ctx, k('23-spaces-create'));
  });
}
