require('dotenv').config({ path: require('path').join(__dirname, '.env') });

module.exports = {
    apps: [
        {
            name: 'misa-dashboard',
            script: 'server.js',
            cwd: __dirname,
            instances: 1,
            autorestart: true,          // restart if it crashes
            watch: false,               // don't watch files (Playwright spawns its own)
            max_memory_restart: '500M', // restart if memory exceeds 500 MB
            env: {
                NODE_ENV: 'production',
                PRODUCTION_MODE: '1',
                PLAYWRIGHT_HEADLESS: '1',
                MAX_CONCURRENT_RUNS: process.env.MAX_CONCURRENT_RUNS || '3',
                PORT: 3050,
                RUN_AI_FALLBACK: process.env.RUN_AI_FALLBACK || '',
                OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
                AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL || 'gpt-4o',
                AI_FALLBACK_MAX_TURNS: process.env.AI_FALLBACK_MAX_TURNS || '12',
            },
            // Keep last 30 days of logs
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            out_file: './logs/dashboard-out.log',
            error_file: './logs/dashboard-err.log',
            merge_logs: false
        }
    ]
};
