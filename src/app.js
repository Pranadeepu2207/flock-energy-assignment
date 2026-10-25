const express = require('express');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');
const { UrjaPortalClient, NotFoundError, UpstreamError } = require('./client');
const config = require('./config');

const app = express();
const client = new UrjaPortalClient();

// Load OpenAPI specification
const openapiPath = path.join(__dirname, '..', 'openapi.json');
const openapiDocument = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));

// Middleware
app.use(express.json());

// CORS & Security headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Simple request logger
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    });
    next();
});

// Swagger Documentation at /docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiDocument, {
    customSiteTitle: 'Urja Meter Ops API — Swagger UI',
    customCss: '.swagger-ui .topbar { display: none }'
}));

// Raw OpenAPI JSON spec endpoint
app.get('/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(openapiPath);
});

// Health check endpoint
const startTime = Date.now();
app.get('/health', async (req, res, next) => {
    try {
        const upstream = await client.checkHealth();
        const uptimeSeconds = Math.round((Date.now() - startTime) / 1000);

        const health = {
            status: upstream.reachable ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime_seconds: uptimeSeconds,
            upstream_portal: {
                target_url: config.urja.baseUrl,
                reachable: upstream.reachable,
                status_code: upstream.status_code || null,
                latency_ms: upstream.latency_ms || null,
                error: upstream.error || null
            }
        };

        res.status(upstream.reachable ? 200 : 503).json(health);
    } catch (err) {
        next(err);
    }
});

/**
 * REST API Routes under /api/v1
 */

// GET /api/v1/meters - List & search meters
app.get('/api/v1/meters', async (req, res, next) => {
    try {
        const { q, page, limit, status, make, phase, dtCode } = req.query;
        const result = await client.getMeters({ q, page, limit, status, make, phase, dtCode });
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// GET /api/v1/meters/nearby - Local spatial query layer extension
app.get('/api/v1/meters/nearby', async (req, res, next) => {
    try {
        const { lat, lng, radius_km } = req.query;
        if (!lat || !lng) {
            return res.status(400).json({
                status: 400,
                error: 'Bad Request',
                message: "Query parameters 'lat' and 'lng' are required.",
                timestamp: new Date().toISOString()
            });
        }

        const centerLat = parseFloat(lat);
        const centerLng = parseFloat(lng);
        const maxDist = parseFloat(radius_km || '5.0');

        // Haversine formula
        function getDistanceKm(lat1, lon1, lat2, lon2) {
            const R = 6371; // Earth's radius in km
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a =
                Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }

        const exportData = await client.exportAllMeters();
        const nearby = [];

        exportData.meters.forEach(m => {
            if (m.location && m.location.latitude && m.location.longitude) {
                const dist = getDistanceKm(centerLat, centerLng, m.location.latitude, m.location.longitude);
                if (dist <= maxDist) {
                    nearby.push({
                        ...m,
                        distance_km: Math.round(dist * 1000) / 1000
                    });
                }
            }
        });

        // Sort by distance ascending
        nearby.sort((a, b) => a.distance_km - b.distance_km);

        res.json({
            center: { latitude: centerLat, longitude: centerLng },
            radius_km: maxDist,
            count: nearby.length,
            meters: nearby
        });
    } catch (err) {
        next(err);
    }
});

// GET /api/v1/meters/:id - Single meter details
app.get('/api/v1/meters/:id', async (req, res, next) => {
    try {
        const meter = await client.getMeterDetails(req.params.id);
        res.json(meter);
    } catch (err) {
        next(err);
    }
});

// GET /api/v1/meters/:id/consumption - Meter consumption readings
app.get('/api/v1/meters/:id/consumption', async (req, res, next) => {
    try {
        const consumption = await client.getMeterConsumption(req.params.id);
        res.json(consumption);
    } catch (err) {
        next(err);
    }
});

// GET /api/v1/hierarchy - Full grid hierarchy tree
app.get('/api/v1/hierarchy', async (req, res, next) => {
    try {
        const hierarchy = await client.getHierarchy();
        res.json(hierarchy);
    } catch (err) {
        next(err);
    }
});

// GET /api/v1/transformers - List distribution transformers
app.get('/api/v1/transformers', async (req, res, next) => {
    try {
        const transformers = await client.getTransformers(req.query.page);
        res.json(transformers);
    } catch (err) {
        next(err);
    }
});

// GET /api/v1/export - Full dataset bulk export
app.get('/api/v1/export', async (req, res, next) => {
    try {
        const bulk = await client.exportAllMeters();
        res.json(bulk);
    } catch (err) {
        next(err);
    }
});

// Root route redirect to docs
app.get('/', (req, res) => {
    res.redirect('/docs');
});

// 404 handler for unknown routes
app.use((req, res) => {
    res.status(404).json({
        status: 404,
        error: 'Not Found',
        message: `Endpoint ${req.method} ${req.originalUrl} does not exist. Explore interactive docs at /docs.`,
        timestamp: new Date().toISOString()
    });
});

// Global error handler
app.use((err, req, res, next) => {
    const statusCode = err.statusCode || 500;
    const errorType = err.name || 'InternalServerError';

    console.error(`[Error] ${statusCode} ${errorType}: ${err.message}`);

    res.status(statusCode).json({
        status: statusCode,
        error: errorType,
        message: err.message,
        details: err.details || null,
        timestamp: new Date().toISOString()
    });
});

module.exports = { app, client };
