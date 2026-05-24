# Connect your company's dashboard to the automation runner

Your team keeps **their own UI**. The **company’s server** runs the automation engine (Playwright + AI). This must **not** run on a developer’s laptop that gets turned off.

They do **not** need `index.html`.

**IT install:** [COMPANY-HANDOFF.md](./COMPANY-HANDOFF.md)

---

## Architecture

```
[Company dashboard]  --HTTPS-->  [Company runner server :3050]  --headed-->  [MISA website]
        |                                    |
        | POST /api/v1/runs                  | Playwright + OpenAI (.env on company server)
        | GET  /api/v1/runs/:id               |
        | POST /api/otp                       |
```

---

## Setup (company IT — once)

1. Install on **always-on Windows Server** (see [COMPANY-HANDOFF.md](./COMPANY-HANDOFF.md)).
2. Give developers:
   - **Base URL** — e.g. `https://automation.company.com`
   - **API key** — from `server-config.json` → field `apiKey`
3. **OpenAI** key in `.env` on **that server** (company billing).

```powershell
pm2 restart misa-dashboard
```

---

## Authentication

Every protected request:

```http
Authorization: Bearer YOUR_API_KEY_FROM_server-config.json
```

Or query param: `?key=YOUR_API_KEY` (logs may expose this — prefer header).

---

## 1. Start a run (their "Run" button)

```http
POST /api/v1/runs
Authorization: Bearer <apiKey>
Content-Type: application/json
```

**Body:** same JSON as our internal dashboard. See [api/run-payload.example.json](./api/run-payload.example.json).

Optional fields:

- `"_runId": "unique-id"` — correlate in logs  
- `"_clientId": "client-1"` — label client 1 / 2 / 3 in status API  

### Multiple clients at the same time (production)

- **No visible browser** on the server (`NODE_ENV=production` or `PLAYWRIGHT_HEADLESS=1`).
- Default **`MAX_CONCURRENT_RUNS=3`** — client 1, 2, and 3 can run **in parallel** (do not wait for client 1 to finish).
- If more than 3 start at once, extra runs are **`queued`** and start automatically when a slot is free.

```http
POST /api/v1/runs  → client-1
POST /api/v1/runs  → client-2   (runs at same time)
POST /api/v1/runs  → client-3   (runs at same time)
POST /api/v1/runs  → client-4   (queued until one finishes)
```

**Response `202`:**

```json
{
  "success": true,
  "runId": "1779629702562",
  "clientId": "client-1",
  "phase": "running",
  "queuePosition": 0,
  "maxConcurrentRuns": 3,
  "message": "Automation started (headless browser)"
}
```

If queued:

```json
{
  "phase": "queued",
  "queuePosition": 2,
  "message": "Queued (position 2) — starts when a slot is free"
}
```

List all runs: `GET /api/v1/runs` (with Bearer token).

---

## 2. Poll status (progress + OTP needed)

```http
GET /api/v1/runs/{runId}
```

No auth required (runId is unguessable). You can require auth later if needed.

**Response while running:**

```json
{
  "runId": "1779629702562",
  "running": true,
  "result": "running",
  "otp": {
    "email": "waiting",
    "mobile": null
  },
  "exitCode": null
}
```

| `otp.email` / `otp.mobile` | Their UI should |
|----------------------------|-----------------|
| `"waiting"` | Show OTP input + submit |
| `"accepted"` | Show "verified" / hide input |
| `null` | Not at that step yet |

Poll every **2–3 seconds** while `result` is `"running"` or `"queued"`.

| `result` | Meaning |
|----------|---------|
| `queued` | Waiting for a free slot |
| `running` | Playwright active |
| `success` | Done |
| `failed` | Stopped with error |

When `result` is `"success"` or `"failed"`, stop polling.

---

## 3. Submit OTP (their OTP form)

When `otp.email === "waiting"`:

```http
POST /api/otp
Content-Type: application/json

{
  "type": "email",
  "otp": "123456",
  "runId": "1779629702562"
}
```

For Saudi mobile step:

```json
{ "type": "mobile", "otp": "654321", "runId": "1779629702562" }
```

Wrong OTP → status goes back to `"waiting"` — let user retry.

---

## 4. Live logs (optional)

```http
GET /api/logs?runId=1779629702562
Authorization: Bearer <apiKey>
```

Returns last ~200 log lines for a terminal view in their dashboard.

---

## 5. Health check

```http
GET /api/v1/health
```

```json
{ "ok": true, "service": "misa-automation-runner", "version": "1.0.0" }
```

---

## 6. Payload schema

```http
GET /api/v1/schema
```

Returns the example JSON with all field names.

---

## Example: JavaScript (their frontend)

```javascript
const RUNNER = 'https://your-runner.ngrok-free.app';
const API_KEY = 'from-you-securely'; // server-side proxy recommended

async function startMisaRegistration(formPayload, clientId) {
  const res = await fetch(`${RUNNER}/api/v1/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ ...formPayload, _clientId: clientId }),
  });
  const { runId, phase, queuePosition } = await res.json();
  return { runId, phase, queuePosition };
}

// Start 3 clients without waiting:
// await Promise.all([
//   startMisaRegistration(data1, 'client-1'),
//   startMisaRegistration(data2, 'client-2'),
//   startMisaRegistration(data3, 'client-3'),
// ]);

async function pollUntilDone(runId, onOtpNeeded) {
  while (true) {
    const st = await fetch(`${RUNNER}/api/v1/runs/${runId}`).then((r) => r.json());
    if (st.otp?.email === 'waiting') onOtpNeeded('email', runId);
    if (st.otp?.mobile === 'waiting') onOtpNeeded('mobile', runId);
    if (!st.running) return st.result; // 'success' | 'failed'
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function submitOtp(runId, type, code) {
  await fetch(`${RUNNER}/api/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, otp: code, runId }),
  });
}
```

**Important:** Call the runner from **their backend** if possible, so the API key is not exposed in the browser.

---

## CORS (browser calls from their domain)

Default: `Access-Control-Allow-Origin: *`

Restrict in `.env`:

```env
CORS_ORIGIN=https://their-dashboard.com
```

---

## Field mapping

Their form fields must map to our JSON keys (`regTitle`, `firstName`, `shareholders`, file objects with `filename` + `base64`, etc.). Share [api/run-payload.example.json](./api/run-payload.example.json) with their dev team.

Files:

```json
{
  "filename": "cr.pdf",
  "base64": "data:application/pdf;base64,...."
}
```

---

## What you still host

| You provide | They provide |
|-------------|--------------|
| Runner URL + API key | Their dashboard UI |
| Playwright + browser | Form + Run button |
| OpenAI billing | OTP from user email/SMS |
| PM2 24/7 | — |

---

## Legacy endpoints (still work)

| Endpoint | Use |
|----------|-----|
| `POST /api/run` | Our `index.html` — streaming logs |
| `POST /api/trigger` | Re-run last `config.json` (API key) |

New integrations should use **`POST /api/v1/runs`**.
