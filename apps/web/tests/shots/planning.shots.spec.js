import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// guide capture (npm run shots, never in CI): planning tab (#128), screenshots 70-72; the arithmetic and flows
// are unit-tested (planning.test.ts, planningModel.test.ts, PlanningScreen.test.tsx)

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`planning-a1 the plan, a subject, the periods ahead [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="tab-planning"]');
    await expect(page.locator('[data-testid="screen-planning"]')).toBeVisible();
    await expect(page.locator('[data-testid="plan-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="plan-segment-expenses"]')).toBeVisible();
    await page.waitForTimeout(400); // the circle's fill animation settles
    await shot(page, k('70-planning'));

    await page.click('[data-testid="plan-subject-demo_psub_eatout"]');
    await expect(page.locator('[data-testid="plan-sheet"]')).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, k('71-planning-subject'));
    await page.click('[data-testid="plan-page-back"]');
    await expect(page.locator('[data-testid="plan-sheet"]')).toBeHidden();

    await page.click('[data-testid="plan-ahead"]');
    await expect(page.locator('[data-testid="plan-ahead-sheet"]')).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, k('72-planning-ahead'));
    await teardown(page, ctx, k('72-planning-ahead'));
  });
}
