/**
 * Compact visible DOM summary for LLM recovery (not full HTML).
 */

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<object[]>}
 */
export async function captureDomSnapshot(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const nodes = document.querySelectorAll(
        'button, a[role="button"], input, select, textarea, [role="button"], [role="combobox"], ' +
        '[role="textbox"], [role="dialog"], .p-dialog, label, h1, h2, h3, [role="heading"]'
      );

      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const st = window.getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.1) continue;

        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const placeholder = el.placeholder || '';
        const aria = el.getAttribute('aria-label') || '';
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const type = el.getAttribute('type') || '';
        const key = `${role}|${text}|${placeholder}|${aria}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          role,
          tag: el.tagName.toLowerCase(),
          type,
          text,
          placeholder,
          ariaLabel: aria,
          name: el.getAttribute('name') || '',
          disabled: !!el.disabled,
        });
        if (out.length >= 100) break;
      }
      return out;
    });
  } catch (e) {
    console.log(`[AI-RECOVERY] DOM snapshot failed: ${e.message}`);
    return [];
  }
}

/**
 * @param {object[]} snapshot
 * @returns {string}
 */
export function formatDomSnapshotForPrompt(snapshot) {
  if (!snapshot?.length) return '(no interactive elements captured)';
  return snapshot.map((el, i) => {
    const parts = [`#${i + 1}`, el.role || el.tag];
    if (el.text) parts.push(`text="${el.text}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.ariaLabel) parts.push(`aria="${el.ariaLabel}"`);
    if (el.disabled) parts.push('disabled');
    return parts.join(' ');
  }).join('\n');
}
