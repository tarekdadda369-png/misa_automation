# Deploy on Render.com

**For the deployer:** see **[DELIVER-TO-IT.md](./DELIVER-TO-IT.md)** — what the project owner sends you.

**Yes, you can use Render** — but use a **Docker Web Service** (not static site, not free tier for production).

This project is an **API + headless browser**, not a normal website.

---

## Will it work?

| Requirement | Render |
|-------------|--------|
| Node.js API | Yes — Web Service |
| Headless Chromium | Yes — Docker + `Dockerfile` |
| Runs 24/7 | Yes — **paid** plan (free spins down) |
| 15–30 min per registration | Yes — API returns `202` immediately; work runs in background |
| 3 parallel clients | **No on small plan** — use `MAX_CONCURRENT_RUNS=1` on 2 GB; upgrade RAM for more |
| No visible browser | Yes — `PLAYWRIGHT_HEADLESS=1` (default in Docker) |

---

## Recommended Render setup

| Setting | Value |
|---------|--------|
| **Type** | Web Service |
| **Runtime** | **Docker** (use repo `Dockerfile`) |
| **Plan** | **Standard** minimum (2 GB RAM) — **Pro 4 GB** if 2 parallel runs |
| **Health check** | `/api/v1/health` |
| **Region** | Closest to Saudi / users |

**Do not use** Free tier for production — service sleeps and has low RAM.

---

## Deploy steps

### Option A — Blueprint (`render.yaml`)

1. Push `playwright-cli` to GitHub.
2. Render Dashboard → **New** → **Blueprint**.
3. Connect repo; Render reads `render.yaml`.
4. Set secret env vars in dashboard:
   - `OPENAI_API_KEY`
   - `CORS_ORIGIN` (company dashboard URL)
5. Deploy.

### Option B — Manual

1. **New Web Service** → connect GitHub repo.
2. **Root directory:** `playwright-cli` (if monorepo) or repo root.
3. **Runtime:** Docker  
4. **Dockerfile path:** `Dockerfile`
5. **Environment variables:**

```env
NODE_ENV=production
PLAYWRIGHT_HEADLESS=1
MAX_CONCURRENT_RUNS=1
RUN_AI_FALLBACK=1
OPENAI_API_KEY=sk-...
CORS_ORIGIN=https://their-dashboard.com
```

6. **Health check path:** `/api/v1/health`
7. Create Web Service.

---

## After deploy

1. **URL:** `https://misa-automation-runner.onrender.com` (example)
2. **API key:** first deploy logs show key, or open shell and read `server-config.json`:

```bash
cat server-config.json
```

3. Give dev team:
   - Base URL: `https://your-service.onrender.com`
   - API key
   - [EXTERNAL-API.md](./EXTERNAL-API.md)

4. Test:

```bash
curl https://your-service.onrender.com/api/v1/health
```

---

## Memory on Render

| Plan | RAM | Suggested `MAX_CONCURRENT_RUNS` |
|------|-----|----------------------------------|
| Standard | 2 GB | **1** |
| Pro | 4 GB | **2** |
| Pro Plus | 8 GB | **3** |

Each MISA run uses ~1.5–2 GB while active.

---

## Important limitations on Render

1. **Ephemeral disk** — `server-config.json` and `uploads/` reset on **redeploy**.  
   - Save API key after first deploy.  
   - Optional: [Render persistent disk](https://render.com/docs/disks) mounted at `/app/persist` (advanced).

2. **No parallel on 2 GB** — start with `MAX_CONCURRENT_RUNS=1`; scale plan for more.

3. **Cold start** — first request after idle may be slow on lower tiers.

4. **OTP + files** — work the same via API; company dashboard must call `POST /api/otp` per `runId`.

---

## Company dashboard integration

Same as any cloud host:

```http
POST https://your-app.onrender.com/api/v1/runs
Authorization: Bearer <apiKey>
```

See [EXTERNAL-API.md](./EXTERNAL-API.md).

---

## Render vs company VPS

| | Render | Company Windows/Linux VPS |
|--|--------|---------------------------|
| Setup | Easier (Git push) | IT installs Node/Docker |
| Cost | Monthly Render bill | Server they already have |
| RAM for 3 parallel | Expensive tier | 8 GB VPS often cheaper |
| Best for | Quick cloud API | Full control, more parallel runs |

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Executable doesn't exist` | Must use **Docker** deploy, not native Node build |
| OOM / crash | Lower `MAX_CONCURRENT_RUNS=1`; upgrade plan |
| 502 timeout on POST | Use `/api/v1/runs` (returns 202), not long streaming `/api/run` |
| API key lost after deploy | Copy from logs or set `API_KEY` env (future); back up `server-config.json` |

---

## Summary for IT

> **Yes, Render works** with Docker Web Service, headless Playwright, paid plan 2 GB+, `MAX_CONCURRENT_RUNS=1` to start. Developers trigger via `POST /api/v1/runs`. Not suitable for free tier or static hosting.
