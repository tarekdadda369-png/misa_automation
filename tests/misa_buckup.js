import { test, expect } from '@playwright/test';
import fs from 'fs';

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

/** Click the first visible button matching any alternative label */
async function clickButton(page, name, alternatives, options = {}) {
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
const RUN_ID          = process.env.RUN_ID || '';
const CONFIG_FILE     = process.env.CONFIG_FILE || 'config.json';
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
    await page.waitForTimeout(1500);
  }
  console.log(`OTP INJECTOR: done.`);
}

/**
 * Full OTP handling cycle:
 *  1. Poll otp_session.json for the token
 *  2. If found → inject it into the page
 *  3. Regardless → wait for the portal's Close/success button and click it
 */
async function handleOtpFlow(page, type, label) {
  console.log(`OTP HANDLER [${type}]: starting flow — "${label}"`);
  const otp = await pollForOtp(page, type, 240000);
  if (otp) {
    await injectOtpIntoPage(page, otp);
  } else {
    console.log(`OTP HANDLER [${type}]: no automated token — waiting for manual close on "${label}"...`);
  }
  // Wait for the portal's own success/close button (covers both automated and manual paths)
  try {
    const closeBtn = page.locator('button:has-text("Close"), .close-icon, [aria-label="Close"]').last();
    await closeBtn.waitFor({ state: 'visible', timeout: 60000 });
    console.log(`OTP HANDLER [${type}]: success dialog detected — clicking Close.`);
    await closeBtn.click({ force: true });
  } catch (err) {
    console.log(`OTP HANDLER [${type}]: no close button found — ${err.message}`);
  }
  await waitForPageReady(page);
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

test('MISA Saudi Registration Workflow', async ({ page }) => {
  // Increase timeout to 30 minutes for manual OTP + slow execution
  test.setTimeout(1800000);

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

  // Load config file for this run (each parallel run has its own file)
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log(`Successfully loaded dynamic configuration from ${CONFIG_FILE}!`);
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
      console.log(`Could not parse ${CONFIG_FILE}, using defaults.`, e);
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

  // 2. Select Title (Robust and Bulletproof)
  console.log(`Step 1: Selecting Title: ${regTitle}`);
  try {
    const titleSelect = page.locator('select[name="firstName_prefix"], select[id="firstName_prefix"], select').first();
    await titleSelect.waitFor({ state: 'visible', timeout: 15000 });

    try {
      console.log(`Attempting to select option by label: "${regTitle}"`);
      await titleSelect.selectOption({ label: regTitle });
    } catch (e1) {
      console.log(`Label select failed, trying selectOption by value/index or text matching...`);
      const titleMap = {
        'Dr.': '1', 'Dr': '1',
        'Miss': '2',
        'Mr.': '3', 'Mr': '3',
        'Mrs.': '4', 'Mrs': '4',
        'Ms.': '5', 'Ms': '5'
      };
      const val = titleMap[regTitle] || '3';
      console.log(`Mapping "${regTitle}" to value "${val}"...`);
      await titleSelect.selectOption({ value: val });
    }

    // Force trigger change and input events to ensure state updates correctly
    await titleSelect.evaluate(el => {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    console.log(`Title successfully selected: ${regTitle}`);
  } catch (e) {
    console.error(`CRITICAL ERROR selecting Title: ${e.message}`);
    // Ultimate fallback: select option via page.evaluate
    await page.evaluate((titleText) => {
      const select = document.querySelector('select[name="firstName_prefix"], select');
      if (select) {
        const option = Array.from(select.options).find(opt => opt.text.includes(titleText) || opt.value === titleText);
        if (option) {
          select.value = option.value;
        } else {
          select.value = '3';
        }
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, regTitle);
  }

  // 3. Write First Name (Slow Typing)
  console.log(`Step 1: Typing First Name: ${firstName}`);
  const firstNameInput = page.locator('input[placeholder="Enter First Name"]');
  await expect(firstNameInput).toBeVisible({ timeout: 15000 });
  await firstNameInput.type(firstName, { delay: 200 });

  // 4. Write Last Name (Slow Typing)
  console.log(`Step 1: Typing Last Name: ${lastName}`);
  const lastNameInput = page.locator('input[placeholder="Enter Last Name"]');
  await expect(lastNameInput).toBeVisible();
  await lastNameInput.type(lastName, { delay: 200 });

  // National ID — only typed when both the input is visible AND a value was configured
  const nationalIdInput = page.locator('input[placeholder="Enter National ID / IQAMA ID"]');
  if (await nationalIdInput.isVisible()) {
    if (nationalId !== '') {
      console.log(`Step 1: Typing National ID / IQAMA ID: ${nationalId}`);
      await nationalIdInput.type(nationalId, { delay: 150 });
    } else {
      console.log('Step 1: National ID left empty (no value configured) — skipping.');
    }
  } else {
    console.log('Step 1: National ID input not rendered — skipping.');
  }

  // 5. Write Company Name (Dynamic)
  console.log(`Step 1: Typing Company Name: ${companyName}`);
  const companyInput = page.locator('input[placeholder="Enter Company Name"]');
  await expect(companyInput).toBeVisible();
  await companyInput.type(companyName, { delay: 150 });

  // 6. Select Sector from dropdown
  console.log(`Selecting Sector: ${sector}`);
  await selectDropdownOption(page, 'input[placeholder="Select Sector"]', sector);

  // 7. Write Email (Force editable and slow type)
  const emailInput = page.locator('input[placeholder="Enter Your Email"]');
  await emailInput.evaluate(el => { el.readOnly = false; });
  await expect(emailInput).toBeEditable();
  await emailInput.type(targetEmail, { delay: 100 });

  // 8. Select Country
  console.log(`Step 1: Selecting Country: ${country}`);
  await page.click('input[placeholder="Select Country"]');
  const countryOption = page.locator('div, span, li').filter({ hasText: country }).last();
  try {
    await expect(countryOption).toBeVisible({ timeout: 15000 });
    await countryOption.click({ force: true });
  } catch (err) {
    console.log('Fallback: Clicking via text selector...');
    await page.click(`text=${country}`);
  }
  await waitForPageReady(page);

  // 9. Write Number (Prefix is automatically set by MISA based on Country)
  console.log(`Step 1: Typing Registration Mobile Number: ${regMobile}`);
  const regMobileInput = page.locator('input[placeholder="Enter Mobile Number"]');
  await regMobileInput.evaluate(el => { el.readOnly = false; });
  await expect(regMobileInput).toBeEditable();
  await regMobileInput.type(regMobile, { delay: 200 });

  // 11. Click the button "Verify Email"
  const verifyButton = page.locator(':text("Verify Email")').first();
  await verifyButton.scrollIntoViewIfNeeded();
  await expect(verifyButton).toBeVisible();
  await verifyButton.click({ force: true });

  // 12. Email OTP — automated polling (via otp_session.json) with manual fallback
  console.log(`Step 1/2: Starting Email OTP flow for ${targetEmail}...`);
  await handleOtpFlow(page, 'email', `Email OTP for ${targetEmail}`);

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

  // 14. Click "Next"
  await clickButton(page, 'Next', ['Next']);

  // Final check for next step
  await expect(page.getByText('Username & Password')).toBeVisible({ timeout: 30000 });

  // 15. Write Username (Dynamic)
  const usernameInput = page.locator('input[placeholder="Enter Username"]');
  await expect(usernameInput).toBeVisible();
  await usernameInput.type(credsUsername, { delay: 150 });

  // 16. Write Password (Human-like)
  const passwordInput = page.locator('input[placeholder="Enter Password"]');
  await passwordInput.type(credsPassword, { delay: 150 });

  // 17. Write Confirm Password (Human-like)
  const confirmPasswordInput = page.locator('input[placeholder="Enter Confirm Password"]');
  await confirmPasswordInput.type(credsPassword, { delay: 150 });

  // 18. Check Terms & Conditions
  console.log('Step 2: Checking the terms agreement checkbox...');
  try {
    await page.click('text=I acknowledge reading and agreeing to the', { timeout: 5000 });
  } catch (err) {
    console.log('Fallback: Checking checkbox input directly...');
    await page.locator('input[type="checkbox"]').first().check({ force: true });
  }

  // 19. Click final "Register" button
  await clickButton(page, 'Register', ['Register']);
  await page.getByText('MISA Investment Registration').waitFor({ state: 'visible', timeout: 60000 });
  console.log('Registration process completed!');

  // --- STEP 3: MISA Investment Registration ---
  await page.getByText('MISA Investment Registration').first().click();
  await waitForPageReady(page);

  // 21. Click on "Apply"
  await clickButton(page, 'Apply', ['Apply']);

  // 22. Click on "Agree" (Terms window)
  console.log('Step 3: Waiting for Terms agreement button "Agree"...');
  await clickButton(page, 'Agree', ['Agree']);

  // 23. Click on "No" (GCC nationality window)
  console.log('Step 3: Waiting for GCC nationality dialog button "No"...');
  await clickButton(page, 'No', ['No']);
  await waitForPageReady(page);
  console.log('Investment Registration application started!');

  // --- STEP 4: Registration Business Activities ---

  // 24. Click on checkbox of "Regular Investment Registration"
  console.log('Searching for Regular Investment Registration checkbox...');
  const container = page.locator('div, label, span').filter({ hasText: /^Regular Investment Registration$/ }).first();
  await expect(container).toBeVisible({ timeout: 30000 });
  await container.scrollIntoViewIfNeeded();

  // Click the text itself (often triggers the checkbox)
  await container.click({ force: true });

  // Specifically find and check the input if it's there
  const checkbox = container.locator('input[type="checkbox"]').first();
  if (await checkbox.count() > 0) {
    await checkbox.check({ force: true });
  } else {
    // If no input inside, try clicking the parent container
    await container.locator('..').first().click({ force: true });
  }

  await waitForPageReady(page);

  for (let i = 0; i < isicCodes.length; i++) {
    const isicCode = isicCodes[i];
    console.log(`--- Adding Business Activity ${i + 1} of ${isicCodes.length} (${isicCode}) ---`);

    // 25. Click on "+ Add Business Activities"
    const addActivityButton = page.locator('button:has-text("Add Business Activities"), button:has-text("+ Add Business Activities")');
    await addActivityButton.waitFor({ state: 'visible' });
    await addActivityButton.click();
    await waitForPageReady(page);

    // 26. Click on "Search your Activity" button
    const searchActivityBtn = page.getByRole('button', { name: 'Search your Activity' });
    await expect(searchActivityBtn).toBeVisible({ timeout: 15000 });
    await searchActivityBtn.click();

    // 27. Type ISIC Code and Press Enter
    const searchInput = page.locator('input[placeholder="Search"]').last();
    await searchInput.waitFor({ state: 'visible' });
    await searchInput.type(isicCode, { delay: 150 });
    await page.keyboard.press('Enter'); // Ensure search is triggered
    await expect(page.getByText(isicCode).last()).toBeVisible({ timeout: 30000 });

    // 28. Select the activity (Advanced DOM evaluation logic)
    console.log('Searching for activity result via advanced evaluation...');
    const activityText = page.getByText(isicCode).last();

    try {
      await activityText.waitFor({ state: 'visible', timeout: 15000 });
      // Execute a forced click via browser context to completely bypass Playwright visibility/actionability issues
      await page.evaluate((code) => {
        // Find the deepest element containing the code text
        const elements = Array.from(document.querySelectorAll('*'))
          .filter(el => el.textContent && el.textContent.includes(code) && el.children.length === 0);

        if (elements.length > 0) {
          const el = elements[elements.length - 1]; // The last one is usually the search result in the DOM
          // Find the nearest container/row
          const rowContainer = el.closest('div[class*="row"], tr, li, div[class*="MuiGrid"]') || el.parentElement;
          if (rowContainer) {
            const checkbox = rowContainer.querySelector('input[type="checkbox"]');
            if (checkbox) {
              checkbox.click();
              return;
            }
            rowContainer.click();
            return;
          }
          // Ultimate fallback: click the text directly
          el.click();
        }
      }, isicCode);
    } catch (error) {
      console.log('Advanced DOM selection fallback triggered.');
      await activityText.click({ force: true });
    }

    // 29. Click "Next" in the modal
    const modalNextBtn = page.getByRole('button', { name: 'Next' }).last();
    await expect(modalNextBtn).toBeVisible();
    await modalNextBtn.click();
    await waitForPageReady(page);
  }

  // 30. Verify Step 4 is finished (Look for "Allowed" classification)
  await expect(page.getByText('Allowed').first()).toBeVisible();
  console.log('Step 4: Business Activities selected correctly!');

  // --- STEP 5: Entity Information (Using loaded config let variables) ---

  // 31. Entity Name English
  await page.locator('input[placeholder="Enter Entity Name in English"]').type(entityNameEnglish, { delay: 150 });

  // 32. Entity Name Arabic
  await page.locator('input[placeholder="Enter Entity Name in Arabic"]').type(entityNameArabic, { delay: 150 });

  // 33. Legal Status Dropdown
  await selectDropdownOption(page, 'input[placeholder="Select Legal Status"]', legalStatus);

  // 34. Capital
  await page.locator('input[placeholder="Enter Capital"]').type(capital, { delay: 100 });

  // 35. Email
  await page.locator('input[placeholder="Enter Email"]').type(entityEmail, { delay: 100 });

  // 36. Mobile Number (Prefix + Number)
  const mobilePrefix = entityMobilePrefix;

  // Open the mobile prefix dropdown (robustly targeting the element next to the mobile input)
  await page.evaluate(() => {
    const mobileInput = document.querySelector('input[placeholder="Enter Mobile Number"]');
    if (mobileInput) {
      // Find the container holding the mobile input and the prefix dropdown
      const container = mobileInput.closest('div[class*="row"], div[class*="container"]') || mobileInput.parentElement.parentElement;
      // Look for standard prefix dropdown triggers (Select placeholder, flag dropdown, or the first div sibling)
      const trigger = container.querySelector('input[placeholder="Select"], .flag-dropdown, .selected-flag, div[class*="prefix"]')
        || mobileInput.parentElement.previousElementSibling;
      if (trigger) trigger.click();
    }
  });

  // Select the specific country code (+213)
  const prefixOption = page.locator('div, span, li').filter({ hasText: mobilePrefix }).last();
  await expect(prefixOption).toBeVisible({ timeout: 15000 });
  await prefixOption.click({ force: true });

  // Write the actual mobile number
  await page.locator('input[placeholder="Enter Mobile Number"]').type(entityMobile, { delay: 100 });

  // 37. Region Dropdown
  await selectDropdownOption(page, 'input[placeholder="Select Region"]', region);
  await page.locator('input[placeholder="Select City"]').waitFor({ state: 'visible', timeout: 15000 });

  // 38. City Dropdown
  await selectDropdownOption(page, 'input[placeholder="Select City"]', city);

  // 39. Investment Spending Dropdown
  await selectDropdownOption(page, 'input[placeholder="Expected Investment Spending"]', investmentSpending);

  console.log('Step 5: Entity Information filled successfully!');

  // 40. Upload Attachments
  console.log(`Uploading real user files: ${entityCRFile} and ${entityFSFile}`);
  const crFile = entityCRFile;
  const fsFile = entityFSFile;

  // Crucial: Wait for the file input elements to be attached in the DOM first
  console.log('Step 5: Waiting for file input elements to render...');
  try {
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 20000 });
  } catch (err) {
    console.log('Warning: Timeout waiting for input[type="file"]. Proceeding...');
  }
  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count();

  if (count >= 2) {
    // Upload Commercial Register
    await fileInputs.nth(0).setInputFiles(resolveFilePath(crFile));
    await waitForUploadComplete(page);
    // Upload Financial Statement
    await fileInputs.nth(1).setInputFiles(resolveFilePath(fsFile));
    await waitForUploadComplete(page);
  } else {
    console.log(`Only found ${count} file inputs. Trying to upload anyway...`);
    for (let i = 0; i < count; i++) {
      await fileInputs.nth(i).setInputFiles(resolveFilePath(crFile));
      await waitForUploadComplete(page);
    }
  }

  // 41. Click final "Next" button
  console.log('Clicking the final Next button to submit the application...');
  await page.getByRole('button', { name: 'Next' }).last().click({ force: true });
  await page.locator('button').filter({ hasText: /Add Shareholder|Add shareholder|إضافة شريك/ }).first()
    .waitFor({ state: 'visible', timeout: 60000 });
  console.log('Step 5 completely finished! Registration submitted.');

  // --- STEP 6: Add Shareholder ---
  console.log('--- Starting Step 6: Shareholders List ---');

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
      console.log(`MISA SH FLOW [PERSON]: Filling Person shareholder ${i + 1}`);

      // ── Inline helpers — identical to Step 7 ─────────────────────────────
      const shEscP = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const shClosePopups = async () => {
        await page.keyboard.press('Escape');
        await page.locator('.react-datepicker-popper, .p-dropdown-panel')
          .filter({ visible: true }).waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
      };

      // Dropdown helper: tries p-dropdown (PrimeNG) first across parent/grandparent,
      // then falls back to Step 7's input-first approach.
      // p-dropdown MUST be first — clicking a plain <input> does NOT open PrimeNG panels.
      const shSelectDropdown = async (labelName, optionText) => {
        if (!optionText || String(optionText).trim() === '') return;
        console.log(`Step 6 [P]: 🔽 "${labelName}" → "${optionText}"`);
        try {
          const label = page.locator('label, span, div').filter({
            hasText: new RegExp(`^\\s*${shEscP(labelName)}\\s*\\*?\\s*$`, 'i')
          }).first();
          await label.scrollIntoViewIfNeeded();

          // Walk up ancestor levels looking for a PrimeNG p-dropdown or combobox FIRST.
          // (Step 7 puts 'input' first which works there, but on this form
          //  the input is unrelated and does not open the dropdown panel.)
          let trigger = null;
          for (const level of ['xpath=..', 'xpath=../..', 'xpath=../../..']) {
            const ancestor = label.locator(level);
            for (const sel of ['.p-dropdown', 'p-dropdown', '[role="combobox"]']) {
              const el = ancestor.locator(sel).first();
              if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
                trigger = el; break;
              }
            }
            if (trigger) break;
          }
          // Final fallback: Step 7 input-first style
          if (!trigger) {
            trigger = label.locator('xpath=..').locator('input, .p-dropdown-trigger').first();
          }

          await trigger.scrollIntoViewIfNeeded();
          await trigger.click({ force: true });
          await page.waitForTimeout(400);

          const cleanOpt = optionText.replace(/\.$/, '').trim();
          const optionItem = page.locator('li, .p-dropdown-item, p-dropdownitem, span, div').filter({
            hasText: new RegExp(`^\\s*${shEscP(cleanOpt)}`, 'i')
          }).filter({ visible: true }).last();
          await expect(optionItem).toBeVisible({ timeout: 12000 });
          await optionItem.scrollIntoViewIfNeeded();
          await optionItem.click({ force: true });
          await shClosePopups();
          console.log(`Step 6 [P]: ✅ "${labelName}"`);
        } catch (e) {
          console.log(`Step 6 [P]: ⚠ Dropdown fallback "${labelName}": ${e.message}`);
          // Targeted fallbacks for each known field
          if (labelName.includes('Identity')) {
            await page.getByRole('combobox').first().click({ force: true });
            await page.locator('li, .p-dropdown-item').filter({ hasText: /^Passport$/i }).filter({ visible: true }).first().click({ force: true });
          } else if (labelName.includes('Title')) {
            await page.locator('[role="combobox"]').nth(1).click({ force: true });
            await page.locator('li, span, div').filter({ hasText: new RegExp(`^\\s*${shEscP(optionText.replace(/\.$/, ''))}`, 'i') }).filter({ visible: true }).first().click({ force: true });
          } else {
            await page.locator('li, span, div').filter({ hasText: new RegExp(`^\\s*${shEscP(optionText)}`, 'i') }).filter({ visible: true }).first().click({ force: true });
          }
          await shClosePopups().catch(() => {});
        }
      };

      // Text fill — getByLabel (Playwright accessibility) first, then label→parent→input fallback.
      // Does NOT include 'div' in the label selector to avoid matching large containers.
      const shFillText = async (labelText, value) => {
        if (!value || String(value).trim() === '') return;
        console.log(`Step 6 [P]: ✍ "${labelText}" → "${value}"`);
        try {
          let inp = page.getByLabel(new RegExp(shEscP(labelText), 'i')).first();
          if (!(await inp.isVisible({ timeout: 2000 }).catch(() => false))) {
            // Narrow to label/span only — no 'div' to avoid big container matches
            const lbl = page.locator('label, span').filter({
              hasText: new RegExp(`^\\s*${shEscP(labelText)}\\s*\\*?\\s*$`, 'i')
            }).first();
            inp = lbl.locator('xpath=..').locator('input:not([readonly]):not([disabled])').first();
          }
          await inp.scrollIntoViewIfNeeded();
          await inp.click({ force: true });
          await inp.fill('');
          await inp.pressSequentially(String(value), { delay: 80 });
          console.log(`Step 6 [P]: ✅ "${labelText}"`);
        } catch (e) {
          console.log(`Step 6 [P]: ⚠ Fill failed "${labelText}": ${e.message}`);
        }
      };

      // Calendar fill — Step 7 logic exactly, plus Hijri/Gregorian chooser at the front.
      const SH_MONTH_IDX = {
        january:'0',jan:'0',february:'1',feb:'1',march:'2',mar:'2',april:'3',apr:'3',
        may:'4',june:'5',jun:'5',july:'6',jul:'6',august:'7',aug:'7',
        september:'8',sep:'8',october:'9',oct:'9',november:'10',nov:'10',december:'11',dec:'11'
      };
      const shFillCalendar = async (labelText, yr, mo, dy, calType = 'Gregorian') => {
        const dayNum = String(parseInt(dy, 10));
        console.log(`Step 6 [P]: 📅 "${labelText}" → ${dayNum}/${mo}/${yr} (${calType})`);
        try {
          const lbl = page.locator('label, span').filter({
            hasText: new RegExp(`^\\s*${shEscP(labelText)}\\s*\\*?\\s*$`, 'i')
          }).first();
          if (!(await lbl.isVisible({ timeout: 5000 }).catch(() => false))) {
            console.log(`Step 6 [P]: 📅 "${labelText}" not found — skipping`);
            return;
          }
          await shClosePopups();

          // Open the date field — scroll into view, click, retry if needed
          const parent = lbl.locator('xpath=..');
          const trigger = parent.locator(
            '.react-datepicker__input-container input, .react-datepicker-wrapper input, input, button'
          ).first();
          await trigger.scrollIntoViewIfNeeded();
          await page.waitForTimeout(400);
          await trigger.click({ force: true });
          await page.waitForTimeout(600);

          // Select Hijri / Gregorian if the chooser appears
          const calTypeBtn = page.locator('button, span, div, li').filter({
            hasText: new RegExp(`^${calType}$`, 'i')
          }).filter({ visible: true }).first();
          if (await calTypeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await calTypeBtn.click({ force: true });
            await page.waitForTimeout(500);
          }

          // Wait for the popup — retry the trigger click once if not visible
          const cal = page.locator(
            '.react-datepicker-popper, .react-datepicker, .p-datepicker, .p-calendar-panel'
          ).filter({ visible: true }).last();

          if (!(await cal.isVisible({ timeout: 2000 }).catch(() => false))) {
            // Calendar didn't open — scroll again and click harder
            await trigger.scrollIntoViewIfNeeded();
            await page.waitForTimeout(300);
            await trigger.click({ force: true, clickCount: 1 });
            await page.waitForTimeout(600);
            // If Gregorian chooser appears again, click it again
            if (await calTypeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
              await calTypeBtn.click({ force: true });
              await page.waitForTimeout(400);
            }
          }

          await cal.waitFor({ state: 'visible', timeout: 8000 });

          // ── Year — same as Step 7: getByRole YYYY textbox ────────────────────
          const yearBox = cal.getByRole('textbox', { name: 'YYYY' }).first();
          if (await yearBox.isVisible({ timeout: 1500 }).catch(() => false)) {
            await yearBox.fill(String(yr));
            await page.keyboard.press('Tab');
          } else {
            // Fallback: any visible number/text input inside the popup (triple-click + type)
            const numInp = cal.locator(
              'input[type="number"], input[type="text"]:not([readonly]), p-inputnumber input'
            ).filter({ visible: true }).first();
            if (await numInp.isVisible({ timeout: 1000 }).catch(() => false)) {
              await numInp.click({ force: true, clickCount: 3 });
              await numInp.fill(String(yr));
              await page.keyboard.press('Tab');
              await page.waitForTimeout(300);
            }
          }

          // ── Month — same as Step 7: native select ────────────────────────────
          const monthSel = cal.locator('select').first();
          await expect(monthSel).toBeVisible({ timeout: 5000 });
          const mv = SH_MONTH_IDX[mo.toLowerCase()];
          if (mv !== undefined) await monthSel.selectOption(mv);
          else await monthSel.selectOption({ label: mo });

          // ── Day — same as Step 7: react-datepicker day cell ──────────────────
          const dayCell = cal.locator(
            '.react-datepicker__day:not(.react-datepicker__day--outside-month):not(.react-datepicker__day--disabled),' +
            'td span:not(.p-datepicker-other-month):not(.p-disabled)'
          ).filter({ hasText: new RegExp(`^${dayNum}$`) }).first();
          await expect(dayCell).toBeVisible({ timeout: 8000 });
          await dayCell.click({ force: true });

          // ── Save ─────────────────────────────────────────────────────────────
          const saveBtn = cal.getByRole('button', { name: /^Save$/i }).first();
          if (await saveBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await saveBtn.click({ force: true });
          } else {
            await page.keyboard.press('Escape');
          }
          await cal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
          console.log(`Step 6 [P]: ✅ "${labelText}"`);
        } catch (e) {
          console.log(`Step 6 [P]: ⚠ Calendar "${labelText}" failed: ${e.message}`);
          await shClosePopups().catch(() => {});
        }
      };

      // ── Data from config ──────────────────────────────────────────────────
      const shTitle        = sh.title           || 'Mr.';
      const shFirstNameAr  = sh.firstNameAr     || sh.nameAr  || '';
      const shLastNameAr   = sh.lastNameAr      || '';
      const shFullNameEn   = sh.fullNameEn      || sh.nameEng || '';
      const shPassportNum  = sh.passportNumber  || '';
      const shNationality  = sh.nationality     || sh.country || 'Algeria';
      const shPersonCountry= sh.country         || 'Algeria';
      const shCity         = sh.city            || '';
      const shProfLicense  = sh.professionalLicense || 'No';
      const shPlaceOfBirth = sh.placeOfBirth    || sh.city    || 'Algiers';
      const shPersonEmail  = sh.email           || `person_sh_${i}@alphatech.com`;
      const shPersonMobCode= sh.mobilePrefix    || '+213';
      const shPersonMobile = sh.mobile          || `50000000${i}`;
      const shDobDay   = sh.dobDay    || '1'; const shDobMonth   = sh.dobMonth   || 'January'; const shDobYear   = sh.dobYear   || '1990';
      const shIssueDay = sh.issueDay  || '1'; const shIssueMonth = sh.issueMonth || 'January'; const shIssueYear = sh.issueYear || '2020';
      const shExpDay   = sh.expiryDay || '1'; const shExpMonth   = sh.expiryMonth|| 'January'; const shExpYear   = sh.expiryYear|| '2030';
      const shPassportFile = sh.passportFile || sh.crFile || null;

      // ── Fill the form — same sequence as Step 7 Contact Person ────────────
      await shSelectDropdown('Identity Type', 'Passport');
      await page.locator('label, span, div').filter({ hasText: /^Title\s*\*?$/i }).first()
        .waitFor({ state: 'visible', timeout: 20000 });

      await shSelectDropdown('Title', shTitle);
      await shFillText('First Name in Arabic', shFirstNameAr);
      await shFillText('Last Name in Arabic',  shLastNameAr);
      await shFillText('Full Name in English', shFullNameEn);
      await shFillText('Share Percentage',     sh.percentage);
      await shFillText('Passport Number',      shPassportNum);
      await shFillCalendar('Date of Birth',    shDobYear, shDobMonth, shDobDay, sh.dobCalendar || 'Gregorian');
      await shClosePopups();
      await shSelectDropdown('Current Nationality', shNationality);
      await shClosePopups();
      await shSelectDropdown('Country',        shPersonCountry);
      await shClosePopups();
      await shFillText('City',                 shCity);
      await shSelectDropdown('Professional License', shProfLicense);
      await shClosePopups();
      await shFillText('Place of Birth',       shPlaceOfBirth);
      await shFillText('Email',                shPersonEmail);

      // Mobile — exact same pattern as Step 7:
      // selectListDropdown('Mobile Number', prefix) opens the code dropdown
      // fillContactText('Mobile Number', number) types the number
      console.log(`Step 6 [P]: 📱 Mobile: ${shPersonMobCode} ${shPersonMobile}`);
      await shSelectDropdown('Mobile Number',  shPersonMobCode);
      await shClosePopups();
      await shFillText('Mobile Number',        shPersonMobile);

      // Dates — try all possible label name variants (form label may differ)
      await shClosePopups();
      await shFillCalendar('Passport Issue Date', shIssueYear, shIssueMonth, shIssueDay, sh.issueCalendar  || 'Gregorian');
      await shClosePopups();
      await shFillCalendar('ID Issue Date',       shIssueYear, shIssueMonth, shIssueDay, sh.issueCalendar  || 'Gregorian');
      await shClosePopups();
      await shFillCalendar('Passport Expiry Date',shExpYear,   shExpMonth,   shExpDay,   sh.expiryCalendar || 'Gregorian');
      await shClosePopups();
      await shFillCalendar('ID Expiry Date',      shExpYear,   shExpMonth,   shExpDay,   sh.expiryCalendar || 'Gregorian');
      await shClosePopups();

      // Passport / License file upload
      if (shPassportFile && String(shPassportFile).trim() !== '') {
        const resolvedPassport = resolveFilePath(shPassportFile);
        if (fs.existsSync(resolvedPassport)) {
          console.log(`Step 6 [P]: 📎 Uploading: ${resolvedPassport}`);
          try {
            await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
            const fileInputs = page.locator('input[type="file"]');
            if (await fileInputs.count() > 0) {
              await fileInputs.first().setInputFiles(resolvedPassport);
              await waitForUploadComplete(page);
            }
          } catch (e) { console.log(`Step 6 [P]: ⚠ Upload error: ${e.message}`); }
        } else {
          console.log(`Step 6 [P]: ⚠ Passport file not found: ${resolvedPassport}`);
        }
      }

      // Save
      console.log('Step 6 [P]: Saving shareholder...');
      const personSaveBtn = page.locator('button').filter({
        hasText: /Save New Shareholder|Save Shareholder|حفظ|Save/
      }).filter({ visible: true }).first();
      await expect(personSaveBtn).toBeVisible({ timeout: 15000 });
      await personSaveBtn.click({ force: true });
      await addShareholderBtn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
      await waitForPageReady(page);
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
  // STEP 7: CONTACT PERSON
  // ==========================================
  console.log('--- Starting Step 7: Contact Person ---');
  
  // Wait for the Contact Person form to fully render by checking for a stable label
  console.log('Step 7: Waiting for the Contact Person form to render...');
  const identityTypeLabel = page.locator('label, .label, span.label-text').filter({ hasText: /Identity Type/i }).first();
  await identityTypeLabel.waitFor({ state: 'visible', timeout: 30000 });
  console.log('Step 7: Contact Person form rendered!');

  // ── Tab Selection (Shareholder vs Others) ──────────────────────────────────
  console.log('Step 7: Checking for Shareholder vs Others tabs...');
  const othersTab = page.locator('div').filter({ hasText: /^Others$/ }).first();
  if (await othersTab.isVisible()) {
    const isOthersDisabled = await othersTab.getAttribute('disabled') !== null || await othersTab.getAttribute('aria-disabled') === 'true';
    if (!isOthersDisabled) {
      console.log('Step 7: Clicking "Others" tab to ensure editable contact form...');
      await othersTab.click({ force: true });
      await identityTypeLabel.waitFor({ state: 'visible', timeout: 15000 });
    }
  }

  // Step 7 helpers — scoped to each form row (div.sc-fRwpmT + label.sc-cOtduh) from live DOM
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const getContactFieldRow = (labelText) => {
    const labelPattern = new RegExp(`^\\s*${escapeRegExp(labelText)}`, 'i');
    return page.locator('div.sc-fRwpmT').filter({
      has: page.locator('label.sc-cOtduh', { hasText: labelPattern })
    }).first();
  };

  const closeOpenPopups = async () => {
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

  // Click-to-open list dropdowns (Identity Type, Title, Current Nationality, Country) — same flow for all
  const selectListDropdown = async (labelName, optionText) => {
    console.log(`Step 7: 🔽 Selecting "${optionText}" for "${labelName}"`);
    try {
      const label = page.locator('label, span, div').filter({
        hasText: new RegExp(`^\\s*${escapeRegExp(labelName)}\\s*\\*?\\s*$`, 'i')
      }).first();
      await label.scrollIntoViewIfNeeded();
      const parent = label.locator('xpath=..');
      const trigger = parent.locator('input, [role="combobox"], .p-dropdown-trigger').first();
      await trigger.click({ force: true });

      const cleanOption = optionText.replace(/\.$/, '').trim();
      const optionItem = page.locator('li, .p-dropdown-item, p-dropdownitem, span, div').filter({
        hasText: new RegExp(`^\\s*${escapeRegExp(cleanOption)}`, 'i')
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
    await closeOpenPopups();

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
    if (monthVal) {
      await monthSelect.selectOption(monthVal);
    } else {
      await monthSelect.selectOption({ label: month });
    }

    const dayCell = calendarPopup
      .locator('.react-datepicker__day:not(.react-datepicker__day--outside-month):not(.react-datepicker__day--disabled)')
      .filter({ hasText: new RegExp(`^${dayNum}$`) })
      .first();
    await expect(dayCell).toBeVisible({ timeout: 10000 });
    await dayCell.click({ force: true });

    const saveBtn = calendarPopup.getByRole('button', { name: /^Save$/i }).first();
    if (await saveBtn.isVisible()) {
      await saveBtn.click({ force: true });
    } else {
      await page.keyboard.press('Escape');
    }
    await page.locator('.react-datepicker-popper').filter({ visible: true })
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {});
    console.log(`Step 7: ✅ Calendar "${labelText}" saved`);
  };

  // --- DROPDOWN SELECTIONS & TEXT FIELDS ---
  await selectListDropdown('Identity Type', 'Passport');

  console.log('Step 7: Waiting for passport fields (Title) to render after Identity Type...');
  const titleLabel = page.locator('label, .label, span.label-text').filter({ hasText: /Title/i }).first();
  await titleLabel.waitFor({ state: 'visible', timeout: 15000 });

  await selectListDropdown('Title', contactTitle);
  await fillContactText('First Name in Arabic', contactFirstNameAr);
  await fillContactText('Last Name in Arabic', contactLastNameAr);
  await fillContactText('Full Name in English', contactFullNameEn);
  await selectListDropdown('Current Nationality', contactNationality);
  await fillContactCalendar('Date of Birth', contactDobYear, contactDobMonth, contactDobDay);
  await fillContactText('Passport number', contactPassportNumber);
  await fillContactCalendar('ID Issue Date', contactIssueYear, contactIssueMonth, contactIssueDay);
  await fillContactCalendar('ID Expiry Date', contactExpiryYear, contactExpiryMonth, contactExpiryDay);

  // --- CONTACT INFORMATION ---
  await selectListDropdown('Country', contactCountry);
  await fillContactText('City', contactCity);

  // Select Mobile Prefix
  await selectListDropdown('Mobile Number', contactMobilePrefix);

  // Fill Mobile Number
  await fillContactText('Mobile Number', contactMobile);

  // Fill Email Address
  await fillContactText('Email Address', contactEmail);

  // Click Next to proceed to Step 8 (Preview)
  console.log('Step 7: Clicking Next to proceed to Step 8 (Preview)...');
  await page.locator('button').filter({ hasText: 'Next' }).last().click({ force: true });
  await waitForPageReady(page, 60000);

  console.log('Step 7 completely finished! Contact Person saved and proceeded.');

  // ==========================================
  // STEP 8: PREVIEW & SUBMIT
  // ==========================================
  console.log('--- Starting Step 8: Preview & Submit ---');

  // Wait for Preview page to load
  await waitForPageReady(page, 60000);

  // Scroll to bottom to see checkbox and submit button
  console.log('Step 8: Scrolling to the bottom of the Preview page...');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);

  // Check the terms agreement checkbox (simple and direct)
  console.log('Step 8: Checking the terms agreement checkbox...');
  try {
    const termsCheckbox = page.locator('input[type="checkbox"]').first();
    await termsCheckbox.scrollIntoViewIfNeeded();
    await termsCheckbox.check({ force: true });
    await page.waitForTimeout(1000);
    console.log('✓ Terms checkbox checked successfully');
  } catch (err) {
    console.log('Checkbox check failed, proceeding anyway...');
  }

  // Click Submit button - SIMPLE AND DIRECT (just like Step 7 with Next)
  console.log('Step 8: Clicking Submit button...');
  await clickButton(page, 'Submit', ['Submit', 'تقديم', 'إرسال']);
  await waitForPageReady(page, 30000);

  // Handle Agree dialog if it appears (optional, no timeout)
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

  // Handle feedback/cancel dialog if it appears (optional, no timeout)
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

  console.log('🏆 E2E MISA Saudi Registration completed successfully from end to end! 🏆');
});