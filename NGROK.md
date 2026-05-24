# Dashboard + ngrok (remote access)

The automation dashboard runs on **port 3050** (`server.js` / PM2 `misa-dashboard`).

## One-time setup

1. Install [ngrok](https://ngrok.com/download) and add to PATH.
2. Sign in and set your authtoken:

```powershell
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

3. Install PM2 (if not already):

```powershell
npm install -g pm2
```

## Start dashboard + ngrok (Windows)

**Option A — batch file**

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli
.\start-dashboard-ngrok.bat
```

**Option B — PowerShell (fixed ngrok domain, paid plan)**

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli
.\start-dashboard-ngrok.ps1 -Domain "your-name.ngrok-free.app"
```

**Option C — manual (two terminals)**

Terminal 1 — dashboard:

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli
pm2 start ecosystem.config.js
# or: node server.js
```

Terminal 2 — ngrok:

```powershell
ngrok http 3050
```

Open the **Forwarding** URL ngrok prints (e.g. `https://xxxx.ngrok-free.app`).

## Local only (no ngrok)

```powershell
pm2 restart misa-dashboard
# Browser: http://localhost:3050
```

## API key

On first run, `server-config.json` is created with an `apiKey`. Use it if the UI or API asks for authentication.

## PM2 useful commands

```powershell
pm2 status
pm2 logs misa-dashboard
pm2 restart misa-dashboard
pm2 stop misa-dashboard
```

## Notes

- ngrok free tier shows a browser warning page once per visitor — click through to reach the dashboard.
- For a stable URL, use a reserved domain on ngrok (`--domain=...`) or keep the same free subdomain when ngrok assigns one.
- Do not commit `server-config.json` with real keys to public repos.
