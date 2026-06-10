// Language-agnostic navigation helpers — all selectors use data-testid.

export async function goToSignupPicker(page) {
  await page.click('[data-testid="login-create-account"]');
  await page.waitForSelector('[data-testid="signup-pick-email"]');
}

export async function goToSignupEmail(page) {
  await goToSignupPicker(page);
  await page.click('[data-testid="signup-pick-email"]');
  await page.waitForSelector('[data-testid="signup-send-code"]');
}
