# MISA automation runner

Playwright automation for Invest Saudi (MISA) registration. Exposes an HTTP API so your company dashboard can start runs, poll status, and submit OTP codes.

## Docs

| File | For |
|------|-----|
| [RENDER.md](./RENDER.md) | IT — deploy on Render (Docker) |
| [EXTERNAL-API.md](./EXTERNAL-API.md) | Developers — connect their dashboard |
| [api/run-payload.example.json](./api/run-payload.example.json) | JSON body for `POST /api/v1/runs` |

## Stack

Node.js 20 · Playwright (Chromium) · no database

## Production

- Headless browser (`NODE_ENV=production` or `PLAYWRIGHT_HEADLESS=1`)
- Parallel runs: `MAX_CONCURRENT_RUNS` (default 3)
- Secrets in `.env` on the server — never commit `.env`

## Local dev

```powershell
npm install
npx playwright install chromium
copy .env.example .env
node server.js
# http://localhost:3050
```

Optional visible browser: `PLAYWRIGHT_HEADED=1`

## Config

- `site_data/misa_config.json` — step templates
- `server-config.json` — API key (created on first start)
