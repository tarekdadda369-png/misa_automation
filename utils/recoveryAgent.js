/**
 * Skyvern-style recovery agent — multi-turn vision + DOM until step goal is met, then handoff.
 *
 * Env:
 *   RUN_AI_FALLBACK=1
 *   OPENAI_API_KEY
 *   AI_FALLBACK_MODEL=gpt-4o
 *   AI_FALLBACK_MAX_TURNS=12        — agent actions per failed step
 *   AI_FALLBACK_BASE_URL            — optional OpenAI-compatible endpoint
 */

import fs from 'fs';
import path from 'path';
import { captureDomSnapshot, formatDomSnapshotForPrompt } from './domSnapshot.js';
import { executeRecoveryAction } from './recoveryExecutor.js';
import { reportFailedStep } from './aiFallback.js';
import { verifyStepGoal, formatCheckpoint } from './stepVerifier.js';

function aiEnabled() {
  return process.env.RUN_AI_FALLBACK === '1' && !!process.env.OPENAI_API_KEY;
}

function resolveValue(step, ctx) {
  if (step.valueKey && ctx[step.valueKey] != null) return String(ctx[step.valueKey]);
  if (step.value != null) return String(step.value);
  return '';
}

async function captureScreenshot(page, tag = 'recover') {
  const dir = path.join(process.cwd(), 'test-results', 'ai-fallback');
  fs.mkdirSync(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${tag}_${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  return screenshotPath;
}

/**
 * @param {object} payload
 * @returns {Promise<object|null>}
 */
async function requestAgentTurn(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const baseUrl = (process.env.AI_FALLBACK_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.AI_FALLBACK_MODEL || 'gpt-4o';

  const historyText = payload.history.length
    ? payload.history.map((h) => `Turn ${h.turn}: ${h.plan.action} → ${h.plan.target || ''} (${h.ok ? 'ok' : 'failed'})`).join('\n')
    : '(none)';

  const prompt = `You are a browser automation agent (like Skyvern) recovering a failed registration step on MISA / Invest Saudi.

GOAL: Complete the intent of the FAILED STEP below, OR clear blockers so deterministic Playwright can retry it.

FAILED STEP:
${JSON.stringify(payload.step, null, 2)}

EXPECTED VALUE (if any): "${payload.expectedValue || ''}"
SECTION: ${payload.section}
STEP INDEX: ${payload.stepIndex + 1} of ${payload.totalSteps}
URL: ${payload.url}

PREVIOUS ACTIONS THIS RECOVERY:
${historyText}

NUMBERED VISIBLE UI (use click_index with index from list):
${payload.domText}

Return ONE JSON object only.

Actions (pick the best):
- click_text: click visible text (partial OK)
- click_role: role=button|combobox|tab|link + target
- click_index: index from numbered DOM list
- fill / fill_placeholder: type into field
- select_option: pick dropdown option (value=option text)
- dismiss_dialog: close Error/Success modal
- press_key: Escape, Tab, Enter
- scroll: direction up|down
- wait: ms in "ms" field
- handoff: YOU are done — set stepComplete true if YOU finished the step goal, false if you only unblocked (e.g. closed error dialog)

Rules:
- Take the action a human would — multi-step is OK across turns
- Close "Invalid OTP" / "Error" modals before filling fields
- Do not submit final application unless step was Submit
- Do not navigate away from registration flow
- When city/region/dropdown: open dropdown then select_option on next turn if needed
- Use handoff when ready for code to continue

Schema:
{
  "action": "click_text|click_role|click_index|fill|fill_placeholder|select_option|dismiss_dialog|press_key|scroll|wait|handoff",
  "target": "label or text",
  "role": "button",
  "index": 1,
  "value": "for fill/select",
  "placeholder": "input placeholder if known",
  "ms": 1500,
  "direction": "down",
  "handoff": false,
  "stepComplete": false,
  "reason": "short"
}

For handoff action set "handoff": true and stepComplete true/false.`;

  const content = [{ type: 'text', text: prompt }];

  if (payload.screenshotPath && fs.existsSync(payload.screenshotPath)) {
    const b64 = fs.readFileSync(payload.screenshotPath).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } });
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      response_format: { type: 'json_object' },
      max_tokens: 500,
      temperature: 0.15,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.log(`[AI-AGENT] API ${res.status}: ${errText.slice(0, 280)}`);
    if (/insufficient_quota|billing|exceeded.*quota|credit balance/i.test(errText)) {
      console.log('[AI-AGENT] No API credits — add billing at platform.openai.com OR use OpenRouter/Ollama (see .env.example)');
    }
    return null;
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed.handoff || parsed.action === 'handoff') {
      console.log(`[AI-AGENT] Handoff — stepComplete=${!!parsed.stepComplete} (${parsed.reason || ''})`);
    } else {
      console.log(`[AI-AGENT] Plan: ${parsed.action} → ${parsed.target || parsed.index} (${parsed.reason || ''})`);
    }
    return parsed;
  } catch (e) {
    console.log(`[AI-AGENT] Bad JSON: ${raw.slice(0, 180)}`);
    return null;
  }
}

/**
 * Skyvern-style loop until step verified or max turns.
 * @returns {Promise<{ recovered: boolean, stepComplete: boolean }>}
 */
export async function tryAiRecovery(page, step, ctx, options = {}) {
  if (!aiEnabled()) return { recovered: false, stepComplete: false };

  const section = options.section || 'RUN';
  const stepIndex = options.stepIndex ?? 0;
  const totalSteps = options.totalSteps ?? 1;
  const maxTurns = Number(process.env.AI_FALLBACK_MAX_TURNS) || 12;

  console.log('════════════════════════════════════════');
  console.log(`[AI-AGENT] Skyvern recovery — ${section} step ${stepIndex + 1}/${totalSteps}`);
  console.log(`[AI-AGENT] Failed step: ${step.type} — ${step.label || step.placeholder || step.valueKey}`);
  console.log('════════════════════════════════════════');

  const expectedValue = resolveValue(step, ctx);
  let screenshotPath = await captureScreenshot(page, 'agent_start');
  const dom0 = await captureDomSnapshot(page);

  await reportFailedStep(page, step, section, {
    ...ctx,
    stepIndex,
    screenshot: screenshotPath,
    domSnapshot: dom0,
    expectedValue,
  });

  const history = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const dom = await captureDomSnapshot(page);
    const domText = formatDomSnapshotForPrompt(dom);
    screenshotPath = await captureScreenshot(page, `turn${turn}`);

    const plan = await requestAgentTurn({
      step,
      section,
      stepIndex,
      totalSteps,
      url: page.url(),
      domText,
      screenshotPath,
      expectedValue,
      history,
    });

    if (!plan) break;

    if (plan.handoff || plan.action === 'handoff') {
      const agentSaysComplete = plan.stepComplete === true;
      const verified = await verifyStepGoal(page, step, ctx);

      if (verified) {
        console.log(formatCheckpoint(section, stepIndex, totalSteps, step, 'agent verified — code resumes next step'));
        return { recovered: true, stepComplete: true };
      }
      if (agentSaysComplete) {
        console.log('[AI-AGENT] Agent reports complete; verifier pending — one code retry.');
        return { recovered: true, stepComplete: false };
      }
      console.log(formatCheckpoint(section, stepIndex, totalSteps, step, 'unblocked — code retries same step'));
      return { recovered: true, stepComplete: false };
    }

    const ok = await executeRecoveryAction(page, {
      ...plan,
      placeholder: plan.placeholder || step.placeholder,
      valueKey: step.valueKey,
      altLabels: step.altLabels,
    }, ctx, dom);

    history.push({ turn, plan, ok });
    await page.waitForTimeout(Number(plan.ms) || 700);

    if (await verifyStepGoal(page, step, ctx)) {
      console.log(formatCheckpoint(section, stepIndex, totalSteps, step, `goal met after turn ${turn} — code resumes next step`));
      return { recovered: true, stepComplete: true };
    }
  }

  console.log('[AI-AGENT] Max turns reached without verified handoff.');
  return { recovered: false, stepComplete: false };
}

export { aiEnabled };
