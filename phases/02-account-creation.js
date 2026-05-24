const { safeFill, safeClick } = require('../utils/helpers');

async function runPhase02AccountCreation(page, config) {
  const { user, timeouts } = config;

  console.log('Filling Account Credentials...');

  await safeFill(page, 'input[name="username"], #username, input[placeholder*="Username"]', user.username);
  await page.waitForTimeout(timeouts.typingDelay);

  await safeFill(page, 'input[name="password"], #password, input[type="password"]', user.password);
  await page.waitForTimeout(timeouts.typingDelay);

  // Handle Terms Modal
  console.log('Handling Terms & Conditions...');
  const agreeButton = page.locator('button:has-text("Agree"), button:has-text("Accept"), button:has-text("I Accept")');

  if (await agreeButton.isVisible()) {
    await agreeButton.scrollIntoViewIfNeeded();
    await agreeButton.click();
    console.log('Terms accepted');
  }

  // GCC Nationality Check - Select "No"
  console.log('Handling GCC Nationality popup...');
  const noGccOption = page.locator('input[value="No"], input[type="radio"]:has-text("No"), button:has-text("No")');

  if (await noGccOption.isVisible()) {
    await noGccOption.click();
    console.log('Selected "No" for GCC nationality');
  }
}

module.exports = runPhase02AccountCreation;