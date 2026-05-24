import fs from 'fs';
import path from 'path';

/**
 * Load site-specific data (one file per site for 500-site scale).
 * Returns flat `values` for the existing test "brain" plus declarative `steps`.
 *
 * @param {string} siteDataFile - e.g. site_data/misa_config.json
 * @param {string} [overrideFile] - e.g. config.json from dashboard (merged on top)
 * @returns {{ siteId: string, values: object, steps: object, shareholders: array } | null}
 */
export function loadSiteData(siteDataFile, overrideFile = null) {
  const base = { siteId: 'unknown', values: {}, steps: {}, shareholders: [] };

  if (siteDataFile && fs.existsSync(siteDataFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(siteDataFile, 'utf8'));
      base.siteId = raw.site_id || raw.siteId || 'unknown';
      base.values = raw.values && typeof raw.values === 'object' ? { ...raw.values } : {};
      base.steps = raw.steps && typeof raw.steps === 'object' ? raw.steps : {};
      if (Array.isArray(raw.shareholders)) base.shareholders = raw.shareholders;
      else if (Array.isArray(base.values.shareholders)) {
        base.shareholders = base.values.shareholders;
        delete base.values.shareholders;
      }
      console.log(`Loaded site data: ${siteDataFile} (site: ${base.siteId})`);
    } catch (e) {
      console.log(`Could not parse site data ${siteDataFile}:`, e.message);
    }
  }

  if (overrideFile && fs.existsSync(overrideFile)) {
    try {
      const override = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
      base.values = { ...base.values, ...override };
      if (Array.isArray(override.shareholders)) base.shareholders = override.shareholders;
      console.log(`Merged run override: ${overrideFile}`);
    } catch (e) {
      console.log(`Could not parse override ${overrideFile}:`, e.message);
    }
  }

  if (Object.keys(base.values).length === 0 && base.shareholders.length === 0 && Object.keys(base.steps).length === 0) {
    return null;
  }
  return base;
}

/**
 * Flat config object for existing misa.spec.js variable assignment (backward compatible).
 * @param {string} siteDataFile
 * @param {string} [overrideFile]
 * @returns {object | null}
 */
export function loadMergedConfig(siteDataFile, overrideFile = null) {
  const site = loadSiteData(siteDataFile, overrideFile);
  if (!site) return null;

  const config = { ...site.values };
  if (site.shareholders.length) config.shareholders = site.shareholders;
  return config;
}

/**
 * Resolve path relative to playwright-cli root.
 * @param {string} relativePath
 * @param {string} [rootDir]
 */
export function resolveSiteDataPath(relativePath, rootDir = process.cwd()) {
  return path.isAbsolute(relativePath) ? relativePath : path.join(rootDir, relativePath);
}
