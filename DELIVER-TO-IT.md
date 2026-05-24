# What to give the person who deploys on Render

Send this page + the zip from `scripts\package-for-company.ps1` (or GitHub repo access).

---

## 1. The project files

**Option A — Zip (easiest)**

```powershell
cd playwright-cli
powershell -ExecutionPolicy Bypass -File .\scripts\package-for-company.ps1
```

Send: `dist\misa-automation-handoff-YYYYMMDD.zip`

**Option B — GitHub**

Give access to the repo; they deploy folder **`playwright-cli`** (root of the app).

**Do not include in zip:** `.env`, `node_modules`, `server-config.json`, `config.json`, `uploads/`

---

## 2. Documents for them

| File | Who reads it |
|------|----------------|
| **RENDER.md** | Deploy on Render (step by step) |
| **SERVER-ADMIN.md** | Language, API, ports, RAM |
| **EXTERNAL-API.md** | Give to **developers** (company dashboard integration) |
| **api/run-payload.example.json** | JSON format for `POST /api/v1/runs` |
| **render.yaml** | Optional Render Blueprint (auto config) |
| **Dockerfile** | Required for Render Docker deploy |

---

## 3. Secrets — you prepare, they paste in Render dashboard

They add these in Render → **Environment**:

| Variable | Who provides | Example |
|----------|----------------|---------|
| `OPENAI_API_KEY` | Company / you | `sk-...` |
| `RUN_AI_FALLBACK` | Fixed | `1` |
| `NODE_ENV` | Fixed | `production` |
| `PLAYWRIGHT_HEADLESS` | Fixed | `1` |
| `MAX_CONCURRENT_RUNS` | IT chooses | `1` on 2GB plan, `3` on 8GB |
| `CORS_ORIGIN` | Dev team URL | `https://dashboard.company.com` |
| `AI_FALLBACK_MODEL` | Optional | `gpt-4o` |

**Do not send OpenAI key in email/chat** — use password manager or Render secret UI only.

---

## 4. Render settings (copy for IT)

| Setting | Value |
|---------|--------|
| Service type | **Web Service** |
| Runtime | **Docker** |
| Dockerfile | `Dockerfile` |
| Root directory | `playwright-cli` (if repo has parent folder) |
| Plan | **Standard** (2 GB) minimum — **not Free** |
| Health check | `/api/v1/health` |
| Port | `3050` (also set `PORT=3050` in env) |

---

## 5. After deploy — IT sends back to you / dev team

| Item | Where |
|------|--------|
| **Public URL** | e.g. `https://misa-automation-xxxx.onrender.com` |
| **API key** | `server-config.json` on server, or Render logs on first start |

Developers need **both** for integration.

Test:

```text
GET https://YOUR-URL.onrender.com/api/v1/health
→ {"ok":true,...}
```

---

## 6. What developers need (forward from IT)

```
Runner URL:  https://________________.onrender.com
API key:     ________________  (Bearer token)
Docs:        EXTERNAL-API.md
Payload:     api/run-payload.example.json
```

**Start a run:**

```http
POST https://YOUR-URL.onrender.com/api/v1/runs
Authorization: Bearer API_KEY
Content-Type: application/json

{ "_clientId": "client-1", ...fields from run-payload.example.json... }
```

**Poll status:**

```http
GET https://YOUR-URL.onrender.com/api/v1/runs/{runId}
```

**OTP:**

```http
POST https://YOUR-URL.onrender.com/api/otp
{ "type": "email", "otp": "123456", "runId": "..." }
```

---

## 7. What you do NOT need to give

| Not needed | Why |
|------------|-----|
| Your laptop / PC access | They host on Render |
| Your `.env` file | They create new secrets on Render |
| `node_modules` | Installed at build |
| Database setup | No database |
| Your `index.html` dashboard | Optional; company uses their UI |

---

## 8. Email template (copy to IT)

> **Subject:** MISA automation — deploy on Render  
>  
> Please deploy the attached zip (or GitHub repo folder `playwright-cli`) as a **Render Web Service** using **Docker**.  
>  
> - Guide: **RENDER.md** inside the zip  
> - Health check: `/api/v1/health`  
> - Plan: Standard 2GB minimum (not Free tier)  
> - Env: see **DELIVER-TO-IT.md** section 3  
>  
> After deploy, send us:  
> 1. Public HTTPS URL  
> 2. API key from `server-config.json`  
>  
> Our developers will connect our dashboard using **EXTERNAL-API.md**.

---

## Checklist (you)

- [ ] Zip built (`package-for-company.ps1`) or repo access  
- [ ] OpenAI key ready for company (or they use their own)  
- [ ] `CORS_ORIGIN` = company dashboard URL (ask dev team)  
- [ ] IT has RENDER.md + DELIVER-TO-IT.md  
- [ ] Devs have EXTERNAL-API.md + example JSON  
- [ ] After deploy: received URL + API key  
- [ ] One test run from dev dashboard succeeded  
