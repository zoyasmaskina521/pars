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

export type BootstrapSessionStatus = 'success' | 'auth_expired' | 'challenge_detected' | 'manual_incomplete' | 'timeout';

const LOGIN_SELECTOR = 'input[type="email"], input[name*="email" i], input[name*="user" i]';
const PASSWORD_SELECTOR = 'input[type="password"]';
const SUBMIT_SELECTOR = 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")';
const AUTH_MARKER_SELECTOR = 'text=Logout, text=Inbox, text=Messages';
const LOADING_SELECTOR = '[aria-busy="true"], .loader, .spinner, [class*="loading" i], [class*="skeleton" i]';

const CHALLENGE_MARKERS = [
  'captcha',
  'cloudflare',
  'verify you are human',
  'attention required',
  'challenge',
  'cf-browser-verification',
  'cf-challenge'
];

const CHALLENGE_SELECTORS = ['#cf-challenge-runner', '#turnstile-wrapper', 'iframe[src*="challenges"]', '[data-sitekey]'];

function challengeDetected(content: string): boolean {
  const lower = content.toLowerCase();
  return CHALLENGE_MARKERS.some((m) => lower.includes(m));
}

async function isChallengePresent(page: Page): Promise<boolean> {
  const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
  if (challengeDetected(bodyText)) return true;

  for (const selector of CHALLENGE_SELECTORS) {
    const found = await page.locator(selector).first().count().catch(() => 0);
    if (found > 0) return true;
  }

  return false;
}

export async function persistSessionState(context: BrowserContext, sessionPath: string, logger: pino.Logger): Promise<void> {
  try {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    await context.storageState({ path: sessionPath });
  } catch (error) {
    logger.warn({ err: error }, 'Failed to persist session state');
  }
}

async function waitForLoginDomReady(page: Page, env: Env, logger: pino.Logger): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: env.AUTH_FORM_TIMEOUT_MS }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: Math.min(env.NAV_TIMEOUT_MS, env.AUTH_FORM_TIMEOUT_MS) }).catch(() => undefined);

  const loader = page.locator(LOADING_SELECTOR).first();
  await loader.waitFor({ state: 'hidden', timeout: Math.floor(env.AUTH_FORM_TIMEOUT_MS / 3) }).catch(() => {
    logger.debug('Loader did not disappear before auth timeout; proceeding with resilient locator checks');
  });
}

function createProxyConfig(env: Env) {
  return env.PROXY_SERVER
    ? {
        server: env.PROXY_SERVER,
        username: env.PROXY_USERNAME,
        password: env.PROXY_PASSWORD
      }
    : undefined;
}

function assertDisplayAvailable(env: Env): void {
  if (env.HEADLESS) {
    return;
  }

  const display = process.env.DISPLAY;
  if (!display) {
    throw new Error(
      'X display is not available. Set DISPLAY (and XAUTHORITY if needed) before running bootstrap-session in Linux/VNC mode.'
    );
  }
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
    proxy: createProxyConfig(env),
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(env.NAV_TIMEOUT_MS);

  return { browser, context, page };
}

export async function runManualSessionBootstrap(env: Env, logger: pino.Logger): Promise<BootstrapSessionStatus> {
  assertDisplayAvailable({ ...env, HEADLESS: false });
  fs.mkdirSync(path.dirname(env.SESSION_STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    executablePath: env.CHROMIUM_EXECUTABLE_PATH
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(env.SESSION_STATE_PATH) ? env.SESSION_STATE_PATH : undefined,
    proxy: createProxyConfig(env),
    viewport: { width: 1280, height: 720 }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(env.NAV_TIMEOUT_MS);

  try {
    const response = await page.goto(env.SITE_URL, { waitUntil: 'domcontentloaded' });
    if (!response || response.status() >= 500) {
      logger.warn({ statusCode: response?.status() }, 'Site did not load correctly during bootstrap; continuing to allow manual login');
    }

    await waitForLoginDomReady(page, env, logger);
    logger.info(
      {
        siteUrl: env.SITE_URL,
        sessionStatePath: env.SESSION_STATE_PATH,
        timeoutSec: env.BOOTSTRAP_TIMEOUT_SEC
      },
      'Manual bootstrap started: complete challenge/login in browser window'
    );

    const deadline = Date.now() + env.BOOTSTRAP_TIMEOUT_SEC * 1000;
    while (Date.now() < deadline) {
      const looksLoggedIn = await page.locator(AUTH_MARKER_SELECTOR).first().isVisible().catch(() => false);
      if (looksLoggedIn) {
        await persistSessionState(context, env.SESSION_STATE_PATH, logger);
        logger.info({ status: 'success', sessionStatePath: env.SESSION_STATE_PATH }, 'Manual bootstrap completed and session persisted');
        return 'success';
      }

      if (await isChallengePresent(page)) {
        logger.info({ status: 'challenge_detected' }, 'Challenge currently visible; waiting for operator to complete it');
      }

      const loginVisible = await page.locator(LOGIN_SELECTOR).first().isVisible().catch(() => false);
      const passwordVisible = await page.locator(PASSWORD_SELECTOR).first().isVisible().catch(() => false);

      if (!loginVisible && !passwordVisible && !(await isChallengePresent(page))) {
        logger.debug('Neither login form nor authenticated markers visible during bootstrap; waiting');
      }

      await page.waitForTimeout(env.BOOTSTRAP_POLL_INTERVAL_MS);
    }

    const finalLoggedIn = await page.locator(AUTH_MARKER_SELECTOR).first().isVisible().catch(() => false);
    if (finalLoggedIn) {
      await persistSessionState(context, env.SESSION_STATE_PATH, logger);
      return 'success';
    }

    const finalChallenge = await isChallengePresent(page);
    if (finalChallenge) return 'challenge_detected';

    const loginVisible = await page.locator(LOGIN_SELECTOR).first().isVisible().catch(() => false);
    const passwordVisible = await page.locator(PASSWORD_SELECTOR).first().isVisible().catch(() => false);
    if (loginVisible || passwordVisible) return 'manual_incomplete';

    const bodyText = (await page.textContent('body').catch(() => '')) ?? '';
    if (bodyText.trim().length > 0) return 'auth_expired';

    return 'timeout';
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

export async function detectSiteOrChallenge(page: Page, siteUrl: string): Promise<'ok' | 'challenge' | 'down'> {
  try {
    const response = await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
    if (!response) return 'down';
    const status = response.status();

    if (await isChallengePresent(page)) return 'challenge';

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
  await waitForLoginDomReady(page, env, logger);

  if (await isChallengePresent(page)) {
    logger.warn({ status: 'challenge_detected' }, 'Challenge page detected before auth check');
    return 'challenge';
  }

  const looksLoggedIn = await page.locator(AUTH_MARKER_SELECTOR).first().isVisible().catch(() => false);
  if (looksLoggedIn) {
    await persistSessionState(page.context(), env.SESSION_STATE_PATH, logger);
    return 'authenticated';
  }

  const loginInput = page.locator(LOGIN_SELECTOR).first();
  const passwordInput = page.locator(PASSWORD_SELECTOR).first();

  const loginVisible = await loginInput
    .waitFor({ state: 'visible', timeout: env.AUTH_FORM_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  const passwordVisible = await passwordInput
    .waitFor({ state: 'visible', timeout: env.AUTH_FORM_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);

  if (!loginVisible || !passwordVisible) {
    logger.error(
      { status: 'auth_expired', loginVisible, passwordVisible },
      'Login form did not become interactable within timeout; likely dynamic content or selector drift'
    );
    return 'auth_expired';
  }

  await loginInput.fill(env.CRDTROVE_LOGIN);
  await passwordInput.fill(env.CRDTROVE_PASSWORD);
  await page.locator(SUBMIT_SELECTOR).first().click();

  await page.waitForTimeout(env.POST_LOGIN_SETTLE_MS);
  await waitForLoginDomReady(page, env, logger);

  if (await isChallengePresent(page)) return 'challenge';

  const loggedInAfterSubmit = await page.locator(AUTH_MARKER_SELECTOR).first().isVisible().catch(() => false);
  if (!loggedInAfterSubmit) {
    logger.error({ status: 'auth_expired' }, 'Login submitted but authenticated markers not detected');
    return 'auth_expired';
  }

  await persistSessionState(page.context(), env.SESSION_STATE_PATH, logger);
  return 'authenticated';
}
