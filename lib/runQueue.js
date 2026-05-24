/**
 * Parallel run queue — multiple clients at once (no visible browser in production).
 */

const MAX_CONCURRENT_RUNS = Math.max(
    1,
    parseInt(process.env.MAX_CONCURRENT_RUNS || '3', 10)
);

/** @type {Array<{ job: object, configFileName: string, streamRes: import('http').ServerResponse|null, start: Function }>} */
const waitQueue = [];

function countRunning(jobs) {
    return [...jobs.values()].filter((j) => j.phase === 'running').length;
}

function queuePositionFor(runId) {
    const idx = waitQueue.findIndex((w) => w.job.runId === runId);
    return idx === -1 ? 0 : idx + 1;
}

/**
 * Start immediately or enqueue.
 * @param {Map} jobs
 * @param {object} job
 * @param {string} configFileName
 * @param {import('http').ServerResponse|null} streamRes
 * @param {(job: object, configFileName: string, streamRes: object|null) => void} startPlaywright
 */
function scheduleRun(jobs, job, configFileName, streamRes, startPlaywright) {
    if (countRunning(jobs) < MAX_CONCURRENT_RUNS) {
        job.phase = 'running';
        job.running = true;
        startPlaywright(job, configFileName, streamRes);
        return { phase: 'running', queuePosition: 0, maxConcurrentRuns: MAX_CONCURRENT_RUNS };
    }

    job.phase = 'queued';
    job.running = false;
    waitQueue.push({ job, configFileName, streamRes, start: startPlaywright });
    const queuePosition = waitQueue.length;
    console.log(`[QUEUE] Run ${job.runId} (${job.clientId || 'no-client-id'}) queued — position ${queuePosition}`);
    return { phase: 'queued', queuePosition, maxConcurrentRuns: MAX_CONCURRENT_RUNS };
}

/**
 * @param {Map} jobs
 * @param {(job: object, configFileName: string, streamRes: object|null) => void} startPlaywright
 */
function drainQueue(jobs, startPlaywright) {
    while (waitQueue.length > 0 && countRunning(jobs) < MAX_CONCURRENT_RUNS) {
        const next = waitQueue.shift();
        next.job.phase = 'running';
        next.job.running = true;
        console.log(`[QUEUE] Starting queued run ${next.job.runId} (${next.job.clientId || ''})`);
        startPlaywright(next.job, next.configFileName, next.streamRes);
    }
}

function getQueueStats(jobs) {
    return {
        maxConcurrentRuns: MAX_CONCURRENT_RUNS,
        activeRuns: countRunning(jobs),
        queuedRuns: waitQueue.length,
    };
}

module.exports = {
    MAX_CONCURRENT_RUNS,
    scheduleRun,
    drainQueue,
    countRunning,
    queuePositionFor,
    getQueueStats,
};
