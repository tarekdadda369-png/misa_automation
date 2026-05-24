async function safeFill(page, selector, value, options = {}) {
  const timeout = options.timeout || 30000;
  try {
    const locator = page.locator(selector);
    await locator.waitFor({ state: 'visible', timeout });
    await locator.fill(value);
  } catch (error) {
    console.error(`Error filling ${selector}:`, error.message);
    throw error;
  }
}

async function safeClick(page, selector, options = {}) {
  const timeout = options.timeout || 30000;
  try {
    const locator = page.locator(selector);
    await locator.waitFor({ state: 'visible', timeout });
    await locator.click();
  } catch (error) {
    console.error(`Error clicking ${selector}:`, error.message);
    throw error;
  }
}

async function handleNetworkError(page, action) {
  try {
    await action();
  } catch (error) {
    const networkErrorModal = page.locator('text=Network Error');
    if (await networkErrorModal.isVisible()) {
      console.log('Network Error detected, attempting recovery...');
      const closeBtn = page.locator('button:has-text("Close"), button[class*="close"]').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      }
      console.log('Retrying action...');
      await action();
    } else {
      throw error;
    }
  }
}

async function waitForUploadComplete(page, containerSelector) {
  const trashIcon = page.locator(`${containerSelector} svg[class*="trash"], ${containerSelector} [class*="delete"]`).first();
  await trashIcon.waitFor({ state: 'visible', timeout: 30000 });
  console.log('Upload processing complete');
}

async function checkAndSkipDisabled(page, selector) {
  const field = page.locator(selector);
  if (await field.isVisible()) {
    const isDisabled = await field.isDisabled();
    if (isDisabled) {
      console.log(`Field ${selector} is disabled, skipping...`);
      return false;
    }
    return true;
  }
  return false;
}

module.exports = { safeFill, safeClick, handleNetworkError, waitForUploadComplete, checkAndSkipDisabled };