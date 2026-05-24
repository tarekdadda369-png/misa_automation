/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

loadEnv({ path: path.join(__dirname, '.env') });

const headless =
  process.env.PLAYWRIGHT_HEADED === '1'
    ? false
    : process.env.PLAYWRIGHT_HEADLESS === '0'
      ? false
      : process.env.PLAYWRIGHT_HEADLESS === '1' ||
        process.env.NODE_ENV === 'production' ||
        process.env.PRODUCTION_MODE === '1';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: {
    headless,
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
    video: 'on',               // Record video for all test runs
    screenshot: 'on',          // Capture screenshots for all test runs
    trace: 'on',               // Record trace for every run
    // Default to Chromium only
    ...devices['Desktop Edge'],
  },
  // Define a single project (Chromium) to avoid launching three browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], headless },
    },
  ],
});
