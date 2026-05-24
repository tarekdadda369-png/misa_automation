# Deploy to server (production / team access)

**Handing off to the company (not your PC):** read [COMPANY-HANDOFF.md](./COMPANY-HANDOFF.md) first.

## What you upload

Upload the **`playwright-cli`** directory. On the server:

```bash
cd playwright-cli
npm install
npx playwright install chromium
```

Do **not** upload `node_modules/` from your PC (different OS may break native binaries).

## Secrets (never commit)

| File | Purpose |
|------|---------|
| `.env` | `OPENAI_API_KEY`, `RUN_AI_FALLBACK=1` |
| `server-config.json` | Dashboard API key (created on first start) |
| `config.json` | Run payloads from UI |

Example `.env`:

```
RUN_AI_FALLBACK=1
OPENAI_API_KEY=sk-...
AI_FALLBACK_MODEL=gpt-4o
AI_FALLBACK_MAX_TURNS=12
```

## PM2 (dashboard + test launcher)

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Dashboard: `http://SERVER_IP:3050`

## ngrok (optional)

On the server or your PC (if Playwright runs locally):

```bash
ngrok http 3050
```

Windows: `start-dashboard-ngrok.bat`

## AI on production runs

The dashboard spawns:

```text
npx playwright test tests/misa.spec.js --headed
```

Child process inherits `process.env`, so set AI variables in:

- `.env` loaded by PM2, or
- `ecosystem.config.js` `env` block, or
- System environment on the host

Verify in logs:

```text
WORKFLOW: AI agent recovery ENABLED (RUN_AI_FALLBACK=1 + OPENAI_API_KEY)
```

On failure:

```text
[AI-AGENT] Skyvern recovery — Step 5 step 7/12
CHECKPOINT: Step 5 step 7/12 "Select City" — ...
```

## Playwright on server

- Windows: headed mode needs a logged-in desktop session (RDP).
- Linux: use `xvfb-run` for headed, or run headed on a Windows worker and only host the dashboard on Linux.

Example Linux headed:

```bash
xvfb-run npx playwright test tests/misa.spec.js --headed
```

## Firewall

Open **3050** (dashboard) only. Do not expose Playwright browsers to the internet.

## Updates

1. Pull/upload new code
2. `npm install`
3. `pm2 restart misa-dashboard`
