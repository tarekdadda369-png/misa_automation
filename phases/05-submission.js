const { safeClick } = require('../utils/helpers');

async function runPhase05Submission(page, config) {
  console.log('Final Review & Submission...');

  const summaryPage = page.locator('[class*="summary"], [class*="review"], [class*="details"]');
  await summaryPage.scrollIntoViewIfNeeded();

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  console.log('Clicking Declaration Checkbox...');
  const declarationCheckbox = page.locator('input[type="checkbox"][name="declaration"], input[type="checkbox"][id*="declare"]');
  await declarationCheckbox.check();

  console.log('Clicking Submit Button...');
  const submitButton = page.locator('button:has-text("Submit"), button[type="submit"]:has-text("Submit")');
  await submitButton.scrollIntoViewIfNeeded();
  await submitButton.click();

  console.log('Form submitted successfully!');
}

module.exports = runPhase05Submission;