/**
 * ISIC business-activities loop (Step 4) — kept as shared brain logic.
 */

import { expect } from '@playwright/test';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} isicCodes
 * @param {{ waitForPageReady: (page: any, timeout?: number) => Promise<void> }} helpers
 */
export async function runIsicBusinessActivities(page, isicCodes, { waitForPageReady }) {
  console.log('Searching for Regular Investment Registration checkbox...');
  const container = page.locator('div, label, span').filter({ hasText: /^Regular Investment Registration$/ }).first();
  await expect(container).toBeVisible({ timeout: 30000 });
  await container.scrollIntoViewIfNeeded();
  await container.click({ force: true });

  const checkbox = container.locator('input[type="checkbox"]').first();
  if (await checkbox.count() > 0) {
    await checkbox.check({ force: true });
  } else {
    await container.locator('..').first().click({ force: true });
  }
  await waitForPageReady(page);

  const codes = Array.isArray(isicCodes) ? isicCodes : [isicCodes].filter(Boolean);
  for (let i = 0; i < codes.length; i++) {
    const isicCode = codes[i];
    console.log(`--- Adding Business Activity ${i + 1} of ${codes.length} (${isicCode}) ---`);

    const addActivityButton = page.locator(
      'button:has-text("Add Business Activities"), button:has-text("+ Add Business Activities")'
    );
    await addActivityButton.waitFor({ state: 'visible' });
    await addActivityButton.click();
    await waitForPageReady(page);

    const searchActivityBtn = page.getByRole('button', { name: 'Search your Activity' });
    await expect(searchActivityBtn).toBeVisible({ timeout: 15000 });
    await searchActivityBtn.click();

    const searchInput = page.locator('input[placeholder="Search"]').last();
    await searchInput.waitFor({ state: 'visible' });
    await searchInput.type(isicCode, { delay: 150 });
    await page.keyboard.press('Enter');
    await expect(page.getByText(isicCode).last()).toBeVisible({ timeout: 30000 });

    console.log('Searching for activity result via advanced evaluation...');
    const activityText = page.getByText(isicCode).last();
    try {
      await activityText.waitFor({ state: 'visible', timeout: 15000 });
      await page.evaluate((code) => {
        const elements = Array.from(document.querySelectorAll('*'))
          .filter((el) => el.textContent && el.textContent.includes(code) && el.children.length === 0);
        if (elements.length > 0) {
          const el = elements[elements.length - 1];
          const rowContainer = el.closest('div[class*="row"], tr, li, div[class*="MuiGrid"]') || el.parentElement;
          if (rowContainer) {
            const cb = rowContainer.querySelector('input[type="checkbox"]');
            if (cb) { cb.click(); return; }
            rowContainer.click();
            return;
          }
          el.click();
        }
      }, isicCode);
    } catch {
      await activityText.click({ force: true });
    }

    const modalNextBtn = page.getByRole('button', { name: 'Next' }).last();
    await expect(modalNextBtn).toBeVisible();
    await modalNextBtn.click();
    await waitForPageReady(page);
  }

  await expect(page.getByText('Allowed').first()).toBeVisible();
  console.log('Step 4: Business Activities selected correctly!');
}
