/**
 * AI fallback — queue failures + optional screenshot/DOM for recovery agent.
 * Enable recovery with RUN_AI_FALLBACK=1 and OPENAI_API_KEY.
 */

import fs from 'fs';
import path from 'path';

const QUEUE_FILE = process.env.AI_FALLBACK_QUEUE || 'ai_fallback_queue.jsonl';

/**
 * Record a failed step for human or AI review.
 * @param {import('@playwright/test').Page} page
 * @param {object} step
 * @param {string} section
 * @param {object} [ctx]
 */
export async function reportFailedStep(page, step, section, ctx = {}) {
  const entry = {
    ts: new Date().toISOString(),
    section,
    stepIndex: ctx.stepIndex,
    type: step.type,
    label: step.label,
    placeholder: step.placeholder,
    valueKey: step.valueKey,
    url: page.url(),
    expectedValue: ctx.expectedValue || null,
  };

  console.log('────────────────────────────────────────');
  console.log('[AI-FALLBACK] Step failed — queued for review');
  console.log(`  Section : ${section}`);
  console.log(`  Type    : ${step.type}`);
  console.log(`  Target  : ${step.label || step.placeholder || step.valueKey}`);
  console.log(`  URL     : ${entry.url}`);
  if (process.env.RUN_AI_FALLBACK !== '1') {
    console.log('  (Set RUN_AI_FALLBACK=1 + OPENAI_API_KEY to auto-recover)');
  }
  console.log('────────────────────────────────────────');

  try {
    if (ctx.screenshot) {
      entry.screenshot = ctx.screenshot;
    } else if (process.env.RUN_AI_FALLBACK === '1') {
      const dir = path.join(process.cwd(), 'test-results', 'ai-fallback');
      fs.mkdirSync(dir, { recursive: true });
      const screenshotPath = path.join(dir, `fail_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      entry.screenshot = screenshotPath;
    }

    if (ctx.domSnapshot) {
      entry.domSnapshot = ctx.domSnapshot;
    }

    fs.appendFileSync(QUEUE_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.log(`[AI-FALLBACK] Could not write queue: ${e.message}`);
  }

  return false;
}
