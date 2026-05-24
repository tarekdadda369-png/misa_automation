const { safeFill, safeClick, checkAndSkipDisabled, waitForUploadComplete } = require('../utils/helpers');

async function runPhase04Shareholder(page, config) {
  const { shareholder, entity, timeouts } = config;

  console.log('Navigating to Add Shareholder section...');

  const addShareholderBtn = page.locator('button:has-text("Add Shareholder"), a:has-text("Add Shareholder")');
  await addShareholderBtn.click();

  console.log(`Setting Shareholder Country to: ${shareholder.shareholderCountry}`);

  const countryDropdown = page.locator('select[name="country"], #country, select[name="shareholderCountry"]');
  await countryDropdown.selectOption(shareholder.shareholderCountry);
  await page.waitForTimeout(timeouts.typingDelay);

  // Algeria Conditional Bypass - Skip Unified Number if disabled
  console.log('Checking for Unified Number field...');
  const unifiedNumberField = page.locator('input[name="unifiedNumber"], input[name="unifiedNumber"], input[placeholder*="Unified Number"]');
  const shouldFillUnified = await checkAndSkipDisabled(page, unifiedNumberField);

  if (shouldFillUnified) {
    console.log('Unified Number is enabled, filling...');
  } else {
    console.log('Unified Number is disabled, skipping as required...');
  }

  // Project Location - Saudi Region/City (separate from shareholder country)
  console.log('Setting Investment Project Location (Saudi)...');

  const projectRegion = page.locator('select[name="projectRegion"], #projectRegion');
  await projectRegion.selectOption(entity.region);
  await page.waitForTimeout(timeouts.typingDelay);

  const projectCity = page.locator('select[name="projectCity"], #projectCity');
  await projectCity.selectOption(entity.city);
  await page.waitForTimeout(timeouts.typingDelay);

  console.log('Uploading documents...');

  const passportUpload = page.locator('input[type="file"][name*="passport"], input[type="file"]').first();
  await passportUpload.setInputFiles(shareholder.documentPaths.passport);

  await waitForUploadComplete(page, '[class*="upload"], [class*="file-container"]');

  console.log('Shareholder phase complete');
}

module.exports = runPhase04Shareholder;