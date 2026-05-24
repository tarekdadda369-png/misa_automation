# MISA Playwright Automation + Dashboard

End-to-end Invest Saudi (MISA) registration: Playwright test, web dashboard, OTP panel, and **Skyvern-style AI recovery** when steps fail.

## Quick start (local)

```powershell
cd playwright-cli
npm install
npx playwright install chromium

# Dashboard
pm2 start ecosystem.config.js
# Open http://localhost:3050

# Run test (headed)
npx playwright test tests/misa.spec.js --headed
```

## AI recovery (when automation stops)

Set before dashboard run or in PM2 environment:

```powershell
$env:RUN_AI_FALLBACK="1"
$env:OPENAI_API_KEY="sk-..."
$env:AI_FALLBACK_MODEL="gpt-4o"
$env:AI_FALLBACK_MAX_TURNS="12"
```

| Layer | Steps | On failure |
|-------|-------|------------|
| Engine | 1, 2, 5, 6 (JSON) | AI agent → retry same step or continue |
| Worker | 3, 4, 7, 8 (proven code) | AI agent → retry worker or continue |
| OTP | Email/Mobile | Dashboard + retry (not LLM) |

Logs: `CHECKPOINT: Step N step X/8` — exact resume point.

## Remote dashboard (ngrok)

```powershell
.\start-dashboard-ngrok.bat
```

See [NGROK.md](./NGROK.md).

## Cloud hosting + API for developers

Host on a **VPS** (not shared web hosting). Developers call `POST /api/v1/runs` from their dashboard.

See [HOSTING-CLOUD.md](./HOSTING-CLOUD.md), [RENDER.md](./RENDER.md) (Render.com), and [EXTERNAL-API.md](./EXTERNAL-API.md).

## Give the project to the company (not your laptop)

Production must run on **their always-on Windows server** — when your PC is off, automation stops.

1. Build zip: `powershell -File scripts\package-for-company.ps1`
2. Company IT: [COMPANY-HANDOFF.md](./COMPANY-HANDOFF.md) + `scripts\company-server-setup.ps1`
3. Company devs: [EXTERNAL-API.md](./EXTERNAL-API.md) (their dashboard → API)

See also [DEPLOY.md](./DEPLOY.md).

## Config

- `site_data/misa_config.json` — defaults + step definitions
- `config.json` — per-run overrides from dashboard
- `server-config.json` — API key (auto-generated)

## Docs

- [SERVER-ADMIN.md](./SERVER-ADMIN.md) — **for IT/sysadmin** (language, trigger, ports)
- [EXTERNAL-API.md](./EXTERNAL-API.md) — **company’s own dashboard** → connect via API
- [COMPANY-OPS.md](./COMPANY-OPS.md) — 24/7 hosting, upgrades
- [site_data/README.md](./site_data/README.md) — engine steps
- [NGROK.md](./NGROK.md) — public URL
- [DEPLOY.md](./DEPLOY.md) — server upload checklist
- [.env.example](./.env.example) — AI env template
