/**
 * Success checks for worker steps (3, 4, 7, 8) before AI handoff / resume.
 */

import { isBusinessActivitiesPage } from './smartActions.js';

export async function verifyWorkerStep3(page) {
  const url = page.url() || '';
  if (await isBusinessActivitiesPage(page)) return true;
  if (/investment|business|isic|apply/i.test(url) && !/dashboard-without-ir/i.test(url)) return true;

  const errorDlg = page.getByRole('heading', { name: /^Error$/i }).filter({ visible: true }).first();
  if (await errorDlg.isVisible({ timeout: 800 }).catch(() => false)) return false;

  return true;
}

export async function verifyWorkerStep4(page) {
  if (!(await isBusinessActivitiesPage(page))) return false;
  return page.getByText(/Allowed/i).first().isVisible({ timeout: 5000 }).catch(() => false);
}

export async function verifyWorkerStep7(page) {
  const url = page.url() || '';
  if (/preview|summary|review/i.test(url)) return true;
  const preview = page.getByText(/preview|review your application|summary/i).first();
  if (await preview.isVisible({ timeout: 3000 }).catch(() => false)) return true;
  return page.getByRole('button', { name: /^Submit$/i }).first().isVisible({ timeout: 3000 }).catch(() => false);
}

export async function verifyWorkerStep8(page) {
  const success = page.getByText(/success|submitted|completed|تم التقديم|thank you/i).first();
  if (await success.isVisible({ timeout: 8000 }).catch(() => false)) return true;
  return page.getByText(/🏆|completed successfully/i).isVisible({ timeout: 2000 }).catch(() => false);
}
