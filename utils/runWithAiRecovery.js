/**
 * Run a worker step (Steps 3,4,7,8) with Skyvern-style AI recovery when it fails or verify fails.
 */

import { tryAiRecovery, aiEnabled } from './recoveryAgent.js';
import { formatCheckpoint } from './stepVerifier.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} options
 * @param {string} options.section
 * @param {number} [options.stepIndex]
 * @param {number} [options.totalSteps]
 * @param {object} options.pseudoStep — passed to AI agent as failed-step context
 * @param {object} [options.ctx]
 * @param {(page: import('@playwright/test').Page) => Promise<import('@playwright/test').Page>} options.run
 * @param {(page: import('@playwright/test').Page) => Promise<boolean>} [options.verify]
 * @param {number} [options.maxRetries]
 * @returns {Promise<import('@playwright/test').Page>}
 */
export async function runWorkerWithAi(page, options) {
  const {
    section,
    stepIndex = 0,
    totalSteps = 8,
    pseudoStep,
    ctx = {},
    run,
    verify,
    maxRetries = 2,
  } = options;

  if (!run) throw new Error('runWorkerWithAi: run() is required');

  let lastError = null;
  const maxAttempts = aiEnabled() ? maxRetries + 1 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[${section}] worker attempt ${attempt}/${maxAttempts}`);
      const result = await run(page);
      page = result || page;

      if (verify && !(await verify(page))) {
        throw new Error(`${section}: verification failed after worker run`);
      }

      console.log(formatCheckpoint(section, stepIndex, totalSteps, pseudoStep, 'worker OK'));
      return page;
    } catch (err) {
      lastError = err;
      console.log(`[${section}] ❌ ${err.message}`);

      if (!aiEnabled() || attempt >= maxAttempts) break;

      console.log(`[${section}] 🤖 Starting AI agent recovery...`);
      const recovery = await tryAiRecovery(page, pseudoStep, ctx, {
        section,
        stepIndex,
        totalSteps,
      });

      if (recovery.recovered && recovery.stepComplete && verify && (await verify(page))) {
        console.log(formatCheckpoint(section, stepIndex, totalSteps, pseudoStep, 'AI completed step'));
        return page;
      }

      if (recovery.recovered) {
        console.log(`[${section}] AI unblocked — retrying worker code...`);
        continue;
      }

      console.log(`[${section}] AI could not recover — stopping.`);
      break;
    }
  }

  throw lastError || new Error(`Automation Stopped: ${section} failed after ${maxAttempts} attempt(s).`);
}
