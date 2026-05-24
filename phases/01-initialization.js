const { safeFill, safeClick } = require('../utils/helpers');

async function runPhase01Initialization(page, config) {
  const { url, user, timeouts } = config;

  console.log(`Navigating to ${url}/register...`);
  await page.goto(url + '/register', { waitUntil: 'networkidle', timeout: timeouts.navigationTimeout });

  // Step 1: Click and select Title from dropdown
  console.log('Step 1: Selecting Title (Mr.)...');
  const titleSelect = page.locator('select[name="firstName_prefix"]');
  await titleSelect.waitFor({ state: 'visible' });
  await titleSelect.selectOption('3'); // Mr.
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 2: Write First Name
  console.log('Step 2: Filling First Name...');
  await safeFill(page, 'input[name="firstName"]', user.firstName);
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 3: Write Last Name
  console.log('Step 3: Filling Last Name...');
  await safeFill(page, 'input[name="lastName"]', user.lastName);
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 4: Write Company Name (this triggers Sector and Country dropdowns to appear!)
  console.log('Step 4: Filling Company Name...');
  await safeFill(page, 'input[name="company_name"]', user.companyName);
  await page.waitForTimeout(timeouts.typingDelay);

  // Wait for dropdowns to appear after company name
  await page.waitForTimeout(500);

  // Step 5: Click dropdown and select Sector
  console.log('Step 5: Selecting Sector...');
  const sectorSelect = page.locator('select[name="sector"]');
  await sectorSelect.waitFor({ state: 'visible', timeout: 10000 });
  await sectorSelect.selectOption({ label: 'Services' });
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 6: Click dropdown and select Country
  console.log('Step 6: Selecting Country (Algeria)...');
  const countrySelect = page.locator('select[name="country"]');
  await countrySelect.waitFor({ state: 'visible', timeout: 10000 });
  await countrySelect.selectOption({ label: 'Algeria' });
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 7: Write phone number (without country code)
  console.log('Step 7: Filling Mobile Number...');
  const mobileInput = page.locator('input[name="mobileNumber"]');
  await mobileInput.click();
  await page.waitForTimeout(300);
  await mobileInput.fill(user.mobile); // Already without country code
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 8: Write email (click first to enable, then fill)
  console.log('Step 8: Filling Email...');
  const emailInput = page.locator('input#email');
  await emailInput.click();
  await page.waitForTimeout(300);
  await emailInput.fill(user.email);
  await page.waitForTimeout(timeouts.typingDelay);

  // Step 9: Click Verify Email button
  console.log('Step 9: Clicking Verify Email...');
  const verifyBtn = page.locator('button:has-text("Verify Email")');
  await verifyBtn.click();
  await page.waitForTimeout(1000);

  // Step 10: Wait for OTP input
  console.log('\n📧 WAITING: Please enter the Email OTP manually in the browser.');
  
  const otpInput = page.locator('input[name="otp"], input[name="verificationCode"]');
  await otpInput.waitFor({ state: 'visible', timeout: 30000 });
  console.log('OTP field visible - waiting for manual entry...');

  // Wait for user to enter OTP - detect when success modal appears
  await page.waitForFunction(() => {
    const body = document.body.innerText;
    return body.includes('verified') || body.includes('success') || body.includes('Email Verified');
  }, { timeout: 180000 }).catch(() => {
    console.log('Waiting for OTP verification...');
  });

  // Wait for success window
  await page.waitForTimeout(3000);

  // Step 11: Close success window if it appears
  console.log('Step 11: Closing OTP success window if present...');
  const closeBtn = page.locator('button:has-text("Close"), button[class*="close"], [class*="close"]').first();
  if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(1000);
  }

  // Step 12: Click Next button
  console.log('Step 12: Clicking Next button...');
  const nextButton = page.locator('button:has-text("Next")');
  await nextButton.click();

  // Wait for navigation to next step
  await page.waitForLoadState('networkidle');
  console.log('Phase 1 complete - moved to next step.');
}

module.exports = runPhase01Initialization;