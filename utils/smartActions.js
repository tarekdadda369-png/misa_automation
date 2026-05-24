/**
 * Resilient UI actions — semantic locators first, broad fallbacks second.
 */

import { expect } from '@playwright/test';

const DELAY_MS = 500;

const MONTH_INDEX = {
  january: '0', jan: '0', february: '1', feb: '1', march: '2', mar: '2',
  april: '3', apr: '3', may: '4', june: '5', jun: '5', july: '6', jul: '6',
  august: '7', aug: '7', september: '8', sep: '8', october: '9', oct: '9',
  november: '10', nov: '10', december: '11', dec: '11',
};

export function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeSelector(value) {
  const s = String(value).trim();
  return /^[#.\[]/.test(s) || /^[a-z]+\[/i.test(s) || s.includes(' >> ');
}

export function aiHelp(action, target) {
  console.log(`AI Help Needed for: [${action}] ${target}`);
}

const INTERCEPT_MS = 500;
const INTERCEPT_CLICK_MS = 900;

/** Good in-flow URLs (registration, apply wizard, business activities) */
const WORKFLOW_URL_RE = /eservices\.investsaudi\.sa\/(register|services\/|investment|business|apply)/i;
/** Wrong dashboard / marketing — NOT a successful Step 3 outcome */
const BAD_WORKFLOW_URL_RE = /dashboard-without-ir|dashboard-without|dashboard#|\/home\/?$/i;
const DRIFT_URL_RE = /opportunit|\/offer|\/news|\/event|\/explore|\/media|marketing/i;

function isGoodWorkflowUrl(url = '') {
  if (BAD_WORKFLOW_URL_RE.test(url)) return false;
  if (/regular investment|business.?activit|isic/i.test(url)) return true;
  if (WORKFLOW_URL_RE.test(url) && !DRIFT_URL_RE.test(url)) return true;
  return false;
}

export async function closeOpenPopups(page) {
  await page.keyboard.press('Escape');
  await page.locator('.react-datepicker-popper, .p-dropdown-panel, .p-overlay-panel')
    .filter({ visible: true })
    .waitFor({ state: 'hidden', timeout: 2000 })
    .catch(() => {});
}

/**
 * Active MISA tab — prefer business-activities / apply over dashboard-without-ir.
 * @returns {import('@playwright/test').Page}
 */
export function getWorkflowPage(mainPage) {
  const open = mainPage.context().pages().filter((p) => !p.isClosed());
  if (!open.length) return mainPage;

  const score = (p) => {
    const u = p.url() || '';
    if (/regular investment|business.?activit|isic/i.test(u)) return 100;
    if (/investment.*registration|\/apply/i.test(u) && !BAD_WORKFLOW_URL_RE.test(u)) return 85;
    if (/eservices\.investsaudi\.sa\/register/i.test(u)) return 75;
    if (BAD_WORKFLOW_URL_RE.test(u)) return 5;
    if (/eservices\.investsaudi\.sa/i.test(u)) return 40;
    if (u && u !== 'about:blank') return 20;
    return 0;
  };

  return open.reduce((best, p) => (score(p) > score(best) ? p : best), mainPage);
}

/**
 * Global interceptor — fast pass before every engine step.
 * @param {object} [options]
 * @param {'full'|'tabs-only'|'dialogs-only'} [options.interceptorMode]
 *   - tabs-only: close stray tabs + URL recovery only (safe during Step 3 Apply)
 *   - dialogs-only: tabs + GCC/Terms modals, no promo Close
 *   - full: everything including promo panels
 */
export async function cleanMisaEnvironment(page, options = {}) {
  const mode = options.interceptorMode || 'full';
  const wp = getWorkflowPage(page);
  let acted = false;
  acted = (await closeUnexpectedTabs(wp)) || acted;
  acted = (await recoverWorkflowUrl(wp)) || acted;

  if (mode !== 'tabs-only') {
    for (let pass = 0; pass < 2; pass++) {
      const dismissed = await dismissVisibleDialogs(wp);
      if (!dismissed) break;
      acted = true;
      await wp.waitForTimeout(150);
    }
  }

  if (mode === 'full') {
    for (let pass = 0; pass < 2; pass++) {
      const dismissed = await dismissOrphanOverlays(wp);
      if (!dismissed) break;
      acted = true;
      await wp.waitForTimeout(150);
    }
  }

  if (acted) {
    await wp.bringToFront().catch(() => {});
    await wp.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
  }

  return acted;
}

/** Step 4+ screen — Regular Investment Registration / Business Activities. */
export async function isBusinessActivitiesPage(page) {
  const url = page.url() || '';
  if (/business.?activit|regular investment/i.test(url)) return true;
  if (BAD_WORKFLOW_URL_RE.test(url)) return false;

  const reg = page.getByText(/Regular Investment Registration/i).first();
  if (await reg.isVisible({ timeout: 4000 }).catch(() => false)) return true;

  const heading = page.getByRole('heading', { name: /business activities/i }).first();
  return heading.isVisible({ timeout: 2000 }).catch(() => false);
}

/** Dashboard links that open wrong pages — never click these in Step 3. */
const DASHBOARD_TRAP_RE = /explore all|know more|explore opportunities|opportunities\s*→|about the sector|elderly care|assembly of solar|industrial valves|polyhydroxy|healthcare and life/i;

/** MISA Investment Registration accordion card on dashboard-without-ir. */
function misaIrCardLocator(page) {
  return page.locator('a, div, article, section, li').filter({
    has: page.getByText(/^MISA Investment Registration$/i),
  }).filter({
    hasNot: page.getByText(/^RHQ License$/i),
  }).filter({ visible: true }).first();
}

/**
 * APPLY FOR → MISA Investment Registration card only (not RHQ, not Explore/Know More).
 * Expands the card on dashboard-without-ir; may also open a new tab.
 */
export async function clickMisaInvestmentRegistrationCard(page) {
  const context = page.context();

  const misaTitle = page.getByText(/^MISA Investment Registration$/i).first();
  await misaTitle.waitFor({ state: 'visible', timeout: 30000 });

  const card = misaIrCardLocator(page);
  await card.scrollIntoViewIfNeeded();

  const applyVisible = await card.locator('button, a[role="button"]').filter({
    hasText: /^Apply\s*→?$/i,
  }).filter({ visible: true }).first().isVisible({ timeout: 2000 }).catch(() => false);

  if (applyVisible) {
    console.log('[STEP3] MISA card already expanded — skipping header click.');
    return getWorkflowPage(page);
  }

  console.log('[STEP3] Clicking APPLY FOR → MISA Investment Registration card (scoped).');

  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await card.click({ force: true });

  const popup = await popupPromise;
  await page.waitForTimeout(1200);

  if (popup && !popup.isClosed()) {
    await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    console.log(`[STEP3] MISA IR opened tab: ${popup.url()}`);
    await popup.bringToFront().catch(() => {});
    return getWorkflowPage(popup);
  }

  const wp = getWorkflowPage(page);
  await wp.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  console.log('[STEP3] MISA card expanded on dashboard.');
  return wp;
}

/**
 * Apply → inside the expanded MISA card on dashboard — not Explore/Know More.
 */
export async function clickMisaApplyButton(page) {
  const card = misaIrCardLocator(page);

  const applyInCard = card.locator('button, a[role="button"], [role="button"]').filter({
    hasText: /^Apply\s*→?$|^تقديم\s*→?$/i,
  }).filter({ visible: true }).first();

  if (await applyInCard.isVisible({ timeout: 20000 }).catch(() => false)) {
    await applyInCard.scrollIntoViewIfNeeded();
    await applyInCard.click({ force: true });
    console.log('[STEP3] Clicked Apply → inside MISA card.');
    return true;
  }

  const scope = page.locator('.p-dialog, [role="dialog"], main, form, [class*="content"], body').filter({ visible: true }).last();
  const candidates = scope.locator('button, a[role="button"], [role="button"]').filter({
    hasText: /^Apply\s*→?$|^تقديم\s*→?$/i,
  }).filter({ visible: true });

  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = candidates.nth(i);
    const nearby = (await btn.locator('xpath=ancestor::div[4]').innerText().catch(() => '')).slice(0, 500);
    if (DASHBOARD_TRAP_RE.test(nearby)) continue;
    if (/^Opportunities$/im.test(nearby) && !/apply for|investment registration/i.test(nearby)) continue;
    if (!/MISA Investment Registration|Simplifying investment access/i.test(nearby)) continue;

    await btn.scrollIntoViewIfNeeded();
    await btn.click({ force: true });
    console.log('[STEP3] Clicked scoped Apply button.');
    return true;
  }

  const roleApply = page.getByRole('button', { name: /^Apply\s*→?$|^تقديم$/i }).filter({ visible: true });
  const roleCount = await roleApply.count().catch(() => 0);
  for (let i = 0; i < roleCount; i++) {
    const btn = roleApply.nth(i);
    const nearby = (await btn.locator('xpath=ancestor::div[4]').innerText().catch(() => '')).slice(0, 500);
    if (DASHBOARD_TRAP_RE.test(nearby)) continue;
    if (!/MISA Investment Registration|Simplifying investment access/i.test(nearby)) continue;
    await btn.click({ force: true });
    console.log('[STEP3] Clicked scoped Apply (role).');
    return true;
  }

  aiHelp('click', 'Apply → (scoped — not Explore/Know More)');
  return false;
}

/** GCC / shareholder question — No inside dialog only. */
export async function clickMisaGccNo(page) {
  if (page.isClosed()) return false;
  const gccDialog = page.locator('.p-dialog, [role="dialog"]').filter({
    hasText: /GCC|all your shareholders/i,
  }).filter({ visible: true }).last();
  if (await gccDialog.isVisible({ timeout: 8000 }).catch(() => false)) {
    return clickScopedButton(gccDialog, [/^No$/i, /^لا$/], 'GCC No');
  }
  return false;
}

/**
 * Re-open MISA Investment Registration from dashboard-without-ir.
 */
export async function recoverToInvestmentFlow(page) {
  const url = page.url();
  console.log(`[RECOVER] Re-aligning investment flow from: ${url}`);

  if (await isBusinessActivitiesPage(page)) {
    console.log('[RECOVER] Already on Business Activities.');
    return page;
  }

  if (BAD_WORKFLOW_URL_RE.test(url) || /dashboard-without/i.test(url)) {
    const wp = await clickMisaInvestmentRegistrationCard(page);
    return wp;
  }

  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 6000 });
    await page.waitForTimeout(800);
    if (await isBusinessActivitiesPage(page)) return page;
    return clickMisaInvestmentRegistrationCard(page);
  } catch (_) {
    return page;
  }
}

/** Close offer/marketing/blank tabs — never close the MISA registration workflow tab. */
async function closeUnexpectedTabs(page) {
  const context = page.context();
  const open = context.pages().filter((p) => !p.isClosed());
  if (open.length <= 1) return false;

  const keeper = getWorkflowPage(page);
  let closed = false;
  for (const p of open) {
    if (p === keeper) continue;
    try {
      await p.close({ runBeforeUnload: true });
      closed = true;
    } catch (_) {
      try { await p.close(); closed = true; } catch (_) {}
    }
  }
  if (closed) {
    console.log(`[INTERCEPTOR] Closed extra tab(s); keeping workflow: ${keeper.url()}`);
    await keeper.bringToFront().catch(() => {});
  }
  return closed;
}

/** Drifted to marketing dashboard, offer page, or wrong MISA shell — recover. */
async function recoverWorkflowUrl(page) {
  const url = page.url();
  if (!/investsaudi\.sa/i.test(url)) return false;
  if (isGoodWorkflowUrl(url)) return false;

  if (BAD_WORKFLOW_URL_RE.test(url) || DRIFT_URL_RE.test(url) || /\/en\/?$|\/ar\/?$/i.test(url)) {
    return recoverToInvestmentFlow(page);
  }

  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 4000 });
    console.log(`[INTERCEPTOR] Navigated back from: ${url}`);
    return true;
  } catch (_) {
    return recoverToInvestmentFlow(page);
  }
}

function dialogLocator(page) {
  return page.locator(
    '.p-dialog:visible, [role="dialog"]:visible, .modal.show:visible, .modal:visible, .p-confirmdialog:visible'
  ).filter({ visible: true });
}

/** Click first visible match inside a scoped container (short timeout). */
async function clickScopedButton(scope, patterns, logMsg) {
  for (const pattern of patterns) {
    const roleBtn = scope.getByRole('button', { name: pattern }).first();
    if (await roleBtn.isVisible({ timeout: INTERCEPT_MS }).catch(() => false)) {
      await roleBtn.click({ force: true, timeout: INTERCEPT_CLICK_MS });
      console.log(`[INTERCEPTOR] ${logMsg} → ${pattern}`);
      return true;
    }
    const textBtn = scope.locator('button, a[role="button"], [role="button"]').filter({ hasText: pattern }).first();
    if (await textBtn.isVisible({ timeout: INTERCEPT_MS }).catch(() => false)) {
      await textBtn.click({ force: true, timeout: INTERCEPT_CLICK_MS });
      console.log(`[INTERCEPTOR] ${logMsg} → ${pattern}`);
      return true;
    }
  }
  return false;
}

/** PrimeNG / modal dialogs — always scope clicks inside the dialog shell. */
async function dismissVisibleDialogs(page) {
  const dialogs = dialogLocator(page);
  const count = await dialogs.count().catch(() => 0);
  if (!count) return false;

  const dialog = dialogs.last();
  if (!(await dialog.isVisible({ timeout: INTERCEPT_MS }).catch(() => false))) return false;

  const bodyText = await dialog.innerText({ timeout: INTERCEPT_MS }).catch(() => '');

  if (/GCC|all your shareholders|shareholders from GCC/i.test(bodyText)) {
    if (await clickScopedButton(dialog, [/^No$/i, /^لا$/], 'GCC shareholders dialog')) return true;
  }

  if (/Terms\s*&\s*Conditions|terms and conditions|acknowledge/i.test(bodyText)) {
    if (await clickScopedButton(
      dialog,
      [/^Agree$/i, /^موافق$/i, /^أوافق$/i, /^Accept$/i, /^I Agree$/i],
      'Terms dialog'
    )) return true;
  }

  if (/Are all your shareholders/i.test(bodyText)) {
    if (await clickScopedButton(dialog, [/^No$/i, /^لا$/], 'Shareholders question')) return true;
  }

  if (await clickScopedButton(
    dialog,
    [/^Close$/i, /^Cancel$/i, /^Dismiss$/i, /^Not now$/i, /^Skip$/i, /^Later$/i, /^No$/i, /^إغلاق$/i, /^لا$/],
    'Dialog dismiss'
  )) return true;

  const closeIcon = dialog.locator(
    '.p-dialog-header-close, .p-dialog-close-icon, [aria-label="Close"], [aria-label="close"], button.close'
  ).first();
  if (await closeIcon.isVisible({ timeout: INTERCEPT_MS }).catch(() => false)) {
    await closeIcon.click({ force: true, timeout: INTERCEPT_CLICK_MS });
    console.log('[INTERCEPTOR] Dialog closed via X icon.');
    return true;
  }

  return false;
}

/** Overlays / inline prompts without role=dialog (ads, masks, GCC inline). */
async function dismissOrphanOverlays(page) {
  const mask = page.locator('.p-dialog-mask, .p-component-overlay, .cdk-overlay-backdrop').filter({ visible: true }).first();
  const maskVisible = await mask.isVisible({ timeout: INTERCEPT_MS }).catch(() => false);

  const gccPanel = page.locator('div, section, form').filter({
    hasText: /GCC|Are all your shareholders/i,
  }).filter({ visible: true }).first();

  if (await gccPanel.isVisible({ timeout: INTERCEPT_MS }).catch(() => false)) {
    if (await clickScopedButton(gccPanel, [/^No$/i, /^لا$/], 'GCC inline prompt')) return true;
  }

  const promo = page.locator('div, section').filter({
    hasText: /opportunit|special offer|limited time|investment opportunity/i,
  }).filter({ visible: true }).first();

  if (await promo.isVisible({ timeout: INTERCEPT_MS }).catch(() => false)) {
    if (await clickScopedButton(
      promo,
      [/^Close$/i, /^Dismiss$/i, /^Not now$/i, /^Skip$/i, /^Later$/i, /^No$/i],
      'Promo/offer panel'
    )) return true;
  }

  if (maskVisible) {
    const closeNearMask = page.locator(
      '.p-dialog-header-close, .p-dialog-close-icon, [aria-label="Close"]'
    ).filter({ visible: true }).first();
    if (await closeNearMask.isVisible({ timeout: INTERCEPT_MS }).catch(() => false)) {
      await closeNearMask.click({ force: true, timeout: INTERCEPT_CLICK_MS });
      console.log('[INTERCEPTOR] Closed overlay via mask close icon.');
      return true;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    return true;
  }

  return false;
}

async function focusAndClick(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.page().waitForTimeout(DELAY_MS);
  await locator.click({ force: true });
}

/** @returns {import('@playwright/test').Locator} */
export function findLabel(page, labelText) {
  return page.locator('label, span, .label, span.label-text').filter({
    hasText: new RegExp(`^\\s*${escapeRegex(labelText)}\\s*\\*?\\s*$`, 'i'),
  }).first();
}

/** PrimeNG: walk up to find p-dropdown / combobox before plain input */
export async function findDropdownTrigger(page, labelText, scope = null) {
  const root = scope || page;
  const label = root.locator('label, span, .label, span.label-text').filter({
    hasText: new RegExp(`^\\s*${escapeRegex(labelText)}\\s*\\*?\\s*$`, 'i'),
  }).first();
  if (!(await label.isVisible({ timeout: 2000 }).catch(() => false))) return null;

  for (const level of ['xpath=..', 'xpath=../..', 'xpath=../../..']) {
    const ancestor = label.locator(level);
    for (const sel of ['.p-dropdown', 'p-dropdown', '[role="combobox"]', '.p-dropdown-trigger']) {
      const el = ancestor.locator(sel).first();
      if (await el.isVisible({ timeout: 400 }).catch(() => false)) return el;
    }
  }
  return label.locator('xpath=..').locator('input, [role="combobox"], .p-dropdown-trigger').first();
}

/** Contact Person form root — heading/label anchors, no hashed CSS classes. */
export async function getContactSection(page) {
  const markers = [
    () => page.getByRole('heading', { name: /Contact Person/i }).first(),
    () => page.getByText(/Contact Person Information/i).first(),
    () => findLabel(page, 'Identity Type'),
  ];
  for (const getMarker of markers) {
    const marker = getMarker();
    if (!(await marker.isVisible({ timeout: 2500 }).catch(() => false))) continue;

    const form = marker.locator('xpath=ancestor::form[1]');
    if (await form.count().then((n) => n > 0) && await form.isVisible({ timeout: 800 }).catch(() => false)) {
      return form;
    }

    const container = marker.locator('xpath=ancestor::div[3]');
    if (await container.isVisible({ timeout: 800 }).catch(() => false)) {
      return container;
    }
  }
  return page;
}

export async function resolveContactScope(page, useContactSection) {
  if (!useContactSection) return page;
  return getContactSection(page);
}

/** Labeled field row within a scope (Contact Person section). */
export function findLabeledRow(scope, labelText) {
  const labelPattern = new RegExp(`^\\s*${escapeRegex(labelText)}`, 'i');
  return scope.locator('div').filter({
    has: scope.locator('label, .label, span.label-text').filter({ hasText: labelPattern }),
  }).first();
}

/** @deprecated use findLabeledRow — kept for callers */
export function findContactRow(page, labelText, scope = null) {
  return findLabeledRow(scope || page, labelText);
}

/** Input/combobox/calendar inside a labeled row (Step 7). */
export async function findFieldInRow(scope, labelText, fieldKind = 'input') {
  const row = findLabeledRow(scope, labelText);
  if (!(await row.isVisible({ timeout: 2000 }).catch(() => false))) return null;

  if (fieldKind === 'prefix' || fieldKind === 'combobox') {
    for (const sel of ['[role="combobox"]', '.p-dropdown', 'p-dropdown', '.p-dropdown-trigger', 'input[placeholder*="Select"]']) {
      const el = row.locator(sel).first();
      if (await el.isVisible({ timeout: 500 }).catch(() => false)) return el;
    }
  }

  if (fieldKind === 'calendar') {
    const cal = row.locator(
      '.react-datepicker__input-container input, .react-datepicker-wrapper input, input[readonly]'
    ).first();
    if (await cal.isVisible({ timeout: 500 }).catch(() => false)) return cal;
  }

  const inputs = row.locator('input:not([type="hidden"]):not([disabled])');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const inp = inputs.nth(i);
    if (!(await inp.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const ro = await inp.getAttribute('readonly').catch(() => null);
    const role = await inp.getAttribute('role').catch(() => null);
    if (fieldKind === 'number' && (role === 'combobox' || ro === 'readonly')) continue;
    if (fieldKind === 'input' && role === 'combobox') continue;
    return inp;
  }
  return null;
}

export async function findInputForLabel(page, labelText, options = {}) {
  const useContact = options.contactSection || options.contactRow;
  if (useContact) {
    const scope = options.scope || await resolveContactScope(page, true);
    const rowInput = await findFieldInRow(scope, labelText, 'input');
    if (rowInput) return rowInput;
  }

  const byLabel = page.getByLabel(new RegExp(escapeRegex(labelText), 'i')).first();
  if (await byLabel.isVisible({ timeout: 1500 }).catch(() => false)) return byLabel;

  const lbl = findLabel(page, labelText);
  if (await lbl.isVisible({ timeout: 1500 }).catch(() => false)) {
    return lbl.locator('xpath=..').locator('input:not([readonly]):not([disabled])').first();
  }
  return null;
}

/** Build name patterns from label + altLabels (EN/AR friendly). */
function semanticNamePatterns(label, altLabels = []) {
  return [label, ...(altLabels || [])].filter(Boolean).map((n) => new RegExp(escapeRegex(String(n).trim()), 'i'));
}

/**
 * Find a field using Playwright semantic locators first (role/label/placeholder),
 * then label-DOM walk. Returns { locator, strategy } for logging.
 */
export async function findFieldSemantic(page, options = {}) {
  const {
    label,
    altLabels = [],
    roles = ['textbox', 'combobox'],
    placeholderFallback,
    contactSection = false,
    contactRow = false,
    field,
    scope: scopeIn,
  } = options;

  const useContact = contactSection || contactRow;
  let scope = scopeIn || page;
  if (useContact && scope === page) {
    scope = await resolveContactScope(page, true);
  }

  if (useContact && (field === 'prefix' || field === 'number')) {
    const rowKind = field === 'prefix' ? 'combobox' : 'number';
    const rowEl = await findFieldInRow(scope, label, rowKind);
    if (rowEl) {
      return { locator: rowEl, strategy: `contact-row/${rowKind}("${label}")` };
    }
  }

  const patterns = semanticNamePatterns(label, altLabels);

  for (const pattern of patterns) {
    for (const role of roles) {
      const byRole = scope.getByRole(role, { name: pattern }).first();
      if (await byRole.isVisible({ timeout: 1200 }).catch(() => false)) {
        const tag = useContact ? 'scoped' : 'page';
        return { locator: byRole, strategy: `getByRole(${role}, "${pattern.source}", ${tag})` };
      }
    }
    const byLabel = scope.getByLabel(pattern).first();
    if (await byLabel.isVisible({ timeout: 1200 }).catch(() => false)) {
      return { locator: byLabel, strategy: `getByLabel("${pattern.source}")` };
    }
  }

  for (const pattern of patterns) {
    const name = pattern.source.replace(/^\^|\$$/g, '').replace(/\\/g, '');
    const walked = await findInputForLabel(page, name, { contactSection: useContact, scope });
    if (walked && await walked.isVisible({ timeout: 800 }).catch(() => false)) {
      return { locator: walked, strategy: `label-walk("${name}")` };
    }
  }

  if (placeholderFallback) {
    const byPh = scope.getByPlaceholder(new RegExp(escapeRegex(placeholderFallback), 'i')).first();
    if (await byPh.isVisible({ timeout: 1200 }).catch(() => false)) {
      return { locator: byPh, strategy: `getByPlaceholder("${placeholderFallback}")` };
    }
    const legacy = scope.locator(`input[placeholder="${placeholderFallback}"]`).first();
    if (await legacy.isVisible({ timeout: 800 }).catch(() => false)) {
      return { locator: legacy, strategy: `placeholder-attr("${placeholderFallback}")` };
    }
  }

  return null;
}

function logSemanticMatch(label, strategy) {
  console.log(`  [SEMANTIC] "${label}" → ${strategy}`);
}

/** Pick dropdown/list option — role first, PrimeNG text fallback. */
async function pickListOption(page, optionText) {
  const clean = String(optionText).replace(/\.$/, '').trim();
  if (!clean) return true;
  const re = new RegExp(`^\\s*${escapeRegex(clean)}`, 'i');

  const roleOption = page.getByRole('option', { name: re }).filter({ visible: true }).last();
  if (await roleOption.isVisible({ timeout: 4000 }).catch(() => false)) {
    await roleOption.scrollIntoViewIfNeeded();
    await roleOption.click({ force: true });
    return true;
  }

  const listbox = page.getByRole('listbox').filter({ visible: true }).last();
  if (await listbox.isVisible({ timeout: 1500 }).catch(() => false)) {
    const inList = listbox.getByRole('option', { name: re }).last();
    if (await inList.isVisible({ timeout: 3000 }).catch(() => false)) {
      await inList.click({ force: true });
      return true;
    }
  }

  const legacy = page.locator('li, .p-dropdown-item, p-dropdownitem, span, div').filter({ hasText: re }).filter({ visible: true }).last();
  if (await legacy.isVisible({ timeout: 8000 }).catch(() => false)) {
    await legacy.scrollIntoViewIfNeeded();
    await legacy.click({ force: true });
    return true;
  }
  return false;
}

/** Fill text field — getByRole(textbox) / getByLabel first, placeholder last. */
export async function smartFillSemantic(page, label, value, options = {}) {
  if (value == null || String(value).trim() === '') {
    if (options.optional) return true;
    return true;
  }
  const val = String(value);
  try {
    const found = await findFieldSemantic(page, {
      label,
      altLabels: options.altLabels,
      roles: ['textbox'],
      placeholderFallback: options.placeholderFallback,
      contactSection: options.contactSection,
      contactRow: options.contactRow,
      field: options.field,
      scope: options.scope,
    });
    if (!found) {
      aiHelp('semantic-fill', label);
      return false;
    }
    logSemanticMatch(label, found.strategy);
    const { locator } = found;
    if (options.clearReadonly) {
      await locator.evaluate((el) => { el.readOnly = false; }).catch(() => {});
    }
    await locator.scrollIntoViewIfNeeded();
    await locator.click({ force: true });
    await locator.fill('');
    const delay = options.slow ? 200 : 80;
    await locator.pressSequentially(val, { delay });
    return true;
  } catch (err) {
    aiHelp('semantic-fill', label);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

/** Open combobox/dropdown by accessible name, pick option by role/text. */
export async function smartSelectSemantic(page, label, optionText, options = {}) {
  if (!optionText || String(optionText).trim() === '') return true;
  const clean = String(optionText).replace(/\.$/, '').trim();
  try {
    await closeOpenPopups(page);

    let trigger = null;
    let strategy = '';

    const useContact = options.contactSection || options.contactRow;
    const scope = options.scope || (useContact ? await resolveContactScope(page, true) : page);

    const found = await findFieldSemantic(page, {
      label,
      altLabels: options.altLabels,
      roles: ['combobox', 'textbox'],
      placeholderFallback: options.placeholderFallback,
      contactSection: useContact,
      field: options.field,
      scope,
    });
    if (found) {
      trigger = found.locator;
      strategy = found.strategy;
    } else {
      trigger = await findDropdownTrigger(page, label, scope);
      if (trigger) strategy = `findDropdownTrigger("${label}")`;
    }

    if (!trigger) {
      aiHelp('semantic-dropdown', `${label} → ${clean}`);
      return false;
    }
    logSemanticMatch(label, strategy);
    await focusAndClick(trigger);
    await page.waitForTimeout(400);

    if (!(await pickListOption(page, clean))) {
      aiHelp('semantic-dropdown-option', `${label} → ${clean}`);
      return false;
    }
    await closeOpenPopups(page);
    return true;
  } catch (err) {
    aiHelp('semantic-dropdown', `${label} → ${clean}`);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

/** Title on registration — getByLabel / getByRole(combobox) then native select fallback. */
export async function smartSemanticTitleSelect(page, titleValue) {
  const regTitle = String(titleValue || 'Mr.').trim();
  const patterns = semanticNamePatterns('Title', ['Salutation', 'Prefix']);

  for (const pattern of patterns) {
    const labeled = page.getByLabel(pattern).first();
    if (await labeled.isVisible({ timeout: 1500 }).catch(() => false)) {
      const tag = await labeled.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') {
        logSemanticMatch('Title', `getByLabel(select, "${pattern.source}")`);
        try {
          await labeled.selectOption({ label: regTitle });
        } catch (_) {
          const titleMap = { 'Dr.': '1', Dr: '1', Miss: '2', 'Mr.': '3', Mr: '3', 'Mrs.': '4', Mrs: '4', 'Ms.': '5', Ms: '5' };
          await labeled.selectOption({ value: titleMap[regTitle] || '3' });
        }
        await labeled.evaluate((el) => {
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return true;
      }
    }
    const combo = page.getByRole('combobox', { name: pattern }).first();
    if (await combo.isVisible({ timeout: 1500 }).catch(() => false)) {
      logSemanticMatch('Title', `getByRole(combobox, "${pattern.source}")`);
      await focusAndClick(combo);
      await page.waitForTimeout(400);
      if (await pickListOption(page, regTitle)) {
        await closeOpenPopups(page);
        return true;
      }
    }
  }

  console.log('  [SEMANTIC] Title → fallback native_select');
  return smartNativeTitleSelect(page, regTitle);
}

async function findSafeClickTarget(page, textOrSelector) {
  const text = String(textOrSelector).trim();
  if (!text) return null;

  if (looksLikeSelector(text)) {
    const loc = page.locator(text).first();
    if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) return loc;
    return null;
  }

  const roles = ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio'];
  for (const role of roles) {
    const byRole = page.getByRole(role, { name: new RegExp(text, 'i') }).first();
    if (await byRole.isVisible({ timeout: 800 }).catch(() => false)) return byRole;
  }

  for (const finder of [
    () => page.getByLabel(new RegExp(text, 'i')).first(),
    () => page.getByPlaceholder(new RegExp(text, 'i')).first(),
    () => page.getByText(new RegExp(`^\\s*${escapeRegex(text)}\\s*$`, 'i')).first(),
  ]) {
    const loc = finder();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) return loc;
  }

  const candidates = page.locator(
    'button, a, [role="button"], [role="link"], [role="tab"], li, span, div'
  ).filter({ hasText: new RegExp(escapeRegex(text), 'i') });
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    if (await el.isVisible({ timeout: 300 }).catch(() => false)) return el;
  }
  return null;
}

export async function smartClick(page, textOrSelector) {
  const target = String(textOrSelector).trim();
  try {
    const locator = await findSafeClickTarget(page, target);
    if (locator) {
      await focusAndClick(locator);
      return true;
    }
    aiHelp('click', target);
    return false;
  } catch (err) {
    aiHelp('click', target);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

/** Try several button labels (English / Arabic) — first match wins */
export async function smartClickAny(page, labels = []) {
  const list = (Array.isArray(labels) ? labels : [labels]).filter(Boolean);
  const wantsGccNo = list.some((t) => /^no$/i.test(String(t).trim()) || String(t).trim() === 'لا');
  const wantsApply = list.some((t) => /^apply$/i.test(String(t).trim()) || String(t).trim() === 'تقديم');

  if (wantsGccNo && await clickMisaGccNo(page)) return true;

  if (wantsApply) return clickMisaApplyButton(page);

  for (const text of list) {
    const trimmed = String(text).trim();
    if (/^misa investment registration$/i.test(trimmed)) continue;
    const locator = await findSafeClickTarget(page, trimmed);
    if (locator) {
      const blockText = await locator.locator('xpath=ancestor::div[3]').innerText().catch(() => '');
      if (DASHBOARD_TRAP_RE.test(blockText)) continue;
      await focusAndClick(locator);
      return true;
    }
  }
  aiHelp('click', list.join(' | '));
  return false;
}

export async function smartFill(page, labelText, value, options = {}) {
  if (value == null || String(value).trim() === '') {
    if (!options.optional) return true;
    return true;
  }
  const val = String(value);
  try {
    const input = await findInputForLabel(page, labelText, options);
    if (!input) {
      aiHelp('fill', labelText);
      return false;
    }
    await input.scrollIntoViewIfNeeded();
    await input.click({ force: true });
    await input.fill('');
    await input.pressSequentially(val, { delay: 80 });
    return true;
  } catch (err) {
    aiHelp('fill', labelText);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

export async function smartSelect(page, labelText, optionText, options = {}) {
  if (!optionText || String(optionText).trim() === '') return true;
  const clean = String(optionText).replace(/\.$/, '').trim();
  try {
    const useContact = options.contactSection || options.contactRow;
    const scope = useContact ? (options.scope || await resolveContactScope(page, true)) : null;
    const trigger = await findDropdownTrigger(page, labelText, scope);
    if (!trigger) {
      aiHelp('dropdown', `${labelText} → ${clean}`);
      return false;
    }
    await focusAndClick(trigger);
    await page.waitForTimeout(400);

    const optionItem = page.locator('li, .p-dropdown-item, p-dropdownitem, span, div').filter({
      hasText: new RegExp(`^\\s*${escapeRegex(clean)}`, 'i'),
    }).filter({ visible: true }).last();

    await expect(optionItem).toBeVisible({ timeout: 12000 });
    await optionItem.scrollIntoViewIfNeeded();
    await optionItem.click({ force: true });
    await closeOpenPopups(page);
    return true;
  } catch (err) {
    console.log(`smartSelect fallback "${labelText}": ${err.message}`);
    try {
      if (labelText.includes('Identity')) {
        await page.getByRole('textbox', { name: 'Select' }).first().click({ force: true });
        await page.locator('li, div, span').filter({ hasText: /^Passport$/i }).first().click({ force: true });
        return true;
      }
    } catch (_) {}
    aiHelp('dropdown', `${labelText} → ${clean}`);
    return false;
  }
}

/**
 * Calendar: Hijri/Gregorian chooser (shareholder) + react-datepicker (contact).
 */
export async function smartCalendar(page, labelText, { year, month, day, calendarType = 'Gregorian' }, options = {}) {
  const dayNum = String(parseInt(day, 10));
  try {
    await closeOpenPopups(page);

    let trigger = null;
    if (options.contactSection || options.contactRow) {
      const scope = options.scope || await resolveContactScope(page, true);
      const row = findLabeledRow(scope, labelText);
      await row.waitFor({ state: 'visible', timeout: 15000 });
      trigger = await findFieldInRow(scope, labelText, 'calendar');
      if (!trigger) {
        trigger = row.locator(
          '.react-datepicker__input-container input, .react-datepicker-wrapper input, input[readonly]'
        ).first();
      }
    } else {
      const lbl = findLabel(page, labelText);
      if (await lbl.isVisible({ timeout: 3000 }).catch(() => false)) {
        trigger = lbl.locator('xpath=..').locator(
          '.react-datepicker__input-container input, .react-datepicker-wrapper input, input, button'
        ).first();
      }
    }

    if (!trigger || !(await trigger.isVisible({ timeout: 2000 }).catch(() => false))) {
      aiHelp('calendar', labelText);
      return false;
    }

    await trigger.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await trigger.click({ force: true });
    await page.waitForTimeout(500);

    const calTypeBtn = page.locator('button, span, div, li').filter({
      hasText: new RegExp(`^${escapeRegex(calendarType)}$`, 'i'),
    }).filter({ visible: true }).first();
    if (await calTypeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await calTypeBtn.click({ force: true });
      await page.waitForTimeout(500);
    }

    const cal = page.locator(
      '.react-datepicker-popper, .react-datepicker, .p-datepicker, .p-calendar-panel'
    ).filter({ visible: true }).last();

    if (!(await cal.isVisible({ timeout: 2000 }).catch(() => false))) {
      await trigger.click({ force: true });
      await page.waitForTimeout(600);
      if (await calTypeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await calTypeBtn.click({ force: true });
        await page.waitForTimeout(400);
      }
    }
    await cal.waitFor({ state: 'visible', timeout: 8000 });

    const yearBox = cal.getByRole('textbox', { name: 'YYYY' }).first();
    if (await yearBox.isVisible({ timeout: 1500 }).catch(() => false)) {
      await yearBox.fill(String(year));
      await page.keyboard.press('Tab');
    } else {
      const numInp = cal.locator('input[type="number"], p-inputnumber input, input[type="text"]').first();
      if (await numInp.isVisible({ timeout: 1000 }).catch(() => false)) {
        await numInp.click({ force: true, clickCount: 3 });
        await numInp.fill(String(year));
        await page.keyboard.press('Tab');
      }
    }

    const monthSel = cal.locator('select').first();
    if (await monthSel.isVisible({ timeout: 2000 }).catch(() => false)) {
      const mv = MONTH_INDEX[String(month).toLowerCase()];
      if (mv !== undefined) await monthSel.selectOption(mv);
      else await monthSel.selectOption({ label: month });
    }

    const dayCell = cal.locator(
      '.react-datepicker__day:not(.react-datepicker__day--outside-month):not(.react-datepicker__day--disabled),' +
      'td span:not(.p-datepicker-other-month):not(.p-disabled)'
    ).filter({ hasText: new RegExp(`^${dayNum}$`) }).first();
    await expect(dayCell).toBeVisible({ timeout: 8000 });
    await dayCell.click({ force: true });

    const saveBtn = cal.getByRole('button', { name: /^Save$/i }).first();
    if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await saveBtn.click({ force: true });
    } else {
      await page.keyboard.press('Escape');
    }
    await cal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    return true;
  } catch (err) {
    aiHelp('calendar', labelText);
    if (err?.message) console.log(`  (${err.message})`);
    await closeOpenPopups(page);
    return false;
  }
}

export async function smartTab(page, tabText) {
  return smartClick(page, tabText);
}

/** MISA Step 2: terms checkbox / acknowledge text */
export async function smartTermsAcknowledge(page) {
  try {
    await page.click('text=I acknowledge reading and agreeing to the', { timeout: 5000 });
    return true;
  } catch (_) {
    return smartCheckbox(page, 'terms');
  }
}

export async function smartCheckbox(page, labelText) {
  try {
    const cb = page.getByRole('checkbox', { name: new RegExp(labelText, 'i') }).first();
    if (await cb.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (!(await cb.isChecked().catch(() => false))) await cb.check({ force: true });
      return true;
    }
    const label = page.locator('label').filter({ hasText: new RegExp(labelText, 'i') }).first();
    if (await label.isVisible({ timeout: 1000 }).catch(() => false)) {
      await focusAndClick(label);
      return true;
    }
    return smartClick(page, labelText);
  } catch (err) {
    aiHelp('checkbox', labelText);
    return false;
  }
}

export async function smartUpload(page, filePath, options = {}) {
  if (!filePath || String(filePath).trim() === '') return true;
  try {
    const { index = 0 } = options;
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
    const inputs = page.locator('input[type="file"]');
    const count = await inputs.count();
    if (count <= index) {
      aiHelp('upload', `file input index ${index}`);
      return false;
    }
    await inputs.nth(index).setInputFiles(filePath);
    return true;
  } catch (err) {
    aiHelp('upload', filePath);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

/** MISA registration: native <select> for Title */
export async function smartNativeTitleSelect(page, titleValue) {
  const regTitle = String(titleValue || 'Mr.').trim();
  try {
    const titleSelect = page.locator('select[name="firstName_prefix"], select[id="firstName_prefix"], select').first();
    await titleSelect.waitFor({ state: 'visible', timeout: 15000 });
    try {
      await titleSelect.selectOption({ label: regTitle });
    } catch (_) {
      const titleMap = { 'Dr.': '1', Dr: '1', Miss: '2', 'Mr.': '3', Mr: '3', 'Mrs.': '4', Mrs: '4', 'Ms.': '5', Ms: '5' };
      await titleSelect.selectOption({ value: titleMap[regTitle] || '3' });
    }
    await titleSelect.evaluate((el) => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return true;
  } catch (e) {
    await page.evaluate((titleText) => {
      const select = document.querySelector('select[name="firstName_prefix"], select');
      if (!select) return;
      const option = Array.from(select.options).find(
        (opt) => opt.text.includes(titleText) || opt.value === titleText
      );
      select.value = option ? option.value : '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, regTitle);
    return true;
  }
}

/** Fill by placeholder (MISA registration fields) */
export async function smartFillByPlaceholder(page, placeholder, value, options = {}) {
  if (!value || String(value).trim() === '') {
    if (options.optional) return true;
    return true;
  }
  try {
    const input = page.locator(`input[placeholder="${placeholder}"]`).first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    if (options.clearReadonly) {
      await input.evaluate((el) => { el.readOnly = false; });
    }
    await input.scrollIntoViewIfNeeded();
    await input.click({ force: true });
    await input.fill('');
    const delay = options.slow ? 200 : 80;
    await input.pressSequentially(String(value), { delay });
    return true;
  } catch (err) {
    aiHelp('fill', placeholder);
    return false;
  }
}

/** Open PrimeNG / custom dropdown panel attached to a placeholder trigger. */
function dropdownPanelLocator(page) {
  return page.locator(
    '.p-dropdown-panel, .p-overlay-visible, .p-connected-overlay, ul[role="listbox"], .p-dropdown-items'
  ).filter({ visible: true }).last();
}

/** Click placeholder trigger then pick option (Entity Legal Status, Region, City, etc.) */
export async function smartPlaceholderDropdown(page, placeholder, optionText, options = {}) {
  if (!optionText) return true;
  const labels = [optionText, ...(options.altLabels || [])].filter(Boolean);

  try {
    const trigger = page.locator(`input[placeholder="${placeholder}"]`).first();
    await trigger.waitFor({ state: 'visible', timeout: 15000 });

    if (placeholder === 'Select City') {
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    }

    await trigger.scrollIntoViewIfNeeded();
    await trigger.click({ force: true });
    await page.waitForTimeout(1500);

    const panel = dropdownPanelLocator(page);
    const searchRoot = (await panel.isVisible({ timeout: 2000 }).catch(() => false)) ? panel : page;

    const isCity = placeholder === 'Select City';
    let clicked = false;

    for (const label of labels) {
      const matchers = isCity
        ? [
            new RegExp(`^${escapeRegex(label)}$`, 'i'),
            new RegExp(`\\b${escapeRegex(label)}\\b`, 'i'),
          ]
        : [label];

      for (const matcher of matchers) {
        const optionsLoc = searchRoot.locator('div, span, li, .p-dropdown-item, p-dropdownitem').filter({
          hasText: typeof matcher === 'string' ? matcher : matcher,
        });
        const count = await optionsLoc.count().catch(() => 0);

        for (let i = count - 1; i >= 0; i--) {
          const opt = optionsLoc.nth(i);
          if (!(await opt.isVisible().catch(() => false))) continue;
          const text = (await opt.innerText().catch(() => '')).trim();
          if (isCity && /riyadh/i.test(label) && /^al\s+riyadh$/i.test(text)) continue;
          await opt.click({ force: true });
          clicked = true;
          break;
        }
        if (clicked) break;
      }
      if (clicked) break;
    }

    if (!clicked) {
      throw new Error(`No visible option for ${placeholder} → ${labels.join(' | ')}`);
    }

    await page.waitForTimeout(1000);

    if (placeholder === 'Select City') {
      const display = await trigger.evaluate((el) => {
        const wrap = el.closest('.p-dropdown, p-dropdown, [class*="dropdown"]');
        const label = wrap?.querySelector('.p-dropdown-label');
        return (label?.textContent || el.value || '').trim();
      }).catch(() => '');
      if (!display || /select city/i.test(display)) {
        throw new Error('City dropdown still empty after selection');
      }
    }

    console.log(`  [DROPDOWN] ${placeholder} → ${optionText}`);
    return true;
  } catch (err) {
    aiHelp('dropdown', `${placeholder} → ${optionText}`);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

/** Entity mobile: prefix dropdown + number */
export async function smartEntityMobile(page, prefix, number) {
  try {
    await page.evaluate(() => {
      const mobileInput = document.querySelector('input[placeholder="Enter Mobile Number"]');
      if (mobileInput) {
        const container = mobileInput.closest('div[class*="row"], div[class*="container"]')
          || mobileInput.parentElement?.parentElement;
        const trigger = container?.querySelector(
          'input[placeholder="Select"], .flag-dropdown, .selected-flag, div[class*="prefix"]'
        ) || mobileInput.parentElement?.previousElementSibling;
        if (trigger) trigger.click();
      }
    });
    const prefOpt = page.locator('div, span, li').filter({ hasText: prefix }).filter({ visible: true }).last();
    await expect(prefOpt).toBeVisible({ timeout: 15000 });
    await prefOpt.click({ force: true });
    const numInp = page.locator('input[placeholder="Enter Mobile Number"]').first();
    await numInp.click({ force: true });
    await numInp.fill('');
    await numInp.pressSequentially(String(number), { delay: 100 });
    return true;
  } catch (err) {
    aiHelp('fill', `Entity mobile ${prefix} ${number}`);
    return false;
  }
}

/** Wait until a step anchor label/heading is visible (semantic + label walk). */
export async function waitForStepLabel(page, label, options = {}) {
  const names = [label, ...(options.altLabels || [])].filter(Boolean);
  const timeout = options.timeout || 30000;
  const perTry = Math.min(5000, timeout);

  for (const name of names) {
    const pattern = new RegExp(escapeRegex(name), 'i');
    for (const finder of [
      () => findLabel(page, name),
      () => page.getByRole('heading', { name: pattern }).first(),
      () => page.getByRole('textbox', { name: pattern }).first(),
      () => page.getByText(pattern).first(),
    ]) {
      const loc = finder();
      if (await loc.isVisible({ timeout: perTry }).catch(() => false)) {
        console.log(`  [SEMANTIC] wait_label → visible "${name}"`);
        return true;
      }
    }
  }

  await findLabel(page, names[0]).waitFor({ state: 'visible', timeout });
  return true;
}

/** Checkbox tied to visible label text (Step 4) — getByRole first, text container fallback. */
export async function smartCheckboxByLabelText(page, labelText, options = {}) {
  const patterns = semanticNamePatterns(labelText, options.altLabels);
  try {
    for (const pattern of patterns) {
      const cb = page.getByRole('checkbox', { name: pattern }).first();
      if (await cb.isVisible({ timeout: 2000 }).catch(() => false)) {
        if (!(await cb.isChecked().catch(() => false))) await cb.check({ force: true });
        logSemanticMatch(labelText, `getByRole(checkbox, "${pattern.source}")`);
        return true;
      }
      const byLabel = page.getByLabel(pattern).first();
      if (await byLabel.isVisible({ timeout: 1500 }).catch(() => false)) {
        if (!(await byLabel.isChecked().catch(() => false))) await byLabel.check({ force: true });
        logSemanticMatch(labelText, `getByLabel(checkbox, "${pattern.source}")`);
        return true;
      }
    }

    const container = page.locator('div, label, span').filter({
      hasText: new RegExp(`^${escapeRegex(labelText)}`, 'i'),
    }).first();
    await expect(container).toBeVisible({ timeout: 30000 });
    await container.scrollIntoViewIfNeeded();
    await container.click({ force: true });
    const cb = container.locator('input[type="checkbox"]').first();
    if (await cb.count() > 0) await cb.check({ force: true });
    console.log(`  [SEMANTIC] "${labelText}" → label-text container click`);
    return true;
  } catch (err) {
    aiHelp('checkbox', labelText);
    if (err?.message) console.log(`  (${err.message})`);
    return false;
  }
}

/** Sector dropdown on registration page */
export async function smartSectorSelect(page, sector) {
  try {
    const trigger = page.locator('input[placeholder="Select Sector"]').first();
    await trigger.click({ force: true });
    await page.waitForTimeout(500);
    const opt = page.locator('div, span, li, .p-dropdown-item').filter({ hasText: sector }).filter({ visible: true }).last();
    await expect(opt).toBeVisible({ timeout: 12000 });
    await opt.click({ force: true });
    return true;
  } catch (err) {
    aiHelp('dropdown', `Sector → ${sector}`);
    return false;
  }
}

/** Country on registration page */
export async function smartRegistrationCountry(page, country) {
  try {
    await page.locator('input[placeholder="Select Country"]').first().click({ force: true });
    const opt = page.locator('div, span, li').filter({ hasText: country }).filter({ visible: true }).last();
    await expect(opt).toBeVisible({ timeout: 15000 });
    await opt.click({ force: true });
    return true;
  } catch (err) {
    try {
      await page.click(`text=${country}`);
      return true;
    } catch (_) {
      aiHelp('dropdown', `Country → ${country}`);
      return false;
    }
  }
}

/** Optional national ID — skip if empty or field hidden */
export async function smartNationalId(page, nationalId) {
  const inp = page.locator('input[placeholder="Enter National ID / IQAMA ID"]');
  if (!(await inp.isVisible({ timeout: 2000 }).catch(() => false))) return true;
  if (!nationalId || String(nationalId).trim() === '') return true;
  return smartFillByPlaceholder(page, 'Enter National ID / IQAMA ID', nationalId, { slow: true });
}
