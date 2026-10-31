import { Page, expect } from '@playwright/test';

export interface TestUser {
  fullName: string;
  email: string;
  password: string;
  country: string;
}

let counter = 0;

/** A fresh, unique test user for each call — avoids collisions between test runs. */
export function makeTestUser(): TestUser {
  counter += 1;
  const stamp = `${Date.now()}_${counter}`;
  return {
    fullName: `E2E Test User ${stamp}`,
    email: `e2e+${stamp}@example.test`,
    password: 'SecurePass123!',
    country: 'United States',
  };
}

/**
 * Drives the real signup form in the browser — no API shortcuts. Leaves the
 * page wherever the app redirects to after signup (usually
 * /workspace/create for a brand-new user with no memberships yet).
 */
export async function signUpViaUi(page: Page, user: TestUser) {
  await page.goto('/signup');

  await page.getByLabel('Full name').fill(user.fullName);
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByLabel('Country of residence').selectOption(user.country);

  await page.getByRole('button', { name: 'Create account' }).click();
}

/** Drives the real login form in the browser. */
export async function logInViaUi(page: Page, user: Pick<TestUser, 'email' | 'password'>) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
}

/** Asserts the app has a session in localStorage under the key authStore persists to. */
export async function expectAuthenticated(page: Page) {
  const hasSession = await page.evaluate(() => {
    const raw = localStorage.getItem('kith-auth');
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw);
      return !!parsed?.state?.session?.access_token;
    } catch {
      return false;
    }
  });
  expect(hasSession).toBe(true);
}
