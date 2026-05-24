# Technical brief for server administrator (production)

Short answers for IT / DevOps who will host this on the **company server**.

---

## 1. What language / stack is this project?

| Layer | Technology |
|-------|------------|
| **Runtime** | **Node.js** (JavaScript) — version **18 or 20 LTS** |
| **Package manager** | **npm** |
| **Browser automation** | **Playwright** (Chromium) |
| **API / web server** | **Node.js** built-in HTTP (`server.js`) — not PHP, not Python, not Java |
| **Process manager (Windows)** | **PM2** (keeps service running after reboot) |
| **Optional (Linux cloud)** | **Docker** + Docker Compose |
| **AI recovery (optional)** | OpenAI HTTP API (env var `OPENAI_API_KEY`) |

**Summary for IT:** *“Node.js 20 application with Playwright Chromium; exposes a REST API on port 3050.”*

---

## 2. How is the workflow triggered?

Automation does **not** run on a schedule by default. It starts when something sends an **HTTP request** to the server.

### Main trigger (production — company dashboard)

```http
POST /api/v1/runs
Authorization: Bearer <API_KEY>
Content-Type: application/json

<body = registration JSON — see api/run-payload.example.json>
```

| Step | What happens |
|------|----------------|
| 1 | Company dashboard sends JSON to this URL |
| 2 | Server saves config, starts **one** Playwright test process |
| 3 | Playwright opens Chromium and runs MISA registration (Steps 1–8) |
| 4 | Dashboard polls `GET /api/v1/runs/{runId}` for status |
| 5 | When OTP needed, dashboard calls `POST /api/otp` with the code |
| 6 | Process exits; status becomes `success` or `failed` |

**Summary for IT:** *“Triggered by HTTP POST from the company web app; each click = one background Playwright job.”*

### Other endpoints (reference)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/v1/health` | No | Health check / monitoring |
| GET | `/api/v1/runs/{runId}` | No | Run status + OTP state |
| GET | `/api/logs?runId=` | Bearer | Last log lines |
| POST | `/api/otp` | No | Submit email/mobile OTP |
| POST | `/api/run` | No | Legacy: same as v1 but streams log in response (built-in HTML UI only) |

Full API doc: [EXTERNAL-API.md](./EXTERNAL-API.md)

### What runs on the server (process tree)

```
node server.js          ← always running (PM2 or Docker)
    └── npx playwright test tests/misa.spec.js   ← started per POST /api/v1/runs
            └── chromium (browser)
```

Test file: `tests/misa.spec.js`  
Config template: `site_data/misa_config.json`  
Per-run data: `config_<runId>.json` (created by API, deleted after run)

---

## 3. Production requirements

| Requirement | Detail |
|-------------|--------|
| **OS** | Windows Server 2019+ **or** Linux Ubuntu 22.04+ (Docker) |
| **RAM** | **8 GB** for 3 parallel runs (~2 GB per browser); 16 GB for 5 |
| **CPU** | **4 vCPU** for 3 parallel; 2 vCPU if only 1 at a time |
| **Disk** | 40 GB+ (`uploads/`, logs, Playwright browser) |
| **Network** | Outbound HTTPS (MISA site + OpenAI if AI enabled) |
| **Inbound** | Port **3050** (internal) or **443** via reverse proxy (public) |
| **Uptime** | Server must stay on; **one run ≈ 15–30 minutes** |
| **Concurrent runs** | **3 by default** (`MAX_CONCURRENT_RUNS`) — client 1, 2, 3 in parallel |
| **Browser in production** | **Headless** (no window) — `NODE_ENV=production` or `PLAYWRIGHT_HEADLESS=1` |

### Windows-specific

- Playwright uses a **visible browser** unless `PLAYWRIGHT_HEADLESS=1` (Linux/Docker).
- A **logged-in desktop session** (RDP) may be required for headed mode.

### Linux / Docker

- Set `PLAYWRIGHT_HEADLESS=1` in `.env`
- Use `docker compose up -d` — see [HOSTING-CLOUD.md](./HOSTING-CLOUD.md)
- `shm_size: 2gb` for Chromium (already in `docker-compose.yml`)

---

## 4. Install on company server (quick)

### Windows

```powershell
# Install Node.js 20 LTS from https://nodejs.org
cd C:\misa-automation\playwright-cli
powershell -ExecutionPolicy Bypass -File .\scripts\company-server-setup.ps1
notepad .env
pm2 restart misa-dashboard
```

### Linux (Docker)

```bash
cd /opt/misa-automation/playwright-cli
cp .env.example .env && nano .env
docker compose up -d --build
curl http://localhost:3050/api/v1/health
```

---

## 5. Environment file (`.env`) — secrets on server only

```env
NODE_ENV=production
RUN_AI_FALLBACK=1
OPENAI_API_KEY=sk-...
AI_FALLBACK_MODEL=gpt-4o
PLAYWRIGHT_HEADLESS=1
MAX_CONCURRENT_RUNS=3
PORT=3050
CORS_ORIGIN=https://their-dashboard.company.com
```

Do not commit `.env` to git.

---

## 6. API key (dashboard → server auth)

On first start, server creates **`server-config.json`**:

```json
{ "apiKey": "long-random-hex-string" }
```

Give `apiKey` to the **development team** (secure channel). They send it as:

`Authorization: Bearer <apiKey>`

---

## 7. HTTPS (production)

Do **not** expose raw `:3050` to the internet without TLS.

Typical setup:

```
Internet → nginx / IIS / Caddy (443, TLS)
              → http://127.0.0.1:3050  (this Node app)
```

Example health URL after setup:

`https://automation.company.com/api/v1/health`

---

## 8. Firewall

| Port | Direction | Who |
|------|-----------|-----|
| 443 | Inbound | Public (via reverse proxy) |
| 3050 | Inbound | Internal only, or localhost |
| 443 outbound | Outbound | Server → MISA + OpenAI |

---

## 9. Monitoring

| Check | Expected |
|-------|----------|
| `GET /api/v1/health` | `{"ok":true,...}` |
| PM2 / Docker | Process `misa-dashboard` or container **running** |
| Disk | `uploads/` growth — plan cleanup if needed |
| Logs | `logs/` (PM2) or `docker compose logs` |

---

## 10. Updates (workflow changes)

```powershell
pm2 stop misa-dashboard
# replace application files (keep .env and server-config.json)
npm install
npx playwright install chromium
pm2 restart misa-dashboard
```

Or on Docker: `docker compose up -d --build`

---

## 11. Files the admin should back up

| File / folder | Why |
|---------------|-----|
| `.env` | OpenAI + settings |
| `server-config.json` | API key |
| `site_data/misa_config.json` | Step definitions |

---

## 12. One-page answers (copy-paste for email)

**Language:** Node.js 20 (JavaScript), Playwright, Chromium.

**Trigger:** HTTP API — `POST /api/v1/runs` with JSON body and Bearer API key; started by the company registration dashboard (not cron, not manual CLI in production).

**Service port:** 3050 (behind HTTPS proxy in production).

**Install:** Node + npm install + Playwright Chromium, or Docker Compose on Linux.

**Docs:** `SERVER-ADMIN.md` (this file), `EXTERNAL-API.md` (developers), `COMPANY-HANDOFF.md` (full handoff).
