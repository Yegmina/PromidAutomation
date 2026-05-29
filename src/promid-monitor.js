import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const env = process.env;

const config = {
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
const jitterOffsets = new Map();

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
Schedule: ${getActiveSchedule()}
Active days: ${formatActiveDays(config.activeDays)}
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
  if (!config.retryDelaysSeconds.length) {
    throw new Error('PROMID_RETRY_DELAYS_SECONDS must include at least one delay.');
  }
}

async function runMonitorLoop() {
  while (true) {
    const events = getActiveEvents();
    const next = getNextAction(new Date(), events);
    const nextKey = eventKey(next);
    if (nextKey !== lastNextNoticeKey) {
      lastNextNoticeKey = nextKey;
      await emit(`Next automatic action: ${next.action.toUpperCase()} at ${formatDateTime(next.at)}${formatJitter(next.jitterMinutes)}.`);
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
      await maybeSendDailyReport(next, events);
      continue;
    }

    const queued = runExclusive(`auto:${next.action}`, () => runActionWithRetries(next.action, autoContext(next)));
    await queued.promise;
    await maybeSendDailyReport(next, events);
  }
}

function autoContext(next) {
  return {
    trigger: 'auto',
    source: 'schedule',
    scheduledAt: next.at,
    baseAt: next.baseAt,
    jitterMinutes: next.jitterMinutes
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
        allowed_updates: ['message']
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
  const message = update.message;
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
    await sendTelegramMessage(message.chat.id, commandHelp());
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
      await sendTelegramMessage(chatId, commandHelp());
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
      runtimeState.automationEnabled = true;
      await saveRuntimeState();
      wakeMonitorLoop();
      await emit(`Automatic schedule turned ON by @${username}.`);
      return;
    case '/turnoff':
      runtimeState.automationEnabled = false;
      await saveRuntimeState();
      wakeMonitorLoop();
      await emit(`Automatic schedule turned OFF by @${username}.`);
      return;
    case '/schedule':
      await sendTelegramMessage(chatId, `Active schedule: ${getActiveSchedule()}\nSource: ${runtimeState.scheduleOverride ? 'Telegram override' : '.env'}`);
      return;
    case '/setschedule':
      await handleSetScheduleCommand(chatId, username, argsText);
      return;
    case '/resetschedule':
      runtimeState.scheduleOverride = null;
      await saveRuntimeState();
      jitterOffsets.clear();
      wakeMonitorLoop();
      await emit(`Schedule reset to .env by @${username}. Active schedule: ${getActiveSchedule()}`);
      return;
    case '/report':
      await sendTelegramMessage(chatId, buildDailyReport(dateKey(new Date()), false));
      return;
    default:
      await sendTelegramMessage(chatId, `Unknown command: ${command}\n\n${commandHelp()}`);
  }
}

async function handleStatusCommand(chatId) {
  const next = getNextAction(new Date(), getActiveEvents());
  const statusLines = [
    `Automation: ${runtimeState.automationEnabled ? 'on' : 'off'}`,
    `Dry-run: ${config.dryRun ? 'on' : 'off'}`,
    `Schedule: ${getActiveSchedule()}`,
    `Next event: ${next.action.toUpperCase()} at ${formatDateTime(next.at)}${formatJitter(next.jitterMinutes)}`
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

  await sendTelegramMessage(chatId, statusLines.join('\n'));
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
    parseSchedule(argsText);
  } catch (error) {
    await sendTelegramMessage(chatId, `Invalid schedule: ${formatError(error)}`);
    return;
  }

  runtimeState.scheduleOverride = argsText;
  await saveRuntimeState();
  jitterOffsets.clear();
  wakeMonitorLoop();
  await emit(`Schedule override set by @${username}: ${argsText}`);
}

function commandHelp() {
  return [
    'Promid Manager commands:',
    '/status - show automation, schedule, next event, and Promid state',
    '/startwork - run safe start action now',
    '/lunch - run safe lunch action now',
    '/stopwork - run safe stop action now',
    '/turnon - enable automatic schedule',
    '/turnoff - disable automatic schedule',
    '/schedule - show active schedule',
    '/setschedule 06:00=start,09:00=stop - override runtime schedule',
    '/resetschedule - use .env schedule again',
    '/report - send today report'
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

async function sendTelegramMessage(chatId, text) {
  if (config.telegramDryRun) {
    console.log(`[telegram dry-run -> ${chatId}] ${text}`);
    return;
  }
  if (!config.telegramToken) return;

  for (const chunk of chunkText(text, 3900)) {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true
    });
  }
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
    action: result.action,
    status: result.status,
    reason: result.reason || null,
    previousState: result.previousState || null,
    finalState: result.finalState || null,
    attempts: result.attempts || 0
  });
  await saveRuntimeState();
}

async function maybeSendDailyReport(next, events) {
  if (!isLastEventOfDay(next, events)) return;

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

function isLastEventOfDay(next, events) {
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
    days: {}
  };
}

function defaultTelegramState() {
  return {
    offset: 0,
    chats: []
  };
}

async function loadRuntimeState() {
  const loaded = await loadJson(config.runtimeStatePath, defaultRuntimeState());
  return {
    automationEnabled: loaded.automationEnabled !== false,
    scheduleOverride: typeof loaded.scheduleOverride === 'string' && loaded.scheduleOverride ? loaded.scheduleOverride : null,
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
    chats: Array.isArray(loaded.chats) ? loaded.chats : []
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

function getActiveSchedule() {
  return runtimeState.scheduleOverride || config.schedule;
}

function getActiveEvents() {
  return parseSchedule(getActiveSchedule());
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
  return events;
}

function getNextAction(now, events) {
  const candidates = [];
  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    for (const event of events) {
      const baseAt = dateAt(now, dayOffset, event.time);
      if (!config.activeDays.has(baseAt.getDay())) {
        continue;
      }
      const jitterMinutes = getJitterMinutes(baseAt, event);
      candidates.push({
        action: event.action,
        at: addMinutes(baseAt, jitterMinutes),
        baseAt,
        jitterMinutes
      });
    }
  }

  const next = candidates
    .filter((candidate) => candidate.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];

  if (!next) {
    throw new Error('No upcoming actions found. Check PROMID_SCHEDULE and PROMID_ACTIVE_DAYS.');
  }

  return next;
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
  return `${event.action}|${event.at.toISOString()}|${event.baseAt.toISOString()}`;
}

function validateTime(hour, minute, source) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
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

function formatActiveDays(activeDays) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return [...activeDays].sort((a, b) => a - b).map((day) => names[day]).join(', ');
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

function pad2(value) {
  return String(value).padStart(2, '0');
}
