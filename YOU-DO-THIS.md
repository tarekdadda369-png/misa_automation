# What YOU do (before IT deploys on Render)

## Step 1 — OpenAI key (company)

Put the **company OpenAI key** in `.env` on your PC **only for local tests**:

```env
RUN_AI_FALLBACK=1
OPENAI_API_KEY=sk-company-key-here
AI_FALLBACK_MODEL=gpt-4o
PLAYWRIGHT_HEADLESS=1
MAX_CONCURRENT_RUNS=1
```

**Do not put `.env` on GitHub.** IT will add the same variables in the **Render dashboard** (secret).

---

## Step 2 — Create GitHub repository

1. Go to [https://github.com/new](https://github.com/new)
2. Name: e.g. `misa-automation`
3. **Private** repository (recommended)
4. Do **not** add README if you already have files
5. Create repository

---

## Step 3 — Push the project (one time)

Open PowerShell:

```powershell
cd d:\Dadda\Desktop\playwright\playwright-cli

git init
git add .
git status
```

Check: `.env` must **NOT** appear in the list (it is in `.gitignore`).

```powershell
git commit -m "MISA automation runner for Render"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/misa-automation.git
git push -u origin main
```

Replace `YOUR-USERNAME` and repo name with yours.

---

## Step 4 — Send IT this message

Copy and edit:

> **GitHub repo:** https://github.com/YOUR-USERNAME/misa-automation  
>  
> Deploy on **Render** as **Web Service + Docker** (see `RENDER.md` in the repo).  
>  
> **Environment variables on Render** (not in GitHub):  
> - `OPENAI_API_KEY` = *(company OpenAI key)*  
> - `RUN_AI_FALLBACK` = `1`  
> - `NODE_ENV` = `production`  
> - `PLAYWRIGHT_HEADLESS` = `1`  
> - `MAX_CONCURRENT_RUNS` = `1`  
> - `PORT` = `3050`  
>  
> Health check: `/api/v1/health`  
> Plan: **Standard 2GB** (not Free)  
>  
> When finished, send me:  
> 1. Render URL (https://....onrender.com)  
> 2. API key from `server-config.json`

---

## Step 5 — After IT deploys

You receive:

- Render URL  
- API key  

Send both to **company developers** with file `EXTERNAL-API.md` from the repo.

---

## Do NOT

- Commit `.env` to GitHub  
- Commit `server-config.json`  
- Put OpenAI key in the repo  

---

## Checklist

- [ ] `.env` on your PC with company OpenAI key (local test only)  
- [ ] GitHub repo created (private)  
- [ ] Code pushed (`playwright-cli` is the app root)  
- [ ] Link sent to IT + message above  
- [ ] Got back Render URL + API key  
- [ ] Sent URL + API key to developers  
