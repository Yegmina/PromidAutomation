import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const env = process.env;

const config = {
  url: env.PROMID_URL || 'https://metropolia.promid.fi/',
  email: env.PROMID_EMAIL,
  password: env.PROMID_PASSWORD,
  headless: parseBoolean(env.PROMID_HEADLESS, false),
  confirmBeforeAction: parseBoolean(env.PROMID_CONFIRM_BEFORE_ACTION, true),
  dryRun: parseBoolean(env.PROMID_DRY_RUN, false),
  statePath: env.PROMID_LOGIN_STATE_PATH || '.auth/promid-state.json',
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
  stopSelector: env.PROMID_STOP_SELECTOR
};

const args = process.argv.slice(2);
const onceIndex = args.indexOf('--once');
const onceAction = onceIndex >= 0 ? args[onceIndex + 1] : undefined;
const jitterOffsets = new Map();

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  validateConfig();

  if (onceAction) {
    if (!['start', 'lunch', 'stop'].includes(onceAction)) {
      throw new Error('Use --once start, --once lunch, or --once stop.');
    }

    await runActionWithRetries(onceAction);
    return;
  }

  console.log(`Promid monitor started at ${formatDateTime(new Date())}.`);
  console.log(`Configured schedule: ${config.schedule}`);
  console.log(`Active days: ${formatActiveDays(config.activeDays)}.`);
  if (config.jitterMinutes > 0) {
    console.log(`Time jitter: +/- ${config.jitterMinutes} minutes.`);
  }

  const events = parseSchedule(config.schedule);
  while (true) {
    const next = getNextAction(new Date(), events);
    const waitMs = Math.max(0, next.at.getTime() - Date.now());
    console.log(`Next action: ${next.action.toUpperCase()} at ${formatDateTime(next.at)}${formatJitter(next.jitterMinutes)}.`);
    await sleep(waitMs);

    await runActionWithRetries(next.action);
  }
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

async function openSession() {
  const storageState = await fileExists(config.statePath) ? config.statePath : undefined;
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();

  await ensureLoggedIn(page, context);
  return { browser, context, page };
}

async function runActionWithRetries(action) {
  let lastError;

  for (let attempt = 0; attempt < config.retryDelaysSeconds.length; attempt += 1) {
    const delaySeconds = config.retryDelaysSeconds[attempt];
    if (delaySeconds > 0) {
      console.log(`Retrying ${action.toUpperCase()} in ${delaySeconds} seconds.`);
      await sleep(delaySeconds * 1000);
    }

    let session;
    try {
      console.log(`Running ${action.toUpperCase()} attempt ${attempt + 1}/${config.retryDelaysSeconds.length}.`);
      session = await openSession();
      return await performAction(session.page, action);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) {
        console.log(`Skipped ${action.toUpperCase()}: ${formatError(error)}`);
        return { status: 'skipped', action };
      }
      console.log(`Attempt ${attempt + 1}/${config.retryDelaysSeconds.length} failed: ${formatError(error)}`);
    } finally {
      if (session) {
        await session.browser.close().catch(() => {});
      }
    }
  }

  console.log(`${action.toUpperCase()} failed after ${config.retryDelaysSeconds.length} attempts: ${formatError(lastError)}`);
  return { status: 'failed', action };
}

async function ensureLoggedIn(page, context) {
  await safeGoto(page, config.url);

  const adfsButton = page.getByRole('button', { name: 'ADFS kirjautuminen' });
  if (await isVisible(adfsButton)) {
    await adfsButton.click();
    await page.waitForLoadState('domcontentloaded');
  }

  const userField = page.getByLabel('User Account');
  const passwordField = page.getByLabel('Password');
  if (await isVisible(userField)) {
    await userField.fill(config.email);
    await passwordField.fill(config.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForLoadState('domcontentloaded');

    console.log('If your organization requires MFA, complete it in the browser window.');
    await page.waitForURL(/promid\.fi/i, { timeout: 120_000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  if (!/promid\.fi/i.test(page.url())) {
    throw retryableError(`Login may still be in progress. Current URL: ${page.url()}`);
  }

  const stillOnPromidLogin = page.getByRole('button', { name: 'ADFS kirjautuminen' });
  const stillOnAdfsLogin = page.getByLabel('User Account');
  if (await isVisible(stillOnPromidLogin) || await isVisible(stillOnAdfsLogin)) {
    throw retryableError(`Login did not reach the Promid stamping page. Current URL: ${page.url()}`);
  }

  await fs.mkdir(path.dirname(config.statePath), { recursive: true });
  await context.storageState({ path: config.statePath });
}

async function performAction(page, action) {
  await safeGoto(page, config.url);
  await page.waitForLoadState('networkidle').catch(() => {});

  const state = await detectPromidState(page);
  console.log(`Promid state: ${state.name} (${state.reason}).`);

  const decision = decideAction(action, state);
  if (decision.type === 'skip') {
    console.log(`Skipped ${action.toUpperCase()}: ${decision.reason}`);
    return { status: 'skipped', action, state: state.name };
  }

  const locator = await findActionLocator(page, action);

  if (config.dryRun) {
    console.log(`[dry-run] Would click ${action.toUpperCase()} from state ${state.name}. No click performed.`);
    return { status: 'dry-run', action, state: state.name };
  }

  if (config.confirmBeforeAction) {
    const confirmed = await askYesNo(`Confirm ${action.toUpperCase()} in Promid now?`);
    if (!confirmed) {
      console.log(`Skipped ${action}.`);
      return { status: 'skipped', action, state: state.name };
    }
  }

  await locator.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log(`${action.toUpperCase()} clicked at ${formatDateTime(new Date())}.`);
  return { status: 'clicked', action, state: state.name };
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
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function validateTime(hour, minute, source) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time in ${source}.`);
  }
}

async function askYesNo(question) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
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

function formatActiveDays(activeDays) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return [...activeDays].sort((a, b) => a - b).map((day) => names[day]).join(', ');
}

function formatJitter(jitterMinutes) {
  if (!jitterMinutes) return '';
  const sign = jitterMinutes > 0 ? '+' : '';
  return ` (${sign}${jitterMinutes} min jitter)`;
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
