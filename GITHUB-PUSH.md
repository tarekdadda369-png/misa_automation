# Push to GitHub (simple steps) — `.env` stays on your PC

## Why `.env` is NOT pushed

Your folder has a file named **`.gitignore`**. Line 7 says:

```
.env
```

Git **ignores** `.env` on purpose. Your OpenAI key stays only on your computer.

**Check anytime:**

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli
git check-ignore -v .env
```

If you see `.gitignore:7:.env` → **safe, .env will not upload.**

What **does** go to GitHub: `.env.example` (no real key, only examples).

---

## Step 1 — Create YOUR repository on GitHub

1. Open browser: https://github.com/new  
2. **Repository name:** `misa-automation` (or any name)  
3. Choose **Private**  
4. **Do NOT** tick “Add a README”  
5. Click **Create repository**  
6. Copy the URL GitHub shows, e.g.  
   `https://github.com/YourName/misa-automation.git`

---

## Step 2 — Point Git to YOUR repo (not Microsoft)

Your PC may still point to `microsoft/playwright-cli`. Fix it once:

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli

git remote remove origin

git remote add origin https://github.com/YourName/misa-automation.git
```

Replace `YourName` and `misa-automation` with your real repo.

Check:

```powershell
git remote -v
```

You must see **your** GitHub URL, not `microsoft/playwright-cli`.

---

## Step 3 — Add files (`.env` is skipped automatically)

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli

git add .

git status
```

**Look at the list.** You should see many files BUT **NOT** `.env`.

If you see `.env` in the list → **STOP** and ask for help (should not happen).

---

## Step 4 — Commit

```powershell
git commit -m "MISA automation runner for company Render deploy"
```

---

## Step 5 — Push to GitHub

First time:

```powershell
git branch -M main
git push -u origin main
```

GitHub may ask you to log in (browser or token).

Later updates:

```powershell
git add .
git commit -m "Update automation"
git push
```

---

## Step 6 — Send IT the link

```
https://github.com/YourName/misa-automation
```

Plus the message from `YOU-DO-THIS.md` (Render env vars — IT adds OpenAI key on Render, not in GitHub).

---

## Quick picture

```
Your PC                          GitHub
────────                         ──────
.env          ──X── (blocked)    (never uploaded)
.env.example  ──✓──               (example only)
server.js     ──✓──               (code)
Dockerfile    ──✓──               (for Render)
```

---

## If `git push` asks for password

GitHub no longer accepts account password in terminal.

Use:

1. **GitHub Desktop** app (easiest), or  
2. **Personal Access Token** as password:  
   GitHub → Settings → Developer settings → Personal access tokens → create token → paste when Git asks for password
