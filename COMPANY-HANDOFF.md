# Hand off automation to the company (not your personal PC)

If the runner lives on **your laptop**, automation **stops when you shut down or sleep the PC**.  
The company must host this on **their own always-on server** (or cloud VM).

You deliver the **project + docs**. Their IT installs it once. Their dashboard calls the API on **their** server.

---

## Who hosts what

| Piece | Owner | Runs on |
|-------|--------|---------|
| **Automation runner** (`server.js` + Playwright) | Company IT | Company Windows Server / cloud VM |
| **Their registration dashboard** | Company dev team | Their web app (any host) |
| **OpenAI account** | Company (recommended) | `.env` on company server only |
| **MISA browser sessions** | Runner server | Headed Chrome on that server |

You do **not** need to keep your PC on 24/7.

---

## What to give the company (delivery package)

Zip the **`playwright-cli`** folder **without**:

- `node_modules/`
- `uploads/` (old runs)
- `test-results/`
- `.env` (you create a fresh one on their server — never send your personal keys in email)
- `config.json`, `config_*.json`, `otp_session*.json`
- `logs/`

**Include these docs** (already in the folder):

| Document | For |
|----------|-----|
| [COMPANY-HANDOFF.md](./COMPANY-HANDOFF.md) | IT — install server |
| [EXTERNAL-API.md](./EXTERNAL-API.md) | Devs — connect their dashboard |
| [api/run-payload.example.json](./api/run-payload.example.json) | Devs — JSON field names |
| [.env.example](./.env.example) | IT — copy to `.env` |
| [DEPLOY.md](./DEPLOY.md) | IT — details |

Optional: run `scripts\package-for-company.ps1` to build the zip.

---

## Server the company must provide

**Required:** Windows Server 2019+ or Windows 10/11 **dedicated machine** (not a laptop that goes home).

| Requirement | Why |
|-------------|-----|
| Always powered on | Runner + browser 24/7 |
| User logged in (RDP ok) | Playwright `--headed` needs a desktop session |
| 8 GB+ RAM, 4 CPU | Browser + Node |
| Outbound HTTPS | MISA site + OpenAI API |
| Inbound **3050** (or HTTPS via reverse proxy) | Their dashboard calls the API |

### Good options

1. **Cloud VPS + Docker** — DigitalOcean, Hetzner, AWS, Azure (see [HOSTING-CLOUD.md](./HOSTING-CLOUD.md))  
2. **Company on-prem server** — VM or physical box in the office  
3. **Azure / AWS Windows VM** — if Linux headless is not reliable on MISA  

### Bad options

- Your personal PC  
- Developer laptop  
- Machine that sleeps at night  

---

## For the person who manages the server

Send them **[SERVER-ADMIN.md](./SERVER-ADMIN.md)** — it answers:

- **Language:** Node.js 20 (JavaScript) + Playwright + Chromium  
- **Trigger:** HTTP `POST /api/v1/runs` from the company dashboard (not cron)  
- Ports, RAM, firewall, HTTPS, install commands  

---

## Company IT — install (one time)

On the **company server**, as Administrator:

```powershell
# 1. Install Node.js 20 LTS from https://nodejs.org
# 2. Unzip playwright-cli to e.g. C:\misa-automation\playwright-cli
cd C:\misa-automation\playwright-cli

# 3. Automated setup (or follow steps in DEPLOY.md)
powershell -ExecutionPolicy Bypass -File .\scripts\company-server-setup.ps1

# 4. Edit secrets
notepad .env          # OPENAI_API_KEY, RUN_AI_FALLBACK=1
# server-config.json is created on first start — share apiKey with dev team only

# 5. Start service
pm2 start ecosystem.config.js
pm2 save
pm2-startup install   # restart after reboot (see script output)

# 6. Open firewall (if other machines call this server)
New-NetFirewallRule -DisplayName "MISA Runner" -Direction Inbound -LocalPort 3050 -Protocol TCP -Action Allow
```

**Keep an RDP session open** or use a logged-in service account — headed browser fails on a locked headless session.

### HTTPS (production)

Their dashboard should call `https://automation.company.com`, not raw `:3050`.

Options for IT:

- **IIS / nginx** reverse proxy → `localhost:3050`  
- **Cloudflare Tunnel** on the server  
- **ngrok** with reserved domain (quick test, not ideal long-term)

---

## Company dev team — connect their dashboard

They do **not** install Playwright. They only call your runner:

1. **Base URL** — `https://automation.company.com` (from IT)  
2. **API key** — from `server-config.json` on the server (IT gives securely)  
3. Follow [EXTERNAL-API.md](./EXTERNAL-API.md)

Flow: their **Run** → `POST /api/v1/runs` → poll `GET /api/v1/runs/{runId}` → `POST /api/otp` when needed.

---

## OpenAI billing

Put the **company’s** OpenAI key in `.env` on **their** server:

```env
RUN_AI_FALLBACK=1
OPENAI_API_KEY=sk-...
AI_FALLBACK_MODEL=gpt-4o
```

You are not responsible for API cost after handoff.

---

## Your handoff checklist (before you stop hosting)

- [ ] Zip project (`package-for-company.ps1` or manual)  
- [ ] Company server ready (Windows, always on)  
- [ ] IT ran `company-server-setup.ps1` + `pm2 start`  
- [ ] `.env` on **their** server with **their** OpenAI key  
- [ ] Test: `GET https://.../api/v1/health` → `{ "ok": true }`  
- [ ] Test: one full registration from **their** dashboard  
- [ ] Devs have EXTERNAL-API.md + example JSON  
- [ ] You removed / rotated any keys that were only on your PC  
- [ ] You can shut down your laptop — runs use company URL only  

---

## Upgrades later

You (or their dev) send an updated zip or `git pull` on the server:

```powershell
pm2 stop misa-dashboard
# replace files, keep .env and server-config.json
npm install
npx playwright install chromium
pm2 restart misa-dashboard
```

Bump `WORKFLOW_VERSION` in `tests/misa.spec.js` when you ship workflow changes.

---

## Summary

| Your PC off | Company server on |
|-------------|-------------------|
| Automation **stops** | Automation **keeps running** |
| Bad for production | Correct for production |

**Give them the code + docs; they host on their server; their dashboard uses the API.**
