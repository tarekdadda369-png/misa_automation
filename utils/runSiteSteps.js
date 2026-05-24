/**
 * Generic step runner — one brain for all site_data/*.json flows.
 */

import {
  smartClick,
  smartFill,
  smartSelect,
  smartCalendar,
  smartTab,
  smartCheckbox,
  smartUpload,
  closeOpenPopups,
  cleanMisaEnvironment,
  findLabel,
  smartNativeTitleSelect,
  smartFillByPlaceholder,
  smartSectorSelect,
  smartRegistrationCountry,
  smartNationalId,
  smartTermsAcknowledge,
  smartClickAny,
  smartPlaceholderDropdown,
  smartEntityMobile,
  smartCheckboxByLabelText,
  smartFillSemantic,
  smartSelectSemantic,
  smartSemanticTitleSelect,
  waitForStepLabel,
  clickMisaInvestmentRegistrationCard,
  clickMisaApplyButton,
  clickMisaGccNo,
  getWorkflowPage,
} from './smartActions.js';
import { runIsicBusinessActivities } from './isicFlow.js';
import {
  resolveInputValue,
  resolveDropdownValue,
  resolveCalendarParts,
  resolveUploadPath,
} from './stepValueMap.js';
import { reportFailedStep } from './aiFallback.js';
import { tryAiRecovery, aiEnabled } from './recoveryAgent.js';

function resolvePlaceholderValue(step, ctx) {
  if (step.valueKey && ctx[step.valueKey] != null) return String(ctx[step.valueKey]);
  if (step.value != null && step.value !== '') return String(step.value);
  return '';
}

/** Shared flags for Step 7 Contact Person (scoped semantic locators). */
function contactFlags(options, step = {}) {
  const on = options.contactSection || options.contactRow || step.contactSection;
  return {
    contactSection: !!on,
    contactRow: !!on,
    field: step.field,
    scope: options.scope,
  };
}

/**
 * Execute one declarative step from site_data.
 */
export async function executeStep(page, step, ctx, options = {}) {
  if (options.pageRef?.current) page = options.pageRef.current;

  const { section = 'RUN', contactRow = false, uploadIndex = 0, resolveFilePath = (p) => p } = options;
  const type = (step.type || '').toLowerCase();
  const label = step.label || '';

  console.log(`${section}: ▶ ${type} "${label || step.placeholder || ''}" (${page.url()})`);

  // Global interceptor — Step 3 uses tabs-only so promo Close does not cancel Apply wizard
  if (options.skipInterceptor !== true) {
    await cleanMisaEnvironment(page, { interceptorMode: options.interceptorMode || 'full' });
  }

  let ok = false;

  switch (type) {
    case 'misa_ir_entry': {
      const wp = await clickMisaInvestmentRegistrationCard(page);
      if (options.pageRef) options.pageRef.current = wp;
      ok = true;
      break;
    }

    case 'misa_apply': {
      ok = await clickMisaApplyButton(page);
      if (!ok && step.optional) ok = true;
      break;
    }

    case 'misa_gcc_no': {
      ok = await clickMisaGccNo(page);
      if (!ok && step.optional) ok = true;
      break;
    }

    case 'button':
    case 'tab': {
      const clickLabels = step.altLabels?.length
        ? [label, ...step.altLabels].filter(Boolean)
        : [label];
      ok = type === 'tab'
        ? await smartTab(page, label)
        : await smartClickAny(page, clickLabels);
      if (!ok && step.optional) ok = true;
      break;
    }

    case 'wait_ready': {
      await page.waitForTimeout(step.ms || 3000);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: step.timeout || 60000 }).catch(() => {});
      await page.waitForTimeout(step.pauseAfter || 500);
      ok = true;
      break;
    }

    case 'wait_label': {
      try {
        await waitForStepLabel(page, label || step.placeholder || 'Identity Type', {
          altLabels: step.altLabels,
          timeout: step.timeout || 30000,
        });
        ok = true;
      } catch (_) {
        ok = !!step.optional;
      }
      break;
    }

    case 'checkbox':
      if (step.checkboxLabel) {
        ok = await smartCheckboxByLabelText(page, step.checkboxLabel, { altLabels: step.altLabels });
      } else {
        ok = label === 'terms' || step.termsMisa
          ? await smartTermsAcknowledge(page)
          : await smartCheckbox(page, label || 'terms');
      }
      break;

    case 'semantic_checkbox':
      ok = label === 'terms' || step.termsMisa
        ? await smartTermsAcknowledge(page)
        : await smartCheckbox(page, label || 'terms');
      break;

    case 'checkbox_text':
      ok = await smartCheckboxByLabelText(page, label);
      break;

    case 'semantic_checkbox_text':
      ok = await smartCheckboxByLabelText(page, label, { altLabels: step.altLabels });
      break;

    case 'placeholder_dropdown': {
      const value = resolvePlaceholderValue(step, ctx) || resolveDropdownValue(step, ctx);
      ok = await smartPlaceholderDropdown(page, step.placeholder, value, {
        altLabels: step.altLabels,
      });
      break;
    }

    case 'entity_mobile':
      ok = await smartEntityMobile(page, ctx.entityMobilePrefix || '+213', ctx.entityMobile || '');
      break;

    case 'isic_loop': {
      const codes = ctx.isicCodes || [];
      if (options.waitForPageReady && codes.length) {
        await runIsicBusinessActivities(page, codes, { waitForPageReady: options.waitForPageReady });
        ok = true;
      } else {
        ok = false;
      }
      break;
    }

    case 'input': {
      const value = resolveInputValue(step, ctx);
      if (!value && step.optional) return true;
      ok = await smartFill(page, label, value, { optional: step.optional, contactRow });
      break;
    }

    case 'placeholder_input': {
      const value = resolvePlaceholderValue(step, ctx);
      if (!value && step.optional) return true;
      ok = await smartFillByPlaceholder(page, step.placeholder, value, {
        optional: step.optional,
        clearReadonly: step.clearReadonly,
        slow: step.slow,
      });
      break;
    }

    case 'semantic_input': {
      const value = resolvePlaceholderValue(step, ctx) || resolveInputValue(step, ctx);
      if (!value && step.optional) return true;
      ok = await smartFillSemantic(page, label || step.placeholder, value, {
        optional: step.optional,
        clearReadonly: step.clearReadonly,
        slow: step.slow,
        altLabels: step.altLabels,
        placeholderFallback: step.placeholderFallback || step.placeholder,
        ...contactFlags(options, step),
      });
      break;
    }

    case 'semantic_dropdown': {
      const value = resolvePlaceholderValue(step, ctx) || resolveDropdownValue(step, ctx);
      if (!value && step.optional) return true;
      ok = await smartSelectSemantic(page, label, value, {
        altLabels: step.altLabels,
        placeholderFallback: step.placeholderFallback || step.placeholder,
        ...contactFlags(options, step),
      });
      if (!ok && step.fallbackType === 'dropdown') {
        ok = await smartSelect(page, label, value, contactFlags(options, step));
      }
      if (ok && label.includes('Identity Type')) {
        await findLabel(page, 'Title').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      break;
    }

    case 'semantic_calendar': {
      await closeOpenPopups(page);
      const parts = resolveCalendarParts(step, ctx);
      ok = await smartCalendar(page, label, parts, {
        ...contactFlags(options, step),
        altLabels: step.altLabels,
      });
      break;
    }

    case 'native_select':
      ok = await smartNativeTitleSelect(page, resolvePlaceholderValue(step, ctx) || ctx.regTitle);
      break;

    case 'semantic_select':
      ok = await smartSemanticTitleSelect(page, resolvePlaceholderValue(step, ctx) || ctx.regTitle);
      break;

    case 'national_id':
      ok = await smartNationalId(page, ctx.nationalId || '');
      break;

    case 'semantic_national_id': {
      const nid = ctx.nationalId || '';
      if (!nid || String(nid).trim() === '') return true;
      ok = await smartFillSemantic(page, label || 'National ID', nid, {
        optional: true,
        slow: true,
        altLabels: step.altLabels || ['IQAMA', 'National ID / IQAMA ID'],
        placeholderFallback: step.placeholderFallback || 'Enter National ID / IQAMA ID',
      });
      break;
    }

    case 'sector':
      ok = await smartSectorSelect(page, ctx.sector || step.value);
      break;

    case 'semantic_sector':
      ok = await smartSelectSemantic(page, label || 'Sector', ctx.sector || step.value, {
        altLabels: step.altLabels,
        placeholderFallback: step.placeholderFallback || 'Select Sector',
      });
      if (!ok) ok = await smartSectorSelect(page, ctx.sector || step.value);
      break;

    case 'registration_country':
      ok = await smartRegistrationCountry(page, ctx.country || step.value);
      break;

    case 'semantic_country':
      ok = await smartSelectSemantic(page, label || 'Country', ctx.country || step.value, {
        altLabels: step.altLabels || ['Nationality', 'Country of Residence'],
        placeholderFallback: step.placeholderFallback || 'Select Country',
      });
      if (!ok) ok = await smartRegistrationCountry(page, ctx.country || step.value);
      break;

    case 'dropdown': {
      await closeOpenPopups(page);
      const value = resolveDropdownValue(step, ctx);
      if (!value && step.optional) return true;
      ok = await smartSelect(page, label, value, contactFlags(options, step));
      if (label.includes('Identity Type') && ok) {
        await findLabel(page, 'Title').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(400);
      }
      break;
    }

    case 'calendar': {
      await closeOpenPopups(page);
      const parts = resolveCalendarParts(step, ctx);
      ok = await smartCalendar(page, label, parts, contactFlags(options, step));
      break;
    }

    case 'upload': {
      const raw = resolveUploadPath(step, ctx);
      const path = resolveFilePath(raw);
      if (!path) return step.optional !== false;
      const idx = step.uploadIndex != null ? step.uploadIndex : uploadIndex;
      ok = await smartUpload(page, path, { index: idx });
      break;
    }

    case 'scroll_bottom':
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(step.ms || 2000);
      ok = true;
      break;

    case 'wait':
      await page.waitForTimeout(step.ms || 1000);
      ok = true;
      break;

    case 'close_popups':
      await closeOpenPopups(page);
      ok = true;
      break;

    default:
      console.log(`${section}: ⚠ Unknown step type "${type}"`);
      ok = false;
  }

  if (!ok && options.queueAiFallback !== false && process.env.RUN_AI_FALLBACK !== '1') {
    await reportFailedStep(page, step, section, ctx);
  }
  return ok;
}

/**
 * Run an ordered list of steps from site_data.
 * @returns {Promise<{ ok: number, failed: object[] }>}
 */
export async function runSiteSteps(page, steps, ctx, options = {}) {
  const failed = [];
  let ok = 0;
  let uploadCounter = 0;

  if (!Array.isArray(steps) || steps.length === 0) {
    console.log(`${options.section || 'RUN'}: No steps defined — skipping.`);
    return { ok: 0, failed: [] };
  }

  const pageRef = options.pageRef || null;
  let activePage = pageRef?.current || page;

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (step.skip) continue;

    const stepOpts = {
      ...options,
      uploadIndex: step.uploadIndex != null ? step.uploadIndex : uploadCounter,
      pageRef,
      stepIndex,
    };

    let success = await executeStep(activePage, step, ctx, stepOpts);
    if (pageRef?.current) activePage = pageRef.current;

    if (!success && aiEnabled() && options.aiRecovery !== false) {
      const section = options.section || 'RUN';
      const recovery = await tryAiRecovery(activePage, step, ctx, {
        section,
        stepIndex,
        totalSteps: steps.length,
      });

      if (recovery.recovered) {
        if (recovery.stepComplete) {
          success = true;
          console.log(`${section}: ✅ Step ${stepIndex + 1}/${steps.length} completed by AI agent — continuing.`);
        } else {
          console.log(`${section}: ↻ AI unblocked — code retries step ${stepIndex + 1}/${steps.length}...`);
          success = await executeStep(activePage, step, ctx, stepOpts);
          if (pageRef?.current) activePage = pageRef.current;
          if (success) {
            console.log(`${section}: ✅ Step ${stepIndex + 1} OK after AI + engine retry.`);
          }
        }
      }
    }

    if (success) {
      ok++;
      if (step.type === 'upload') uploadCounter++;
    } else {
      failed.push({ label: step.label, type: step.type, placeholder: step.placeholder });
      if (options.failFast) break;
    }

    if (step.pauseAfter) await page.waitForTimeout(step.pauseAfter);
    if (options.afterStep) await options.afterStep(step, activePage, ctx, success);
  }

  const section = options.section || 'RUN';
  if (failed.length) {
    console.log(`${section}: ⚠ ${failed.length} step(s) need attention (AI queue ready):`,
      failed.map((f) => `${f.type}:${f.label || f.placeholder}`).join(', '));
  } else {
    console.log(`${section}: ✅ All ${ok} steps completed.`);
  }

  return { ok, failed, page: pageRef?.current || activePage };
}
