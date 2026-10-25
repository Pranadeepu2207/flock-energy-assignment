const { app } = require('../src/app');
const http = require('http');

let server;
const PORT = 3099; // Test port

async function request(path) {
    const res = await fetch(`http://localhost:${PORT}${path}`);
    const contentType = res.headers.get('content-type') || '';
    let body;
    if (contentType.includes('application/json')) {
        body = await res.json();
    } else {
        body = await res.text();
    }
    return { status: res.status, headers: res.headers, body };
}

async function runTests() {
    console.log('🧪 Starting End-to-End API Verification Suite...');
    
    // Start test server
    await new Promise((resolve) => {
        server = app.listen(PORT, resolve);
    });
    console.log(`📡 Test server running on http://localhost:${PORT}\n`);

    let passed = 0;
    let failed = 0;

    async function check(name, fn) {
        try {
            process.stdout.write(`Testing ${name}... `);
            await fn();
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log('❌ FAIL:', err.message);
            failed++;
        }
    }

    try {
        // 1. Health
        await check('GET /health', async () => {
            const res = await request('/health');
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (res.body.status !== 'healthy') throw new Error(`Expected status 'healthy'`);
            if (!res.body.upstream_portal.reachable) throw new Error('Upstream portal not reachable');
        });

        // 2. Meters list
        let sampleMeterId = 'J100000';
        await check('GET /api/v1/meters', async () => {
            const res = await request('/api/v1/meters?limit=5');
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (!Array.isArray(res.body.data) || res.body.data.length === 0) throw new Error('Expected meters array');
            sampleMeterId = res.body.data[0].meter_id;
            const meter = res.body.data[0];
            if (!meter.meter_id || !meter.serial_number || !meter.status) {
                throw new Error('Meter object missing required fields');
            }
        });

        // 3. Meters filtering
        await check('GET /api/v1/meters?status=Installed', async () => {
            const res = await request('/api/v1/meters?status=Installed&limit=5');
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (!res.body.data.every(m => m.status.toLowerCase() === 'installed')) {
                throw new Error('Filter by status failed');
            }
        });

        // 4. Meter detail
        await check(`GET /api/v1/meters/${sampleMeterId}`, async () => {
            const res = await request(`/api/v1/meters/${sampleMeterId}`);
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (res.body.meter_id !== sampleMeterId) throw new Error(`Mismatched meter_id`);
            if (!res.body.hierarchy || !res.body.hierarchy.zone) throw new Error('Missing hierarchy');
            if (!res.body.location || typeof res.body.location.latitude !== 'number') {
                throw new Error('Missing or non-numeric geo coordinates');
            }
        });

        // 5. Meter consumption
        await check(`GET /api/v1/meters/${sampleMeterId}/consumption`, async () => {
            const res = await request(`/api/v1/meters/${sampleMeterId}/consumption`);
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (res.body.meter_id !== sampleMeterId) throw new Error(`Mismatched meter_id`);
            if (!Array.isArray(res.body.readings) || res.body.readings.length === 0) {
                throw new Error('Expected non-empty readings array');
            }
            const r = res.body.readings[0];
            if (typeof r.kwh !== 'number' || typeof r.voltage_r !== 'number') {
                throw new Error('Telemetry numbers not properly normalized to numbers');
            }
            if (!r.timestamp || !r.timestamp.includes('T')) {
                throw new Error('Timestamp not normalized to ISO-8601');
            }
        });

        // 6. Hierarchy tree
        await check('GET /api/v1/hierarchy', async () => {
            const res = await request('/api/v1/hierarchy');
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (!res.body.tree || typeof res.body.tree !== 'object') throw new Error('Missing tree');
            if (res.body.total_meters_indexed < 100) throw new Error('Hierarchy tree indexed fewer meters than expected');
        });

        // 7. Transformers
        await check('GET /api/v1/transformers', async () => {
            const res = await request('/api/v1/transformers');
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (!Array.isArray(res.body.data) || res.body.data.length === 0) throw new Error('Expected transformers array');
        });

        // 8. Nearby spatial query extension
        await check('GET /api/v1/meters/nearby', async () => {
            const res = await request('/api/v1/meters/nearby?lat=26.9389&lng=75.8309&radius_km=15');
            if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
            if (!Array.isArray(res.body.meters) || res.body.meters.length === 0) throw new Error('Expected nearby meters');
            if (typeof res.body.meters[0].distance_km !== 'number') throw new Error('Missing distance_km float');
        });

        // 9. 404 Not Found error handling
        await check('GET /api/v1/meters/NON_EXISTENT_ID (404 handling)', async () => {
            const res = await request('/api/v1/meters/NON_EXISTENT_ID');
            if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`);
            if (res.body.status !== 404 || !res.body.message.includes('not found')) {
                throw new Error('Expected 404 JSON error format');
            }
        });

        // 10. OpenAPI & Docs
        await check('GET /openapi.json & GET /docs', async () => {
            const specRes = await request('/openapi.json');
            if (specRes.status !== 200 || specRes.body.openapi !== '3.0.3') throw new Error('Invalid openapi.json');
            const docsRes = await request('/docs/');
            if (docsRes.status !== 200 || !docsRes.body.includes('swagger')) throw new Error('Swagger UI not rendering');
        });

        console.log(`\n========================================`);
        console.log(`🏁 Test Summary: ${passed} Passed, ${failed} Failed`);
        console.log(`========================================`);

        if (failed > 0) {
            process.exit(1);
        }
    } finally {
        server.close();
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    if (server) server.close();
    process.exit(1);
});
