# Host on a cloud service + developers use the API

**Yes — this is the right production model.**

```
[Company developers]  →  HTTPS API  →  [Cloud VPS / VM]  →  MISA website
     their dashboard         POST /api/v1/runs      Playwright + Node
```

Your laptop is **not** in the path. The project runs on a **server that stays on 24/7**.

API docs: [EXTERNAL-API.md](./EXTERNAL-API.md)

---

## What works vs what does not

| Hosting type | Works? | Why |
|--------------|--------|-----|
| **VPS / cloud VM** (Azure, AWS, DigitalOcean, Hetzner) | ✅ Yes | Full Node + Chromium + long runs |
| **Docker on VPS** | ✅ Yes | See `Dockerfile` in this folder |
| **Windows cloud VM** | ✅ Yes | Best if headless mode fails on MISA |
| Shared cPanel / PHP hosting | ❌ No | No Playwright, no long processes |
| Vercel / Netlify / static sites | ❌ No | Serverless, no browser |
| Your PC + ngrok | ⚠️ Dev only | Stops when PC is off |

---

## What developers need (only API)

They **do not** deploy this repo. They only call your hosted URL:

| Call | Purpose |
|------|---------|
| `POST /api/v1/runs` | Start registration (JSON body) |
| `GET /api/v1/runs/{runId}` | Status + `otp.email` / `otp.mobile` |
| `POST /api/otp` | Submit OTP codes |
| `GET /api/logs?runId=` | Optional live log |

Auth: `Authorization: Bearer <apiKey>` from `server-config.json` on the server.

Example payload: [api/run-payload.example.json](./api/run-payload.example.json)

---

## Option A — Linux VPS + Docker (recommended for cloud)

**Good providers:** DigitalOcean, Hetzner, AWS EC2 (Ubuntu), Azure Linux VM.

### 1. On the server

```bash
# Install Docker, clone or upload playwright-cli
cd /opt/misa-automation/playwright-cli

cp .env.example .env
# Edit .env: OPENAI_API_KEY, RUN_AI_FALLBACK=1, PLAYWRIGHT_HEADLESS=1

docker compose up -d --build
```

### 2. HTTPS

Put **nginx** or **Caddy** in front:

- `https://automation.company.com` → `http://127.0.0.1:3050`

### 3. Get API key (first start)

```bash
docker compose logs | grep "API key"
# or copy file out:
docker compose cp misa-runner:/app/server-config.json ./server-config.json
```

Give developers the `apiKey` value securely.

### 4. Give developers

- Base URL: `https://automation.company.com`
- API key: from step 3

### 5. Health check

```bash
curl https://automation.company.com/api/v1/health
# {"ok":true,"service":"misa-automation-runner",...}
```

---

## Option B — Windows cloud VM (no Docker)

Same as [COMPANY-HANDOFF.md](./COMPANY-HANDOFF.md) but machine is **Azure/AWS Windows**, not office PC.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\company-server-setup.ps1
pm2 start ecosystem.config.js
```

Use **headed** browser (default). Open RDP once so desktop session exists.

---

## Environment variables on the host

```env
# Required for AI recovery
RUN_AI_FALLBACK=1
OPENAI_API_KEY=sk-...

# Cloud Linux (Docker / Ubuntu VPS)
PLAYWRIGHT_HEADLESS=1

# Server port (default 3050)
PORT=3050

# Lock API to company dashboard origin (optional)
CORS_ORIGIN=https://dashboard.company.com
```

---

## Server size (minimum)

| Resource | Suggestion |
|----------|------------|
| RAM | 4 GB (8 GB safer) |
| CPU | 2 vCPU |
| Disk | 40 GB |
| OS | Ubuntu 22.04 or Windows Server |

Default: **3 parallel** headless browsers (`MAX_CONCURRENT_RUNS=3`). Use **8 GB RAM** minimum; **16 GB** for 5 parallel.

---

## Security checklist

- [ ] HTTPS only (no public `http://IP:3050` in production)
- [ ] API key only on **backend** of company dashboard (not in browser JS if possible)
- [ ] Firewall: only 443 (nginx), not 3050 to the internet
- [ ] `.env` and `server-config.json` only on server
- [ ] Rotate API key if leaked

---

## Updates

```bash
git pull   # or upload new zip
docker compose up -d --build
# or: pm2 restart misa-dashboard
```

---

## Summary

| Question | Answer |
|----------|--------|
| Can we use a hosting service? | **Yes — VPS/VM or Docker**, not cheap shared hosting |
| Can developers run via API? | **Yes — already built** (`/api/v1/runs`) |
| Is your PC required? | **No** |
| Who pays OpenAI? | Company, key in server `.env` |

**Flow:** Company pays for a small cloud server → you/IT deploy this project → devs integrate [EXTERNAL-API.md](./EXTERNAL-API.md) → users click Run on **their** dashboard.
