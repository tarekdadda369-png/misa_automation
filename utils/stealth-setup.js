const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

async function createStealthBrowser() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  return browser;
}

async function createStealthContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  return context;
}

module.exports = { createStealthBrowser, createStealthContext };