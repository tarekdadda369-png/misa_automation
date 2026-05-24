const { safeFill, safeClick } = require('../utils/helpers');

async function runPhase03EntityInvestment(page, config) {
  const { entity, timeouts } = config;

  console.log('Searching for Activity...');

  const activitySearch = page.locator('input[name="activity"], #activity, input[placeholder*="Activity"]');
  await activitySearch.waitFor({ state: 'visible' });
  await activitySearch.fill(entity.activityKeyword);
  await page.waitForTimeout(timeouts.typingDelay);

  const searchButton = page.locator('button:has-text("Search"), button[type="submit"]');
  await searchButton.click();

  const resultsList = page.locator('[class*="results"], [class*="suggestions"], ul li');
  await resultsList.first().waitFor({ state: 'visible', timeout: 10000 });

  const firstResult = page.locator('input[type="checkbox"]').first();
  await firstResult.check();
  console.log('Activity selected');

  console.log('Filling Entity Details...');

  await safeFill(page, 'select[name="legalStatus"], #legalStatus', entity.legalStatus);
  await page.waitForTimeout(timeouts.typingDelay);

  await safeFill(page, 'select[name="region"], #region', entity.region);
  await page.waitForTimeout(timeouts.typingDelay);

  await safeFill(page, 'select[name="city"], #city', entity.city);
  await page.waitForTimeout(timeouts.typingDelay);

  console.log('Selecting Investment Timeline...');

  await safeFill(page, 'select[name="investmentRange"], #investmentRange', entity.investmentRange);
  await page.waitForTimeout(timeouts.typingDelay);
}

module.exports = runPhase03EntityInvestment;