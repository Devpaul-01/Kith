import { test, expect } from '@playwright/test';
import { makeTestUser, signUpViaUi } from './helpers';

test.describe('Signup', () => {
  test('a new user can sign up and lands on workspace creation', async ({ page }) => {
    const user = makeTestUser();

    await signUpViaUi(page, user);

    // A brand-new user has no workspace memberships yet, so the app should
    // route them to create one (see SignupPage.tsx redirectAfterAuth).
    await expect(page).toHaveURL(/\/workspace\/create/, { timeout: 10_000 });
  });

  test('shows a validation error for a weak password', async ({ page }) => {
    const user = makeTestUser();
    user.password = 'short';

    await page.goto('/signup');
    await page.getByLabel('Full name').fill(user.fullName);
    await page.getByLabel('Email address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText(/at least 8 characters/i)).toBeVisible();
    // Should not have navigated away from signup
    await expect(page).toHaveURL(/\/signup/);
  });

  test('shows an error when signing up with an already-registered email', async ({ page }) => {
    const user = makeTestUser();

    // First signup succeeds
    await signUpViaUi(page, user);
    await expect(page).toHaveURL(/\/workspace\/create/, { timeout: 10_000 });

    // Second signup with the same email should fail
    await page.evaluate(() => localStorage.clear());
    await signUpViaUi(page, user);
    await expect(page.getByText(/already|exists|registered/i)).toBeVisible({ timeout: 10_000 });
  });
});
