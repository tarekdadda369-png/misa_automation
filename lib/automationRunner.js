/**
 * Shared run preparation + Playwright spawn (dashboard + external API).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SITE_DATA_FILE = process.env.SITE_DATA_FILE || 'site_data/misa_config.json';

/** Production: no visible browser. Dev: set PLAYWRIGHT_HEADED=1 */
function useHeadless() {
    if (process.env.PLAYWRIGHT_HEADED === '1') return false;
    if (process.env.PLAYWRIGHT_HEADLESS === '0') return false;
    if (process.env.PLAYWRIGHT_HEADLESS === '1') return true;
    return process.env.NODE_ENV === 'production' || process.env.PRODUCTION_MODE === '1';
}

function saveBase64File(filePayload, uploadsDir) {
    if (filePayload && typeof filePayload === 'object' && filePayload.base64) {
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const matches = filePayload.base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        let base64Data = filePayload.base64;
        if (matches && matches.length === 3) base64Data = matches[2];
        const buffer = Buffer.from(base64Data, 'base64');
        const filename = `${Date.now()}_${(filePayload.filename || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, buffer);
        console.log(`Saved uploaded file to: ${filePath}`);
        return path.resolve(filePath);
    }
    return filePayload;
}

/**
 * @param {object} configData — same JSON shape as index.html /api/run
 * @param {string} projectRoot
 */
function prepareRunConfig(configData, projectRoot) {
    const uploadsDir = path.join(projectRoot, 'uploads');
    const crypto = require('crypto');
    const runId = (configData._runId || `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`).toString();
    const clientId = configData._clientId || configData.clientId || null;
    const data = { ...configData };
    delete data._runId;
    delete data._clientId;
    delete data._webhookUrl;
    if (clientId) data.clientId = clientId;

    if (data.entityCRFile) data.entityCRFile = saveBase64File(data.entityCRFile, uploadsDir);
    if (data.entityFSFile) data.entityFSFile = saveBase64File(data.entityFSFile, uploadsDir);

    if (data.shareholders && Array.isArray(data.shareholders)) {
        data.shareholders = data.shareholders.map((sh) => {
            const copy = { ...sh };
            if (copy.crFile) copy.crFile = saveBase64File(copy.crFile, uploadsDir);
            if (copy.fsFile) copy.fsFile = saveBase64File(copy.fsFile, uploadsDir);
            if (copy.other1File) copy.other1File = saveBase64File(copy.other1File, uploadsDir);
            if (copy.other2File) copy.other2File = saveBase64File(copy.other2File, uploadsDir);
            if (copy.passportFile) copy.passportFile = saveBase64File(copy.passportFile, uploadsDir);
            return copy;
        });
    }

    const configFileName = `config_${runId}.json`;
    fs.writeFileSync(path.join(projectRoot, configFileName), JSON.stringify(data, null, 2), 'utf8');
    fs.writeFileSync(path.join(projectRoot, 'config.json'), JSON.stringify(data, null, 2), 'utf8');
    console.log(`[RUN ${runId}] Saved ${configFileName}`);

    return { runId, configFileName, config: data, clientId };
}

/** Update job.otp state from a log line (for external dashboards). */
function applyLogLineToJob(job, line) {
    if (!job.otp) job.otp = { email: null, mobile: null };

    const waitingEmail =
        /OTP HANDLER \[email\]: starting flow/i.test(line) ||
        /Starting Email OTP/i.test(line) ||
        /Email OTP flow/i.test(line) ||
        /OTP HANDLER \[email\]: waiting for OTP/i.test(line);
    const waitingMobile =
        /OTP HANDLER \[mobile\]: starting flow/i.test(line) ||
        /Starting Mobile OTP/i.test(line) ||
        /Mobile OTP flow/i.test(line) ||
        /Verify Mobile OTP/i.test(line) ||
        /OTP HANDLER \[mobile\]: waiting for OTP/i.test(line);

    if (waitingEmail) job.otp.email = 'waiting';
    if (waitingMobile) job.otp.mobile = 'waiting';

    if (/OTP DASHBOARD: RESET email/i.test(line) || /OTP HANDLER \[email\]: ❌ rejected/i.test(line)) {
        job.otp.email = 'waiting';
    }
    if (/OTP DASHBOARD: RESET mobile/i.test(line) || /OTP HANDLER \[mobile\]: ❌ rejected/i.test(line)) {
        job.otp.mobile = 'waiting';
    }

    if (/OTP DASHBOARD: ACCEPTED email/i.test(line) || /OTP HANDLER \[email\]: ✅ OTP accepted/i.test(line)) {
        job.otp.email = 'accepted';
    }
    if (/OTP DASHBOARD: ACCEPTED mobile/i.test(line) || /OTP HANDLER \[mobile\]: ✅ OTP accepted/i.test(line)) {
        job.otp.mobile = 'accepted';
    }

    if (line.includes('[AI-AGENT]')) job.lastAiActivity = new Date().toISOString();
}

/**
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.runId
 * @param {string} opts.configFileName
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [opts.onLine]
 */
function spawnPlaywrightRun(opts) {
    const { projectRoot, runId, configFileName, onLine } = opts;

    const headless = useHeadless();
    const testArgs = ['playwright', 'test', 'tests/misa.spec.js', '--workers=1'];
    if (!headless) testArgs.push('--headed');

    if (onLine) onLine(`[RUNNER] Browser mode: ${headless ? 'headless (production)' : 'headed (visible)'}`, 'stdout');

    const child = spawn('npx', testArgs, {
        shell: true,
        cwd: projectRoot,
        env: {
            ...process.env,
            RUN_ID: runId,
            CONFIG_FILE: configFileName,
            SITE_DATA_FILE,
            RUN_AI_FALLBACK: process.env.RUN_AI_FALLBACK || '',
            OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
            AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL || 'gpt-4o',
            AI_FALLBACK_MAX_TURNS: process.env.AI_FALLBACK_MAX_TURNS || '12',
        },
    });

    child.stdout.on('data', (data) => {
        const text = data.toString();
        text.split('\n').filter(Boolean).forEach((line) => onLine && onLine(line, 'stdout'));
    });

    child.stderr.on('data', (data) => {
        const text = data.toString();
        text.split('\n').filter(Boolean).forEach((line) => onLine && onLine(`[ERROR] ${line}`, 'stderr'));
    });

    return child;
}

function cleanupRunFiles(projectRoot, runId, configFileName) {
    try { fs.unlinkSync(path.join(projectRoot, configFileName)); } catch (_) {}
    try { fs.unlinkSync(path.join(projectRoot, `otp_session_${runId}.json`)); } catch (_) {}
}

module.exports = {
    prepareRunConfig,
    spawnPlaywrightRun,
    applyLogLineToJob,
    cleanupRunFiles,
    useHeadless,
};
