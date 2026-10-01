import { test, expect } from '@playwright/test';
import { VARIANTS, createPage, base, shot, teardown } from '../helpers/base.js';

// Why this spec exists (test policy 2026-09-17): the planning tab (#128)
// in a real browser on the rich demo — the plan with its segments, the
// circle and the left-to-give head, a subject opened, and the periods
// ahead. It produces the gallery/guide screenshots 70-72. The arithmetic
// and the flows are unit-tested (domain/planning.test.ts,
// application/planningModel.test.ts, features/planning/PlanningScreen.test.tsx).

for (const V of VARIANTS) {
  const k = (name) => `${name}--${V.id}`;

  test(`planning-a1 the plan, a subject, the periods ahead [${V.id}]`, async ({ browser }) => {
    const { page, ctx } = await createPage(browser, V);
    await base(page, V, { demo: true });
    await page.click('[data-testid="tab-planning"]');
    await expect(page.locator('[data-testid="screen-planning"]')).toBeVisible();
    // the rich demo seeds this period's plan: the head and the segments render
    await expect(page.locator('[data-testid="plan-header"]')).toBeVisible();
    await expect(page.locator('[data-testid="plan-segment-expenses"]')).toBeVisible();
    await page.waitForTimeout(400); // the circle's fill animation settles
    await shot(page, k('70-planning'));

    await page.click('[data-testid="plan-subject-demo_psub_eatout"]');
    await expect(page.locator('[data-testid="plan-sheet"]')).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, k('71-planning-subject'));
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="plan-sheet"]')).toBeHidden();

    await page.click('[data-testid="plan-ahead"]');
    await expect(page.locator('[data-testid="plan-ahead-sheet"]')).toBeVisible();
    await page.waitForTimeout(350);
    await shot(page, k('72-planning-ahead'));
    await teardown(page, ctx, k('72-planning-ahead'));
  });
}
