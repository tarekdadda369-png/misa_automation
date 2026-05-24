/**
 * Verify whether a declarative step's goal is satisfied (agent handoff or code retry).
 */

import { escapeRegex } from './smartActions.js';

function resolveValue(step, ctx) {
  if (step.valueKey && ctx[step.valueKey] != null) return String(ctx[step.valueKey]);
  if (step.value != null) return String(step.value);
  return '';
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} step
 * @param {object} ctx
 * @returns {Promise<boolean>}
 */
export async function verifyStepGoal(page, step, ctx = {}) {
  const type = (step.type || '').toLowerCase();
  const expected = resolveValue(step, ctx);

  try {
    switch (type) {
      case 'placeholder_dropdown': {
        if (!step.placeholder) return false;
        const inp = page.locator(`input[placeholder="${step.placeholder}"]`).first();
        if (!(await inp.isVisible({ timeout: 2000 }).catch(() => false))) return false;
        const display = await inp.evaluate((el) => {
          const wrap = el.closest('.p-dropdown, p-dropdown, [class*="dropdown"]');
          const label = wrap?.querySelector('.p-dropdown-label');
          return (label?.textContent || el.value || '').trim();
        }).catch(() => '');
        if (!display) return false;
        if (new RegExp(escapeRegex(step.placeholder), 'i').test(display)) return false;
        if (expected && !new RegExp(escapeRegex(expected), 'i').test(display)) return false;
        return true;
      }

      case 'placeholder_input': {
        if (!step.placeholder) return false;
        const inp = page.locator(`input[placeholder="${step.placeholder}"]`).first();
        const val = await inp.inputValue().catch(() => '');
        return val.length > 0 && (!expected || val.includes(expected.slice(0, 20)));
      }

      case 'semantic_input': {
        const label = step.label || '';
        const byLabel = page.getByLabel(new RegExp(escapeRegex(label), 'i')).first();
        if (await byLabel.isVisible({ timeout: 1500 }).catch(() => false)) {
          const val = await byLabel.inputValue().catch(() => '');
          return val.length > 0;
        }
        if (step.placeholderFallback) {
          const ph = page.getByPlaceholder(new RegExp(escapeRegex(step.placeholderFallback), 'i')).first();
          const val = await ph.inputValue().catch(() => '');
          return val.length > 0;
        }
        return false;
      }

      case 'semantic_dropdown':
      case 'dropdown': {
        if (!expected) return false;
        const label = step.label || '';
        const row = page.locator('label, span').filter({ hasText: new RegExp(escapeRegex(label), 'i') }).first();
        if (!(await row.isVisible({ timeout: 1500 }).catch(() => false))) return false;
        const block = await row.locator('xpath=ancestor::div[3]').innerText().catch(() => '');
        return new RegExp(escapeRegex(expected), 'i').test(block);
      }

      case 'semantic_checkbox':
      case 'checkbox':
      case 'checkbox_text':
      case 'semantic_checkbox_text': {
        const cb = page.getByRole('checkbox', { name: new RegExp(escapeRegex(step.label || 'terms'), 'i') }).first();
        if (await cb.isVisible({ timeout: 1500 }).catch(() => false)) {
          return cb.isChecked().catch(() => false);
        }
        return true;
      }

      case 'button':
      case 'tab':
        return false;

      case 'upload':
        return false;

      default:
        return false;
    }
  } catch (_) {
    return false;
  }
}

/**
 * Human-readable checkpoint line for logs.
 */
export function formatCheckpoint(section, stepIndex, totalSteps, step, outcome) {
  const name = step.label || step.placeholder || step.type;
  return `CHECKPOINT: ${section} step ${stepIndex + 1}/${totalSteps} "${name}" — ${outcome}`;
}
