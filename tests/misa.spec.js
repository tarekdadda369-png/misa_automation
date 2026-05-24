import { test, expect } from '@playwright/test';
import fs from 'fs';
import { loadSiteData } from '../utils/loadSiteData.js';
import { runSiteSteps } from '../utils/runSiteSteps.js';
import { runIsicBusinessActivities } from '../utils/isicFlow.js';
import { buildShareholderPersonContext, buildRegistrationContext, buildEntityContext } from '../utils/stepValueMap.js';
import {
  getWorkflowPage,
  isBusinessActivitiesPage,
} from '../utils/smartActions.js';
import { runWorkerWithAi } from '../utils/runWithAiRecovery.js';
import {
  verifyWorkerStep3,
  verifyWorkerStep4,
  verifyWorkerStep7,
  verifyWorkerStep8,
} from '../utils/workerStepGoals.js';
import { aiEnabled } from '../utils/recoveryAgent.js';

const WORKFLOW_TOTAL_STEPS = 8;

/** Keep automation on the live MISA tab (not a closed/blank Playwright tab). */
function ensureWorkflowPage(page, stepLabel = '') {
  const wp = getWorkflowPage(page);
  if (wp.isClosed()) {
    const where = stepLabel ? ` during ${stepLabel}` : '';
    throw new Error(
      `Automation Stopped: browser window was closed${where}. Cannot continue to Steps 2–8.`
    );
  }
  return wp;
}

// Helper to insert random dots in Gmail addresses to bypass unique constraints
function randomizeGmailDots(email) {
  if (!email || !email.endsWith('@gmail.com')) return email;
  const [username, domain] = email.split('@');
  const cleanUsername = username.replace(/\./g, '');
  
  let dotUsername = '';
  for (let i = 0; i < cleanUsername.length; i++) {
    dotUsername += cleanUsername[i];
    if (i < cleanUsername.length - 1) {
      if (Math.random() > 0.5) {
        dotUsername += '.';
      }
    }
  }
  if (!dotUsername.includes('.') && cleanUsername.length > 1) {
    const splitIndex = Math.floor(Math.random() * (cleanUsername.length - 1)) + 1;
    dotUsername = cleanUsername.slice(0, splitIndex) + '.' + cleanUsername.slice(splitIndex);
  }
  return `${dotUsername}@${domain}`;
}

// Helper to resolve dynamic, missing, or double-extended file paths gracefully
function resolveFilePath(filePath) {
  if (!filePath) return '';
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  // Try appending '.pdf' if missing
  if (!filePath.toLowerCase().endsWith('.pdf') && fs.existsSync(filePath + '.pdf')) {
    console.log(`Smart Resolver: Found file by appending .pdf to: ${filePath}`);
    return filePath + '.pdf';
  }
  // Try appending '.pdf.pdf' (if double extended on disk)
  if (fs.existsSync(filePath + '.pdf')) {
    return filePath + '.pdf';
  }
  if (fs.existsSync(filePath + '.pdf.pdf')) {
    console.log(`Smart Resolver: Found file by appending .pdf.pdf to: ${filePath}`);
    return filePath + '.pdf.pdf';
  }
  // Try removing '.pdf' if present and double-extended on disk
  if (filePath.toLowerCase().endsWith('.pdf')) {
    const doubleExtended = filePath + '.pdf';
    if (fs.existsSync(doubleExtended)) {
      console.log(`Smart Resolver: Found double-extended file on disk: ${doubleExtended}`);
      return doubleExtended;
    }
  }
  return filePath; // Fallback
}

/** Wait for DOM + network to settle after navigation or heavy API calls */
async function waitForPageReady(page, timeout = 30000) {
  await page.waitForTimeout(3000);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

/** Click the first visible button matching any alternative label (misa_buckup.js). */
async function clickButton(page, name, alternatives, options = {}) {
  page = getWorkflowPage(page);
  if (page.isClosed()) {
    console.log(`Page already closed when trying to click "${name}"`);
    return;
  }
  const { timeout = 15000, force = true } = options;
  const selector = alternatives.map(t => `button:has-text("${t}")`).join(', ');
  console.log(`Clicking "${name}" (${alternatives.join(' | ')})...`);
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    await page.waitForTimeout(1000);
    await page.locator(selector).first().click({ force });
    await page.waitForTimeout(2000);
  } catch (err) {
    console.log(`clickButton warning for "${name}": ${err.message}`);
  }
}

// Ensure the page is stable before the next step after OTP
async function proceedAfterOtp(page) {
  await waitForPageReady(page);
  // Proceed to next step (e.g., click "Next")
  await clickButton(page, 'Next', ['Next']);
}

async function selectDropdownOption(page, trigger, optionText) {
  const triggerLoc = typeof trigger === 'string' ? page.locator(trigger).first() : trigger;
  await triggerLoc.click({ force: true });
  await page.waitForTimeout(1500); // Wait for dropdown animation
  
  const options = page.locator('div, span, li, .p-dropdown-item, p-dropdownitem').filter({ hasText: optionText });
  const count = await options.count();
  let clicked = false;
  
  for (let i = count - 1; i >= 0; i--) {
    const opt = options.nth(i);
    if (await opt.isVisible()) {
      await opt.click({ force: true });
      clicked = true;
      break;
    }
  }
  
  if (!clicked) {
    console.log(`Warning: Could not find visible option for "${optionText}", trying fallback...`);
    await options.last().click({ force: true });
  }
  
  await page.waitForTimeout(1000); // Wait for dropdown to close
}

/** Wait for file upload processing to finish */
async function waitForUploadComplete(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// OTP AUTOMATION LAYER
// The dashboard server writes incoming OTPs to otp_session.json.
// The test polls that file every 2 s and injects the token automatically.
// If the server isn't running (or token never arrives), we fall back to waiting
// for the human to click the portal's Close button — same as before.
// ─────────────────────────────────────────────────────────────────────────────

// Each parallel run gets its own config + OTP session file via env vars
const WORKFLOW_VERSION = '1.0.0'; // bump when you deploy workflow changes (see COMPANY-OPS.md)
const RUN_ID           = process.env.RUN_ID || '';
const SITE_DATA_FILE   = process.env.SITE_DATA_FILE || 'site_data/misa_config.json';
const CONFIG_FILE      = process.env.CONFIG_FILE || 'config.json';
const OTP_SESSION_FILE = RUN_ID ? `otp_session_${RUN_ID}.json` : 'otp_session.json';

/**
 * Poll otp_session.json every 2 s until an OTP for `type` ('email'|'mobile')
 * appears or maxWaitMs elapses. Consumes (deletes) the token on read.
 * Returns the OTP string, or null on timeout.
 */
async function pollForOtp(page, type, maxWaitMs = 240000) {
  const intervalMs = 2000;
  const maxAttempts = Math.floor(maxWaitMs / intervalMs);
  console.log(`OTP POLLER [${type}]: polling every ${intervalMs}ms, max ${maxWaitMs / 1000}s...`);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (fs.existsSync(OTP_SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(OTP_SESSION_FILE, 'utf8'));
        const token = data[type] ? String(data[type]).trim() : '';
        if (token.length >= 4) {
          console.log(`OTP POLLER [${type}]: token found → "${token}"`);
          delete data[type];
          fs.writeFileSync(OTP_SESSION_FILE, JSON.stringify(data, null, 2), 'utf8');
          return token;
        }
      }
    } catch (_) { /* file may be mid-write — retry */ }
    await page.waitForTimeout(intervalMs);
  }
  console.log(`OTP POLLER [${type}]: timed out — falling back to manual mode.`);
  return null;
}

/**
 * Inject an OTP string into the portal's currently-open OTP modal.
 * Handles two DOM patterns:
 *   (a) Individual single-digit input boxes  → fill each digit
 *   (b) Single text/number input             → fill whole string
 * Then clicks the in-modal Confirm/Verify button if present.
 */
async function injectOtpIntoPage(page, otp) {
  console.log(`OTP INJECTOR: injecting "${otp}" into page...`);

  // Pattern (a): multiple single-character boxes
  const digitInputs = page.locator(
    'input[maxlength="1"], input[type="number"][maxlength="1"], input[type="tel"][maxlength="1"]'
  ).filter({ visible: true });
  const digitCount = await digitInputs.count();

  if (digitCount >= 4) {
    console.log(`OTP INJECTOR: ${digitCount} digit-box(es) found — filling individually.`);
    for (let d = 0; d < Math.min(digitCount, otp.length); d++) {
      await digitInputs.nth(d).click({ force: true });
      await digitInputs.nth(d).fill(otp[d]);
      await page.waitForTimeout(80);
    }
  } else {
    // Pattern (b): single OTP input
    const singleInput = page.locator([
      'input[placeholder*="OTP" i]',
      'input[placeholder*="code" i]',
      'input[placeholder*="verification" i]',
      'input[placeholder*="رمز" i]',
      'input[type="number"]:not([maxlength="1"])',
      'input[type="tel"]:not([maxlength="1"])',
    ].join(', ')).filter({ visible: true }).first();

    if (await singleInput.isVisible().catch(() => false)) {
      console.log(`OTP INJECTOR: single OTP input found — filling full code.`);
      await singleInput.click({ force: true });
      await singleInput.fill('');
      await singleInput.fill(otp);
    } else {
      console.log(`OTP INJECTOR: no OTP input located — typing into focused element.`);
      await page.keyboard.type(otp, { delay: 120 });
    }
  }

  // Click in-modal Confirm / Verify button (optional — only if visible)
  const confirmBtn = page.locator([
    'button:has-text("Confirm")',
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("OK")',
    'button:has-text("تأكيد")',
    'button:has-text("أكد")',
  ].join(', ')).last();

  if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log(`OTP INJECTOR: clicking in-modal confirm button.`);
    await confirmBtn.click({ force: true });
    await page.waitForTimeout(1200);
  }
  console.log(`OTP INJECTOR: done.`);
}

/** Clear OTP digit boxes / single input on the MISA modal so a new code can be injected. */
async function clearOtpInputsOnPage(page) {
  const digitInputs = page.locator(
    'input[maxlength="1"], input[type="number"][maxlength="1"], input[type="tel"][maxlength="1"]'
  ).filter({ visible: true });
  const digitCount = await digitInputs.count().catch(() => 0);
  if (digitCount >= 4) {
    for (let d = 0; d < digitCount; d++) {
      await digitInputs.nth(d).fill('');
    }
    return;
  }
  const singleInput = page.locator([
    'input[placeholder*="OTP" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="verification" i]',
    'input[placeholder*="رمز" i]',
  ].join(', ')).filter({ visible: true }).first();
  if (await singleInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    await singleInput.click({ force: true });
    await singleInput.fill('');
  }
}

/** Close invalid-OTP error dialog / toast on the MISA site (OK, Close, Confirm). */
async function dismissOtpErrorDialog(page) {
  const errorPanel = page.locator('div').filter({
    has: page.getByRole('heading', { name: /^Error$/i }),
  }).filter({
    hasText: /invalid\s*otp|attempt.*remaining/i,
  }).filter({ visible: true }).first();

  if (await errorPanel.isVisible({ timeout: 1500 }).catch(() => false)) {
    const closeBtn = errorPanel.getByRole('button', { name: /^Close$/i }).first();
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log('OTP HANDLER: closing Invalid OTP Error dialog.');
      await closeBtn.click({ force: true });
      await page.waitForTimeout(600);
      return true;
    }
  }

  const failDialog = page.locator('.p-dialog, [role="dialog"], .swal2-container, .swal2-popup').filter({
    hasText: /invalid|wrong|incorrect|failed|error|expired|try again|remaining|فشل|غير صحيح|رمز/i,
  }).filter({ visible: true }).first();

  if (await failDialog.isVisible({ timeout: 2500 }).catch(() => false)) {
    const dialogText = await failDialog.innerText().catch(() => '');
    if (/success|verified|تم التحقق/i.test(dialogText) && !/invalid|wrong|incorrect|فشل/i.test(dialogText)) {
      return false;
    }
    for (const pattern of [/^(OK|Ok)$/i, /^Close$/i, /^Confirm$/i, /^حسنا$/i, /^إغلاق$/i, /^تأكيد$/i]) {
      const btn = failDialog.getByRole('button', { name: pattern }).first();
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        console.log('OTP HANDLER: closing invalid-OTP error dialog.');
        await btn.click({ force: true });
        await page.waitForTimeout(600);
        return true;
      }
    }
    const anyBtn = failDialog.locator('button').filter({ visible: true }).first();
    if (await anyBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await anyBtn.click({ force: true });
      await page.waitForTimeout(600);
      return true;
    }
  }

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  return false;
}

/** After wrong OTP: close MISA error UI, clear portal inputs, tell dashboard to accept a new code. */
async function prepareOtpRetry(page, type) {
  await dismissOtpErrorDialog(page);
  await clearOtpInputsOnPage(page);
  await page.waitForTimeout(400);
  console.log(`OTP DASHBOARD: RESET ${type}`);
}

/** OTP entry modal still open (digits / code input visible). */
function otpEntryModal(page) {
  return page.locator('.p-dialog, [role="dialog"]').filter({
    has: page.locator(
      'input[maxlength="1"], input[placeholder*="OTP" i], input[placeholder*="code" i], input[placeholder*="verification" i]'
    ),
  }).filter({ visible: true });
}

/**
 * Detect invalid OTP feedback (toast, alert, or error dialog).
 * @returns {Promise<string|null>} error text if failed, else null
 */
async function detectOtpFailure(page) {
  await page.waitForTimeout(600);

  const textPatterns = [
    /invalid\s*otp/i,
    /wrong\s*code/i,
    /incorrect\s*otp/i,
    /otp\s*is\s*not\s*valid/i,
    /verification\s*failed/i,
    /code\s*expired/i,
    /try\s*again/i,
    /attempt.*remaining/i,
    /رمز.*غير/i,
    /غير\s*صحيح/i,
    /فشل/i,
  ];

  for (const re of textPatterns) {
    const hit = page.getByText(re).filter({ visible: true }).first();
    if (await hit.isVisible({ timeout: 1200 }).catch(() => false)) {
      return (await hit.innerText().catch(() => '')).trim() || re.source;
    }
  }

  const alert = page.locator(
    '[role="alert"], .p-toast-message-error, .p-message-error, .toast-error, .error-message, .text-danger, [class*="error"]'
  ).filter({ visible: true }).first();

  if (await alert.isVisible({ timeout: 1000 }).catch(() => false)) {
    const text = (await alert.innerText().catch(() => '')).trim();
    if (text && /otp|code|invalid|wrong|expired|خطأ|رمز|فشل/i.test(text)) return text;
  }

  const failDialog = page.locator('.p-dialog, [role="dialog"]').filter({
    hasText: /invalid|wrong|failed|error|incorrect|فشل|غير صحيح/i,
  }).filter({ visible: true }).first();

  if (await failDialog.isVisible({ timeout: 800 }).catch(() => false)) {
    const text = (await failDialog.innerText().catch(() => '')).trim();
    if (!/success|verified|تم التحقق/i.test(text)) {
      return text || 'OTP verification failed';
    }
  }

  return null;
}

/** Email verified on Step 1 (icon/badge — not merely OTP modal closed). */
async function isEmailVerifiedOnStep1(page) {
  const verifiedIcon = page.locator('img[alt="Verified"], img[alt*="verified" i]').first();
  if (await verifiedIcon.isVisible({ timeout: 1500 }).catch(() => false)) return true;

  const nearEmail = page.locator('div').filter({
    has: page.getByPlaceholder(/enter your email/i),
  }).filter({ has: page.locator('img[alt="Verified"], img[alt*="verified" i]') }).first();
  if (await nearEmail.isVisible({ timeout: 1000 }).catch(() => false)) return true;

  return page.getByText(/email verified successfully/i).isVisible({ timeout: 1000 }).catch(() => false);
}

/** True when OTP was accepted — type-specific checks (email must show verified badge). */
async function verifyOtpAccepted(page, type) {
  if (await detectOtpFailure(page)) return false;

  if (type === 'email') {
    for (let i = 0; i < 25; i++) {
      if (await isEmailVerifiedOnStep1(page)) return true;
      if (await detectOtpFailure(page)) return false;
      const otpOpen = await otpEntryModal(page).isVisible({ timeout: 400 }).catch(() => false);
      if (!otpOpen && i >= 5 && (await page.getByText(/email verified/i).isVisible({ timeout: 500 }).catch(() => false))) {
        return true;
      }
      await page.waitForTimeout(500);
    }
    return false;
  }

  const modal = otpEntryModal(page);
  if (!(await modal.isVisible({ timeout: 1500 }).catch(() => false))) return true;
  await page.waitForTimeout(1500);
  if (await detectOtpFailure(page)) return false;
  return !(await modal.isVisible({ timeout: 1500 }).catch(() => false));
}

/**
 * MISA shows SweetAlert-style "Email verified successfully!" (not always role=dialog).
 * Must close before Next / Step 2 — otherwise Next clicks are blocked.
 */
async function dismissEmailVerificationSuccess(page) {
  const successPanel = page.locator('div').filter({
    has: page.getByRole('heading', { name: /^Success$/i }),
  }).filter({
    hasText: /email verified|verified successfully|تم التحقق/i,
  }).filter({ visible: true }).last();

  if (await successPanel.isVisible({ timeout: 3000 }).catch(() => false)) {
    const closeBtn = successPanel.getByRole('button', { name: /^Close$/i }).first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('OTP HANDLER: closing "Email verified successfully" overlay.');
      await closeBtn.click({ force: true });
      await page.waitForTimeout(600);
      return true;
    }
  }

  if (await page.getByText(/email verified successfully/i).isVisible({ timeout: 1500 }).catch(() => false)) {
    const closeBtn = page.getByRole('button', { name: /^Close$/i }).filter({ visible: true }).last();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('OTP HANDLER: closing success overlay (Close near verified message).');
      await closeBtn.click({ force: true });
      await page.waitForTimeout(600);
      return true;
    }
  }

  return dismissOtpSuccessDialog(page);
}

/** Close PrimeNG / role=dialog success only (no OTP inputs inside). */
async function dismissOtpSuccessDialog(page) {
  const successDialog = page.locator('.p-dialog, [role="dialog"]').filter({
    hasText: /success|verified|completed|تم التحقق|successful/i,
  }).filter({
    hasNot: page.locator('input[maxlength="1"]'),
  }).filter({ visible: true }).last();

  if (await successDialog.isVisible({ timeout: 2000 }).catch(() => false)) {
    const closeBtn = successDialog.getByRole('button', { name: /close|ok|تم|حسنا/i }).first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log('OTP HANDLER: closing dialog success panel.');
      await closeBtn.click({ force: true });
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}

/** Wait until email OTP succeeded (verified badge or Success dialog). */
async function waitForEmailOtpSuccessUi(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await detectOtpFailure(page)) return 'failure';
    if (await isEmailVerifiedOnStep1(page)) return 'ok';
    const successHeading = page.getByRole('heading', { name: /^Success$/i }).filter({ visible: true }).first();
    if (await successHeading.isVisible({ timeout: 400 }).catch(() => false)) return 'ok';
    await page.waitForTimeout(450);
  }
  return (await isEmailVerifiedOnStep1(page)) ? 'ok' : 'pending';
}

/**
 * After valid OTP: close Error dialog (if still open), then Success, then wait for clean page.
 */
async function finalizeOtpSuccess(page, type) {
  console.log(`OTP HANDLER [${type}]: finalizing — closing error/success overlays...`);

  for (let i = 0; i < 4; i++) {
    const errClosed = await dismissOtpErrorDialog(page);
    if (!errClosed) break;
    await page.waitForTimeout(350);
  }

  if (type === 'email') {
    for (let i = 0; i < 6; i++) {
      const closed = (await dismissEmailVerificationSuccess(page)) || (await dismissOtpSuccessDialog(page));
      if (!closed) break;
      await page.waitForTimeout(400);
    }

    const closeButtons = page.getByRole('button', { name: /^Close$/i }).filter({ visible: true });
    const n = await closeButtons.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const btn = closeButtons.nth(i);
      const block = (await btn.locator('xpath=ancestor::div[5]').innerText().catch(() => '')).slice(0, 400);
      if (/success|email verified|verified successfully/i.test(block)) {
        await btn.click({ force: true });
        console.log('OTP HANDLER: clicked Close on success panel.');
        await page.waitForTimeout(400);
      }
    }
  } else {
    for (let i = 0; i < 4; i++) {
      if (!(await dismissOtpSuccessDialog(page))) break;
      await page.waitForTimeout(400);
    }
  }

  await page.locator('.p-dialog, [role="dialog"], .swal2-container, .swal2-popup').filter({ visible: true })
    .waitFor({ state: 'hidden', timeout: 10000 })
    .catch(() => {});

  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  console.log(`OTP DASHBOARD: ACCEPTED ${type}`);
  console.log(`OTP HANDLER [${type}]: overlays cleared — continuing registration.`);
}

/** Manual OTP: poll until accepted or timeout (dashboard can resubmit OTP). */
async function waitForOtpManualSuccess(page, type, maxWaitMs = 300000) {
  const intervalMs = 2000;
  const maxAttempts = Math.floor(maxWaitMs / intervalMs);
  for (let i = 0; i < maxAttempts; i++) {
    if (await detectOtpFailure(page)) {
      console.log(`OTP HANDLER [${type}]: error visible — enter correct OTP in dashboard.`);
      await prepareOtpRetry(page, type);
      await page.waitForTimeout(intervalMs);
      continue;
    }
    if (await verifyOtpAccepted(page, type)) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

function otpFailureError(type, detail = '') {
  const label = type === 'email' ? 'Email' : 'Mobile';
  const extra = detail ? ` (${detail})` : '';
  if (type === 'email') {
    return new Error(
      `Automation Stopped: Invalid Email OTP entered${extra}. Script will not proceed to Step 2. ` +
      'Submit the correct OTP in the dashboard OTP panel and re-run, or restart this run.'
    );
  }
  return new Error(`Automation Stopped: Invalid ${label} OTP entered${extra}. Script will not proceed.`);
}

/**
 * Full OTP handling cycle:
 *  1. Poll otp_session.json for the token
 *  2. Inject + confirm → verify no error + modal closed
 *  3. On invalid OTP: log, wait for corrected OTP (do NOT fake success)
 *  4. After email OTP: caller must reach Step 2 (Username) before continuing
 */
async function handleOtpFlow(page, type, label) {
  const maxAttempts = 20;
  const pollMs = attempt => (attempt <= 2 ? 120000 : 30000);
  console.log(`OTP HANDLER [${type}]: starting flow — "${label}"`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`OTP HANDLER [${type}]: attempt ${attempt}/${maxAttempts}`);

    const otp = await pollForOtp(page, type, pollMs(attempt));

    if (otp) {
      await injectOtpIntoPage(page, otp);

      if (type === 'email') {
        const ui = await waitForEmailOtpSuccessUi(page, 25000);
        if (ui === 'failure') {
          const failureMsg = await detectOtpFailure(page);
          console.log(`OTP HANDLER [${type}]: ❌ rejected — ${failureMsg || 'Invalid OTP'}`);
          console.log(`OTP HANDLER [${type}]: Enter the correct OTP in the dashboard — waiting for new code...`);
          await prepareOtpRetry(page, type);
          continue;
        }
        if (ui !== 'ok' && !(await verifyOtpAccepted(page, type))) {
          if (await detectOtpFailure(page)) {
            await prepareOtpRetry(page, type);
            continue;
          }
          console.log(`OTP HANDLER [${type}]: OTP not confirmed yet — waiting for valid code...`);
          continue;
        }
      } else {
        const failureMsg = await detectOtpFailure(page);
        if (failureMsg) {
          console.log(`OTP HANDLER [${type}]: ❌ rejected — ${failureMsg}`);
          await prepareOtpRetry(page, type);
          continue;
        }
        if (!(await verifyOtpAccepted(page, type))) {
          if (await detectOtpFailure(page)) {
            await prepareOtpRetry(page, type);
            continue;
          }
          continue;
        }
      }

      console.log(`OTP HANDLER [${type}]: ✅ OTP accepted.`);
      await finalizeOtpSuccess(page, type);
      await waitForPageReady(page);
      return;
    }

    console.log(`OTP HANDLER [${type}]: waiting for OTP (dashboard or browser) — "${label}"...`);
    const manualOk = await waitForOtpManualSuccess(page, type, 20000);
    if (manualOk && !(await detectOtpFailure(page))) {
      console.log(`OTP HANDLER [${type}]: ✅ OTP accepted (manual).`);
      await finalizeOtpSuccess(page, type);
      await waitForPageReady(page);
      return;
    }
  }

  throw otpFailureError(type);
}

/** Click Step 1 → Step 2 Next (registration footer, not modal). */
async function clickRegistrationNext(page) {
  await finalizeOtpSuccess(page, 'email');
  const nextBtn = page.getByRole('button', { name: /next/i }).filter({ visible: true }).last();
  await nextBtn.scrollIntoViewIfNeeded();
  await expect(nextBtn).toBeEnabled({ timeout: 15000 });
  await nextBtn.click({ force: true });
  await page.waitForTimeout(800);
}

/** Step 2 form visible — check one field only (avoid Playwright strict .or() violation). */
async function assertStep2CredentialsVisible(page) {
  await dismissEmailVerificationSuccess(page);
  await page.waitForTimeout(500);

  const usernameField = page.getByRole('textbox', { name: /username/i }).first();
  const usernamePh = page.getByPlaceholder(/enter username/i).first();

  let visible = await usernameField.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) {
    visible = await usernamePh.isVisible({ timeout: 25000 }).catch(() => false);
  }
  if (!visible) {
    await expect(usernameField).toBeVisible({ timeout: 5000 });
  }

  const stillOnStep1 = await page.getByPlaceholder(/enter first name/i).isVisible({ timeout: 1500 }).catch(() => false);
  if (stillOnStep1) {
    throw new Error(
      'Automation Stopped: Still on Step 1 (Basic Details) after Next. ' +
      'Close the "Email verified successfully" popup if open, then retry.'
    );
  }
  console.log('OTP GATE: Step 2 credentials form confirmed — safe to run Step 2.');
}

/**
 * Step 3 — MISA Investment Registration (worker logic from misa_buckup.js).
 * Simple button:has-text clicks; no scoped engine / recovery loop.
 */
async function runMisaStep3(page) {
  page = ensureWorkflowPage(page, 'Step 3');
  await page.getByText('MISA Investment Registration').first().click();
  await waitForPageReady(page);

  await clickButton(page, 'Apply', ['Apply'], { timeout: 30000 });

  console.log('Step 3: Waiting for Terms agreement button "Agree"...');
  await clickButton(page, 'Agree', ['Agree', 'موافق', 'أوافق'], { timeout: 30000 });

  console.log('Step 3: Waiting for GCC nationality dialog button "No"...');
  await clickButton(page, 'No', ['No', 'لا'], { timeout: 30000 });

  await waitForPageReady(page);
  return getWorkflowPage(page);
}

/**
 * Step 4 — Business Activities (misa_buckup.js worker logic via isicFlow.js).
 * Does NOT click wizard Next — only Regular Investment + ISIC loop + Allowed check.
 */
async function runMisaStep4(page, isicCodes) {
  page = ensureWorkflowPage(page, 'Step 4');
  await runIsicBusinessActivities(page, isicCodes, { waitForPageReady });
  return getWorkflowPage(page);
}

/** Step 7 — Contact Person (misa_buckup.js worker logic; avoids semantic Identity Type loops). */
async function runMisaStep7(page, c) {
  page = ensureWorkflowPage(page, 'Step 7');
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  console.log('Step 7: Waiting for the Contact Person form to render...');
  const identityTypeLabel = page.locator('label, .label, span.label-text').filter({ hasText: /Identity Type/i }).first();
  await identityTypeLabel.waitFor({ state: 'visible', timeout: 30000 });
  console.log('Step 7: Contact Person form rendered!');

  const othersTab = page.locator('div').filter({ hasText: /^Others$/ }).first();
  if (await othersTab.isVisible().catch(() => false)) {
    const disabled = await othersTab.getAttribute('disabled') !== null
      || (await othersTab.getAttribute('aria-disabled')) === 'true';
    if (!disabled) {
      console.log('Step 7: Clicking "Others" tab...');
      await othersTab.click({ force: true });
      await identityTypeLabel.waitFor({ state: 'visible', timeout: 15000 });
    }
  }

  const getContactFieldRow = (labelText) => {
    const labelPattern = new RegExp(`^\\s*${escapeRegExp(labelText)}`, 'i');
    return page.locator('div.sc-fRwpmT').filter({
      has: page.locator('label.sc-cOtduh', { hasText: labelPattern }),
    }).first();
  };

  const closeContactPopups = async () => {
    await page.keyboard.press('Escape');
    await page.locator('.react-datepicker-popper, .p-dropdown-panel').filter({ visible: true })
      .waitFor({ state: 'hidden', timeout: 2000 })
      .catch(() => {});
  };

  const fillContactText = async (labelText, value) => {
    console.log(`Step 7: ✍️ Filling "${labelText}" with "${value}"`);
    const row = getContactFieldRow(labelText);
    await row.waitFor({ state: 'visible', timeout: 15000 });
    let input = row.locator('input.sc-evlKSw:not([readonly])').first();
    if (!(await input.isVisible().catch(() => false))) {
      input = row.locator('input:not([readonly])').first();
    }
    await input.scrollIntoViewIfNeeded();
    await input.click({ force: true });
    await input.fill('');
    await input.pressSequentially(value, { delay: 80 });
    console.log(`Step 7: ✅ Filled "${labelText}"`);
  };

  const selectListDropdown = async (labelName, optionText) => {
    console.log(`Step 7: 🔽 Selecting "${optionText}" for "${labelName}"`);
    try {
      const label = page.locator('label, span, div').filter({
        hasText: new RegExp(`^\\s*${escapeRegExp(labelName)}\\s*\\*?\\s*$`, 'i'),
      }).first();
      await label.scrollIntoViewIfNeeded();
      const parent = label.locator('xpath=..');
      const trigger = parent.locator('input, [role="combobox"], .p-dropdown-trigger').first();
      await trigger.click({ force: true });

      const cleanOption = optionText.replace(/\.$/, '').trim();
      const optionItem = page.locator('li, .p-dropdown-item, p-dropdownitem, span, div').filter({
        hasText: new RegExp(`^\\s*${escapeRegExp(cleanOption)}`, 'i'),
      }).filter({ visible: true }).last();
      await expect(optionItem).toBeVisible({ timeout: 15000 });
      await optionItem.scrollIntoViewIfNeeded();
      await optionItem.click({ force: true });
      console.log(`Step 7: ✅ Selected "${labelName}" → "${optionText}"`);
    } catch (e) {
      console.log(`Step 7: Fallback for "${labelName}": ${e.message}`);
      if (labelName.includes('Identity')) {
        await page.getByRole('textbox', { name: 'Select' }).first().click({ force: true });
        await page.locator('div').filter({ hasText: /^Passport$/ }).first().click({ force: true });
      } else if (labelName.includes('Title')) {
        await page.getByRole('textbox', { name: 'Select' }).nth(1).click({ force: true });
        const titlePattern = new RegExp(`^\\s*${escapeRegExp(optionText.replace(/\.$/, ''))}\\.?$`, 'i');
        await page.locator('span').filter({ hasText: titlePattern }).first().click({ force: true });
      } else if (labelName.includes('Nationality')) {
        await page.getByRole('textbox', { name: 'Select' }).nth(2).click({ force: true });
        const nationalityOption = page.locator('div, span, li').filter({ hasText: optionText }).last();
        await expect(nationalityOption).toBeVisible({ timeout: 15000 });
        await nationalityOption.click({ force: true });
      } else if (labelName.includes('Country')) {
        await page.getByRole('textbox', { name: 'Select Country' }).first().click({ force: true });
        const countryListOption = page.locator('div, span, li').filter({ hasText: optionText }).last();
        await expect(countryListOption).toBeVisible({ timeout: 15000 });
        await countryListOption.click({ force: true });
      }
    }
  };

  const MONTH_INDEX = {
    january: '0', jan: '0', '01': '0', '1': '0',
    february: '1', feb: '1', '02': '1', '2': '1',
    march: '2', mar: '2', '03': '2', '3': '2',
    april: '3', apr: '3', '04': '3', '4': '3',
    may: '4', '05': '4', '5': '4',
    june: '5', jun: '5', '06': '5', '6': '5',
    july: '6', jul: '6', '07': '6', '7': '6',
    august: '7', aug: '7', '08': '7', '8': '7',
    september: '8', sep: '8', '09': '8', '9': '8',
    october: '9', oct: '9', '10': '9',
    november: '10', nov: '10', '11': '10',
    december: '11', dec: '11', '12': '11',
  };

  const fillContactCalendar = async (labelText, year, month, day) => {
    const dayNum = String(parseInt(day, 10));
    console.log(`Step 7: 📅 "${labelText}" → ${year} ${month} ${dayNum}`);
    await closeContactPopups();

    const row = getContactFieldRow(labelText);
    await row.waitFor({ state: 'visible', timeout: 15000 });
    const trigger = row.locator('.react-datepicker__input-container input, .react-datepicker-wrapper input').first();
    if (!(await trigger.isVisible().catch(() => false))) {
      console.log(`Step 7: 📅 No date trigger for "${labelText}", skipping.`);
      return;
    }
    if (await trigger.isDisabled()) {
      console.log(`Step 7: 📅 "${labelText}" is disabled, skipping.`);
      return;
    }

    await trigger.click({ force: true });
    const calendarPopup = page.locator('.react-datepicker-popper, .react-datepicker').filter({ visible: true }).last();
    await calendarPopup.waitFor({ state: 'visible', timeout: 8000 });

    const yearInput = calendarPopup.getByRole('textbox', { name: 'YYYY' }).first();
    await yearInput.fill(String(year));
    await page.keyboard.press('Tab');

    const monthSelect = calendarPopup.locator('select').first();
    await expect(monthSelect).toBeVisible();
    const monthVal = MONTH_INDEX[month.toLowerCase()];
    if (monthVal) await monthSelect.selectOption(monthVal);
    else await monthSelect.selectOption({ label: month });

    const dayCell = calendarPopup
      .locator('.react-datepicker__day:not(.react-datepicker__day--outside-month):not(.react-datepicker__day--disabled)')
      .filter({ hasText: new RegExp(`^${dayNum}$`) })
      .first();
    await expect(dayCell).toBeVisible({ timeout: 10000 });
    await dayCell.click({ force: true });

    const saveBtn = calendarPopup.getByRole('button', { name: /^Save$/i }).first();
    if (await saveBtn.isVisible()) await saveBtn.click({ force: true });
    else await page.keyboard.press('Escape');

    await page.locator('.react-datepicker-popper').filter({ visible: true })
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {});
    console.log(`Step 7: ✅ Calendar "${labelText}" saved`);
  };

  await selectListDropdown('Identity Type', 'Passport');
  console.log('Step 7: Waiting for passport fields (Title) to render after Identity Type...');
  await page.locator('label, .label, span.label-text').filter({ hasText: /Title/i }).first()
    .waitFor({ state: 'visible', timeout: 15000 });

  await selectListDropdown('Title', c.contactTitle);
  await fillContactText('First Name in Arabic', c.contactFirstNameAr);
  await fillContactText('Last Name in Arabic', c.contactLastNameAr);
  await fillContactText('Full Name in English', c.contactFullNameEn);
  await selectListDropdown('Current Nationality', c.contactNationality);
  await fillContactCalendar('Date of Birth', c.contactDobYear, c.contactDobMonth, c.contactDobDay);
  await fillContactText('Passport number', c.contactPassportNumber);
  await fillContactCalendar('ID Issue Date', c.contactIssueYear, c.contactIssueMonth, c.contactIssueDay);
  await fillContactCalendar('ID Expiry Date', c.contactExpiryYear, c.contactExpiryMonth, c.contactExpiryDay);
  await selectListDropdown('Country', c.contactCountry);
  await fillContactText('City', c.contactCity);
  await selectListDropdown('Mobile Number', c.contactMobilePrefix);
  await fillContactText('Mobile Number', c.contactMobile);
  await fillContactText('Email Address', c.contactEmail);

  console.log('Step 7: Clicking Next to proceed to Step 8 (Preview)...');
  await page.locator('button').filter({ hasText: 'Next' }).last().click({ force: true });
  await waitForPageReady(page, 60000);
  console.log('Step 7 completely finished! Contact Person saved and proceeded.');
  return getWorkflowPage(page);
}

/** Step 8 — Preview & Submit (misa_buckup.js worker logic). */
async function runMisaStep8(page) {
  page = ensureWorkflowPage(page, 'Step 8');
  await waitForPageReady(page, 60000);

  console.log('Step 8: Scrolling to the bottom of the Preview page...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  console.log('Step 8: Checking the terms agreement checkbox...');
  try {
    const termsCheckbox = page.locator('input[type="checkbox"]').first();
    await termsCheckbox.scrollIntoViewIfNeeded();
    await termsCheckbox.check({ force: true });
    await page.waitForTimeout(1000);
    console.log('✓ Terms checkbox checked successfully');
  } catch (err) {
    console.log(`Checkbox check failed, proceeding anyway: ${err.message}`);
  }

  console.log('Step 8: Clicking Submit button...');
  await clickButton(page, 'Submit', ['Submit', 'تقديم', 'إرسال']);
  await waitForPageReady(page, 30000);

  console.log('Step 8: Checking for Agree dialog...');
  try {
    const agreeBtn = page.locator('button').filter({ hasText: /Agree|موافق|أوافق/ }).first();
    await agreeBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await clickButton(page, 'Agree', ['Agree', 'موافق', 'أوافق']);
    await waitForPageReady(page, 15000);
    console.log('✓ Clicked Agree dialog');
  } catch (err) {
    console.log('No Agree dialog found, continuing...');
  }

  console.log('Step 8: Checking for feedback dialog...');
  try {
    const cancelBtn = page.locator('button').filter({ hasText: /Cancel|إلغاء|Dismiss|Close/ }).first();
    await cancelBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    await clickButton(page, 'Cancel', ['Cancel', 'إلغاء', 'Dismiss', 'Close']);
    await waitForPageReady(page, 15000);
    console.log('✓ Clicked Cancel/Close on feedback dialog');
  } catch (err) {
    console.log('No feedback dialog found, submission complete!');
  }

  return getWorkflowPage(page);
}

// ── Universal MISA calendar date picker ───────────────────────────────────────
// Handles two calendar flavours found across MISA investment services:
//   1. MISA custom Hijri/Gregorian picker (shareholder forms, most service forms)
//   2. react-datepicker (Contact Person step 7)
// Falls back gracefully between them so the script survives UI refactors.
//
// @param page          - Playwright Page
// @param fieldTrigger  - Locator or CSS string of the field/button that opens the picker
// @param day           - Day number as string, e.g. "15"
// @param month         - Month name in English, e.g. "March" / "January"
// @param year          - 4-digit year string, e.g. "1990"
// @param calendarType  - "Gregorian" (default) or "Hijri"
const MONTH_IDX_GLOBAL = {
  january:'0', jan:'0', february:'1', feb:'1', march:'2', mar:'2',
  april:'3', apr:'3', may:'4', june:'5', jun:'5', july:'6', jul:'6',
  august:'7', aug:'7', september:'8', sep:'8', october:'9', oct:'9',
  november:'10', nov:'10', december:'11', dec:'11',
};

async function selectShareholderCalendarDate(page, fieldTrigger, day, month, year, calendarType = 'Gregorian') {
  const dayNum   = String(parseInt(day, 10));
  const yearNum  = parseInt(year, 10);
  console.log(`📅 SH Calendar: [${calendarType}] ${dayNum}/${month}/${year}`);

  const trigger = typeof fieldTrigger === 'string'
    ? page.locator(fieldTrigger).first()
    : fieldTrigger;

  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true });
  await page.waitForTimeout(500);

  // ── Branch 1: MISA Hijri/Gregorian selector popup ────────────────────────
  const calTypeBtn = page.locator('button, span, div, li').filter({
    hasText: new RegExp(`^${calendarType}$`, 'i')
  }).filter({ visible: true }).first();

  const isMisaCalendar = await calTypeBtn.isVisible({ timeout: 2500 }).catch(() => false);

  if (isMisaCalendar) {
    await calTypeBtn.click({ force: true });
    await page.waitForTimeout(600);

    // ── Year: triple-click the input and type directly (fastest + most reliable) ──
    const yearInputSel = page.locator(
      'p-inputnumber input, input.p-inputnumber-input, input[aria-valuenow], input[aria-valuemin]'
    ).filter({ visible: true }).first();

    if (await yearInputSel.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Triple-click selects all existing text, then type overwrites it
      await yearInputSel.click({ force: true, clickCount: 3 });
      await yearInputSel.fill(String(yearNum));
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
    } else {
      // Fallback: use spinner up/down buttons
      for (let attempt = 0; attempt < 80; attempt++) {
        let cur = NaN;
        const spans = page.locator('span, div').filter({ hasText: /^\d{4}$/ }).filter({ visible: true });
        const cnt = await spans.count().catch(() => 0);
        if (cnt > 0) cur = parseInt((await spans.first().textContent().catch(() => '')).trim());
        if (isNaN(cur) || cur === yearNum) break;

        const btnUp = page.locator(
          '.p-inputnumber-button-up, .p-inputnumber-button.p-inputnumber-button-up, button:has(.pi-angle-up), button:has(.pi-chevron-up)'
        ).filter({ visible: true }).first();
        const btnDn = page.locator(
          '.p-inputnumber-button-down, .p-inputnumber-button.p-inputnumber-button-down, button:has(.pi-angle-down), button:has(.pi-chevron-down)'
        ).filter({ visible: true }).first();

        if (cur < yearNum) {
          if (await btnUp.isVisible({ timeout: 300 }).catch(() => false)) await btnUp.click({ force: true });
          else break;
        } else {
          if (await btnDn.isVisible({ timeout: 300 }).catch(() => false)) await btnDn.click({ force: true });
          else break;
        }
        await page.waitForTimeout(80);
      }
    }

    // ── Month: try native <select> first (most reliable), then PrimeNG dropdown ──
    try {
      const sel = page.locator('select').filter({ visible: true }).first();
      if (await sel.isVisible({ timeout: 1000 }).catch(() => false)) {
        const mv = MONTH_IDX_GLOBAL[month.toLowerCase()];
        if (mv !== undefined) await sel.selectOption(mv);
        else await sel.selectOption({ label: month });
      } else {
        // PrimeNG p-dropdown month selector
        const monthDdTrigger = page.locator(
          'p-dropdown .p-dropdown-trigger, p-dropdown .p-dropdown-label, .p-dropdown-trigger'
        ).filter({ visible: true }).first();
        if (await monthDdTrigger.isVisible({ timeout: 1000 }).catch(() => false)) {
          await monthDdTrigger.click({ force: true });
          await page.waitForTimeout(300);
          const opt = page.locator('li, .p-dropdown-item').filter({
            hasText: new RegExp(month, 'i')
          }).filter({ visible: true }).first();
          if (await opt.isVisible({ timeout: 4000 }).catch(() => false)) {
            await opt.click({ force: true });
          }
        }
      }
    } catch (e) {
      console.log(`📅 Month selection fallback: ${e.message}`);
    }
    await page.waitForTimeout(300);

    // ── Day: click the correct day cell ──────────────────────────────────────
    const dayCell = page.locator(
      'td span:not(.p-datepicker-other-month):not(.p-disabled), .p-datepicker-calendar td:not(.p-datepicker-other-month):not(.p-disabled) span'
    ).filter({ hasText: new RegExp(`^${dayNum}$`) }).filter({ visible: true }).first();
    await expect(dayCell).toBeVisible({ timeout: 8000 });
    await dayCell.click({ force: true });
    await page.waitForTimeout(200);

    // ── Save ─────────────────────────────────────────────────────────────────
    const saveBtn = page.locator('button').filter({ hasText: /حفظ|Save|OK|Apply/i }).filter({ visible: true }).first();
    if (await saveBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await saveBtn.click({ force: true });
    }

  } else {
    // ── Branch 2: react-datepicker fallback ───────────────────────────────
    const popup = page.locator('.react-datepicker-popper, .react-datepicker').filter({ visible: true }).last();
    await popup.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

    const yearInput = popup.getByRole('textbox', { name: 'YYYY' }).first();
    if (await yearInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await yearInput.fill(String(year));
      await page.keyboard.press('Tab');
    }

    const monthSel = popup.locator('select').first();
    if (await monthSel.isVisible({ timeout: 800 }).catch(() => false)) {
      const mv = MONTH_IDX_GLOBAL[month.toLowerCase()];
      if (mv !== undefined) await monthSel.selectOption(mv);
      else await monthSel.selectOption({ label: month });
    }

    const dayCell = popup.locator(
      '.react-datepicker__day:not(.react-datepicker__day--outside-month):not(.react-datepicker__day--disabled)'
    ).filter({ hasText: new RegExp(`^${dayNum}$`) }).first();
    if (await dayCell.isVisible({ timeout: 3000 }).catch(() => false)) {
      await dayCell.click({ force: true });
    }

    const saveBtn = popup.getByRole('button', { name: /^Save$/i }).first();
    if (await saveBtn.isVisible({ timeout: 800 }).catch(() => false)) {
      await saveBtn.click({ force: true });
    } else {
      await page.keyboard.press('Escape');
    }
  }

  // Wait for picker to close
  await page.locator(
    '.react-datepicker-popper, .p-datepicker-overlay, .p-dialog'
  ).filter({ visible: true }).waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});

  console.log(`📅 SH Calendar saved ✅`);
}


/**
 * MISA Saudi Registration Automation - Human-Like Workflow
 */

test('MISA Saudi Registration Workflow', async ({ page: initialPage }) => {
  // Increase timeout to 30 minutes for manual OTP + slow execution
  test.setTimeout(1800000);
  let page = initialPage;

  console.log(`WORKFLOW VERSION: ${WORKFLOW_VERSION}${RUN_ID ? ` | RUN_ID: ${RUN_ID}` : ''}`);

  // --- DYNAMIC DATA GENERATOR & CONFIG LOADING ---
  const randomId = Math.floor(Math.random() * 900000000) + 100000000;
  const uniqueSuffix = Date.now().toString().slice(-6);
  const uniqueUsername = `MisaUser_${uniqueSuffix}`;
  const uniqueCompany = `AlphaTech_${uniqueSuffix}`;
  const uniqueMobile = `7${Math.floor(Math.random() * 900000000) + 100000000}`.substring(0, 10);

  // Step 1 defaults (Registration Page)
  let regTitle = 'Mr.';
  let firstName = 'Test';
  let lastName = 'User';
  let nationalId = ''; // empty = skip; only filled when config.nationalId is provided
  let companyName = uniqueCompany;
  let sector = 'Information and Communication Technology';
  
  let country = 'United Kingdom';
  let regMobilePrefix = '+44';
  let regMobile = uniqueMobile;
  let targetEmail = 'sm.dn.g.m.sb.fd.n.dng.n@gmail.com';

  // Step 2 defaults (Credentials Page)
  let credsUsername = uniqueUsername;
  let credsPassword = 'SecurePass123!';

  // Step 5 defaults (Entity Information)
  let entityNameEnglish = 'Alpha Tech Solutions';
  let entityNameArabic = 'ألفا للحلول التقنية';
  let legalStatus = 'Limited Liability Company';
  let capital = '100000';
  let entityEmail = 'business@alphatech.com';
  let entityMobilePrefix = '+213';
  let entityMobile = '500000000';
  let region = 'Al Riyadh';
  let city = 'Riyadh';
  let investmentSpending = 'Between SAR 1,000,000 - 5,000,000';
  let isicCodes = ['C251114'];
  let registrationDuration = '1';
  let entityCRFile = 'D:\\Dadda\\Desktop\\misa_files\\commercial_register.pdf';
  let entityFSFile = 'D:\\Dadda\\Desktop\\misa_files\\financial_statement.pdf';

  // Step 7 defaults (Contact Person)
  let contactTitle = 'Mr.';
  let contactFirstNameAr = 'طارق';
  let contactLastNameAr = 'دادا';
  let contactFullNameEn = 'Tarek Dadda';
  let contactNationality = 'Algeria';
  let contactDobYear = '1990';
  let contactDobMonth = 'May';
  let contactDobDay = '17';
  let contactPassportNumber = 'A12345678';
  let contactIssueYear = '2020';
  let contactIssueMonth = 'May';
  let contactIssueDay = '17';
  let contactExpiryYear = '2030';
  let contactExpiryMonth = 'May';
  let contactExpiryDay = '17';
  let contactCountry = 'Algeria';
  let contactCity = 'Algiers';
  let contactMobilePrefix = '+213';
  let contactMobile = '500000000';
  let contactEmail = 'business@alphatech.com';

  // Step 6 defaults (Shareholders)
  let shareholders = [
    {
      percentage: '40',
      nameEng: 'Alpha Tech Shareholder 1 Ltd',
      nameAr: 'ألفا شريك تقني الأول المحدودة',
      country: 'Algeria',
      unifiedNumber: '',
      legalStatus: 'Limited Liability Company',
      years: '(1-5)',
      email: '',
      mobilePrefix: '+213',
      mobile: '',
      website: 'https://www.alphatech.com',
      crFile: 'D:\\Dadda\\Desktop\\misa_files\\commercial_register.pdf',
      fsFile: 'D:\\Dadda\\Desktop\\misa_files\\financial_statement.pdf'
    },
    {
      percentage: '60',
      nameEng: 'Alpha Tech Shareholder 2 Ltd',
      nameAr: 'ألفا شريك تقني الثاني المحدودة',
      country: 'Algeria',
      unifiedNumber: '',
      legalStatus: 'Limited Liability Company',
      years: '(1-5)',
      email: '',
      mobilePrefix: '+213',
      mobile: '',
      website: 'https://www.alphatech.com',
      crFile: 'D:\\Dadda\\Desktop\\misa_files\\commercial_register.pdf',
      fsFile: 'D:\\Dadda\\Desktop\\misa_files\\financial_statement.pdf'
    }
  ];

  // Data layer: site_data/misa_config.json (brain) + optional config.json override (dashboard run)
  const siteData = loadSiteData(SITE_DATA_FILE, CONFIG_FILE);
  const siteSteps = siteData?.steps || {};
  const config = siteData
    ? { ...siteData.values, ...(siteData.shareholders?.length ? { shareholders: siteData.shareholders } : {}) }
    : null;

  if (config) {
    try {
      console.log(`Successfully loaded configuration (site: ${SITE_DATA_FILE}, override: ${CONFIG_FILE})!`);
      if (aiEnabled()) {
        const provider = process.env.AI_FALLBACK_BASE_URL || 'https://api.openai.com/v1';
        console.log(`AI recovery: ENABLED — model=${process.env.AI_FALLBACK_MODEL || 'gpt-4o'} via ${provider}`);
      } else {
        console.log('AI recovery: OFF — set RUN_AI_FALLBACK=1 + API key in .env (or RUN_AI_FALLBACK=0 if no credits)');
      }
      if (config.regTitle) regTitle = config.regTitle;
      if (config.firstName) firstName = config.firstName;
      if (config.lastName) lastName = config.lastName;
      
      // Randomize National ID if present
      if (config.nationalId) {
        if (config.nationalId !== '0') {
          const base = config.nationalId.toString();
          const randomDigits = Math.floor(Math.random() * 900000000 + 100000000).toString().substring(0, base.length);
          nationalId = randomDigits;
        } else {
          nationalId = config.nationalId;
        }
      }
      
      // Randomize Company Name
      if (config.companyName) {
        const base = config.companyName.split('_')[0];
        const randomSuffix = Math.floor(Math.random() * 900000 + 100000);
        companyName = `${base}_${randomSuffix}`;
      }
      
      if (config.sector) sector = config.sector;
      
      // Use the email directly as provided by the user
      if (config.targetEmail) {
        targetEmail = config.targetEmail;
      }
      
      if (config.country) country = config.country;
      // registrationCountry overrides country for the Register page branch logic
      if (config.registrationCountry) country = config.registrationCountry;
      if (config.regMobilePrefix) regMobilePrefix = config.regMobilePrefix;
      
      // Randomize Mobile numbers to guarantee they are never duplicates on the portal
      if (config.regMobile) {
        const base = config.regMobile.toString();
        if (base.length >= 7) {
          const prefix = base.substring(0, base.length - 6);
          const randomSuffix = Math.floor(Math.random() * 900000 + 100000).toString();
          regMobile = prefix + randomSuffix;
        } else {
          regMobile = `7${Math.floor(Math.random() * 900000000) + 100000000}`.substring(0, 10);
        }
      }

      // Randomize Username
      if (config.credsUsername) {
        const base = config.credsUsername.split('_')[0];
        const randomSuffix = Math.floor(Math.random() * 900000 + 100000);
        credsUsername = `${base}_${randomSuffix}`;
      }
      if (config.credsPassword) credsPassword = config.credsPassword;

      if (config.entityNameEnglish) entityNameEnglish = config.entityNameEnglish;
      if (config.entityNameArabic) entityNameArabic = config.entityNameArabic;
      if (config.legalStatus) legalStatus = config.legalStatus;
      if (config.capital) capital = config.capital;
      
      if (config.entityEmail) {
        entityEmail = config.entityEmail;
      }
      if (config.entityMobilePrefix) entityMobilePrefix = config.entityMobilePrefix;
      if (config.entityMobile) {
        const base = config.entityMobile.toString();
        if (base.length >= 6) {
          const prefix = base.substring(0, base.length - 5);
          const randomSuffix = Math.floor(Math.random() * 90000 + 10000).toString();
          entityMobile = prefix + randomSuffix;
        } else {
          entityMobile = Math.floor(Math.random() * 900000000 + 100000000).toString().substring(0, 9);
        }
      }
      if (config.region) region = config.region;
      if (config.city) city = config.city;
      if (config.investmentSpending) investmentSpending = config.investmentSpending;
      if (config.isicCodes && Array.isArray(config.isicCodes)) {
        isicCodes = config.isicCodes;
      } else if (config.isicCode) {
        isicCodes = [config.isicCode];
      }
      if (config.registrationDuration) registrationDuration = config.registrationDuration;
      if (config.entityCRFile) entityCRFile = config.entityCRFile;
      if (config.entityFSFile) entityFSFile = config.entityFSFile;

      if (config.contactTitle) contactTitle = config.contactTitle;
      if (config.contactFirstNameAr) contactFirstNameAr = config.contactFirstNameAr;
      if (config.contactLastNameAr) contactLastNameAr = config.contactLastNameAr;
      if (config.contactFullNameEn) contactFullNameEn = config.contactFullNameEn;
      if (config.contactNationality) contactNationality = config.contactNationality;
      if (config.contactDobYear) contactDobYear = config.contactDobYear;
      if (config.contactDobMonth) contactDobMonth = config.contactDobMonth;
      if (config.contactDobDay) contactDobDay = config.contactDobDay;
      
      // Randomize Passport Number to prevent duplicates
      if (config.contactPassportNumber) {
        const base = config.contactPassportNumber.trim();
        const letter = base.substring(0, 1);
        const randomDigits = Math.floor(Math.random() * 90000000 + 10000000).toString().substring(0, base.length - 1);
        contactPassportNumber = letter + randomDigits;
      }
      
      if (config.contactIssueYear) contactIssueYear = config.contactIssueYear;
      if (config.contactIssueMonth) contactIssueMonth = config.contactIssueMonth;
      if (config.contactIssueDay) contactIssueDay = config.contactIssueDay;
      if (config.contactExpiryYear) contactExpiryYear = config.contactExpiryYear;
      if (config.contactExpiryMonth) contactExpiryMonth = config.contactExpiryMonth;
      if (config.contactExpiryDay) contactExpiryDay = config.contactExpiryDay;
      if (config.contactCountry) contactCountry = config.contactCountry;
      if (config.contactCity) contactCity = config.contactCity;
      if (config.contactMobilePrefix) contactMobilePrefix = config.contactMobilePrefix;
      if (config.contactMobile) {
        const base = config.contactMobile.toString();
        if (base.length >= 6) {
          const prefix = base.substring(0, base.length - 5);
          const randomSuffix = Math.floor(Math.random() * 90000 + 10000).toString();
          contactMobile = prefix + randomSuffix;
        } else {
          contactMobile = Math.floor(Math.random() * 900000000 + 100000000).toString().substring(0, 9);
        }
      }
      if (config.contactEmail) {
        contactEmail = config.contactEmail;
      }

      if (config.shareholders && Array.isArray(config.shareholders)) {
        shareholders = config.shareholders.map(sh => {
          const randomizedSh = { ...sh };
          if (sh.email) {
            randomizedSh.email = sh.email;
          }
          if (sh.mobile) {
            const base = sh.mobile.toString();
            if (base.length >= 6) {
              const prefix = base.substring(0, base.length - 5);
              const randomSuffix = Math.floor(Math.random() * 90000 + 10000).toString();
              randomizedSh.mobile = prefix + randomSuffix;
            } else {
              randomizedSh.mobile = Math.floor(Math.random() * 900000000 + 100000000).toString().substring(0, 9);
            }
          }
          return randomizedSh;
        });
      }
    } catch (e) {
      console.log(`Could not apply configuration, using defaults.`, e);
    }
  }

  console.log('========================================================================');
  console.log('🚀 DYNAMIC RANDOMIZED CONFIGURATION FOR THIS RUN:');
  console.log(`   - Email Address (Gmail Dot-Variant) : ${targetEmail}`);
  console.log(`   - Registration Mobile Number        : ${regMobile}`);
  console.log(`   - Company Name                      : ${companyName}`);
  console.log(`   - Username                          : ${credsUsername}`);
  console.log(`   - Passport Number                   : ${contactPassportNumber}`);
  console.log(`   - Contact Person Mobile Number      : ${contactMobile}`);
  console.log('========================================================================');

  // Intercept and suppress all native OS file chooser dialogs globally to prevent them from blocking the screen
  page.on('filechooser', async (fileChooser) => {
    console.log('--- Intercepted and suppressed native file chooser popup! Bypassing... ---');
  });

  // 1. Go to registration page
  // Navigate with retry (handle occasional site unavailability)
  // 1. Go to registration page with extended timeout and delay between attempts
  let navigated = false;
  for (let attempt = 1; attempt <= 3 && !navigated; attempt++) {
    try {
      await page.goto('https://eservices.investsaudi.sa/register', { waitUntil: 'load', timeout: 120000 });
      navigated = true;
    } catch (err) {
      console.log(`Navigation attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await waitForPageReady(page, 10000);
      } else {
        throw err; // give up after final attempt
      }
    }
  }

  await waitForPageReady(page);

  // Step 1 form — smart engine (site_data → step1_registration)
  const regCtx = buildRegistrationContext({
    regTitle, firstName, lastName, nationalId, companyName, sector, targetEmail, country, regMobile,
    credsUsername, credsPassword,
  });
  await runSiteSteps(page, siteSteps.step1_registration || [], regCtx, { section: 'Step 1' });
  await waitForPageReady(page);

  // Email OTP — stays in code (dashboard API / manual); blocks Step 2 on invalid code
  console.log(`Step 1/2: Starting Email OTP flow for ${targetEmail}...`);
  await handleOtpFlow(page, 'email', `Email OTP for ${targetEmail}`);
  page = ensureWorkflowPage(page, 'after Email OTP');
  console.log(`WORKFLOW: Steps 2–8 will run on → ${page.url()}`);
  if (aiEnabled()) {
    console.log('WORKFLOW: AI agent recovery ENABLED (RUN_AI_FALLBACK=1 + OPENAI_API_KEY)');
  }

  // ── TASK A: Saudi Arabia also requires Mobile OTP verification ──────────
  if (country === 'Saudi Arabia') {
    console.log('MISA REG FLOW: Saudi Arabia path taken — looking for Verify Mobile button...');
    try {
      const verifyMobileBtn = page.locator('button:has-text("Verify Mobile"), :text("Verify Mobile")').first();
      await verifyMobileBtn.scrollIntoViewIfNeeded();
      await expect(verifyMobileBtn).toBeVisible({ timeout: 15000 });
      await verifyMobileBtn.click({ force: true });
      console.log('MISA REG FLOW: Clicked Verify Mobile. Starting Mobile OTP flow...');
      await handleOtpFlow(page, 'mobile', 'Mobile OTP');
    } catch (err) {
      console.log(`MISA REG FLOW: Verify Mobile button not found or already verified — ${err.message}`);
    }
  } else {
    console.log(`MISA REG FLOW: International path taken (${country}) — skipping Verify Mobile step.`);
  }
  // ────────────────────────────────────────────────────────────────────────

  page = ensureWorkflowPage(page, 'before Step 2');
  await clickRegistrationNext(page);
  await assertStep2CredentialsVisible(page);

  // Step 2 credentials — smart engine (only after OTP gate passes)
  console.log('══════════════════════════════════════════════════════════');
  console.log('Step 2: Starting credentials (semantic engine)...');
  console.log('══════════════════════════════════════════════════════════');
  await runSiteSteps(page, siteSteps.step2_credentials || [], regCtx, { section: 'Step 2' });
  await page.getByText('MISA Investment Registration').waitFor({ state: 'visible', timeout: 60000 });
  console.log('Registration process completed!');

  // --- STEP 3: MISA Investment Registration (misa_buckup.js worker flow) ---
  page = ensureWorkflowPage(page, 'before Step 3');
  console.log('══════════════════════════════════════════════════════════');
  console.log('Step 3: MISA Investment Registration...');
  console.log('══════════════════════════════════════════════════════════');
  page = await runWorkerWithAi(page, {
    section: 'Step 3',
    stepIndex: 2,
    totalSteps: WORKFLOW_TOTAL_STEPS,
    pseudoStep: { type: 'worker', label: 'MISA Investment Registration — Apply, Agree, GCC No' },
    ctx: regCtx,
    run: (p) => runMisaStep3(p),
    verify: verifyWorkerStep3,
  });
  console.log('Investment Registration application started!');

  // --- STEP 4: Business Activities (misa_buckup.js worker flow) ---
  const entityCtx = buildEntityContext({
    entityNameEnglish, entityNameArabic, legalStatus, capital, entityEmail,
    entityMobilePrefix, entityMobile, region, city, investmentSpending,
    entityCRFile, entityFSFile, isicCodes,
  });
  page = ensureWorkflowPage(page, 'before Step 4');
  if (!(await isBusinessActivitiesPage(page))) {
    console.log('Step 4: not on Business Activities — re-running Step 3 with AI...');
    page = await runWorkerWithAi(page, {
      section: 'Step 3 recovery',
      stepIndex: 2,
      totalSteps: WORKFLOW_TOTAL_STEPS,
      pseudoStep: { type: 'worker', label: 'MISA Investment Registration — retry' },
      ctx: regCtx,
      run: (p) => runMisaStep3(p),
      verify: verifyWorkerStep3,
    });
  }
  console.log('══════════════════════════════════════════════════════════');
  console.log('Step 4: Business activities...');
  console.log('══════════════════════════════════════════════════════════');
  page = await runWorkerWithAi(page, {
    section: 'Step 4',
    stepIndex: 3,
    totalSteps: WORKFLOW_TOTAL_STEPS,
    pseudoStep: { type: 'worker', label: 'Business Activities — Regular Investment + ISIC' },
    ctx: entityCtx,
    run: (p) => runMisaStep4(p, isicCodes),
    verify: verifyWorkerStep4,
  });

  // --- STEP 5: Entity Information (smart engine) ---
  page = ensureWorkflowPage(page, 'before Step 5');
  console.log('══════════════════════════════════════════════════════════');
  console.log('Step 5: Entity information...');
  console.log('══════════════════════════════════════════════════════════');
  await runSiteSteps(page, siteSteps.step5_entity || [], entityCtx, {
    section: 'Step 5',
    resolveFilePath,
    waitForPageReady,
    afterStep: async (step, pg, _ctx, success) => {
      if (success && step.type === 'upload') await waitForUploadComplete(pg);
      if (success && step.placeholder === 'Select Region') {
        await pg.locator('input[placeholder="Select City"]').waitFor({ state: 'visible', timeout: 15000 });
        await pg.waitForTimeout(1000);
      }
      if (success && step.type === 'button' && step.label === 'Next') {
        await pg.locator('button').filter({ hasText: /Add Shareholder|Add shareholder|إضافة شريك/ }).first()
          .waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});
      }
    },
  });
  console.log('Step 5 completely finished! Registration submitted.');

  // --- STEP 6: Add Shareholder ---
  page = ensureWorkflowPage(page, 'before Step 6');
  console.log('══════════════════════════════════════════════════════════');
  console.log('--- Starting Step 6: Shareholders List ---');
  console.log('══════════════════════════════════════════════════════════');

  for (let i = 0; i < shareholders.length; i++) {
    const sh = shareholders[i];
    console.log(`--- Adding Shareholder ${i + 1} of ${shareholders.length} (${sh.percentage}%) ---`);

    // 1. Wait for "+ Add Shareholder" button to be visible (Clean, standard Playwright wait)
    console.log('Step 6: Waiting for "+ Add Shareholder" button...');
    const addShareholderBtn = page.locator('button').filter({ hasText: /Add Shareholder|Add shareholder|إضافة شريك/ }).first();
    await addShareholderBtn.waitFor({ state: 'visible', timeout: 30000 });

    // 2. Click "+ Add Shareholder" (Standard forced click)
    console.log('Step 6: Clicking "+ Add Shareholder" button...');
    await addShareholderBtn.click({ force: true });

    // 3. Determine shareholder type (Person or Organization)
    const shType = (sh.type || 'Organization').trim();
    console.log(`Step 6: Shareholder type: ${shType}`);

    // 4. Click the appropriate type tab
    if (shType === 'Person') {
      const personOption = page.locator('span, button, div, label').filter({ hasText: /^Person$/ }).first();
      await personOption.waitFor({ state: 'visible', timeout: 20000 });
      await personOption.click({ force: true });
      console.log('Step 6: Clicked "Person" tab.');
    } else {
      const organizationOption = page.locator('span, button, div, label').filter({ hasText: /^Organization$/ }).first();
      await organizationOption.waitFor({ state: 'visible', timeout: 20000 });
      await organizationOption.click({ force: true });
      console.log('Step 6: Clicked "Organization" tab.');
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── PERSON SHAREHOLDER PATH ───────────────────────────────────────────
    // Uses the EXACT same helper pattern as Step 7 (Contact Person) because
    // both forms are identical in structure on the MISA platform.
    // ══════════════════════════════════════════════════════════════════════
    if (shType === 'Person') {
      console.log(`MISA SH FLOW [PERSON]: Filling Person shareholder ${i + 1} (step engine)`);

      const shCtx = buildShareholderPersonContext(sh, {});
      const personSteps = (siteSteps.step6_shareholder_person || []).filter(
        (s) => !(s.type === 'tab' && /^Person$/i.test(s.label || ''))
      );

      const engineOpts = {
        section: 'Step 6 [P]',
        resolveFilePath: (p) => {
          const resolved = resolveFilePath(p);
          return fs.existsSync(resolved) ? resolved : '';
        },
        afterStep: async (step, pg, _ctx, success) => {
          if (success && step.type === 'upload') await waitForUploadComplete(pg);
          if (step.label === 'Save New Shareholder' && success) {
            await addShareholderBtn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
            await waitForPageReady(pg);
          }
        },
      };

      await runSiteSteps(page, personSteps, shCtx, engineOpts);
      console.log(`MISA SH FLOW [PERSON]: Person Shareholder ${i + 1} saved ✅`);

    } else {
    // ══════════════════════════════════════════════════════════════════════
    // ── ORGANIZATION SHAREHOLDER PATH (existing logic below) ─────────────
    // ══════════════════════════════════════════════════════════════════════

    // 4b. Wait for the Organization form inputs to render (Standard wait on visible Country dropdown)
    console.log('Step 6: Waiting for shareholder form fields to render...');
    const countryDropdown = page.locator('input[placeholder="Select Country"], p-dropdown, span:has-text("Select Country"), [placeholder*="Country"]').last();
    await countryDropdown.waitFor({ state: 'visible', timeout: 30000 });

    // --- SHAREHOLDER DETAILS DATA ---
    const shCountry = sh.country || 'Algeria';
    const shUnifiedNumber = sh.unifiedNumber || `700${Math.floor(Math.random() * 9000000) + 1000000}`;
    const shLegalStatus = sh.legalStatus || 'Limited Liability Company';
    const shYears = sh.years || '(1-5)';
    const shEmail = sh.email || `shareholder_${i}_${Math.floor(Math.random() * 10000)}@alphatech.com`;
    const shMobileCode = sh.mobilePrefix || '+213';
    const shMobile = sh.mobile || `50000000${i}`;
    const shWebsite = sh.website || 'https://www.alphatech.com';

    // 5. Select Country (Clean, direct click and popup list option selection like registration page)
    console.log(`Step 6: Selecting Country: ${shCountry}`);
    await countryDropdown.click({ force: true });
    try {
      const shCountryOption = page.locator('div, span, li').filter({ hasText: shCountry }).last();
      await expect(shCountryOption).toBeVisible({ timeout: 15000 });
      await shCountryOption.click({ force: true });
    } catch (err) {
      console.log('Step 6 Fallback: Clicking country via text selector...');
      await page.click(`text=${shCountry}`);
    }
    await waitForPageReady(page);

    // ── TASK B: Branch on Shareholder Country ───────────────────────────────
    if (shCountry === 'Saudi Arabia' || shCountry === 'Saudi Arabia (GCC)') {

      // ── SAUDI ARABIA PATH ─────────────────────────────────────────────────
      // DOM: Country + Unified Number + Validate → Save New Shareholder
      // Percentage / names / mobile / files do NOT apply for KSA shareholders.
      console.log(`MISA SH FLOW: Saudi Arabia path — Shareholder ${i + 1}: fill Unified Number, Validate, Save.`);

      // 6-KSA. Fill Unified Number
      const ksaUnifiedInput = page.locator('input[placeholder="Enter Unified Number"]').first();
      await expect(ksaUnifiedInput).toBeVisible({ timeout: 15000 });
      console.log(`Step 6 [KSA]: Typing Unified Number: ${shUnifiedNumber}`);
      await ksaUnifiedInput.click({ force: true });
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await ksaUnifiedInput.type(shUnifiedNumber, { delay: 150 });

      // 7-KSA. Click Validate button
      console.log('MISA SH FLOW [KSA]: Clicking Validate...');
      const validateBtn = page.locator('button').filter({ hasText: /^Validate$|^التحقق$/ }).first();
      await expect(validateBtn).toBeVisible({ timeout: 15000 });
      await validateBtn.click({ force: true });
      // Wait for validation spinner / network to settle
      await waitForPageReady(page);
      console.log('MISA SH FLOW [KSA]: Validation complete.');

      // 8-KSA. Click Save New Shareholder
      console.log('MISA SH FLOW [KSA]: Clicking Save New Shareholder...');
      const ksaSaveBtn = page.locator('button').filter({ hasText: /Save New Shareholder|Save Shareholder|حفظ/ }).first();
      await expect(ksaSaveBtn).toBeVisible({ timeout: 20000 });
      await ksaSaveBtn.click({ force: true });
      await addShareholderBtn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await waitForPageReady(page);
      console.log(`MISA SH FLOW [KSA]: Saudi Shareholder ${i + 1} saved — proceeding to next entry.`);

    } else {

      // ── INTERNATIONAL PATH ────────────────────────────────────────────────
      // Full form: names, legal status, years, share %, email, mobile, website, files, then Save.
      console.log(`MISA SH FLOW: International path — Shareholder ${i + 1} (${shCountry}): filling full form.`);

      // 7. Fill Organization Name in English
      const nameEngInput = page.locator('input[placeholder="Organization Name in English"]').first();
      if (await nameEngInput.isVisible()) {
        console.log(`Step 6: Typing Organization Name in English: ${sh.nameEng}`);
        await nameEngInput.click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await nameEngInput.type(sh.nameEng, { delay: 150 });
      }

      // 8. Fill Organization Name in Arabic
      const nameArInput = page.locator('input[placeholder="Organization Name in Arabic"]').first();
      if (await nameArInput.isVisible()) {
        console.log(`Step 6: Typing Organization Name in Arabic: ${sh.nameAr}`);
        await nameArInput.click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await nameArInput.type(sh.nameAr, { delay: 150 });
      }

      // 9. Select Legal Status
      const legalStatusDropdown = page.locator('input[placeholder="Select Legal Status"], p-dropdown, span:has-text("Select Legal Status"), [placeholder*="Status"]').last();
      if (await legalStatusDropdown.isVisible()) {
        console.log(`Step 6: Selecting Legal Status: ${shLegalStatus}`);
        await selectDropdownOption(page, legalStatusDropdown, shLegalStatus);
      }

      // 10. Select Number of Years Established
      if (shYears && shYears.trim() !== '') {
        const cleanYears = shYears.replace(/[\(\)]/g, '').trim();
        const yearsDropdown = page.locator('input[placeholder="Select Number of Years"], p-dropdown, span:has-text("Select Number of Years"), [placeholder*="Years"]').last();
        if (await yearsDropdown.isVisible()) {
          console.log(`Step 6: Selecting Number of Years Established: ${cleanYears}`);
          await yearsDropdown.click({ force: true });
          try {
            const yearsOption = page.locator('p-dropdownitem, li, div, span').filter({ hasText: new RegExp("^" + cleanYears + "$") }).first();
            await expect(yearsOption).toBeVisible({ timeout: 15000 });
            await yearsOption.click({ force: true });
          } catch (err) {
            console.log('Step 6 Fallback: Selecting years option via text filter...');
            const fallbackYears = page.locator('div, span, li').filter({ hasText: cleanYears }).last();
            await expect(fallbackYears).toBeVisible({ timeout: 15000 });
            await fallbackYears.click({ force: true });
          }
        }
      }

      // 11. Fill Share Percentage
      const shareInput = page.locator('input[placeholder="Enter the share percentage %"]').first();
      if (await shareInput.isVisible()) {
        console.log(`Step 6: Typing Share Percentage: ${sh.percentage}`);
        await shareInput.click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await shareInput.type(sh.percentage, { delay: 150 });
      }

      // 12. Fill Email Address
      const shEmailInput = page.locator('input[placeholder="Email Address"]').first();
      if (await shEmailInput.isVisible()) {
        console.log(`Step 6: Typing Email Address: ${shEmail}`);
        await shEmailInput.click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await shEmailInput.type(shEmail, { delay: 150 });
      }

      // 14. Mobile Number — find input first, then open prefix dropdown
      const mobileInput = page.locator('input[placeholder*="5xx"], input[placeholder*="5XX"], input[placeholder*="5xx"]').filter({ visible: true }).first();
      console.log(`Step 6: Selecting Mobile Prefix: ${shMobileCode}`);

      const mobileGroup = page.locator('div').filter({ has: mobileInput }).filter({ hasText: /Mobile Number|رقم الجوال/ }).last();
      let prefixDropdown = mobileGroup.locator('.p-dropdown-trigger, .custom-select-trigger, i[class*="chevron"], i[class*="down"], span[class*="caret"], svg').first();
      let dropdownOpened = false;

      if (await prefixDropdown.isVisible()) {
        await prefixDropdown.click({ force: true });
        dropdownOpened = true;
      } else {
        console.log('Dropdown icon not visible, executing exact coordinate click left of mobile input...');
        const box = await mobileInput.boundingBox();
        if (box) {
          await page.mouse.click(box.x - 50, box.y + (box.height / 2));
          dropdownOpened = true;
        }
      }

      if (dropdownOpened) {
        try {
          const regexStr = shMobileCode.replace('+', '\\+') + '|' + shCountry;
          const optionItem = page.locator('p-dropdownitem, li, div, span').filter({ hasText: new RegExp(regexStr) }).filter({ visible: true }).last();
          await expect(optionItem).toBeVisible({ timeout: 15000 });
          await optionItem.scrollIntoViewIfNeeded();
          await optionItem.click();
          console.log(`Successfully selected prefix ${shMobileCode} from the list!`);
        } catch (err) {
          console.log('Step 6 Fallback: Clicking mobile prefix via text selector...');
          const fallbackOption = page.locator('p-dropdownitem, li, div, span').filter({ hasText: shMobileCode }).filter({ visible: true }).last();
          await expect(fallbackOption).toBeVisible({ timeout: 15000 });
          await fallbackOption.click();
        }
      }

      if (await mobileInput.isVisible()) {
        console.log(`Step 6: Typing Mobile Number: ${shMobile}`);
        await mobileInput.click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await mobileInput.type(shMobile, { delay: 150 });
      }

      // 15. Fill Website
      const websiteInput = page.locator('input[placeholder="websitePlaceholder"]').first();
      if (await websiteInput.isVisible()) {
        console.log(`Step 6: Typing Website: ${shWebsite}`);
        await websiteInput.click({ force: true });
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await websiteInput.type(shWebsite, { delay: 150 });
      }

      // 16. Upload Shareholder Attachments
      console.log('Step 6: Uploading shareholder attachments...');
      const shCrFile = sh.crFile && sh.crFile.trim() !== '' ? resolveFilePath(sh.crFile) : null;
      const shFsFile = sh.fsFile && sh.fsFile.trim() !== '' ? resolveFilePath(sh.fsFile) : null;
      const shOther1File = sh.other1File && sh.other1File.trim() !== '' ? resolveFilePath(sh.other1File) : null;
      const shOther2File = sh.other2File && sh.other2File.trim() !== '' ? resolveFilePath(sh.other2File) : null;

      console.log('Step 6: Waiting for file input elements to render...');
      try {
        await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
      } catch (err) {
        console.log('Warning: Timeout waiting for input[type="file"]. Proceeding...');
      }

      const shFileInputs = page.locator('input[type="file"]');
      const shFileCount = await shFileInputs.count();
      console.log(`Step 6: Found ${shFileCount} file input fields on MISA Shareholder page.`);

      if (shFileCount >= 1 && shCrFile && fs.existsSync(shCrFile)) {
        console.log(`Uploading Commercial Registration Copy: ${shCrFile}`);
        await shFileInputs.nth(0).setInputFiles(shCrFile);
        await waitForUploadComplete(page);
      }
      if (shFileCount >= 2 && shFsFile && fs.existsSync(shFsFile)) {
        console.log(`Uploading Last Year Financial Statement: ${shFsFile}`);
        await shFileInputs.nth(1).setInputFiles(shFsFile);
        await waitForUploadComplete(page);
      }
      if (shFileCount >= 3 && shOther1File && fs.existsSync(shOther1File)) {
        console.log(`Uploading Other Attachment 1: ${shOther1File}`);
        await shFileInputs.nth(2).setInputFiles(shOther1File);
        await waitForUploadComplete(page);
      }
      if (shFileCount >= 4 && shOther2File && fs.existsSync(shOther2File)) {
        console.log(`Uploading Other Attachment 2: ${shOther2File}`);
        await shFileInputs.nth(3).setInputFiles(shOther2File);
        await waitForUploadComplete(page);
      }

      // 17. Click Save Button
      console.log('Step 6: Clicking "Save New Shareholder" button...');
      const intlSaveBtn = page.locator('button').filter({ hasText: /Save New Shareholder|Save Shareholder|Save|حفظ/ }).first();
      await intlSaveBtn.click({ force: true });
      await addShareholderBtn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await waitForPageReady(page);

    }
    // ── END TASK B branch (Organization) ─────────────────────────────────────
    } // close Organization else block (shType !== 'Person')
  } // close shareholder loop

  // 56. Click final Next button once total percentage is 100%
  console.log('Step 6: Clicking Next to proceed to Step 7...');
  await page.locator('button').filter({ hasText: 'Next' }).last().click({ force: true });
  await page.locator('label, .label, span.label-text').filter({ hasText: /Identity Type/i }).first()
    .waitFor({ state: 'visible', timeout: 60000 });

  console.log('Step 6 completely finished! Shareholders saved successfully and proceeded.');

  // ==========================================
  // STEP 7: CONTACT PERSON (misa_buckup.js worker flow)
  // ==========================================
  page = ensureWorkflowPage(page, 'before Step 7');
  console.log('══════════════════════════════════════════════════════════');
  console.log('--- Starting Step 7: Contact Person ---');
  console.log('══════════════════════════════════════════════════════════');
  const contactWorkerCtx = {
    contactTitle,
    contactFirstNameAr,
    contactLastNameAr,
    contactFullNameEn,
    contactNationality,
    contactPassportNumber,
    contactDobYear,
    contactDobMonth,
    contactDobDay,
    contactIssueYear,
    contactIssueMonth,
    contactIssueDay,
    contactExpiryYear,
    contactExpiryMonth,
    contactExpiryDay,
    contactCountry,
    contactCity,
    contactMobilePrefix,
    contactMobile,
    contactEmail,
  };
  page = await runWorkerWithAi(page, {
    section: 'Step 7',
    stepIndex: 6,
    totalSteps: WORKFLOW_TOTAL_STEPS,
    pseudoStep: { type: 'worker', label: 'Contact Person — Identity Passport, fields, Next' },
    ctx: contactWorkerCtx,
    run: (p) => runMisaStep7(p, contactWorkerCtx),
    verify: verifyWorkerStep7,
  });

  // ==========================================
  // STEP 8: PREVIEW & SUBMIT (misa_buckup.js worker flow)
  // ==========================================
  page = ensureWorkflowPage(page, 'before Step 8');
  console.log('══════════════════════════════════════════════════════════');
  console.log('--- Starting Step 8: Preview & Submit ---');
  console.log('══════════════════════════════════════════════════════════');
  page = await runWorkerWithAi(page, {
    section: 'Step 8',
    stepIndex: 7,
    totalSteps: WORKFLOW_TOTAL_STEPS,
    pseudoStep: { type: 'worker', label: 'Preview — terms checkbox, Submit, Agree dialogs' },
    ctx: {},
    run: (p) => runMisaStep8(p),
    verify: verifyWorkerStep8,
  });

  console.log('🏆 E2E MISA Saudi Registration completed successfully from end to end! 🏆');
});