require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
    prepareRunConfig,
    spawnPlaywrightRun,
    cleanupRunFiles,
    useHeadless,
} = require('./lib/automationRunner');
const {
    scheduleRun,
    drainQueue,
    countRunning,
    queuePositionFor,
    getQueueStats,
    MAX_CONCURRENT_RUNS,
} = require('./lib/runQueue');

const PORT = parseInt(process.env.PORT || '3050', 10);
const PROJECT_ROOT = __dirname;
const FAILURE_QUEUE = path.join(PROJECT_ROOT, 'ai_fallback_queue.jsonl');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ── API Key ───────────────────────────────────────────────────────────────────
const SERVER_CONFIG_PATH = path.join(PROJECT_ROOT, 'server-config.json');

function loadOrCreateApiKey() {
    try {
        if (fs.existsSync(SERVER_CONFIG_PATH)) {
            const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8'));
            if (cfg.apiKey) return cfg.apiKey;
        }
    } catch (_) {}
    const newKey = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(SERVER_CONFIG_PATH, JSON.stringify({ apiKey: newKey }, null, 2), 'utf8');
    console.log(`\n🔑 New API key generated and saved to server-config.json`);
    console.log(`   Key: ${newKey}\n`);
    return newKey;
}

const API_KEY = loadOrCreateApiKey();
console.log(`🔑 API key loaded: ${API_KEY}`);

// ── Jobs ──────────────────────────────────────────────────────────────────────
const jobs = new Map();
const MAX_LOG_LINES = 200;

function createJob(runId, meta = {}) {
    const job = {
        runId,
        clientId: meta.clientId || null,
        phase: 'queued',
        running: false,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        logBuffer: [],
        otp: { email: null, mobile: null },
        lastAiActivity: null,
    };
    jobs.set(runId, job);
    return job;
}

function pushLog(job, line) {
    job.logBuffer.push({ ts: new Date().toISOString(), line });
    if (job.logBuffer.length > MAX_LOG_LINES) job.logBuffer.shift();
    applyLogLineToJob(job, line);
}

function latestJob() {
    if (jobs.size === 0) return null;
    return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

function isAuthorised(req) {
    const authHeader = req.headers['authorization'] || '';
    const queryKey = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('key') || '';
    return authHeader === `Bearer ${API_KEY}` || queryKey === API_KEY;
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });
}

function jsonResponse(res, status, data) {
    setCors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function jobToStatus(job) {
    let result = 'queued';
    if (job.phase === 'running') result = 'running';
    else if (job.exitCode === 0) result = 'success';
    else if (job.finishedAt) result = 'failed';

    return {
        runId: job.runId,
        clientId: job.clientId,
        phase: job.phase,
        running: job.phase === 'running',
        queuePosition: job.phase === 'queued' ? queuePositionFor(job.runId) : 0,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        exitCode: job.exitCode,
        result,
        otp: job.otp,
        lastAiActivity: job.lastAiActivity,
    };
}

function attachPlaywrightToJob(job, configFileName, streamRes) {
    const onLine = (line, stream) => {
        pushLog(job, line);
        if (streamRes && !streamRes.writableEnded) {
            streamRes.write((stream === 'stderr' ? '[ERROR] ' : '') + line + '\n');
        }
    };

    const child = spawnPlaywrightRun({
        projectRoot: PROJECT_ROOT,
        runId: job.runId,
        configFileName,
        onLine,
    });

    child.on('error', (err) => {
        const msg = '[SYSTEM ERROR] Failed to start Playwright: ' + err.message + '\n';
        pushLog(job, msg.trim());
        if (streamRes && !streamRes.writableEnded) streamRes.write(msg);
        job.running = false;
        job.phase = 'failed';
        job.exitCode = -1;
        job.finishedAt = new Date().toISOString();
        if (streamRes && !streamRes.writableEnded) streamRes.end();
        drainQueue(jobs, attachPlaywrightToJob);
    });

    child.on('close', (code) => {
        job.running = false;
        job.phase = code === 0 ? 'success' : 'failed';
        job.exitCode = code;
        job.finishedAt = new Date().toISOString();
        cleanupRunFiles(PROJECT_ROOT, job.runId, configFileName);
        if (streamRes && !streamRes.writableEnded) {
            streamRes.write('\n--------------------------------------------------\n');
            streamRes.write(
                code === 0
                    ? 'Automation successfully completed! 🏆\n'
                    : `Automation stopped with exit code: ${code}\n`
            );
            streamRes.end();
        }
        console.log(`[RUN ${job.runId}] (${job.clientId || ''}) finished — exit ${code}`);
        drainQueue(jobs, attachPlaywrightToJob);
    });

    return child;
}

function enqueueAndRespond(job, configFileName, streamRes) {
    return scheduleRun(jobs, job, configFileName, streamRes, attachPlaywrightToJob);
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
        setCors(res);
        res.writeHead(204);
        res.end();
        return;
    }

    // ── GET /api/v1/health ────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/v1/health') {
        jsonResponse(res, 200, {
            ok: true,
            service: 'misa-automation-runner',
            version: '1.0.0',
            uptime: process.uptime(),
            headless: useHeadless(),
            ...getQueueStats(jobs),
        });
        return;
    }

    // ── GET /api/v1/runs — list all runs (API key) ────────────────────────────
    if (req.method === 'GET' && pathname === '/api/v1/runs') {
        if (!isAuthorised(req)) {
            jsonResponse(res, 401, { error: 'Unauthorised.' });
            return;
        }
        const list = [...jobs.values()]
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
            .slice(0, 50)
            .map((j) => jobToStatus(j));
        jsonResponse(res, 200, { ...getQueueStats(jobs), runs: list });
        return;
    }

    // ── GET /api/v1/schema ────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/v1/schema') {
        const schemaPath = path.join(PROJECT_ROOT, 'api', 'run-payload.example.json');
        if (!fs.existsSync(schemaPath)) {
            jsonResponse(res, 404, { error: 'Schema example not found' });
            return;
        }
        setCors(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(fs.readFileSync(schemaPath, 'utf8'));
        return;
    }

    // ── POST /api/v1/runs — external company dashboard (async, API key) ───────
    if (req.method === 'POST' && pathname === '/api/v1/runs') {
        if (!isAuthorised(req)) {
            jsonResponse(res, 401, { error: 'Unauthorised. Use Authorization: Bearer <apiKey>' });
            return;
        }
        try {
            const configData = await readBody(req);
            const { runId, configFileName, clientId } = prepareRunConfig(configData, PROJECT_ROOT);
            const job = createJob(runId, { clientId });
            const queue = enqueueAndRespond(job, configFileName, null);

            jsonResponse(res, 202, {
                success: true,
                runId,
                clientId,
                phase: queue.phase,
                queuePosition: queue.queuePosition,
                maxConcurrentRuns: queue.maxConcurrentRuns,
                message:
                    queue.phase === 'queued'
                        ? `Queued (position ${queue.queuePosition}) — starts when a slot is free`
                        : 'Automation started (headless browser)',
                statusUrl: `/api/v1/runs/${runId}`,
                logsUrl: `/api/logs?runId=${runId}`,
                otpSubmitUrl: '/api/otp',
                poll: {
                    status: `GET /api/v1/runs/${runId}`,
                    logs: `GET /api/logs?runId=${runId}`,
                    otp: 'POST /api/otp { type, otp, runId }',
                },
            });
        } catch (err) {
            jsonResponse(res, 400, { error: err.message });
        }
        return;
    }

    // ── GET /api/v1/runs/:runId ───────────────────────────────────────────────
    const runDetailMatch = pathname.match(/^\/api\/v1\/runs\/([^/]+)$/);
    if (req.method === 'GET' && runDetailMatch) {
        const runId = runDetailMatch[1];
        const job = jobs.get(runId);
        if (!job) {
            jsonResponse(res, 404, { error: 'Run not found', runId });
            return;
        }
        jsonResponse(res, 200, { ...jobToStatus(job), ...getQueueStats(jobs) });
        return;
    }

    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(PROJECT_ROOT, 'index.html'), 'utf8', (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading dashboard: ' + err.message);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } else if (req.method === 'GET' && req.url === '/api/config') {
        const configPath = path.join(PROJECT_ROOT, 'config.json');
        if (fs.existsSync(configPath)) {
            fs.readFile(configPath, 'utf8', (err, content) => {
                if (err) {
                    jsonResponse(res, 500, { error: err.message });
                    return;
                }
                setCors(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(content);
            });
        } else {
            jsonResponse(res, 404, { error: 'Config not found' });
        }
    } else if (req.method === 'POST' && req.url === '/api/run') {
        try {
            const configData = await readBody(req);
            const { runId, configFileName, clientId } = prepareRunConfig(configData, PROJECT_ROOT);
                const job = createJob(runId, { clientId });
                const queue = enqueueAndRespond(job, configFileName, res);

                setCors(res);
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Transfer-Encoding': 'chunked',
                    'X-Content-Type-Options': 'nosniff',
                });

                res.write(`RUN_ID:${runId}\n`);
                if (clientId) res.write(`CLIENT_ID:${clientId}\n`);
                if (queue.phase === 'queued') {
                    res.write(`QUEUED: position ${queue.queuePosition} (max ${queue.maxConcurrentRuns} parallel)\n`);
                } else {
                    res.write('Starting MISA Saudi Registration Automation (headless)...\n');
                }
                res.write('--------------------------------------------------\n');
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid request data: ' + err.message);
        }
    } else if (req.method === 'GET' && req.url.startsWith('/api/otp')) {
        const type = url.searchParams.get('type') || 'email';
        const runId = url.searchParams.get('runId') || '';
        const otpFilePath = path.join(
            PROJECT_ROOT,
            runId ? `otp_session_${runId}.json` : 'otp_session.json'
        );
        let result = { otp: null };
        try {
            if (fs.existsSync(otpFilePath)) {
                const data = JSON.parse(fs.readFileSync(otpFilePath, 'utf8'));
                result.otp = data[type] || null;
            }
        } catch (_) {}
        jsonResponse(res, 200, result);
    } else if (req.method === 'POST' && req.url === '/api/otp') {
        try {
            const { type, otp, runId } = await readBody(req);
            const otpFilePath = path.join(
                PROJECT_ROOT,
                runId ? `otp_session_${runId}.json` : 'otp_session.json'
            );
            let data = {};
            if (fs.existsSync(otpFilePath)) {
                data = JSON.parse(fs.readFileSync(otpFilePath, 'utf8'));
            }
            data[type] = String(otp).trim();
            fs.writeFileSync(otpFilePath, JSON.stringify(data, null, 2), 'utf8');
            console.log(`[OTP][run:${runId || 'default'}] Stored ${type}: ${data[type]}`);
            jsonResponse(res, 200, { success: true });
        } catch (err) {
            jsonResponse(res, 400, { error: err.message });
        }
    } else if (req.method === 'POST' && req.url === '/api/otp/clear') {
        try {
            const { type, runId } = await readBody(req);
            const otpFilePath = path.join(
                PROJECT_ROOT,
                runId ? `otp_session_${runId}.json` : 'otp_session.json'
            );
            if (fs.existsSync(otpFilePath)) {
                const data = JSON.parse(fs.readFileSync(otpFilePath, 'utf8'));
                delete data[type];
                fs.writeFileSync(otpFilePath, JSON.stringify(data, null, 2), 'utf8');
            }
            jsonResponse(res, 200, { success: true });
        } catch (err) {
            jsonResponse(res, 400, { error: err.message });
        }
    } else if (req.method === 'GET' && req.url.startsWith('/api/status')) {
        const runId = url.searchParams.get('runId');
        const job = runId ? jobs.get(runId) : latestJob();
        if (!job) {
            jsonResponse(res, 200, { result: 'never_run', activeJobs: 0 });
            return;
        }
        const activeJobs = [...jobs.values()].filter((j) => j.running).length;
        jsonResponse(res, 200, { ...jobToStatus(job), activeJobs });
    } else if (req.method === 'GET' && req.url.startsWith('/api/logs')) {
        if (!isAuthorised(req)) {
            jsonResponse(res, 401, { error: 'Unauthorised.' });
            return;
        }
        const runId = url.searchParams.get('runId');
        const job = runId ? jobs.get(runId) : latestJob();
        jsonResponse(res, 200, {
            runId: job ? job.runId : null,
            logs: job ? job.logBuffer : [],
            otp: job ? job.otp : null,
        });
    } else if (req.method === 'POST' && req.url.startsWith('/api/trigger')) {
        if (!isAuthorised(req)) {
            jsonResponse(res, 401, { error: 'Unauthorised.' });
            return;
        }

        if (!fs.existsSync(path.join(PROJECT_ROOT, 'config.json'))) {
            jsonResponse(res, 422, {
                error: 'No config.json found. POST /api/v1/runs with payload first.',
            });
            return;
        }

        const runId = Date.now().toString();
        const configFileName = 'config.json';
        const job = createJob(runId);
        const queue = enqueueAndRespond(job, configFileName, null);
        console.log(`[TRIGGER] Run ${runId} — ${queue.phase}`);

        jsonResponse(res, 202, {
            success: true,
            runId,
            phase: queue.phase,
            queuePosition: queue.queuePosition,
            message: 'Poll GET /api/v1/runs/' + runId,
        });
    } else if (req.method === 'GET' && req.url === '/api/failures') {
        let entries = [];
        try {
            if (fs.existsSync(FAILURE_QUEUE)) {
                entries = fs
                    .readFileSync(FAILURE_QUEUE, 'utf8')
                    .trim()
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => {
                        try {
                            return JSON.parse(line);
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean);
            }
        } catch (_) {}
        jsonResponse(res, 200, { entries: entries.slice(-50) });
    } else if (req.method === 'POST' && req.url === '/api/failures/clear') {
        try {
            fs.writeFileSync(FAILURE_QUEUE, '', 'utf8');
        } catch (_) {}
        jsonResponse(res, 200, { success: true });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 MISA Automation Runner started`);
    console.log(`👉 Local dashboard: http://localhost:${PORT}`);
    console.log(`👉 External API:    POST http://localhost:${PORT}/api/v1/runs`);
    console.log(`🔑 API key: see server-config.json (Bearer token)`);
    console.log(`🖥️  Browser: ${useHeadless() ? 'headless (production)' : 'headed (dev — set PLAYWRIGHT_HEADED=1)'}`);
    console.log(`⚡ Parallel runs: up to ${MAX_CONCURRENT_RUNS} at once (MAX_CONCURRENT_RUNS)`);
    console.log(`==================================================`);
});
