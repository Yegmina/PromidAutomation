# Promid Time Helper

Supervised Promid stamping helper for Metropolia Promid.

It opens `https://metropolia.promid.fi/`, clicks `ADFS kirjautuminen`, logs in with credentials from `.env`, waits for scheduled work events, skips non-workdays, applies optional random time jitter, and clicks the configured Promid button when the event is due.

By default it asks before every start/lunch/stop click. Keep that default unless your employer explicitly allows unattended attendance actions.

## What The Actions Mean

- `start` means `Sisaan` / `Sign in`
- `lunch` means `Lounas` / `Lunch`
- `stop` means `Ulos` / `Sign out`

Example schedule:

```env
PROMID_SCHEDULE=06:00=start,09:00=stop,17:00=start,19:00=lunch,19:30=start,22:30=stop
```

This means:

- 06:00 start work
- 09:00 stop work
- 17:00 start work
- 19:00 lunch
- 19:30 return from lunch
- 22:30 stop work

## 1. Clone From GitHub

Clone the repository:

```bash
git clone https://github.com/Yegmina/PromidAutomation.git
cd PromidAutomation
```

## 2. Create `.env`

Copy the template:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
nano .env
```

Minimum working config:

```env
PROMID_URL=https://metropolia.promid.fi/
PROMID_EMAIL=your.email@metropolia.fi
PROMID_PASSWORD=your-password

PROMID_HEADLESS=false
PROMID_LOGIN_STATE_PATH=.auth/promid-state.json

PROMID_CONFIRM_BEFORE_ACTION=true
PROMID_DRY_RUN=false

PROMID_SCHEDULE=06:00=start,09:00=stop,17:00=start,19:00=lunch,19:30=start,22:30=stop
PROMID_ACTIVE_DAYS=1,2,3,4,5
PROMID_TIME_JITTER_MINUTES=10
PROMID_RETRY_DELAYS_SECONDS=0,60,180,300

PROMID_START_TEXTS=Sisään,Sisaan,Sign in
PROMID_LUNCH_TEXTS=Lounas,Lunch
PROMID_STOP_TEXTS=Ulos,Sign out

PROMID_WORKING_STATUS_TEXTS=Signed in,Sisäänkirjautunut
PROMID_LUNCH_STATUS_TEXTS=Lunch,Lounas
PROMID_SIGNED_OUT_STATUS_TEXTS=Signed out,Uloskirjautunut
```

Important:

- `.env` is ignored by git and should never be committed.
- `PROMID_ACTIVE_DAYS=1,2,3,4,5` means Monday-Friday only.
- Day numbers are `0=Sunday`, `1=Monday`, `2=Tuesday`, `3=Wednesday`, `4=Thursday`, `5=Friday`, `6=Saturday`.
- You can also use names like `mon,tue,wed,thu,fri`.
- `PROMID_TIME_JITTER_MINUTES=10` means each scheduled event runs randomly from 10 minutes before to 10 minutes after the configured time.
- `PROMID_RETRY_DELAYS_SECONDS=0,60,180,300` means try immediately, then retry after 1, 3, and 5 minutes for transient errors.

## 3. Run Locally Without Docker

Install Node.js 20 or newer, then:

```bash
npm ci
npx playwright install --with-deps chromium
```

On Windows PowerShell, use:

```powershell
npm ci
npx playwright install chromium
```

Test safely without clicking:

```bash
PROMID_DRY_RUN=true npm run once:lunch
```

Windows PowerShell:

```powershell
$env:PROMID_DRY_RUN='true'
npm run once:lunch
```

If the dry run says it found the control, turn dry-run off:

```bash
npm start
```

Windows PowerShell:

```powershell
$env:PROMID_DRY_RUN='false'
npm start
```

The monitor will print the next real scheduled time after jitter. Leave the terminal open.

If a scheduled event fails because Promid is loading, login is temporarily unavailable, the network fails, or the current state is unknown, the monitor retries using `PROMID_RETRY_DELAYS_SECONDS`. Known invalid states are skipped safely instead of retried.

## 4. Run One Action Manually

Use these for testing or manual operation:

```bash
npm run once:start
npm run once:lunch
npm run once:stop
```

With `PROMID_CONFIRM_BEFORE_ACTION=true`, the script asks before clicking.

## 5. Run On Linux Server With Docker

Install Docker and Docker Compose on the server, then clone the repo and create `.env` as shown above.

Build:

```bash
docker compose build
```

Safe test without clicking:

```bash
docker compose run --rm -e PROMID_DRY_RUN=true promid-monitor npm run once:lunch
```

Run attached, so you can answer confirmation prompts:

```bash
docker compose up
```

Run in the background:

```bash
docker compose up -d
```

View logs:

```bash
docker compose logs -f promid-monitor
```

Stop:

```bash
docker compose down
```

Notes for Docker:

- The container runs Chromium headless.
- Promid session state is stored in `./.auth` on the host.
- If ADFS requires MFA or an interactive browser, do the first login on a machine where you can see the browser, then keep the saved `.auth` session.
- Detached mode cannot answer confirmation prompts. Use detached mode only for dry-run monitoring or when unattended attendance actions are explicitly permitted.

## 6. Useful `.env` Options

```env
PROMID_CONFIRM_BEFORE_ACTION=true
```

Ask before every real click.

```env
PROMID_DRY_RUN=true
```

Log in and find the button, but do not click.

```env
PROMID_HEADLESS=true
```

Run browser without a visible window. Docker sets this automatically.

```env
PROMID_TIME_JITTER_MINUTES=10
```

Apply random `-10..+10` minute offset to each scheduled event.

```env
PROMID_ACTIVE_DAYS=1,2,3,4,5
```

Only run Monday-Friday.

```env
PROMID_RETRY_DELAYS_SECONDS=0,60,180,300
```

Retry transient errors now, after 1 minute, after 3 minutes, and after 5 minutes.

```env
PROMID_WORKING_STATUS_TEXTS=Signed in,Sisäänkirjautunut
PROMID_LUNCH_STATUS_TEXTS=Lunch,Lounas
PROMID_SIGNED_OUT_STATUS_TEXTS=Signed out,Uloskirjautunut
```

Override state-detection text if Promid shows different labels.

## 7. State Safety

The helper checks Promid's current state before every action:

- `start` clicks only from `signed_out` or `lunch`; if already `working`, it skips.
- `lunch` clicks only from `working`; if already on `lunch`, it skips.
- `stop` clicks only from `working`; if already `signed_out`, it skips.
- `unknown` state is retried and never clicked blindly.

## 8. Troubleshooting

If a button is not found, run a dry-run first:

```bash
PROMID_DRY_RUN=true npm run once:lunch
```

Then update one of these in `.env`:

```env
PROMID_START_TEXTS=Sisään,Sisaan,Sign in
PROMID_LUNCH_TEXTS=Lounas,Lunch
PROMID_STOP_TEXTS=Ulos,Sign out
```

If Promid uses stable CSS selectors, you can use:

```env
PROMID_START_SELECTOR=
PROMID_LUNCH_SELECTOR=
PROMID_STOP_SELECTOR=
```

If login keeps failing:

- Check `PROMID_EMAIL` and `PROMID_PASSWORD`.
- Try `PROMID_HEADLESS=false` locally so you can see the browser.
- Complete MFA if prompted.
- Delete `.auth` and try again if the saved session is stale.

## 9. Observed Promid Flow

Public login:

- `https://metropolia.promid.fi/` redirects to `/login`
- page title: `Kirjaudu sisään - Promid`
- button: `ADFS kirjautuminen`
- ADFS fields: `User Account`, `Password`
- submit button: `Sign in`

After login, the Stamping page in English showed:

- current status: `Signed in`
- available buttons in that state include `Sign out` and `Lunch`
