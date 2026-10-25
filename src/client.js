const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const config = require('./config');

/**
 * Custom error types for clear API status mapping
 */
class UpstreamError extends Error {
    constructor(message, statusCode = 502, details = null) {
        super(message);
        this.name = 'UpstreamError';
        this.statusCode = statusCode;
        this.details = details;
    }
}

class NotFoundError extends Error {
    constructor(message = 'Resource not found') {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

/**
 * Normalization helpers
 */
function parseFloatSafe(val, fallback = null) {
    if (val === null || val === undefined || val === '') return fallback;
    const num = Number(val);
    return isNaN(num) ? fallback : num;
}

function parseIntSafe(val, fallback = null) {
    if (val === null || val === undefined || val === '') return fallback;
    const num = parseInt(val, 10);
    return isNaN(num) ? fallback : num;
}

/**
 * Converts Indian portal date "DD/MM/YYYY HH:mm" to standard ISO 8601 string
 */
function parseIndianDateTimeToISO(str) {
    if (!str || typeof str !== 'string') return null;
    const match = str.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!match) return null;
    const [, day, month, year, hours, minutes] = match;
    // Construct ISO string (UTC assume or local utility time)
    return `${year}-${month}-${day}T${hours}:${minutes}:00.000Z`;
}

class UrjaPortalClient {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || config.urja.baseUrl).replace(/\/+$/, '');
        this.username = options.username || config.urja.username;
        this.password = options.password || config.urja.password;
        this.timeout = options.timeoutMs || config.urja.timeoutMs;
        this.cacheTtlMs = options.cacheTtlMs || config.cache.ttlMs;

        this.jar = new CookieJar();
        this.client = wrapper(axios.create({
            jar: this.jar,
            withCredentials: true,
            baseURL: this.baseUrl,
            timeout: this.timeout,
            headers: {
                'Origin': this.baseUrl,
                'Referer': `${this.baseUrl}/`,
                'User-Agent': 'FlockEnergy-API-Wrapper/1.0.0 (+https://flockenergy.tech)'
            },
            validateStatus: () => true // Handle statuses manually
        }));

        this.loginPromise = null; // Mutex to prevent multiple concurrent login requests
        this.cache = {
            exportData: null,
            exportTimestamp: 0,
            hierarchyData: null,
            hierarchyTimestamp: 0
        };
    }

    /**
     * Authenticate with Urja Meter Ops legacy portal
     */
    async login(force = false) {
        if (this.loginPromise && !force) {
            return this.loginPromise;
        }

        this.loginPromise = (async () => {
            try {
                const params = new URLSearchParams();
                params.append('email', this.username);
                params.append('password', this.password);

                const response = await this.client.post('/login', params.toString(), {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Origin': this.baseUrl,
                        'Referer': `${this.baseUrl}/login`
                    },
                    maxRedirects: 0
                });

                // SvelteKit returns 200 with JSON redirect or 303 redirect
                const isRedirect = response.status === 303 ||
                    (response.status === 200 && response.data && response.data.type === 'redirect');

                if (!isRedirect && response.status !== 200) {
                    throw new UpstreamError(
                        `Authentication failed with status ${response.status}: ${JSON.stringify(response.data)}`,
                        502
                    );
                }

                return true;
            } catch (err) {
                if (err instanceof UpstreamError) throw err;
                throw new UpstreamError(`Urja portal connection error during login: ${err.message}`, 504);
            } finally {
                this.loginPromise = null;
            }
        })();

        return this.loginPromise;
    }

    /**
     * Internal request wrapper with auto-reauthentication
     */
    async request(fn, retryOnAuth = true) {
        let response = await fn();

        // Check if unauthorized
        const isAuthError = response.status === 401 ||
            (response.data && response.data.error === 'unauthorized') ||
            (typeof response.data === 'string' && response.data.includes('Sign in') && !response.config?.url?.includes('/login'));

        if (isAuthError && retryOnAuth) {
            await this.login(true);
            response = await fn();
        }

        return response;
    }

    /**
     * Search and list meters with pagination & search
     */
    async getMeters({ q = '', page = 1, limit = 20, status = null, make = null, phase = null, dtCode = null } = {}) {
        const queryStr = q ? encodeURIComponent(q) : '';
        const pageNum = Math.max(1, parseIntSafe(page, 1));
        const limitNum = Math.min(100, Math.max(1, parseIntSafe(limit, 20)));

        // If filtering by specific attributes not natively filtered by search endpoint,
        // or if search query is provided:
        const response = await this.request(() => 
            this.client.get(`/portal/meters/search?q=${queryStr}&page=${pageNum}`, {
                headers: { 'Referer': `${this.baseUrl}/meters` }
            })
        );

        if (response.status !== 200) {
            throw new UpstreamError(`Failed to fetch meters from portal (${response.status})`, 502, response.data);
        }

        let rawList = response.data?.data || [];
        const totalEstimate = response.data?.total || rawList.length;

        // Apply filters if provided
        let filtered = rawList;
        if (status) {
            filtered = filtered.filter(m => (m.installStatus || '').toLowerCase() === status.toLowerCase());
        }
        if (make) {
            filtered = filtered.filter(m => (m.make || '').toLowerCase() === make.toLowerCase());
        }
        if (phase) {
            filtered = filtered.filter(m => (m.phaseType || '').toLowerCase() === phase.toLowerCase());
        }
        if (dtCode) {
            filtered = filtered.filter(m => (m.dtCode || '').toLowerCase() === dtCode.toLowerCase());
        }

        const normalizedMeters = filtered.map(m => ({
            meter_id: m.meterId,
            serial_number: m.serialNo,
            make: m.make,
            phase_type: m.phaseType,
            status: m.installStatus,
            transformer_code: m.dtCode
        }));

        return {
            page: pageNum,
            limit: limitNum,
            count: normalizedMeters.length,
            total: totalEstimate,
            data: normalizedMeters.slice(0, limitNum)
        };
    }

    /**
     * Fetch meter details by ID (parses HTML with Cheerio and combines with Geo API)
     */
    async getMeterDetails(meterId) {
        if (!meterId) {
            throw new NotFoundError('Meter ID is required');
        }

        const cleanMeterId = encodeURIComponent(meterId.trim());

        // 1. Fetch HTML page
        const htmlRes = await this.request(() =>
            this.client.get(`/meters/${cleanMeterId}`, {
                headers: { 'Referer': `${this.baseUrl}/meters` }
            })
        );

        if (htmlRes.status === 404 || (typeof htmlRes.data === 'string' && htmlRes.data.includes('404 Not Found'))) {
            throw new NotFoundError(`Meter with ID '${meterId}' not found`);
        }

        if (htmlRes.status !== 200) {
            throw new UpstreamError(`Failed to fetch meter details for '${meterId}' (${htmlRes.status})`, 502);
        }

        // Parse HTML with Cheerio
        const $ = cheerio.load(htmlRes.data);

        // Extract Nameplate details from <dl>
        const nameplate = {};
        $('dl dt').each((_, el) => {
            const key = $(el).text().trim().toLowerCase().replace(/[\s_]+/g, '_');
            const val = $(el).next('dd').text().trim();
            if (key) nameplate[key] = val;
        });

        // Extract breadcrumb hierarchy from <nav>
        const breadcrumbs = [];
        $('nav span').each((_, el) => {
            const text = $(el).text().trim();
            if (text && text !== '›') breadcrumbs.push(text);
        });

        // Map breadcrumbs into structured hierarchy
        const hierarchy = {
            zone: breadcrumbs[0] || null,
            circle: breadcrumbs[1] || null,
            division: breadcrumbs[2] || null,
            subdivision: breadcrumbs[3] || null,
            substation: breadcrumbs[4] || null,
            feeder: breadcrumbs[5] || null,
            transformer: breadcrumbs[6] || null
        };

        // 2. Fetch Geo Coordinates
        let geo = null;
        try {
            const geoRes = await this.request(() =>
                this.client.get(`/portal/meters/${cleanMeterId}/geo`, {
                    headers: { 'Referer': `${this.baseUrl}/meters/${cleanMeterId}` }
                })
            );
            if (geoRes.status === 200 && geoRes.data?.data) {
                geo = {
                    latitude: parseFloatSafe(geoRes.data.data.latitude),
                    longitude: parseFloatSafe(geoRes.data.data.longitude)
                };
            }
        } catch (err) {
            // Geo is optional/fallback
            geo = null;
        }

        return {
            meter_id: nameplate.meter_id || meterId,
            serial_number: nameplate.serial_no || null,
            make: nameplate.make || null,
            phase_type: nameplate.phase_type || null,
            status: nameplate.installation_status || null,
            installation_type: nameplate.installation_type || null,
            location: geo,
            hierarchy
        };
    }

    /**
     * Fetch and normalize meter consumption readings
     */
    async getMeterConsumption(meterId) {
        if (!meterId) {
            throw new NotFoundError('Meter ID is required');
        }

        const cleanMeterId = encodeURIComponent(meterId.trim());

        const response = await this.request(() =>
            this.client.get(`/portal/meters/${cleanMeterId}/energy`, {
                headers: { 'Referer': `${this.baseUrl}/meters/${cleanMeterId}` }
            })
        );

        if (response.status === 404) {
            throw new NotFoundError(`Meter with ID '${meterId}' not found`);
        }

        if (response.status !== 200) {
            throw new UpstreamError(`Failed to fetch consumption history (${response.status})`, 502, response.data);
        }

        const rawData = response.data?.data || [];

        // Normalize time-series records:
        // Convert string numeric values to floats and parse timestamps
        const readings = rawData.map(r => {
            const iso = parseIndianDateTimeToISO(r.timestamp);
            return {
                timestamp_raw: r.timestamp,
                timestamp: iso,
                epoch_ms: iso ? new Date(iso).getTime() : null,
                kwh: parseFloatSafe(r.kwh, 0.0),
                kvah: parseFloatSafe(r.kvah, 0.0),
                voltage_r: parseFloatSafe(r.voltR, 0.0)
            };
        });

        // Compute summary metrics
        let totalKwh = 0;
        let totalKvah = 0;
        let minVoltage = Infinity;
        let maxVoltage = -Infinity;
        let sumVoltage = 0;

        readings.forEach(r => {
            totalKwh = Math.max(totalKwh, r.kwh);
            totalKvah = Math.max(totalKvah, r.kvah);
            if (r.voltage_r > 0) {
                minVoltage = Math.min(minVoltage, r.voltage_r);
                maxVoltage = Math.max(maxVoltage, r.voltage_r);
                sumVoltage += r.voltage_r;
            }
        });

        const avgVoltage = readings.length > 0 && minVoltage !== Infinity
            ? Math.round((sumVoltage / readings.length) * 100) / 100
            : null;

        return {
            meter_id: meterId,
            readings_count: readings.length,
            summary: {
                latest_reading_kwh: readings.length > 0 ? readings[readings.length - 1].kwh : null,
                latest_reading_kvah: readings.length > 0 ? readings[readings.length - 1].kvah : null,
                min_voltage: minVoltage !== Infinity ? minVoltage : null,
                max_voltage: maxVoltage !== -Infinity ? maxVoltage : null,
                avg_voltage: avgVoltage
            },
            readings
        };
    }

    /**
     * Retrieve full bulk export of all meters with HMAC SHA-256 signature
     */
    async exportAllMeters(useCache = true) {
        const now = Date.now();
        if (useCache && this.cache.exportData && (now - this.cache.exportTimestamp < this.cacheTtlMs)) {
            return this.cache.exportData;
        }

        // 1. Fetch signing key
        const keyRes = await this.request(() =>
            this.client.get('/portal/keys', {
                headers: { 'Referer': `${this.baseUrl}/transformers` }
            })
        );

        if (keyRes.status !== 200 || !keyRes.data?.data?.signingSecret) {
            throw new UpstreamError(`Failed to retrieve signing key for export (${keyRes.status})`, 502);
        }

        const signingSecret = keyRes.data.data.signingSecret;

        // 2. Compute HMAC SHA-256 signature
        const method = 'GET';
        const path = '/portal/export';
        const query = 'page=1';
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payloadToSign = [method, path, query, timestamp].join('\n');
        const signature = crypto.createHmac('sha256', signingSecret).update(payloadToSign).digest('hex');

        // 3. Request export data
        const exportRes = await this.request(() =>
            this.client.get(`/portal/export?${query}`, {
                headers: {
                    'Referer': `${this.baseUrl}/transformers`,
                    'x-timestamp': timestamp,
                    'x-signature': signature
                }
            })
        );

        if (exportRes.status !== 200) {
            throw new UpstreamError(`Export failed (${exportRes.status}): ${JSON.stringify(exportRes.data)}`, 502);
        }

        const rawMeters = exportRes.data?.data || [];
        const normalized = rawMeters.map(m => ({
            meter_id: m.meterId,
            serial_number: m.serialNo,
            make: m.make,
            phase_type: m.phaseType,
            status: m.installStatus,
            installation_type: m.installType,
            build: m.build,
            transformer_code: m.dtCode,
            location: m.geo ? {
                latitude: parseFloatSafe(m.geo.lat),
                longitude: parseFloatSafe(m.geo.lng)
            } : null,
            hierarchy: m.hierarchy ? {
                zone: m.hierarchy.zone ? `${m.hierarchy.zone.name} (${m.hierarchy.zone.code})` : null,
                circle: m.hierarchy.circle ? `${m.hierarchy.circle.name} (${m.hierarchy.circle.code})` : null,
                division: m.hierarchy.division ? `${m.hierarchy.division.name} (${m.hierarchy.division.code})` : null,
                subdivision: m.hierarchy.subdivision ? `${m.hierarchy.subdivision.name} (${m.hierarchy.subdivision.code})` : null,
                substation: m.hierarchy.substation ? `${m.hierarchy.substation.name} (${m.hierarchy.substation.code})` : null,
                feeder: m.hierarchy.feeder ? `${m.hierarchy.feeder.name} (${m.hierarchy.feeder.code})` : null,
                transformer: m.hierarchy.dt ? `${m.hierarchy.dt.name} (${m.hierarchy.dt.code})` : null
            } : null
        }));

        this.cache.exportData = {
            total: exportRes.data.total || normalized.length,
            meters: normalized
        };
        this.cache.exportTimestamp = now;

        return this.cache.exportData;
    }

    /**
     * List Distribution Transformers (DTs)
     */
    async getTransformers(page = 1) {
        const pageNum = Math.max(1, parseIntSafe(page, 1));
        const response = await this.request(() =>
            this.client.get(`/portal/dts?page=${pageNum}`, {
                headers: { 'Referer': `${this.baseUrl}/transformers` }
            })
        );

        if (response.status !== 200) {
            throw new UpstreamError(`Failed to fetch transformers (${response.status})`, 502);
        }

        const rawList = response.data?.data || [];
        const normalized = rawList.map(dt => ({
            code: dt.code,
            name: dt.name,
            feeder_code: dt.feederCode,
            capacity_kva: parseFloatSafe(dt.capacityKva)
        }));

        return {
            page: pageNum,
            total: response.data?.total || normalized.length,
            count: normalized.length,
            data: normalized
        };
    }

    /**
     * Build and return hierarchical distribution network tree
     */
    async getHierarchy(useCache = true) {
        const now = Date.now();
        if (useCache && this.cache.hierarchyData && (now - this.cache.hierarchyTimestamp < this.cacheTtlMs)) {
            return this.cache.hierarchyData;
        }

        // Get all meters from bulk export
        const exportData = await this.exportAllMeters(useCache);
        const meters = exportData.meters;

        // Construct tree: Zone -> Circle -> Division -> Subdivision -> Substation -> Feeder -> DT -> Meters
        const tree = {};

        meters.forEach(meter => {
            const h = meter.hierarchy || {};
            const zone = h.zone || 'Unknown Zone';
            const circle = h.circle || 'Unknown Circle';
            const division = h.division || 'Unknown Division';
            const subdivision = h.subdivision || 'Unknown Subdivision';
            const substation = h.substation || 'Unknown Substation';
            const feeder = h.feeder || 'Unknown Feeder';
            const dt = h.transformer || 'Unknown DT';

            if (!tree[zone]) tree[zone] = {};
            if (!tree[zone][circle]) tree[zone][circle] = {};
            if (!tree[zone][circle][division]) tree[zone][circle][division] = {};
            if (!tree[zone][circle][division][subdivision]) tree[zone][circle][division][subdivision] = {};
            if (!tree[zone][circle][division][subdivision][substation]) tree[zone][circle][division][subdivision][substation] = {};
            if (!tree[zone][circle][division][subdivision][substation][feeder]) tree[zone][circle][division][subdivision][substation][feeder] = {};
            if (!tree[zone][circle][division][subdivision][substation][feeder][dt]) {
                tree[zone][circle][division][subdivision][substation][feeder][dt] = [];
            }

            tree[zone][circle][division][subdivision][substation][feeder][dt].push({
                meter_id: meter.meter_id,
                serial_number: meter.serial_number,
                status: meter.status,
                make: meter.make,
                phase_type: meter.phase_type
            });
        });

        const result = {
            network: 'Urja Electricity Distribution Network',
            total_meters_indexed: meters.length,
            tree
        };

        this.cache.hierarchyData = result;
        this.cache.hierarchyTimestamp = now;

        return result;
    }

    /**
     * Health check verifying upstream portal responsiveness
     */
    async checkHealth() {
        try {
            const start = Date.now();
            const res = await this.client.get('/', { timeout: 5000 });
            const latency = Date.now() - start;
            return {
                reachable: res.status === 200,
                status_code: res.status,
                latency_ms: latency
            };
        } catch (err) {
            return {
                reachable: false,
                error: err.message
            };
        }
    }
}

module.exports = {
    UrjaPortalClient,
    UpstreamError,
    NotFoundError
};
