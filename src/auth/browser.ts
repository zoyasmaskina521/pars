import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Env } from '../config/env.js';
import type pino from 'pino';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

function challengeDetected(content: string): boolean {
  const markers = ['captcha', 'cloudflare', 'verify you are human', 'attention required', 'challenge'];
  const lower = content.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

export async function createSession(env: Env, logger: pino.Logger): Promise<BrowserSession> {
  fs.mkdirSync(path.dirname(env.SESSION_STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: env.DIAGNOSTIC_HEADFUL ? false : env.HEADLESS,
    executablePath: env.CHROMIUM_EXECUTABLE_PATH
  });

  if (env.CHROMIUM_EXECUTABLE_PATH) {
    logger.info({ executablePath: env.CHROMIUM_EXECUTABLE_PATH }, 'Using custom Chromium executable path');
  }

  const context = await browser.newContext({
    storageState: fs.existsSync(env.SESSION_STATE_PATH) ? env.SESSION_STATE_PATH : undefined,
    proxy: env.PROXY_SERVER
      ? {
          server: env.PROXY_SERVER,
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD
        }
      : undefined,
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(env.NAV_TIMEOUT_MS);

  return { browser, context, page };
}

export async function detectSiteOrChallenge(page: Page, siteUrl: string): Promise<'ok' | 'challenge' | 'down'> {
  try {
    const response = await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
    if (!response) return 'down';
    const status = response.status();
    const html = await page.content();
    if (challengeDetected(html)) return 'challenge';
    if (status >= 500 || status === 429 || status === 403) return 'down';
    return 'ok';
  } catch {
    return 'down';
  }
}

export async function ensureAuthenticated(
  page: Page,
  env: Env,
  logger: pino.Logger
): Promise<'authenticated' | 'challenge' | 'auth_expired'> {
  const html = (await page.content()).toLowerCase();
  if (challengeDetected(html)) {
    logger.warn({ status: 'challenge_detected' }, 'Challenge page detected before auth check');
    return 'challenge';
  }

  const looksLoggedIn = await page.locator('text=Logout, text=Inbox, text=Messages').first().isVisible().catch(() => false);
  if (looksLoggedIn) {
    return 'authenticated';
  }

  const loginInput = page.locator('input[type="email"], input[name*="email" i], input[name*="user" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  if ((await loginInput.count()) === 0 || (await passwordInput.count()) === 0) {
    logger.error({ status: 'auth_expired' }, 'Unable to confirm authenticated state and login form not detected');
    return 'auth_expired';
  }

  await loginInput.fill(env.CRDTROVE_LOGIN);
  await passwordInput.fill(env.CRDTROVE_PASSWORD);

  await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")').first().click();
  await page.waitForTimeout(2500);

  const postHtml = (await page.content()).toLowerCase();
  if (challengeDetected(postHtml)) return 'challenge';

  await page.context().storageState({ path: env.SESSION_STATE_PATH });
  return 'authenticated';
}
