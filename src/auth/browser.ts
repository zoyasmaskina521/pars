import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import axios from 'axios'; // обязательно установить: npm install axios
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

/**
 * Решает Cloudflare капчу через CapSolver.
 * Автоматически определяет тип капчи и использует соответствующий тип задачи.
 * Возвращает true, если капча успешно решена.
 */
async function solveCloudflareCaptcha(
  page: Page,
  apiKey: string,
  logger: pino.Logger,
  env: Env
): Promise<boolean> {
  try {
    // --- Расширенный поиск sitekey (для Turnstile) ---
    const sitekey = await page.evaluate(() => {
      // 1. По data-sitekey
      const el = document.querySelector('[data-sitekey]');
      if (el) return el.getAttribute('data-sitekey');
      
      // 2. Глобальные переменные turnstile
      if ((window as any).turnstile?.sitekey) return (window as any).turnstile.sitekey;
      
      // 3. Переменные _cf
      if ((window as any)._cf?.turnstile?.sitekey) return (window as any)._cf.turnstile.sitekey;
      
      // 4. Поиск в скриптах (регулярное выражение)
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.innerHTML;
        const match = content.match(/sitekey["']?\s*:\s*["']([^"']+)/);
        if (match) return match[1];
      }
      return null;
    }).catch(() => null);

    const url = page.url();
    logger.info({ sitekey, url }, 'Attempting to solve Cloudflare challenge via CapSolver');

    // --- Определяем тип задачи ---
    let taskPayload: any;
    if (sitekey) {
      // Если нашли sitekey — используем Turnstile
      taskPayload = {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL: url,
        websiteKey: sitekey,
      };
    } else {
      // Иначе пробуем универсальную Cloudflare задачу
      taskPayload = {
        type: 'AntiCloudflareTask',
        websiteURL: url,
        // При необходимости можно указать метаданные:
        // metadata: { type: 'challenge' } 
      };
    }

    // --- Создаём задание в CapSolver ---
    const createRes = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: apiKey,
      task: taskPayload,
    });

    const taskId = createRes.data.taskId;
    if (!taskId) {
      logger.error({ response: createRes.data }, 'Failed to create captcha task');
      return false;
    }

    logger.info({ taskId, taskType: taskPayload.type }, 'Captcha task created');

    // --- Ожидаем решения (опрос каждые 2 сек, до 60 сек) ---
    let solved = false;
    let solution: any = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const getRes = await axios.post('https://api.capsolver.com/getTaskResult', {
        clientKey: apiKey,
        taskId,
      });
      if (getRes.data.status === 'ready') {
        solution = getRes.data.solution;
        solved = true;
        break;
      }
    }

    if (!solved) {
      logger.error('Captcha solving timeout');
      return false;
    }

    // --- Применяем решение в зависимости от типа задачи ---
    if (taskPayload.type === 'AntiTurnstileTaskProxyLess') {
      // Вставляем токен Turnstile
      const token = solution.token;
      await page.evaluate((t) => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input) input.setAttribute('value', t);
        if ((window as any).turnstileCallback) (window as any).turnstileCallback(t);
      }, token);
    } else if (taskPayload.type === 'AntiCloudflareTask') {
      // AntiCloudflareTask возвращает cookies для подстановки
      if (solution.cookies) {
        await page.context().addCookies(solution.cookies.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })));
      }
      // Перезагружаем страницу, чтобы cookies применились
      await page.reload({ waitUntil: 'domcontentloaded' });
    }

    // Пытаемся нажать кнопку подтверждения, если она есть
    await page.click('button[type="submit"]').catch(() => {});

    // Ждём исчезновения капчи
    await page
      .waitForSelector('#cf-challenge-runner, iframe[src*="challenges"], [data-sitekey]', {
        state: 'hidden',
        timeout: 10000,
      })
      .catch(() => {});

    logger.info('Captcha solved successfully');
    return true;
  } catch (err) {
    logger.error({ err }, 'Error solving captcha via CapSolver');
    return false;
  }
}

/**
 * Проверяет состояние сайта, автоматически решая капчу при обнаружении.
 */
export async function detectSiteOrChallenge(
  page: Page,
  siteUrl: string,
  env: Env,
  logger: pino.Logger
): Promise<'ok' | 'challenge' | 'down'> {
  try {
    const response = await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
    if (!response) return 'down';
    const status = response.status();

    if (await isChallengePresent(page)) {
      if (env.CAPTCHA_API_KEY) {
        const solved = await solveCloudflareCaptcha(page, env.CAPTCHA_API_KEY, logger, env);
        if (solved) {
          // После успешного решения проверяем ещё раз
          if (await isChallengePresent(page)) return 'challenge';
          return 'ok';
        }
      } else {
        logger.warn('CAPTCHA_API_KEY not set, cannot solve challenge automatically');
      }
      return 'challenge';
    }

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
  await waitForLoginDomReady(page, env, logger);

  if (await isChallengePresent(page)) {
    logger.warn({ status: 'challenge_detected' }, 'Challenge page detected before auth check');
    if (env.CAPTCHA_API_KEY) {
      const solved = await solveCloudflareCaptcha(page, env.CAPTCHA_API_KEY, logger, env);
      if (!solved) return 'challenge';
    } else {
      return 'challenge';
    }
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
