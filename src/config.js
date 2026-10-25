require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    urja: {
        baseUrl: (process.env.URJA_PORTAL_URL || 'https://urja-ops.flockenergy.tech').replace(/\/+$/, ''),
        username: process.env.URJA_USERNAME || 'operator@urja.local',
        password: process.env.URJA_PASSWORD || 'urja-ops-2026',
        timeoutMs: parseInt(process.env.URJA_TIMEOUT_MS || '15000', 10)
    },
    cache: {
        ttlMs: parseInt(process.env.CACHE_TTL_MS || '60000', 10) // 1 minute default cache
    }
};

module.exports = config;
