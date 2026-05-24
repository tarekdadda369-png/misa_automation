/**
 * Skyvern-style action executor — flexible UI actions from the LLM (still allowlisted).
 */

import {
  smartClickAny,
  smartFill,
  smartFillSemantic,
  smartSelect,
  smartPlaceholderDropdown,
  smartClick,
  escapeRegex,
} from './smartActions.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} action
 * @param {object} ctx
 * @param {object[]} [domSnapshot]
 * @returns {Promise<boolean>}
 */
export async function executeRecoveryAction(page, action, ctx = {}, domSnapshot = []) {
  if (!action?.action) return false;

  const type = String(action.action).toLowerCase().replace(/-/g, '_');
  const target = String(action.target || '').trim();
  const value = action.value != null ? String(action.value) : '';

  console.log(`[AI-AGENT] ▶ ${type}${target ? ` "${target}"` : ''}${value ? ` = "${value}"` : ''}`);

  try {
    switch (type) {
      case 'click':
        if (!target) return false;
        if (await smartClickAny(page, [target])) return true;
        return smartClick(page, target);

      case 'click_text': {
        if (!target) return false;
        const loc = page.getByText(new RegExp(escapeRegex(target), 'i')).filter({ visible: true }).first();
        if (await loc.isVisible({ timeout: 4000 }).catch(() => false)) {
          await loc.click({ force: true });
          return true;
        }
        return false;
      }

      case 'click_role': {
        const role = action.role || 'button';
        const loc = page.getByRole(role, { name: new RegExp(escapeRegex(target), 'i') }).filter({ visible: true }).first();
        if (await loc.isVisible({ timeout: 4000 }).catch(() => false)) {
          await loc.click({ force: true });
          return true;
        }
        return false;
      }

      case 'click_index': {
        const i = Number(action.index) - 1;
        const el = domSnapshot[i];
        if (!el) return false;
        if (el.text) {
          const exact = page.getByText(new RegExp(`^\\s*${escapeRegex(el.text.slice(0, 60))}`, 'i')).filter({ visible: true }).last();
          if (await exact.isVisible({ timeout: 3000 }).catch(() => false)) {
            await exact.click({ force: true });
            return true;
          }
        }
        if (el.placeholder) {
          const inp = page.locator(`input[placeholder="${el.placeholder}"]`).first();
          await inp.click({ force: true });
          return true;
        }
        return false;
      }

      case 'fill':
      case 'type': {
        if (!target) return false;
        const fillValue = value || (action.valueKey && ctx[action.valueKey] != null ? String(ctx[action.valueKey]) : '');
        if (!fillValue) return false;
        if (await smartFillSemantic(page, target, fillValue, {
          placeholderFallback: action.placeholder,
          altLabels: action.altLabels || [],
        })) return true;
        return smartFill(page, target, fillValue);
      }

      case 'fill_placeholder': {
        if (!action.placeholder && !target) return false;
        const ph = action.placeholder || target;
        const inp = page.locator(`input[placeholder="${ph}"]`).first();
        const fillValue = value || (action.valueKey && ctx[action.valueKey] != null ? String(ctx[action.valueKey]) : '');
        if (!fillValue) return false;
        await inp.click({ force: true });
        await inp.fill(fillValue);
        return true;
      }

      case 'select':
      case 'dropdown':
      case 'select_option': {
        const opt = value || target;
        if (!opt) return false;
        if (action.placeholder && await smartPlaceholderDropdown(page, action.placeholder, opt, {
          altLabels: action.altLabels || [],
        })) return true;
        if (action.label && await smartSelect(page, action.label, opt)) return true;
        const open = page.locator('input[placeholder*="Select" i], [role="combobox"]').filter({ visible: true }).last();
        if (await open.isVisible({ timeout: 2000 }).catch(() => false)) {
          await open.click({ force: true });
          await page.waitForTimeout(600);
        }
        const option = page.locator('li, .p-dropdown-item, span, div').filter({
          hasText: new RegExp(escapeRegex(opt), 'i'),
        }).filter({ visible: true }).last();
        if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
          await option.click({ force: true });
          return true;
        }
        return false;
      }

      case 'press_key':
        await page.keyboard.press(value || target || 'Escape');
        return true;

      case 'scroll': {
        const dir = (action.direction || 'down').toLowerCase();
        const amount = Number(action.amount) || 400;
        await page.mouse.wheel(0, dir === 'up' ? -amount : amount);
        return true;
      }

      case 'dismiss_dialog':
      case 'close_dialog': {
        const closeBtn = page.getByRole('button', { name: /^(Close|OK|Ok|Confirm|حسنا|إغلاق|تأكيد)$/i }).filter({ visible: true }).last();
        if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await closeBtn.click({ force: true });
          await page.waitForTimeout(500);
          return true;
        }
        await page.keyboard.press('Escape');
        return true;
      }

      case 'wait':
        await page.waitForTimeout(Number(action.ms) || 1500);
        return true;

      case 'handoff':
        return true;

      default:
        console.log(`[AI-AGENT] Unknown action: ${type}`);
        return false;
    }
  } catch (e) {
    console.log(`[AI-AGENT] Execute failed: ${e.message}`);
    return false;
  }
}
