# Deploy on Render

**Web Service · Docker · Standard 2 GB plan** (not Free tier)

If the GitHub repo is private, add Render (or the deployer) as a collaborator.

## Settings

| Field | Value |
|-------|--------|
| Runtime | Docker |
| Dockerfile | `Dockerfile` |
| Health check | `/api/v1/health` |

## Environment variables

| Name | Value |
|------|--------|
| `OPENAI_API_KEY` | Company key (secret) |
| `RUN_AI_FALLBACK` | `1` |
| `NODE_ENV` | `production` |
| `PLAYWRIGHT_HEADLESS` | `1` |
| `MAX_CONCURRENT_RUNS` | `1` (2 GB) or `3` (8 GB) |
| `PORT` | `3050` |
| `CORS_ORIGIN` | Company dashboard URL (optional) |

Do not put secrets in GitHub.

## After deploy

Send back:

1. `https://your-service.onrender.com`
2. API key from `server-config.json` (first deploy logs)

Test: `GET /api/v1/health` → `{"ok":true}`

Developers integrate using [EXTERNAL-API.md](./EXTERNAL-API.md).
