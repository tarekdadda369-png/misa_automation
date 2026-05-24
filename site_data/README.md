# Site data (one JSON per registration portal)

| File | Portal |
|------|--------|
| `misa_config.json` | Invest Saudi MISA |

## Structure

- **`values`** — flat fields (email, names, files) used by the test brain
- **`shareholders`** — Step 6 records (Person / Organization)
- **`steps`** — declarative actions the engine runs (`input`, `dropdown`, `calendar`, `button`, `upload`, `tab`, `checkbox`)

## Run another site

```bash
SITE_DATA_FILE=site_data/other_service_config.json npx playwright test tests/misa.spec.js
```

Dashboard `config.json` still merges on top for per-run overrides.

## Engine

- `utils/smartActions.js` — resilient click / fill / select / calendar
- `utils/runSiteSteps.js` — executes `steps.*` arrays
- `utils/stepValueMap.js` — label → context key mapping
- `utils/aiFallback.js` — queues failed steps to `ai_fallback_queue.jsonl` (AI later)

## Steps on the smart engine (MISA)

| Step | Engine | Still in code (rules) |
|------|--------|------------------------|
| 1 Registration form | ✅ | OTP, Saudi Verify Mobile, Next |
| 2 Credentials | ✅ | — |
| 3 Apply | ✅ | — |
| 4 Business + ISIC loop | ✅ | `isic_loop` in JSON |
| 5 Entity | ✅ | uploads in JSON |
| 6 Person shareholder | ✅ | Add SH, Person tab |
| 6 Organization | — | KSA unified number, files |
| 7 Contact person | ✅ | Others tab |
| 8 Preview submit | ✅ | — |

## AI recovery on failures

When an **engine** step fails (Steps 1, 2, 5, 6), the runner can call a vision+DOM agent, apply one fix, then **retry the same step** and continue.

Worker steps (3, 4, 7, 8) still use fixed Playwright code — not the agent.

### Enable

Copy `.env.example` → set variables, then:

```powershell
$env:RUN_AI_FALLBACK="1"
$env:OPENAI_API_KEY="sk-..."
$env:AI_FALLBACK_MODEL="gpt-4o"
npx playwright test tests/misa.spec.js
```

Or pass env from the dashboard `server.js` when starting a run.

### Flow (Skyvern-style)

1. Engine step fails → queued in `ai_fallback_queue.jsonl`
2. Agent loop (up to `AI_FALLBACK_MAX_TURNS`): screenshot + numbered DOM → LLM action
3. Actions: `click_text`, `click_index`, `select_option`, `fill_placeholder`, `dismiss_dialog`, …
4. **Verifier** checks if step goal is met → `CHECKPOINT` log with exact step index
5. If agent finished the step → code continues at **step N+1**
6. If agent only unblocked (e.g. closed Error modal) → code **retries step N** then continues

### Files

- `utils/domSnapshot.js` — compact visible elements for the prompt
- `utils/recoveryAgent.js` — multi-turn Skyvern-style agent + handoff
- `utils/recoveryExecutor.js` — flexible allowlisted actions
- `utils/stepVerifier.js` — confirms correct step before resume
- `utils/aiFallback.js` — failure queue + screenshots
