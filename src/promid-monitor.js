import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const DEFAULT_TIME_ZONE = 'Europe/Helsinki';
process.env.TZ ||= DEFAULT_TIME_ZONE;
const env = process.env;

const config = {
  timeZone: env.TZ,
  url: env.PROMID_URL || 'https://metropolia.promid.fi/',
  email: env.PROMID_EMAIL,
  password: env.PROMID_PASSWORD,
  headless: parseBoolean(env.PROMID_HEADLESS, false),
  dryRun: parseBoolean(env.PROMID_DRY_RUN, false),
  statePath: env.PROMID_LOGIN_STATE_PATH || '.auth/promid-state.json',
  runtimeStatePath: env.PROMID_RUNTIME_STATE_PATH || '.auth/promid-runtime-state.json',
  schedule: env.PROMID_SCHEDULE || '06:00=start,09:00=stop,17:00=start,19:00=lunch,19:30=start,22:30=stop',
  activeDays: parseActiveDays(env.PROMID_ACTIVE_DAYS || '1,2,3,4,5'),
  jitterMinutes: parseNonNegativeInteger(env.PROMID_TIME_JITTER_MINUTES, 0),
  retryDelaysSeconds: parseNonNegativeIntegerList(env.PROMID_RETRY_DELAYS_SECONDS || '0,60,180,300'),
  startTexts: splitList(env.PROMID_START_TEXTS || 'Sisään,Sisaan,Sign in'),
  lunchTexts: splitList(env.PROMID_LUNCH_TEXTS || 'Lounas,Lunch'),
  stopTexts: splitList(env.PROMID_STOP_TEXTS || 'Ulos,Sign out'),
  workingStatusTexts: splitList(env.PROMID_WORKING_STATUS_TEXTS || 'Signed in,Sisäänkirjautunut'),
  lunchStatusTexts: splitList(env.PROMID_LUNCH_STATUS_TEXTS || 'Lunch,Lounas'),
  signedOutStatusTexts: splitList(env.PROMID_SIGNED_OUT_STATUS_TEXTS || 'Signed out,Uloskirjautunut'),
  startSelector: env.PROMID_START_SELECTOR,
  lunchSelector: env.PROMID_LUNCH_SELECTOR,
  stopSelector: env.PROMID_STOP_SELECTOR,
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowedUsernames: parseUsernames(env.TELEGRAM_ALLOWED_USERNAMES || 'yehorte,yehortere,yehor_a'),
  telegramStatePath: env.TELEGRAM_STATE_PATH || '.auth/telegram-state.json',
  telegramDryRun: parseBoolean(env.TELEGRAM_DRY_RUN, false)
};

const args = process.argv.slice(2);
const onceIndex = args.indexOf('--once');
const onceAction = onceIndex >= 0 ? args[onceIndex + 1] : undefined;
const bootstrapSession = args.includes('--bootstrap-session');
const telegramUiSelfTest = args.includes('--telegram-ui-self-test');
const jitterOffsets = new Map();
const WORKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WORKDAY_LABELS = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday'
};
const WORKDAY_TO_DAY_NUMBER = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5
};
const DAY_NUMBER_TO_WORKDAY = Object.fromEntries(
  Object.entries(WORKDAY_TO_DAY_NUMBER).map(([key, value]) => [value, key])
);

let runtimeState = defaultRuntimeState();
let telegramState = defaultTelegramState();
let monitorWake;
let lastNextNoticeKey;
let actionQueue = Promise.resolve();
let actionQueueDepth = 0;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  if (telegramUiSelfTest) {
    runTelegramUiSelfTest();
    return;
  }

  validateConfig();
  runtimeState = await loadRuntimeState();
  telegramState = await loadTelegramState();

  if (bootstrapSession) {
    await bootstrapLoginSession();
    return;
  }

  if (onceAction) {
    if (!['start', 'lunch', 'stop'].includes(onceAction)) {
      throw new Error('Use --once start, --once lunch, or --once stop.');
    }

    await runExclusive(`once:${onceAction}`, () => runActionWithRetries(onceAction, {
      trigger: 'manual',
      source: 'cli'
    })).promise;
    return;
  }

  await emit(`Promid monitor started.
Fallback schedule: ${getFallbackSchedule()}
Active days: ${formatActiveDays(config.activeDays)}
Timezone: ${config.timeZone}
Automation: ${runtimeState.automationEnabled ? 'on' : 'off'}
Telegram: ${telegramModeLabel()}`);
  if (config.jitterMinutes > 0) {
    await emit(`Time jitter: +/- ${config.jitterMinutes} minutes.`);
  }

  void runTelegramPoller();
  await runMonitorLoop();
}

function validateConfig() {
  const missing = [];
  if (!config.email) missing.push('PROMID_EMAIL');
  if (!config.password) missing.push('PROMID_PASSWORD');
  if (missing.length) {
    throw new Error(`Missing required .env values: ${missing.join(', ')}`);
  }
  if (config.email === 'your.email@metropolia.fi' || config.password === 'your-password') {
    throw new Error('Update PROMID_EMAIL and PROMID_PASSWORD in .env before running.');
  }
  parseSchedule(config.schedule);
  if (!config.activeDays.size) {
    throw new Error('PROMID_ACTIVE_DAYS must include at least one day.');
  }
  if (![...config.activeDays].some((day) => day >= 1 && day <= 5)) {
    throw new Error('PROMID_ACTIVE_DAYS must include at least one weekday; weekends stay disabled.');
  }
  if (!config.retryDelaysSeconds.length) {
    throw new Error('PROMID_RETRY_DELAYS_SECONDS must include at least one delay.');
  }
}

async function runMonitorLoop() {
  while (true) {
    const next = getNextAction(new Date());
    const nextKey = next ? eventKey(next) : 'none';
    if (nextKey !== lastNextNoticeKey) {
      lastNextNoticeKey = nextKey;
      await emit(next
        ? `Next automatic action: ${next.action.toUpperCase()} at ${formatDateTime(next.at)}${formatJitter(next.jitterMinutes)}.`
        : 'No upcoming automatic actions found for the active weekdays.');
    }

    if (!next) {
      await waitUntil(addMinutes(new Date(), 60));
      continue;
    }

    const waitResult = await waitUntil(next.at);
    if (waitResult === 'woken') {
      continue;
    }

    if (!runtimeState.automationEnabled) {
      const result = {
        status: 'skipped',
        action: next.action,
        reason: 'automation is turned off',
        previousState: 'unknown',
        finalState: 'unknown',
        attempts: 0
      };
      await emit(`Skipped automatic ${next.action.toUpperCase()}: automation is turned off.`);
      await recordAction(result, autoContext(next));
      await maybeSendDailyReport(next);
      continue;
    }

    const queued = runExclusive(`auto:${next.action}`, () => runActionWithRetries(next.action, autoContext(next)));
    await queued.promise;
    await maybeSendDailyReport(next);
  }
}

function autoContext(next) {
  return {
    trigger: 'auto',
    source: 'schedule',
    scheduledAt: next.at,
    baseAt: next.baseAt,
    jitterMinutes: next.jitterMinutes,
    scheduleSource: next.scheduleSource,
    dayKey: next.dayKey
  };
}

async function openSession() {
  const storageState = await fileExists(config.statePath) ? config.statePath : undefined;
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();

  await ensureLoggedIn(page, context);
  return { browser, context, page };
}

async function bootstrapLoginSession() {
  let session;
  try {
    session = await openSession();
    await safeGoto(session.page, config.url);
    await session.page.waitForLoadState('networkidle').catch(() => {});
    const state = await detectPromidState(session.page);
    await session.context.storageState({ path: config.statePath });
    await emit(`Saved Promid session to ${config.statePath}. Current state: ${state.name} (${state.reason}).`);
  } finally {
    if (session) {
      await session.browser.close().catch(() => {});
    }
  }
}

async function runActionWithRetries(action, context = {}) {
  let lastError;
  let lastResult;

  for (let attempt = 0; attempt < config.retryDelaysSeconds.length; attempt += 1) {
    const delaySeconds = config.retryDelaysSeconds[attempt];
    if (delaySeconds > 0) {
      await emit(`Retrying ${action.toUpperCase()} in ${delaySeconds} seconds.`);
      await sleep(delaySeconds * 1000);
    }

    let session;
    try {
      await emit(`Running ${action.toUpperCase()} attempt ${attempt + 1}/${config.retryDelaysSeconds.length} (${context.trigger || 'manual'}).`);
      session = await openSession();
      lastResult = await performAction(session.page, action, attempt + 1);
      await recordAction(lastResult, context);
      await emit(formatActionResult(lastResult));
      return lastResult;
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) {
        lastResult = {
          status: 'skipped',
          action,
          reason: formatError(error),
          previousState: 'unknown',
          finalState: 'unknown',
          attempts: attempt + 1
        };
        await recordAction(lastResult, context);
        await emit(formatActionResult(lastResult));
        return lastResult;
      }
      await emit(`Attempt ${attempt + 1}/${config.retryDelaysSeconds.length} failed: ${formatError(error)}`);
    } finally {
      if (session) {
        await session.browser.close().catch(() => {});
      }
    }
  }

  lastResult = {
    status: 'failed',
    action,
    reason: formatError(lastError),
    previousState: 'unknown',
    finalState: 'unknown',
    attempts: config.retryDelaysSeconds.length
  };
  await recordAction(lastResult, context);
  await emit(formatActionResult(lastResult));
  return lastResult;
}

async function ensureLoggedIn(page, context) {
  await safeGoto(page, config.url);

  const adfsButton = page.getByRole('button', { name: 'ADFS kirjautuminen' });
  if (await isVisible(adfsButton)) {
    await adfsButton.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  const userField = await findVisibleLocator(page, adfsUserLocators(page), 30_000);
  if (userField) {
    const passwordField = await findVisibleLocator(page, adfsPasswordLocators(page), 10_000);
    const signInButton = await findVisibleLocator(page, adfsSubmitLocators(page), 10_000);
    if (!passwordField || !signInButton) {
      throw retryableError(`ADFS login form is incomplete. Current URL: ${page.url()}`);
    }

    await userField.fill(config.email);
    await passwordField.fill(config.password);
    await signInButton.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    await emit('If your organization requires MFA, complete it in the browser window.');
    await waitForPromidOrAdfsCompletion(page, 120_000);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  if (!/promid\.fi/i.test(page.url())) {
    throw retryableError(adfsHelpMessage(page.url()));
  }

  const stillOnPromidLogin = page.getByRole('button', { name: 'ADFS kirjautuminen' });
  const stillOnAdfsLogin = await findVisibleLocator(page, adfsUserLocators(page), 1000);
  if (await isVisible(stillOnPromidLogin) || await isVisible(stillOnAdfsLogin)) {
    throw retryableError(adfsHelpMessage(page.url()));
  }

  await fs.mkdir(path.dirname(config.statePath), { recursive: true });
  await context.storageState({ path: config.statePath });
}

async function performAction(page, action, attempts) {
  await safeGoto(page, config.url);
  await page.waitForLoadState('networkidle').catch(() => {});

  const state = await detectPromidState(page);
  const decision = decideAction(action, state);
  if (decision.type === 'skip') {
    return {
      status: 'skipped',
      action,
      reason: decision.reason,
      previousState: state.name,
      finalState: state.name,
      attempts
    };
  }

  const locator = await findActionLocator(page, action);

  if (config.dryRun) {
    return {
      status: 'dry-run',
      action,
      reason: 'dry-run mode, no click performed',
      previousState: state.name,
      finalState: state.name,
      attempts
    };
  }

  await locator.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  const finalState = await detectPromidState(page);
  return {
    status: 'clicked',
    action,
    reason: 'button clicked',
    previousState: state.name,
    finalState: finalState.name,
    attempts
  };
}

async function inspectPromidState() {
  let session;
  try {
    session = await openSession();
    await safeGoto(session.page, config.url);
    await session.page.waitForLoadState('networkidle').catch(() => {});
    return await detectPromidState(session.page);
  } finally {
    if (session) {
      await session.browser.close().catch(() => {});
    }
  }
}

async function safeGoto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!String(error).includes('net::ERR_ABORTED')) {
      throw error;
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }
}

function adfsUserLocators(page) {
  return [
    page.getByLabel('User Account'),
    page.getByPlaceholder('someone@example.com'),
    page.locator('input#userNameInput'),
    page.locator('input[name="UserName"]'),
    page.locator('input[type="email"]'),
    page.locator('input[type="text"]')
  ];
}

function adfsPasswordLocators(page) {
  return [
    page.getByLabel('Password'),
    page.locator('input#passwordInput'),
    page.locator('input[name="Password"]'),
    page.locator('input[type="password"]')
  ];
}

function adfsSubmitLocators(page) {
  return [
    page.getByRole('button', { name: 'Sign in' }),
    page.locator('input#submitButton'),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]')
  ];
}

async function findVisibleLocator(page, locators, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    for (const locator of locators) {
      if (await isVisible(locator)) {
        return locator;
      }
    }
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function waitForPromidOrAdfsCompletion(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (/promid\.fi/i.test(page.url())) return;

    const userField = await findVisibleLocator(page, adfsUserLocators(page), 500);
    const passwordField = await findVisibleLocator(page, adfsPasswordLocators(page), 500);
    if (userField && passwordField) {
      const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      if (/incorrect|invalid|failed|virhe|väär/i.test(bodyText)) {
        throw retryableError(`ADFS did not accept the login. Check PROMID_EMAIL/PROMID_PASSWORD or complete first login interactively.`);
      }
    }

    await page.waitForTimeout(1000);
  }
}

function adfsHelpMessage(currentUrl) {
  if (/adfs\.metropolia\.fi/i.test(currentUrl)) {
    return `ADFS login did not complete. The server may need a saved browser session or MFA/first-login bootstrap. Run npm run bootstrap:session locally with PROMID_HEADLESS=false, complete login, then copy .auth/promid-state.json to the server. Current URL: ${currentUrl}`;
  }
  return `Login did not reach the Promid stamping page. Current URL: ${currentUrl}`;
}

async function findActionLocator(page, action) {
  const locator = await findOptionalActionLocator(page, action);
  if (locator) return locator;

  const visibleControls = await page
    .locator('button, [role="button"]')
    .evaluateAll((elements) =>
      elements
        .map((element) => element.textContent?.trim())
        .filter(Boolean)
        .slice(0, 40)
    );

  throw new Error(
    `Could not find ${action} control. Update PROMID_${action.toUpperCase()}_TEXTS or PROMID_${action.toUpperCase()}_SELECTOR.\n` +
    `Visible controls included: ${visibleControls.join(' | ')}`
  );
}

async function findOptionalActionLocator(page, action) {
  const selector = getActionConfig(action).selector;
  if (selector) {
    const locator = page.locator(selector);
    if (await locator.count()) return locator.first();
  }

  const texts = getActionConfig(action).texts;
  for (const text of texts) {
    const locator = page.getByRole('button', { name: text, exact: false });
    if (await locator.count()) return locator.first();
  }

  return undefined;
}

async function detectPromidState(page) {
  const controls = {
    start: Boolean(await findOptionalActionLocator(page, 'start')),
    lunch: Boolean(await findOptionalActionLocator(page, 'lunch')),
    stop: Boolean(await findOptionalActionLocator(page, 'stop'))
  };

  const pageText = normalizeText(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
  const matches = {
    working: textMatchesAny(pageText, config.workingStatusTexts),
    lunch: textMatchesAny(pageText, config.lunchStatusTexts),
    signedOut: textMatchesAny(pageText, config.signedOutStatusTexts)
  };

  if ((matches.working && (controls.lunch || controls.stop)) || (controls.lunch && controls.stop)) {
    return { name: 'working', controls, reason: 'working status/buttons are visible' };
  }
  if (matches.lunch && controls.start) {
    return { name: 'lunch', controls, reason: 'lunch status and return button are visible' };
  }
  if ((matches.signedOut && controls.start && !controls.lunch) || (controls.start && !controls.lunch && !controls.stop)) {
    return { name: 'signed_out', controls, reason: 'only start button is visible' };
  }
  if (matches.working) {
    return { name: 'working', controls, reason: 'working status text is visible' };
  }
  if (matches.lunch) {
    return { name: 'lunch', controls, reason: 'lunch status text is visible' };
  }
  if (matches.signedOut) {
    return { name: 'signed_out', controls, reason: 'signed-out status text is visible' };
  }

  return {
    name: 'unknown',
    controls,
    reason: `visible controls start=${controls.start}, lunch=${controls.lunch}, stop=${controls.stop}`
  };
}

function decideAction(action, state) {
  if (state.name === 'unknown') {
    throw retryableError(`Promid state is unknown; ${action} is not safe.`);
  }

  const transitions = {
    start: {
      working: { type: 'skip', reason: 'already working' },
      lunch: { type: 'click' },
      signed_out: { type: 'click' }
    },
    lunch: {
      working: { type: 'click' },
      lunch: { type: 'skip', reason: 'already on lunch' },
      signed_out: { type: 'skip', reason: 'cannot start lunch while signed out' }
    },
    stop: {
      working: { type: 'click' },
      lunch: { type: 'skip', reason: 'currently on lunch; stop is not a valid safe transition' },
      signed_out: { type: 'skip', reason: 'already signed out' }
    }
  };

  return transitions[action][state.name];
}

function runExclusive(label, task) {
  const queued = actionQueueDepth > 0;
  actionQueueDepth += 1;
  const promise = actionQueue
    .catch(() => {})
    .then(async () => {
      if (queued) {
        await emit(`${label} queued until the current browser action finishes.`);
      }
      return task();
    })
    .finally(() => {
      actionQueueDepth -= 1;
    });
  actionQueue = promise.catch(() => {});
  return { queued, promise };
}

async function runTelegramPoller() {
  if (!config.telegramToken && !config.telegramDryRun) {
    console.log('Telegram disabled: TELEGRAM_BOT_TOKEN is not set.');
    return;
  }
  if (config.telegramDryRun) {
    console.log('Telegram dry-run enabled: outgoing messages are logged, not sent.');
  }
  if (!config.telegramToken) {
    return;
  }

  while (true) {
    try {
      const updates = await telegramApi('getUpdates', {
        offset: telegramState.offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query']
      });

      for (const update of updates) {
        await handleTelegramUpdate(update);
        telegramState.offset = update.update_id + 1;
        await saveTelegramState();
      }
    } catch (error) {
      console.log(`Telegram polling error: ${formatError(error)}`);
      await sleep(5000);
    }
  }
}

async function handleTelegramUpdate(update) {
  if (update.callback_query) {
    await handleTelegramCallback(update.callback_query);
    return;
  }

  if (update.message) {
    await handleTelegramMessage(update.message);
  }
}

async function handleTelegramMessage(message) {
  if (!message?.chat?.id || !message.from) return;

  const username = normalizeUsername(message.from.username || '');
  if (!config.telegramAllowedUsernames.has(username)) {
    console.log(`Ignored Telegram message from unauthorized user: ${username || 'unknown'}`);
    return;
  }

  registerTelegramChat(message.chat.id, username);
  await saveTelegramState();

  const text = (message.text || '').trim();
  if (!text.startsWith('/')) {
    await showMainMenu(message.chat.id);
    return;
  }

  const firstSpace = text.indexOf(' ');
  const commandText = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const command = commandText.split('@')[0].toLowerCase();
  const commandArgs = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();

  await handleTelegramCommand(message.chat.id, username, command, commandArgs);
}

async function handleTelegramCommand(chatId, username, command, argsText) {
  switch (command) {
    case '/start':
    case '/help':
      await showMainMenu(chatId);
      return;
    case '/status':
      await handleStatusCommand(chatId);
      return;
    case '/startwork':
      await handleManualActionCommand(chatId, username, 'start');
      return;
    case '/lunch':
      await handleManualActionCommand(chatId, username, 'lunch');
      return;
    case '/stopwork':
      await handleManualActionCommand(chatId, username, 'stop');
      return;
    case '/turnon':
      await setAutomationEnabled(username, true);
      await showMainMenu(chatId);
      return;
    case '/turnoff':
      await setAutomationEnabled(username, false);
      await showMainMenu(chatId);
      return;
    case '/schedule':
      await showScheduleMenu(chatId);
      return;
    case '/setschedule':
      await handleSetScheduleCommand(chatId, username, argsText);
      return;
    case '/resetschedule':
      runtimeState.scheduleOverride = null;
      await persistScheduleChange();
      await emit(`Fallback schedule reset to .env by @${username}. Active fallback: ${getFallbackSchedule()}`);
      await showScheduleMenu(chatId);
      return;
    case '/setdayschedule':
      await handleSetDayScheduleCommand(chatId, username, argsText);
      return;
    case '/cleardayschedule':
      await handleClearDayScheduleCommand(chatId, username, argsText);
      return;
    case '/resetweekschedule':
      runtimeState.weeklyScheduleOverride = {};
      await persistScheduleChange();
      await emit(`Weekly schedule override reset by @${username}.`);
      await showScheduleMenu(chatId);
      return;
    case '/report':
      await sendTelegramMessage(chatId, buildDailyReport(dateKey(new Date()), false));
      return;
    default:
      await sendTelegramMessage(chatId, `Unknown command: ${command}\n\n${commandHelp()}`, {
        replyMarkup: mainMenuKeyboard()
      });
  }
}

async function handleStatusCommand(chatId) {
  await sendTelegramMessage(chatId, await buildStatusText(), {
    replyMarkup: mainMenuKeyboard()
  });
}

async function buildStatusText() {
  const next = getNextAction(new Date());
  const today = getScheduleForDate(new Date());
  const statusLines = [
    `Automation: ${runtimeState.automationEnabled ? 'on' : 'off'}`,
    `Dry-run: ${config.dryRun ? 'on' : 'off'}`,
    `Timezone: ${config.timeZone}`,
    `Today: ${formatScheduleForDisplay(today.schedule)} (${today.source})`,
    `Next event: ${formatNextEvent(next)}`
  ];

  const stateCheck = runExclusive('status', inspectPromidState);
  if (stateCheck.queued) {
    statusLines.push('Promid state: queued behind current action');
  }

  try {
    const state = await stateCheck.promise;
    statusLines.push(`Promid state: ${state.name} (${state.reason})`);
  } catch (error) {
    statusLines.push(`Promid state: unavailable (${formatError(error)})`);
  }

  return statusLines.join('\n');
}

async function handleManualActionCommand(chatId, username, action) {
  await sendTelegramMessage(chatId, `Accepted ${action.toUpperCase()} command from @${username}.`);
  const queued = runExclusive(`telegram:${action}`, () => runActionWithRetries(action, {
    trigger: 'telegram',
    source: `@${username}`
  }));
  if (queued.queued) {
    await sendTelegramMessage(chatId, `${action.toUpperCase()} is queued behind another browser action.`);
  }
  void queued.promise.catch((error) => emit(`Telegram ${action} command failed: ${formatError(error)}`));
}

async function handleSetScheduleCommand(chatId, username, argsText) {
  if (!argsText) {
    await sendTelegramMessage(chatId, 'Usage: /setschedule 06:00=start,09:00=stop,17:00=start');
    return;
  }

  try {
    argsText = normalizeScheduleString(argsText);
  } catch (error) {
    await sendTelegramMessage(chatId, `Invalid schedule: ${formatError(error)}`);
    return;
  }

  runtimeState.scheduleOverride = argsText;
  await persistScheduleChange();
  await emit(`Fallback schedule override set by @${username}: ${argsText}`);
  await showScheduleMenu(chatId);
}

async function handleSetDayScheduleCommand(chatId, username, argsText) {
  const firstSpace = argsText.indexOf(' ');
  if (firstSpace === -1) {
    await sendTelegramMessage(chatId, 'Usage: /setdayschedule mon 06:00=start,09:00=stop');
    return;
  }

  const dayKey = parseWorkdayKey(argsText.slice(0, firstSpace));
  if (!dayKey) {
    await sendTelegramMessage(chatId, 'Choose a weekday: mon, tue, wed, thu, or fri.');
    return;
  }

  const scheduleText = argsText.slice(firstSpace + 1).trim();
  try {
    setWeeklyDaySchedule(dayKey, scheduleText);
  } catch (error) {
    await sendTelegramMessage(chatId, `Invalid ${WORKDAY_LABELS[dayKey]} schedule: ${formatError(error)}`);
    return;
  }

  await persistScheduleChange();
  await emit(`${WORKDAY_LABELS[dayKey]} schedule set by @${username}: ${formatScheduleForDisplay(getScheduleForDayKey(dayKey).schedule)}`);
  await showDayEditor(chatId, dayKey);
}

async function handleClearDayScheduleCommand(chatId, username, argsText) {
  const dayKey = parseWorkdayKey(argsText);
  if (!dayKey) {
    await sendTelegramMessage(chatId, 'Usage: /cleardayschedule mon');
    return;
  }

  setWeeklyDaySchedule(dayKey, '');
  await persistScheduleChange();
  await emit(`${WORKDAY_LABELS[dayKey]} cleared by @${username}; no automatic events will run that day.`);
  await showDayEditor(chatId, dayKey);
}

async function handleTelegramCallback(callback) {
  const chatId = callback.message?.chat?.id;
  if (!chatId || !callback.from) return;

  const username = normalizeUsername(callback.from.username || '');
  if (!config.telegramAllowedUsernames.has(username)) {
    console.log(`Ignored Telegram button from unauthorized user: ${username || 'unknown'}`);
    await answerTelegramCallback(callback.id, 'Not authorized').catch(() => {});
    return;
  }

  registerTelegramChat(chatId, username);
  await saveTelegramState();
  await answerTelegramCallback(callback.id).catch((error) => {
    console.log(`Telegram callback answer failed: ${formatError(error)}`);
  });

  try {
    await routeTelegramCallback(callback, username);
  } catch (error) {
    await respondToCallback(callback, `Could not handle that button safely: ${formatError(error)}`, mainMenuKeyboard());
  }
}

async function routeTelegramCallback(callback, username) {
  const data = callback.data || '';
  const parts = data.split(':');
  const chatId = callback.message.chat.id;

  if (data === 'main') {
    setTelegramSession(chatId, { menu: 'main' });
    await saveTelegramState();
    await respondToCallback(callback, mainMenuText(), mainMenuKeyboard());
    return;
  }

  if (data === 'status') {
    await respondToCallback(callback, await buildStatusText(), mainMenuKeyboard());
    return;
  }

  if (data === 'auto:toggle') {
    await setAutomationEnabled(username, !runtimeState.automationEnabled);
    await respondToCallback(callback, mainMenuText(), mainMenuKeyboard());
    return;
  }

  if (data === 'report:today') {
    await sendTelegramMessage(chatId, buildDailyReport(dateKey(new Date()), false));
    return;
  }

  if (parts[0] === 'act') {
    const action = parts[1];
    if (!['start', 'lunch', 'stop'].includes(action)) throw new Error('Unknown action.');
    await handleManualActionCommand(chatId, username, action);
    return;
  }

  if (data === 'sched:menu' || data === 'sched:view') {
    setTelegramSession(chatId, { menu: 'schedule' });
    await saveTelegramState();
    await respondToCallback(callback, scheduleMenuText(), scheduleMenuKeyboard());
    return;
  }

  if (data === 'sched:resetweek') {
    runtimeState.weeklyScheduleOverride = {};
    await persistScheduleChange();
    await emit(`Weekly schedule override reset by @${username}.`);
    await respondToCallback(callback, scheduleMenuText(), scheduleMenuKeyboard());
    return;
  }

  if (parts[0] === 'day') {
    await handleDayCallback(callback, username, parts);
    return;
  }

  if (parts[0] === 'addact' || parts[0] === 'addhour' || parts[0] === 'addmin') {
    await handleAddEventCallback(callback, username, parts);
    return;
  }

  if (parts[0] === 'del') {
    await handleDeleteEventCallback(callback, username, parts);
    return;
  }

  throw new Error('Unknown button.');
}

async function handleDayCallback(callback, username, parts) {
  const [, command, rawDayKey] = parts;
  const chatId = callback.message.chat.id;
  const dayKey = requireWorkdayKey(rawDayKey);

  if (command === 'edit') {
    setTelegramSession(chatId, { menu: 'day', selectedDay: dayKey });
    await saveTelegramState();
    await respondToCallback(callback, dayEditorText(dayKey), dayEditorKeyboard(dayKey));
    return;
  }

  if (command === 'add') {
    setTelegramSession(chatId, { menu: 'day', flow: 'add_event', selectedDay: dayKey });
    await saveTelegramState();
    await respondToCallback(callback, addActionText(dayKey), addActionKeyboard(dayKey));
    return;
  }

  if (command === 'delete') {
    setTelegramSession(chatId, { menu: 'day', flow: 'delete_event', selectedDay: dayKey });
    await saveTelegramState();
    await respondToCallback(callback, deleteEventText(dayKey), deleteEventKeyboard(dayKey));
    return;
  }

  if (command === 'copy') {
    if (dayKey === 'mon') {
      await respondToCallback(callback, dayEditorText(dayKey), dayEditorKeyboard(dayKey));
      return;
    }
    setWeeklyDaySchedule(dayKey, getScheduleForDayKey('mon').schedule);
    await persistScheduleChange();
    await emit(`${WORKDAY_LABELS[dayKey]} copied from Monday by @${username}.`);
    await respondToCallback(callback, dayEditorText(dayKey), dayEditorKeyboard(dayKey));
    return;
  }

  if (command === 'clear') {
    setWeeklyDaySchedule(dayKey, '');
    await persistScheduleChange();
    await emit(`${WORKDAY_LABELS[dayKey]} cleared by @${username}; no automatic events will run that day.`);
    await respondToCallback(callback, dayEditorText(dayKey), dayEditorKeyboard(dayKey));
    return;
  }

  if (command === 'save') {
    setTelegramSession(chatId, { menu: 'schedule' });
    await saveTelegramState();
    await respondToCallback(callback, scheduleMenuText(), scheduleMenuKeyboard());
    return;
  }

  throw new Error('Unknown day action.');
}

async function handleAddEventCallback(callback, username, parts) {
  const chatId = callback.message.chat.id;
  const section = parts[0];
  const dayKey = requireWorkdayKey(parts[1]);
  const session = getTelegramSession(chatId);

  if (section === 'addact') {
    const action = parts[2];
    if (!['start', 'lunch', 'stop'].includes(action)) throw new Error('Unknown action.');
    setTelegramSession(chatId, { menu: 'day', flow: 'add_event', selectedDay: dayKey, pendingAction: action });
    await saveTelegramState();
    await respondToCallback(callback, addHourText(dayKey, action), addHourKeyboard(dayKey));
    return;
  }

  if (section === 'addhour') {
    const action = session.pendingAction;
    if (!['start', 'lunch', 'stop'].includes(action)) {
      await respondToCallback(callback, addActionText(dayKey), addActionKeyboard(dayKey));
      return;
    }
    const hour = Number(parts[2]);
    validateTime(hour, 0, 'selected hour');
    setTelegramSession(chatId, { ...session, menu: 'day', flow: 'add_event', selectedDay: dayKey, pendingHour: hour });
    await saveTelegramState();
    await respondToCallback(callback, addMinuteText(dayKey, action, hour), addMinuteKeyboard(dayKey));
    return;
  }

  if (section === 'addmin') {
    const action = session.pendingAction;
    const hour = session.pendingHour;
    if (!['start', 'lunch', 'stop'].includes(action) || !Number.isInteger(hour)) {
      await respondToCallback(callback, addActionText(dayKey), addActionKeyboard(dayKey));
      return;
    }
    const minute = Number(parts[2]);
    validateTime(hour, minute, 'selected time');
    if (minute % 5 !== 0) throw new Error('Minutes must use 5-minute steps.');

    const added = addWeeklyDayEvent(dayKey, { action, time: { hour, minute } });
    await persistScheduleChange();
    setTelegramSession(chatId, { menu: 'day', selectedDay: dayKey });
    await saveTelegramState();
    await emit(`${WORKDAY_LABELS[dayKey]} event added by @${username}: ${formatEvent(added)}`);
    await respondToCallback(callback, dayEditorText(dayKey), dayEditorKeyboard(dayKey));
    return;
  }

  throw new Error('Unknown add-event step.');
}

async function handleDeleteEventCallback(callback, username, parts) {
  const chatId = callback.message.chat.id;
  const dayKey = requireWorkdayKey(parts[1]);
  const index = Number(parts[2]);
  const removed = deleteWeeklyDayEvent(dayKey, index);
  await persistScheduleChange();
  setTelegramSession(chatId, { menu: 'day', selectedDay: dayKey });
  await saveTelegramState();
  await emit(`${WORKDAY_LABELS[dayKey]} event deleted by @${username}: ${formatEvent(removed)}`);
  await respondToCallback(callback, dayEditorText(dayKey), dayEditorKeyboard(dayKey));
}

async function setAutomationEnabled(username, enabled) {
  runtimeState.automationEnabled = enabled;
  await saveRuntimeState();
  wakeMonitorLoop();
  await emit(`Automatic schedule turned ${enabled ? 'ON' : 'OFF'} by @${username}.`);
}

async function showMainMenu(chatId) {
  setTelegramSession(chatId, { menu: 'main' });
  await saveTelegramState();
  await sendTelegramMessage(chatId, mainMenuText(), {
    replyMarkup: mainMenuKeyboard()
  });
}

async function showScheduleMenu(chatId) {
  setTelegramSession(chatId, { menu: 'schedule' });
  await saveTelegramState();
  await sendTelegramMessage(chatId, scheduleMenuText(), {
    replyMarkup: scheduleMenuKeyboard()
  });
}

async function showDayEditor(chatId, dayKey) {
  setTelegramSession(chatId, { menu: 'day', selectedDay: dayKey });
  await saveTelegramState();
  await sendTelegramMessage(chatId, dayEditorText(dayKey), {
    replyMarkup: dayEditorKeyboard(dayKey)
  });
}

function mainMenuText() {
  const today = getScheduleForDate(new Date());
  return [
    'Promid Manager',
    `Automation: ${runtimeState.automationEnabled ? 'on' : 'off'}`,
    `Dry-run: ${config.dryRun ? 'on' : 'off'}`,
    `Today: ${formatScheduleForDisplay(today.schedule)} (${today.source})`,
    `Next: ${formatNextEvent(getNextAction(new Date()))}`,
    '',
    'Use the buttons below.'
  ].join('\n');
}

function mainMenuKeyboard() {
  return inlineKeyboard([
    [button('Status', 'status')],
    [button('Start Work', 'act:start'), button('Lunch', 'act:lunch'), button('Stop Work', 'act:stop')],
    [button(runtimeState.automationEnabled ? 'Turn Auto Off' : 'Turn Auto On', 'auto:toggle')],
    [button('Schedule', 'sched:menu'), button('Report', 'report:today')]
  ]);
}

function scheduleMenuText() {
  return [
    'Schedule',
    `Fallback: ${getFallbackSchedule()} (${runtimeState.scheduleOverride ? 'Telegram override' : '.env'})`,
    '',
    formatWeeklySchedule()
  ].join('\n');
}

function scheduleMenuKeyboard() {
  return inlineKeyboard([
    [button('View Week', 'sched:view')],
    [button('Edit Monday', 'day:edit:mon'), button('Edit Tuesday', 'day:edit:tue')],
    [button('Edit Wednesday', 'day:edit:wed'), button('Edit Thursday', 'day:edit:thu')],
    [button('Edit Friday', 'day:edit:fri')],
    [button('Reset Week Override', 'sched:resetweek')],
    [button('Back', 'main')]
  ]);
}

function dayEditorText(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const info = getScheduleForDayKey(safeDayKey);
  const events = info.schedule ? parseSchedule(info.schedule) : [];
  const lines = [
    WORKDAY_LABELS[safeDayKey],
    `Source: ${info.custom ? 'custom weekday schedule' : info.source}`,
    `Schedule: ${formatScheduleForDisplay(info.schedule)}`
  ];

  if (events.length) {
    lines.push('');
    lines.push(...events.map((event, index) => `${index + 1}. ${formatEvent(event)}`));
  }

  return lines.join('\n');
}

function dayEditorKeyboard(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const rows = [
    [button('Add Event', `day:add:${safeDayKey}`), button('Delete Event', `day:delete:${safeDayKey}`)]
  ];
  if (safeDayKey !== 'mon') {
    rows.push([button('Copy From Monday', `day:copy:${safeDayKey}`)]);
  }
  rows.push([button('Clear Day', `day:clear:${safeDayKey}`), button('Save', `day:save:${safeDayKey}`)]);
  rows.push([button('Back', 'sched:menu')]);
  return inlineKeyboard(rows);
}

function addActionText(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  return `${WORKDAY_LABELS[safeDayKey]}: choose event action.`;
}

function addActionKeyboard(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  return inlineKeyboard([
    [
      button('Start', `addact:${safeDayKey}:start`),
      button('Lunch', `addact:${safeDayKey}:lunch`),
      button('Stop', `addact:${safeDayKey}:stop`)
    ],
    [button('Back', `day:edit:${safeDayKey}`)]
  ]);
}

function addHourText(dayKey, action) {
  const safeDayKey = requireWorkdayKey(dayKey);
  return `${WORKDAY_LABELS[safeDayKey]} ${action.toUpperCase()}: choose hour.`;
}

function addHourKeyboard(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const rows = [];
  for (let hour = 0; hour < 24; hour += 6) {
    rows.push([0, 1, 2, 3, 4, 5].map((offset) => button(pad2(hour + offset), `addhour:${safeDayKey}:${hour + offset}`)));
  }
  rows.push([button('Back', `day:add:${safeDayKey}`)]);
  return inlineKeyboard(rows);
}

function addMinuteText(dayKey, action, hour) {
  const safeDayKey = requireWorkdayKey(dayKey);
  return `${WORKDAY_LABELS[safeDayKey]} ${action.toUpperCase()} at ${pad2(hour)}: choose minute.`;
}

function addMinuteKeyboard(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const rows = [];
  for (let minute = 0; minute < 60; minute += 20) {
    rows.push([0, 5, 10, 15].map((offset) => button(pad2(minute + offset), `addmin:${safeDayKey}:${minute + offset}`)));
  }
  rows.push([button('Back', `day:add:${safeDayKey}`)]);
  return inlineKeyboard(rows);
}

function deleteEventText(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const events = parseEditableDayEvents(safeDayKey);
  if (!events.length) {
    return `${WORKDAY_LABELS[safeDayKey]} has no events to delete.`;
  }
  return `${WORKDAY_LABELS[safeDayKey]}: choose event to delete.`;
}

function deleteEventKeyboard(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const events = parseEditableDayEvents(safeDayKey);
  const rows = events.map((event, index) => [button(formatEvent(event), `del:${safeDayKey}:${index}`)]);
  rows.push([button('Back', `day:edit:${safeDayKey}`)]);
  return inlineKeyboard(rows);
}

function inlineKeyboard(inlineKeyboardRows) {
  return {
    inline_keyboard: inlineKeyboardRows
  };
}

function button(text, callbackData) {
  return {
    text,
    callback_data: callbackData
  };
}

function commandHelp() {
  return [
    'Promid Manager',
    'Use the buttons below for normal control.',
    '',
    'Hidden typed shortcuts still work:',
    '/status, /startwork, /lunch, /stopwork, /turnon, /turnoff, /schedule, /report',
    '/setschedule 06:00=start,09:00=stop',
    '/setdayschedule mon 06:00=start,09:00=stop',
    '/cleardayschedule mon',
    '/resetschedule, /resetweekschedule'
  ].join('\n');
}

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return body.result;
}

async function sendTelegramToAll(text) {
  const chats = telegramState.chats.filter((chat) => chat.authorized);
  if (config.telegramDryRun) {
    console.log(`[telegram dry-run] ${text}`);
    return;
  }
  if (!config.telegramToken || chats.length === 0) return;

  for (const chat of chats) {
    await sendTelegramMessage(chat.id, text);
  }
}

async function sendTelegramMessage(chatId, text, options = {}) {
  if (config.telegramDryRun) {
    console.log(`[telegram dry-run -> ${chatId}] ${text}${options.replyMarkup ? `\n${JSON.stringify(options.replyMarkup)}` : ''}`);
    return;
  }
  if (!config.telegramToken) return;

  const chunks = chunkText(text, 3900);
  for (let index = 0; index < chunks.length; index += 1) {
    const isLastChunk = index === chunks.length - 1;
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: chunks[index],
      disable_web_page_preview: true,
      ...(isLastChunk && options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });
  }
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup) {
  if (config.telegramDryRun) {
    console.log(`[telegram dry-run edit -> ${chatId}/${messageId}] ${text}${replyMarkup ? `\n${JSON.stringify(replyMarkup)}` : ''}`);
    return;
  }
  if (!config.telegramToken) return;

  await telegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
}

async function respondToCallback(callback, text, replyMarkup) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId) return;

  if (messageId) {
    try {
      await editTelegramMessage(chatId, messageId, text, replyMarkup);
      return;
    } catch (error) {
      const message = formatError(error);
      if (!/message is not modified/i.test(message)) {
        console.log(`Telegram edit failed, sending a new message instead: ${message}`);
        await sendTelegramMessage(chatId, text, { replyMarkup });
      }
      return;
    }
  }

  await sendTelegramMessage(chatId, text, { replyMarkup });
}

async function answerTelegramCallback(callbackId, text = '') {
  if (config.telegramDryRun) {
    console.log(`[telegram dry-run answer callback] ${text || 'ok'}`);
    return;
  }
  if (!config.telegramToken) return;

  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackId,
    ...(text ? { text } : {})
  });
}

async function emit(text) {
  console.log(text);
  await sendTelegramToAll(text).catch((error) => {
    console.log(`Telegram send failed: ${formatError(error)}`);
  });
}

function registerTelegramChat(chatId, username) {
  const existing = telegramState.chats.find((chat) => chat.id === chatId);
  if (existing) {
    existing.username = username;
    existing.authorized = true;
    existing.lastSeenAt = new Date().toISOString();
    return;
  }

  telegramState.chats.push({
    id: chatId,
    username,
    authorized: true,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  });
}

async function recordAction(result, context = {}) {
  const at = new Date();
  const reportDate = context.baseAt ? dateKey(new Date(context.baseAt)) : dateKey(at);
  const day = ensureRuntimeDay(reportDate);
  day.events.push({
    at: at.toISOString(),
    trigger: context.trigger || 'manual',
    source: context.source || 'unknown',
    scheduledAt: context.scheduledAt ? new Date(context.scheduledAt).toISOString() : null,
    baseAt: context.baseAt ? new Date(context.baseAt).toISOString() : null,
    jitterMinutes: context.jitterMinutes ?? null,
    scheduleSource: context.scheduleSource || null,
    dayKey: context.dayKey || null,
    action: result.action,
    status: result.status,
    reason: result.reason || null,
    previousState: result.previousState || null,
    finalState: result.finalState || null,
    attempts: result.attempts || 0
  });
  await saveRuntimeState();
}

async function maybeSendDailyReport(next) {
  if (!isLastEventOfDay(next)) return;

  const reportDate = dateKey(next.baseAt);
  const day = ensureRuntimeDay(reportDate);
  if (day.reported) return;

  await emit(buildDailyReport(reportDate, true));
  day.reported = true;
  day.reportedAt = new Date().toISOString();
  await saveRuntimeState();
}

function buildDailyReport(reportDate, finalReport) {
  const day = ensureRuntimeDay(reportDate);
  const title = finalReport ? 'End-of-day Promid report' : 'Promid report so far';
  const events = day.events || [];
  const duration = calculateObservedWorkDuration(events);
  const lines = [
    `${title} (${reportDate})`,
    `Events: ${events.length}`,
    `Bot-observed working time: ${formatDuration(duration.ms)}${duration.partial ? ' (partial)' : ''}`
  ];

  if (!events.length) {
    lines.push('No bot-observed events yet.');
    return lines.join('\n');
  }

  for (const event of events.slice(-30)) {
    const at = formatTimeOnly(new Date(event.at));
    lines.push(`${at} ${event.trigger} ${String(event.action).toUpperCase()} -> ${event.status} (${event.previousState || '?'} -> ${event.finalState || '?'})${event.reason ? `: ${event.reason}` : ''}`);
  }

  if (events.length > 30) {
    lines.push(`... ${events.length - 30} older events omitted.`);
  }
  if (duration.partial) {
    lines.push('Note: total is partial because the bot started mid-day, missed transitions, dry-run was used, or an interval is still open.');
  }
  return lines.join('\n');
}

function calculateObservedWorkDuration(events) {
  let startedAt;
  let totalMs = 0;
  let partial = false;

  for (const event of events) {
    if (event.status !== 'clicked') {
      if (['failed', 'dry-run'].includes(event.status)) partial = true;
      continue;
    }

    const at = new Date(event.at);
    if (event.action === 'start') {
      if (startedAt) partial = true;
      startedAt = at;
    } else if (['lunch', 'stop'].includes(event.action)) {
      if (!startedAt) {
        partial = true;
      } else {
        totalMs += Math.max(0, at.getTime() - startedAt.getTime());
        startedAt = undefined;
      }
    }
  }

  if (startedAt) partial = true;
  return { ms: totalMs, partial };
}

function isLastEventOfDay(next) {
  const events = getEventsForDate(next.baseAt);
  const sameDayEvents = events
    .map((event) => ({ event, at: dateAt(next.baseAt, 0, event.time) }))
    .filter((candidate) => dateKey(candidate.at) === dateKey(next.baseAt))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const last = sameDayEvents.at(-1);
  return Boolean(last && last.event.action === next.action && sameClockTime(last.at, next.baseAt));
}

function sameClockTime(a, b) {
  return a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
}

function defaultRuntimeState() {
  return {
    automationEnabled: true,
    scheduleOverride: null,
    weeklyScheduleOverride: {},
    days: {}
  };
}

function defaultTelegramState() {
  return {
    offset: 0,
    chats: [],
    sessions: {}
  };
}

async function loadRuntimeState() {
  const loaded = await loadJson(config.runtimeStatePath, defaultRuntimeState());
  return {
    automationEnabled: loaded.automationEnabled !== false,
    scheduleOverride: normalizeLoadedScheduleOverride(loaded.scheduleOverride),
    weeklyScheduleOverride: normalizeLoadedWeeklySchedule(loaded.weeklyScheduleOverride),
    days: loaded.days && typeof loaded.days === 'object' ? loaded.days : {}
  };
}

async function saveRuntimeState() {
  await saveJson(config.runtimeStatePath, runtimeState);
}

async function loadTelegramState() {
  const loaded = await loadJson(config.telegramStatePath, defaultTelegramState());
  return {
    offset: Number.isInteger(loaded.offset) ? loaded.offset : 0,
    chats: Array.isArray(loaded.chats) ? loaded.chats : [],
    sessions: loaded.sessions && typeof loaded.sessions === 'object' ? loaded.sessions : {}
  };
}

async function saveTelegramState() {
  await saveJson(config.telegramStatePath, telegramState);
}

function ensureRuntimeDay(reportDate) {
  runtimeState.days ||= {};
  runtimeState.days[reportDate] ||= { events: [], reported: false };
  runtimeState.days[reportDate].events ||= [];
  return runtimeState.days[reportDate];
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function persistScheduleChange() {
  await saveRuntimeState();
  jitterOffsets.clear();
  lastNextNoticeKey = undefined;
  wakeMonitorLoop();
}

function normalizeLoadedScheduleOverride(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return normalizeScheduleString(value);
  } catch (error) {
    console.log(`Ignoring invalid saved fallback schedule override: ${formatError(error)}`);
    return null;
  }
}

function normalizeLoadedWeeklySchedule(value) {
  const normalized = {};
  if (!value || typeof value !== 'object') return normalized;

  for (const dayKey of WORKDAY_KEYS) {
    if (!Object.hasOwn(value, dayKey) || typeof value[dayKey] !== 'string') continue;
    try {
      normalized[dayKey] = value[dayKey].trim() ? normalizeScheduleString(value[dayKey]) : '';
    } catch (error) {
      console.log(`Ignoring invalid saved ${WORKDAY_LABELS[dayKey]} schedule override: ${formatError(error)}`);
    }
  }

  return normalized;
}

function getFallbackSchedule() {
  return runtimeState.scheduleOverride || config.schedule;
}

function getActiveSchedule() {
  return getFallbackSchedule();
}

function getActiveEvents() {
  return getEventsForDate(new Date());
}

function getScheduleForDate(date) {
  const dayKey = dayKeyForDate(date);
  if (!dayKey || !isActiveWorkday(date)) {
    return {
      dayKey: null,
      schedule: '',
      source: 'weekend/off day',
      custom: false
    };
  }

  return getScheduleForDayKey(dayKey);
}

function getScheduleForDayKey(dayKey) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const hasCustom = Object.hasOwn(runtimeState.weeklyScheduleOverride || {}, safeDayKey);
  if (hasCustom) {
    return {
      dayKey: safeDayKey,
      schedule: runtimeState.weeklyScheduleOverride[safeDayKey],
      source: `${WORKDAY_LABELS[safeDayKey]} custom`,
      custom: true
    };
  }

  return {
    dayKey: safeDayKey,
    schedule: getFallbackSchedule(),
    source: runtimeState.scheduleOverride ? 'fallback Telegram override' : '.env fallback',
    custom: false
  };
}

function getEventsForDate(date) {
  const schedule = getScheduleForDate(date).schedule;
  return schedule ? parseSchedule(schedule) : [];
}

function getActionConfig(action) {
  const actionConfig = {
    start: { selector: config.startSelector, texts: config.startTexts },
    lunch: { selector: config.lunchSelector, texts: config.lunchTexts },
    stop: { selector: config.stopSelector, texts: config.stopTexts }
  };
  return actionConfig[action];
}

function parseSchedule(value) {
  const events = splitList(value).map((entry) => {
    const match = entry.match(/^(\d{1,2}):(\d{2})=(start|lunch|stop)$/i);
    if (!match) throw new Error(`Invalid schedule event: ${entry}. Expected HH:mm=start|lunch|stop.`);
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const action = match[3].toLowerCase();
    validateTime(hour, minute, entry);
    return {
      action,
      time: { hour, minute }
    };
  });

  if (!events.length) throw new Error('PROMID_SCHEDULE cannot be empty.');
  return sortEvents(validateUniqueEventTimes(events));
}

function normalizeScheduleString(value) {
  return scheduleStringFromEvents(parseSchedule(value));
}

function scheduleStringFromEvents(events) {
  return sortEvents(validateUniqueEventTimes(events)).map(formatEventForSchedule).join(',');
}

function validateUniqueEventTimes(events) {
  const seen = new Set();
  for (const event of events) {
    const key = `${pad2(event.time.hour)}:${pad2(event.time.minute)}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate schedule time: ${key}. Use only one action per timestamp.`);
    }
    seen.add(key);
  }
  return events;
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const byHour = a.time.hour - b.time.hour;
    if (byHour) return byHour;
    return a.time.minute - b.time.minute;
  });
}

function parseEditableDayEvents(dayKey) {
  const info = getScheduleForDayKey(dayKey);
  return info.schedule ? parseSchedule(info.schedule) : [];
}

function setWeeklyDaySchedule(dayKey, schedule) {
  const safeDayKey = requireWorkdayKey(dayKey);
  runtimeState.weeklyScheduleOverride ||= {};
  runtimeState.weeklyScheduleOverride[safeDayKey] = schedule.trim() ? normalizeScheduleString(schedule) : '';
}

function addWeeklyDayEvent(dayKey, event) {
  const safeDayKey = requireWorkdayKey(dayKey);
  validateTime(event.time.hour, event.time.minute, formatEvent(event));
  const events = parseEditableDayEvents(safeDayKey);
  validateUniqueEventTimes([...events, event]);
  setWeeklyDaySchedule(safeDayKey, scheduleStringFromEvents([...events, event]));
  return event;
}

function deleteWeeklyDayEvent(dayKey, index) {
  const safeDayKey = requireWorkdayKey(dayKey);
  const events = parseEditableDayEvents(safeDayKey);
  if (!Number.isInteger(index) || index < 0 || index >= events.length) {
    throw new Error('Selected event no longer exists.');
  }
  const [removed] = events.splice(index, 1);
  setWeeklyDaySchedule(safeDayKey, events.length ? scheduleStringFromEvents(events) : '');
  return removed;
}

function getNextAction(now) {
  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const candidateDate = new Date(now);
    candidateDate.setDate(candidateDate.getDate() + dayOffset);
    const scheduleInfo = getScheduleForDate(candidateDate);
    const events = scheduleInfo.schedule ? parseSchedule(scheduleInfo.schedule) : [];
    for (const event of events) {
      const baseAt = dateAt(now, dayOffset, event.time);
      if (!isActiveWorkday(baseAt)) {
        continue;
      }
      const jitterMinutes = getJitterMinutes(baseAt, event);
      candidates.push({
        action: event.action,
        at: addMinutes(baseAt, jitterMinutes),
        baseAt,
        jitterMinutes,
        dayKey: scheduleInfo.dayKey,
        scheduleSource: scheduleInfo.source
      });
    }
  }

  const next = candidates
    .filter((candidate) => candidate.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];

  return next || null;
}

function getJitterMinutes(baseAt, event) {
  if (config.jitterMinutes <= 0) return 0;

  const key = `${dateKey(baseAt)}|${event.action}|${event.time.hour}:${event.time.minute}`;
  if (!jitterOffsets.has(key)) {
    const range = config.jitterMinutes * 2 + 1;
    jitterOffsets.set(key, Math.floor(Math.random() * range) - config.jitterMinutes);
  }
  return jitterOffsets.get(key);
}

function waitUntil(date) {
  const waitMs = Math.max(0, date.getTime() - Date.now());
  return Promise.race([
    sleep(waitMs).then(() => 'due'),
    new Promise((resolve) => {
      monitorWake = () => resolve('woken');
    })
  ]).finally(() => {
    monitorWake = undefined;
  });
}

function wakeMonitorLoop() {
  if (monitorWake) monitorWake();
}

function dateAt(base, dayOffset, time) {
  const date = new Date(base);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(time.hour, time.minute, 0, 0);
  return date;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function eventKey(event) {
  return `${event.action}|${event.at.toISOString()}|${event.baseAt.toISOString()}|${event.dayKey || ''}|${event.scheduleSource || ''}`;
}

function validateTime(hour, minute, source) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time in ${source}.`);
  }
}

async function isVisible(locator) {
  try {
    return await locator.isVisible({ timeout: 5000 });
  } catch {
    return false;
  }
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function splitList(value) {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative whole number, got: ${value}`);
  }
  return parsed;
}

function parseNonNegativeIntegerList(value) {
  return splitList(value).map((part) => parseNonNegativeInteger(part, 0));
}

function parseActiveDays(value) {
  const aliases = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6
  };

  return new Set(splitList(value).map((part) => {
    const lower = part.toLowerCase();
    const parsed = lower in aliases ? aliases[lower] : Number(lower);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
      throw new Error(`Invalid active day: ${part}. Use 0-6 or names like mon,tue,wed.`);
    }
    return parsed;
  }));
}

function parseUsernames(value) {
  return new Set(splitList(value).map(normalizeUsername).filter(Boolean));
}

function normalizeUsername(value) {
  return value
    .replace(/^https:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
}

function getTelegramSession(chatId) {
  telegramState.sessions ||= {};
  return telegramState.sessions[String(chatId)] || {};
}

function setTelegramSession(chatId, session) {
  telegramState.sessions ||= {};
  telegramState.sessions[String(chatId)] = {
    ...session,
    updatedAt: new Date().toISOString()
  };
}

function parseWorkdayKey(value) {
  const lower = String(value || '').trim().toLowerCase();
  const aliases = {
    1: 'mon',
    monday: 'mon',
    mon: 'mon',
    2: 'tue',
    tuesday: 'tue',
    tue: 'tue',
    tues: 'tue',
    3: 'wed',
    wednesday: 'wed',
    wed: 'wed',
    4: 'thu',
    thursday: 'thu',
    thu: 'thu',
    thur: 'thu',
    thurs: 'thu',
    5: 'fri',
    friday: 'fri',
    fri: 'fri'
  };
  return aliases[lower] || null;
}

function requireWorkdayKey(value) {
  const dayKey = parseWorkdayKey(value);
  if (!dayKey) {
    throw new Error('Only Monday-Friday schedules are available; weekends stay disabled.');
  }
  return dayKey;
}

function dayKeyForDate(date) {
  return DAY_NUMBER_TO_WORKDAY[date.getDay()] || null;
}

function isActiveWorkday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5 && config.activeDays.has(day);
}

function formatActiveDays(activeDays) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return [...activeDays].sort((a, b) => a - b).map((day) => names[day]).join(', ');
}

function formatWeeklySchedule() {
  const lines = ['Monday-Friday effective schedules:'];
  for (const dayKey of WORKDAY_KEYS) {
    const info = getScheduleForDayKey(dayKey);
    lines.push(`${WORKDAY_LABELS[dayKey]}: ${formatScheduleForDisplay(info.schedule)} (${info.custom ? 'custom' : 'fallback'})`);
  }
  return lines.join('\n');
}

function formatScheduleForDisplay(schedule) {
  return schedule ? schedule : 'No events';
}

function formatEvent(event) {
  return `${pad2(event.time.hour)}:${pad2(event.time.minute)} ${event.action.toUpperCase()}`;
}

function formatEventForSchedule(event) {
  return `${pad2(event.time.hour)}:${pad2(event.time.minute)}=${event.action}`;
}

function formatNextEvent(next) {
  if (!next) return 'none';
  const source = next.scheduleSource ? ` (${next.scheduleSource})` : '';
  return `${next.action.toUpperCase()} at ${formatDateTime(next.at)}${formatJitter(next.jitterMinutes)}${source}`;
}

function formatJitter(jitterMinutes) {
  if (!jitterMinutes) return '';
  const sign = jitterMinutes > 0 ? '+' : '';
  return ` (${sign}${jitterMinutes} min jitter)`;
}

function formatActionResult(result) {
  const stateText = `${result.previousState || '?'} -> ${result.finalState || '?'}`;
  return `${String(result.action).toUpperCase()} ${result.status}: ${stateText}; attempts=${result.attempts || 0}; ${result.reason || 'done'}`;
}

function retryableError(message) {
  const error = new Error(message);
  error.retryable = true;
  return error;
}

function isRetryableError(error) {
  return error?.retryable !== false;
}

function formatError(error) {
  return error?.message || String(error);
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function textMatchesAny(pageText, texts) {
  return texts.some((text) => pageText.includes(normalizeText(text)));
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium'
  }).format(date);
}

function formatTimeOnly(date) {
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: 'short'
  }).format(date);
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${pad2(minutes)}m`;
}

function telegramModeLabel() {
  if (config.telegramDryRun) return 'dry-run';
  if (config.telegramToken) return 'enabled';
  return 'disabled';
}

function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length ? chunks : [''];
}

function runTelegramUiSelfTest() {
  const originalRuntimeState = runtimeState;
  const originalTelegramState = telegramState;
  try {
    runtimeState = defaultRuntimeState();
    telegramState = defaultTelegramState();
    runtimeState.scheduleOverride = '08:00=start,10:00=stop';
    runtimeState.weeklyScheduleOverride = {
      mon: '06:00=start,09:00=stop',
      tue: '07:00=start,12:00=lunch,12:30=start,16:00=stop'
    };

    assertSelfTest(parseWorkdayKey('sat') === null, 'Saturday must not be editable.');
    assertSelfTest(dayKeyForDate(new Date(2026, 5, 1)) === 'mon', 'Self-test date should be Monday.');

    const mondayNext = getNextAction(new Date(2026, 5, 1, 5, 0, 0));
    assertSelfTest(mondayNext?.action === 'start', 'Monday next action should use Monday override.');
    assertSelfTest(mondayNext?.baseAt.getHours() === 6, 'Monday next action should be 06:00.');

    const tuesdayNext = getNextAction(new Date(2026, 5, 2, 6, 0, 0));
    assertSelfTest(tuesdayNext?.action === 'start', 'Tuesday next action should use Tuesday override.');
    assertSelfTest(tuesdayNext?.baseAt.getHours() === 7, 'Tuesday next action should be 07:00.');

    const wednesdayNext = getNextAction(new Date(2026, 5, 3, 7, 0, 0));
    assertSelfTest(wednesdayNext?.baseAt.getHours() === 8, 'Missing weekday override should fall back.');

    const fridayAfterWork = getNextAction(new Date(2026, 5, 5, 23, 0, 0));
    assertSelfTest(fridayAfterWork?.baseAt.getDay() === 1, 'Weekend must be skipped.');

    let duplicateRejected = false;
    try {
      addWeeklyDayEvent('mon', { action: 'lunch', time: { hour: 6, minute: 0 } });
    } catch {
      duplicateRejected = true;
    }
    assertSelfTest(duplicateRejected, 'Duplicate weekday times should be rejected.');

    setWeeklyDaySchedule('fri', '');
    assertSelfTest(getEventsForDate(new Date(2026, 5, 5)).length === 0, 'Cleared Friday should have no events.');
    assertSelfTest(scheduleMenuKeyboard().inline_keyboard.flat().every((item) => !/sat|sun/i.test(item.callback_data)), 'Weekend callbacks must not be rendered.');

    console.log('Telegram UI self-test passed.');
  } finally {
    runtimeState = originalRuntimeState;
    telegramState = originalTelegramState;
  }
}

function assertSelfTest(condition, message) {
  if (!condition) {
    throw new Error(`Self-test failed: ${message}`);
  }
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
