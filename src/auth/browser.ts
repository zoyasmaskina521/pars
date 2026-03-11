import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// Для stealth-режима установите: npm install playwright-extra puppeteer-extra-plugin-stealth
// и раскомментируйте строки ниже (также замените chromium на из playwright-extra)
// import { chromium } from 'playwright-extra';
// import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// chromium.use(StealthPlugin());

import type { Env } from '../config/env.js';
import type pino from 'pino';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

// Маркеры Cloudflare-капчи
const CHALLENGE_MARKERS = [
  'captcha',
  'cloudflare',
  'verify you are human',
  'attention required',
  'challenge',
  'cf-browser-verification',
  'cf-challenge',
];

function challengeDetected(content: string): boolean {
  const lower = content.toLowerCase();
  return CHALLENGE_MARKERS.some((m) => lower.includes(m));
}

/**
 * Проверяет наличие капчи на странице по селекторам и тексту.
 */
async function isCaptchaPresent(page: Page): Promise<boolean> {
  try {
    const body = await page.textContent('body').catch(() => '');
    if (challengeDetected(body)) return true;

    const cfSelectors = [
      '#cf-challenge-runner',
      '#turnstile-wrapper',
      'iframe[src*="challenges"]',
      '[data-sitekey]', // признак Turnstile
    ];
    for (const sel of cfSelectors) {
      if (await page.$(sel)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Пытается пройти капчу вручную: кликает по iframe и чекбоксу.
 * Возвращает true, если капча исчезла после попытки.
 */
async function tryManualCaptchaSolve(page: Page, logger: pino.Logger): Promise<boolean> {
  logger.info('Attempting manual captcha solve (click on iframe)');

  try {
    // Ищем iframe с капчей
    const frame = page.frames().find((f) => f.url().includes('challenges') || f.url().includes('turnstile'));
    if (frame) {
      // Пробуем кликнуть по чекбоксу внутри iframe
      await frame.click('#checkbox, .captcha-checkbox, [role="checkbox"]').catch(() => null);
      await page.waitForTimeout(3000); // ждём реакции

      // Проверяем, исчезла ли капча
      const stillPresent = await isCaptchaPresent(page);
      if (!stillPresent) {
        logger.info('Manual captcha solve succeeded');
        return true;
      }
    }

    // Альтернатива: клик по самому элементу страницы, если капча встроена
    await page.click('#cf-challenge-runner, #turnstile-wrapper').catch(() => null);
    await page.waitForTimeout(3000);

    const stillPresent = await isCaptchaPresent(page);
    if (!stillPresent) {
      logger.info('Manual captcha solve succeeded (direct click)');
      return true;
    }

    logger.warn('Manual captcha solve failed');
    return false;
  } catch (err) {
    logger.error({ err }, 'Error during manual captcha solve');
    return false;
  }
}

/**
 * Основная функция: если на странице обнаружена капча – пытаемся её пройти.
 * Возвращает true, если капча была успешно пройдена (или её не было).
 */
export async function handleCaptchaIfNeeded(
  page: Page,
  env: Env,
  logger: pino.Logger
): Promise<boolean> {
  const captchaPresent = await isCaptchaPresent(page);
  if (!captchaPresent) return true;

  logger.info('Captcha detected, attempting to solve...');

  // Сначала пробуем ручной метод
  const solved = await tryManualCaptchaSolve(page, logger);

  if (!solved) {
    logger.warn('Failed to solve captcha');
    return false;
  }

  // После успеха обновляем состояние страницы
  await page.waitForTimeout(2000);
  return true;
}

export async function createSession(env: Env, logger: pino.Logger): Promise<BrowserSession> {
  fs.mkdirSync(path.dirname(env.SESSION_STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: env.DIAGNOSTIC_HEADFUL ? false : env.HEADLESS,
    executablePath: env.CHROMIUM_EXECUTABLE_PATH,
    args: [
      '--disable-blink-features=AutomationControlled', // скрываем автоматизацию
      '--no-sandbox',
      '--disable-web-security', // иногда помогает с iframe
    ],
  });

  if (env.CHROMIUM_EXECUTABLE_PATH) {
    logger.info(
      { executablePath: env.CHROMIUM_EXECUTABLE_PATH },
      'Using custom Chromium executable path'
    );
  }

  const context = await browser.newContext({
    storageState: fs.existsSync(env.SESSION_STATE_PATH) ? env.SESSION_STATE_PATH : undefined,
    proxy: env.PROXY_SERVER
      ? {
          server: env.PROXY_SERVER,
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD,
        }
      : undefined,
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(env.NAV_TIMEOUT_MS);

  return { browser, context, page };
}

export async function detectSiteOrChallenge(
  page: Page,
  siteUrl: string,
  env: Env,
  logger: pino.Logger
): Promise<'ok' | 'challenge' | 'down'> {
  try {
    const response = await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
    if (!response) return 'down';

    // Проверяем капчу и пытаемся решить
    const captchaHandled = await handleCaptchaIfNeeded(page, env, logger);
    if (!captchaHandled) return 'challenge'; // не смогли решить

    // После решения (или если её не было) снова проверяем содержимое
    const html = await page.content();
    if (challengeDetected(html)) return 'challenge';

    const status = response.status();
    if (status >= 500 || status === 429 || status === 403) return 'down';

    return 'ok';
  } catch (error) {
    logger.error({ error }, 'detectSiteOrChallenge failed');
    return 'down';
  }
}

export async function ensureAuthenticated(
  page: Page,
  env: Env,
  logger: pino.Logger
): Promise<'authenticated' | 'challenge' | 'auth_expired'> {
  // Сначала проверяем/решаем капчу
  const captchaHandled = await handleCaptchaIfNeeded(page, env, logger);
  if (!captchaHandled) return 'challenge';

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
