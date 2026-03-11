# CRDTrove Collector (v1)

Collector service for ingesting **new inbound buyer text messages** from `https://crdtrove.com/` and delivering normalized events to n8n Webhook (Workflow A compatible).

## Current maturity status

This repository is implementation-ready for server deployment, but **not marked fully production-ready until live browser smoke-test against real account is completed**.

---

## 1) Playwright browser install blocker (Linux)

### Blocker
In restricted environments, `npx playwright install chromium` may fail (e.g. `403 Domain forbidden`) and collector cannot launch browser.

### Two practical paths

#### Path A — Allow Playwright browser binary download
- Command: `npx playwright install chromium`
- Use when outbound access to Playwright CDN is allowed.

#### Path B — Use preinstalled Chromium on server (recommended for production)
- Install Chromium via OS packages.
- Set `CHROMIUM_EXECUTABLE_PATH` in `.env` (for example `/usr/bin/chromium` or `/usr/bin/chromium-browser`).
- Collector launches Playwright with that executable.

**Why Path B is preferred in production:**
- deterministic server image/package management,
- easier patching via OS updates,
- no runtime dependency on external CDN availability.

---

## 2) Operational checklist

### Required env
- `CRDTROVE_LOGIN`, `CRDTROVE_PASSWORD`
- `N8N_WEBHOOK_URL` (or env-specific `N8N_WEBHOOK_URL_DEV/PROD`)
- `STATE_DB_PATH`, `SESSION_STATE_PATH`
- Optional: `CHROMIUM_EXECUTABLE_PATH`, proxy vars
- Auth stability tuning: `AUTH_FORM_TIMEOUT_MS`, `POST_LOGIN_SETTLE_MS`
- Bootstrap tuning: `BOOTSTRAP_TIMEOUT_SEC`, `BOOTSTRAP_POLL_INTERVAL_MS`

See `.env.example` for full list.

### Linux setup
```bash
npm ci
cp .env.example .env
npm run build
```

If using preinstalled Chromium:
```bash
sudo apt-get update
sudo apt-get install -y chromium
# then set CHROMIUM_EXECUTABLE_PATH in .env
```

### systemd run
1. Build project under `/opt/crdtrove-collector`.
2. Put `.env` there.
3. Copy `deploy/crdtrove-collector.service` to `/etc/systemd/system/`.
4. `sudo systemctl daemon-reload`
5. `sudo systemctl enable --now crdtrove-collector`
6. `journalctl -u crdtrove-collector -f`

### Headless, diagnostic and bootstrap modes
- Default headless collector: `HEADLESS=true`, `DIAGNOSTIC_HEADFUL=false`
- Diagnostic headful collector: set `DIAGNOSTIC_HEADFUL=true`
- Manual session bootstrap (new): `npm run bootstrap-session`
- Optional smoke command: `npm run smoke:dry -- --dry-run`

### Healthy signal
- `GET /healthz` returns current state.
- Expected steady state: `healthy`.
- Transitional/error states: `retrying`, `site_down`, `challenge_detected`, `auth_expired`, `degraded`, `recovered`.

---

## 3) Architecture summary

- **Auth/session**: reuse `SESSION_STATE_PATH`, fallback login via env credentials, persist renewed state.
- **Extraction**: network-first from JSON responses; DOM fallback if network payload unavailable.
- **Normalization**: strict payload contract for n8n.
- **Durable state** (SQLite): sent events, chat cursor, outbox.
- **Delivery**: webhook POST with retries + `x-idempotency-key`.
- **Recovery**: backoff + health-check loop; no anti-bot bypass.

---

## 4) Payload contract

One webhook POST per new inbound message:

```json
{
  "external_chat_id": "...",
  "external_buyer_id": "...",
  "item_title": "...",
  "listed_price": "...",
  "currency": "EUR",
  "message_text": "...",
  "created_at_source": "2026-03-10T10:00:00.000Z",
  "source_message_id": "...",
  "source_event_id": "...",
  "external_item_key": "..."
}
```

Optional metadata: `collector_received_at`, `collector_version`, `source`.

---

## 5) Synthetic identity and dedupe

Because message-level native ID may be absent:

### Implemented strategy (A)
- `source_message_id`: hash(chat_id + buyer_id + direction + timestamp + normalized_text + ordinal_hint)
- `source_event_id`: hash(chat_id + buyer_id + source_message_id + timestamp + direction)

### Alternative strategy (B, not default)
- window-sequence based identity + payload hash.

### Dedupe model
- at-least-once delivery with collector-side dedupe + outbox.
- Sent-event ledger + per-chat cursor persisted in SQLite.
- Controlled resync mode `--resync` may revisit window, dedupe prevents mass repeats.

---

## 6) Challenge/manual intervention runbook

If `challenge_detected`:
1. Switch to diagnostic mode (`DIAGNOSTIC_HEADFUL=true`).
2. Run collector manually and complete challenge/login legally.
3. Confirm new valid session saved at `SESSION_STATE_PATH`.
4. Return to headless mode and restart systemd service.

No anti-bot bypass is implemented.

---

## 7) Proxy/VPN model

- VPN is external (host/container level).
- App-level proxy via `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD`.
- Network/access failures are logged and trigger recovery loop.

---

## 8) Commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run dev -- --dry-run
npm run dev -- --smoke --dry-run
npm run dev -- --resync
npm run bootstrap-session
```

---


## Login dynamic-content readiness

- Login checks are resilient for JS-heavy pages: `domcontentloaded` + best-effort `networkidle` + loader-hidden wait before interacting with fields.
- Challenge detection is network/DOM-based (marker text + known challenge selectors), but **no anti-bot bypass** is implemented.
- Unstable selector notes (may require updates if UI changes):
  - login: `input[type="email"], input[name*="email" i], input[name*="user" i]`
  - password: `input[type="password"]`
  - submit: `button[type="submit"], button:has-text("Login"), button:has-text("Sign in")`

---


## Linux/VNC manual session bootstrap runbook

Use this mode when challenge/login must be completed by an operator once, then reused by the headless collector.

### 1) Prepare Linux display session
Example with a VNC server (conceptual):
- Ensure an X server is running.
- Export display variables in the shell where you run bootstrap:

```bash
export DISPLAY=:1
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
```

If `DISPLAY` is missing, bootstrap exits with a clear error and instructions.

### 2) Run bootstrap command
```bash
npm run bootstrap-session
```

This command:
- launches Chromium in **headful** mode on existing `DISPLAY`,
- uses the **same** `SESSION_STATE_PATH` as main collector,
- opens `SITE_URL`, waits for dynamic login readiness,
- lets operator complete challenge/login manually,
- persists storage state on successful authenticated marker detection.

### 3) Complete challenge/login manually
In the opened browser window:
- complete any challenge manually,
- login to account,
- wait for logged-in UI (inbox/messages/logout marker).

### 4) Completion statuses
Bootstrap exits with one status:
- `success` — session saved and ready for headless collector.
- `auth_expired` — login page not interactable/usable as expected.
- `challenge_detected` — challenge still present at timeout.
- `manual_incomplete` — login form still visible (operator did not finish).
- `timeout` — bootstrap window timed out before success.

### 5) Verify persisted state
Check paths from env:
- session state: `SESSION_STATE_PATH` (default `./data/session-state.json`)
- durable collector state DB: `STATE_DB_PATH` (default `./data/collector.db`)

```bash
ls -lh ./data/session-state.json ./data/collector.db
```

### 6) Start normal headless collector
After successful bootstrap:
```bash
npm run build
npm start
```

The collector will reuse the same `SESSION_STATE_PATH` and should not require re-login while session remains valid.

---

## 9) Scope boundaries (v1)

- Inbound buyer text messages only.
- No outbound message sending.
- No AI logic/translation/moderation.
- No media/attachments.

---

## 10) Known risks and limitations

- Extractor selectors and endpoint assumptions may drift with UI/API changes.
- Cloudflare/challenge may require periodic manual intervention.
- Synthetic IDs have residual collision risk under extreme same-text/same-time bursts.
- Without live account smoke validation, field mapping confidence is provisional.
