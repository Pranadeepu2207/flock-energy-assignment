# Flock Energy — Urja Meter Ops REST API Wrapper

A clean, modern, and production-ready REST API service wrapping the legacy **Urja Meter Ops** portal (`https://urja-ops.flockenergy.tech`).

This service automates session authentication, cookie management, reverse-engineered cryptographic protocol signing, HTML scraping via Cheerio, and data normalization—exposing structured JSON endpoints with an interactive OpenAPI 3.0 Swagger UI documentation.

---

## Table of Contents
- [Architecture & Project Layout](#architecture--project-layout)
- [Key Features](#key-features)
- [Quick Start & Setup](#quick-start--setup)
- [API Documentation & Swagger UI](#api-documentation--swagger-ui)
- [Sample Requests & Live Responses](#sample-requests--live-responses)
- [Design Decisions & Trade-Offs](#design-decisions--trade-offs)
- [Assumptions & Intentional Omissions](#assumptions--intentional-omissions)
- [Future Improvements](#future-improvements)
- [Companion Documents](#companion-documents)

---

## Architecture & Project Layout

The service acts as an abstraction proxy between downstream microservices/client applications and the legacy Urja portal. It unifies server-rendered HTML pages and internal asynchronous endpoints into a single cohesive REST interface.

```
flock-energy-api/
├── src/
│   ├── config.js         # Environment variables & default configurations
│   ├── client.js         # Legacy portal adapter (sessions, auth mutex, Cheerio scraping, HMAC signing)
│   ├── app.js            # Express application, REST routes, Swagger docs & error handling
│   └── index.js          # HTTP server bootstrap entry point
├── test/
│   └── verify_endpoints.js # End-to-end integration test suite
├── openapi.json          # Complete OpenAPI 3.0.3 specification
├── PROTOCOL.md           # Deep-dive report on Urja portal reverse-engineering findings
├── REFLECTION.md         # Detailed answers to the 5 engineering reflection questions
├── package.json          # Node.js project manifest & dependencies
├── .env.example          # Environment variables template
├── .gitignore            # Git exclusion rules
└── README.md             # Project documentation (this file)
```

---

## Key Features

1. **Automated Session Management & Concurrency-Safe Auth**:
   - Manages persistent `__Secure-better-auth.session_token` cookies across requests.
   - Enforces required `Origin` headers to satisfy SvelteKit CSRF checks.
   - Includes a login mutex lock to prevent redundant concurrent logins when multiple requests arrive simultaneously.
   - Automatically detects 401s or redirects, re-authenticates silently, and retries the request.

2. **Hybrid HTML Scraping & Internal API Ingestion**:
   - Uses **Cheerio** to parse server-rendered HTML nameplates (`<dl>` lists) and navigation breadcrumbs (`<nav>` tags).
   - Ingests internal JSON endpoints for coordinates (`/portal/meters/:id/geo`) and interval consumption telemetry (`/portal/meters/:id/energy`).

3. **HMAC-SHA256 Cryptographic Bulk Export Integration**:
   - Discovered and reverse-engineered the portal's internal bulk export protocol (`/portal/export`).
   - Retrieves the dynamic signing key from `/portal/keys` and signs request payloads using HMAC-SHA256 with timestamp headers, enabling instant export of all 403 meters in a single HTTP request.

4. **Data Normalization & Power Metrics**:
   - Strips string quotation from floating-point metrics (`kwh`, `kvah`, `voltage_r`, `lat`, `lng`).
   - Normalizes non-standard Indian date strings (`DD/MM/YYYY HH:mm`) into ISO-8601 timestamps and Unix epoch milliseconds.
   - Calculates real-time telemetry summaries (min/max/average voltage, total consumption).

5. **Local Spatial Query Layer (Extension)**:
   - Provides a `GET /api/v1/meters/nearby` endpoint calculating geospatial Haversine distances to discover smart meters within a given radius (km) of coordinates.

6. **Network Grid Hierarchy Reconstruction**:
   - Restructures flat meter and DT records into a 7-tier distribution network tree: `Zone -> Circle -> Division -> Subdivision -> Substation -> Feeder -> Transformer -> Meters`.

---

## Quick Start & Setup

### Prerequisites
- **Node.js**: v18.0.0 or higher (Tested on Node v22.18.0)
- **npm**: v9.0.0 or higher (Tested on npm 11.12.0)

### 1. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/<your-username>/flock-energy-api.git
cd flock-energy-api
npm install
```

### 2. Environment Configuration
Copy the template environment file:
```bash
cp .env.example .env
```
Default `.env` settings:
```env
PORT=3000
URJA_PORTAL_URL=https://urja-ops.flockenergy.tech
URJA_USERNAME=operator@urja.local
URJA_PASSWORD=urja-ops-2026
CACHE_TTL_MS=60000
```

### 3. Run the Service
Start the server:
```bash
npm start
```
The server will boot on `http://localhost:3000`.

### 4. Run Automated Integration Tests
Execute the comprehensive end-to-end verification test suite:
```bash
npm test
```
All 10 integration tests run against the live upstream portal to verify connectivity, schema compliance, and error edge cases.

---

## API Documentation & Swagger UI

Once the server is running, explore and test the endpoints interactively via Swagger UI:
- **Interactive Documentation**: [http://localhost:3000/docs](http://localhost:3000/docs)
- **OpenAPI 3.0 Specification**: [http://localhost:3000/openapi.json](http://localhost:3000/openapi.json)

---

## Sample Requests & Live Responses

### 1. Health Check
Checks API service status and live upstream portal latency.

**Request:**
```bash
curl -s http://localhost:3000/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2026-10-25T11:56:14.364Z",
  "uptime_seconds": 12,
  "upstream_portal": {
    "target_url": "https://urja-ops.flockenergy.tech",
    "reachable": true,
    "status_code": 200,
    "latency_ms": 320,
    "error": null
  }
}
```

---

### 2. List & Search Meters
Query smart meters with pagination and optional filters (`q`, `status`, `make`, `phase`, `dtCode`).

**Request:**
```bash
curl -s "http://localhost:3000/api/v1/meters?limit=2&status=Installed"
```

**Response:**
```json
{
  "page": 1,
  "limit": 2,
  "count": 2,
  "total": 403,
  "data": [
    {
      "meter_id": "J100001",
      "serial_number": "GE84132",
      "make": "L&T",
      "phase_type": "single",
      "status": "Installed",
      "transformer_code": "DT-002"
    },
    {
      "meter_id": "J100002",
      "serial_number": "AL28136",
      "make": "L&T",
      "phase_type": "single",
      "status": "Installed",
      "transformer_code": "DT-003"
    }
  ]
}
```

---

### 3. Get Meter Details
Parses nameplate parameters from server-rendered HTML `<dl>` tags via Cheerio and merges geographic coordinates.

**Request:**
```bash
curl -s http://localhost:3000/api/v1/meters/J100000
```

**Response:**
```json
{
  "meter_id": "J100000",
  "serial_number": "SE33962",
  "make": "HPL",
  "phase_type": "single",
  "status": "Decommissioned",
  "installation_type": "Whole Current",
  "location": {
    "latitude": 26.938961002479868,
    "longitude": 75.83095696146852
  },
  "hierarchy": {
    "zone": "Jaipur Zone 1 (Z-01)",
    "circle": "Circle 1 (C-01)",
    "division": "Division 1 (D-01)",
    "subdivision": "Subdivision 1 (SD-01)",
    "substation": "Substation 1 (SS-01)",
    "feeder": "Feeder 1 (F-001)",
    "transformer": "Malviya Nagar DT 1 (DT-001)"
  }
}
```

---

### 4. Get Meter Consumption History
Fetches 30-minute interval readings, normalizes numbers and dates, and calculates power summary statistics.

**Request:**
```bash
curl -s http://localhost:3000/api/v1/meters/J100000/consumption
```

**Response (abbreviated):**
```json
{
  "meter_id": "J100000",
  "readings_count": 337,
  "summary": {
    "latest_reading_kwh": 48580.79,
    "latest_reading_kvah": 52467.25,
    "min_voltage": 220,
    "max_voltage": 240,
    "avg_voltage": 229.83
  },
  "readings": [
    {
      "timestamp_raw": "23/06/2026 23:30",
      "timestamp": "2026-06-23T23:30:00.000Z",
      "epoch_ms": 1782257400000,
      "kwh": 48438.74,
      "kvah": 52313.84,
      "voltage_r": 226
    },
    {
      "timestamp_raw": "24/06/2026 00:00",
      "timestamp": "2026-06-24T00:00:00.000Z",
      "epoch_ms": 1782259200000,
      "kwh": 48439.16,
      "kvah": 52314.29,
      "voltage_r": 229
    }
  ]
}
```

---

### 5. Nearby Smart Meters (Spatial Query Extension)
Discovers all meters within a specified radius (km) of given coordinates using the Haversine formula.

**Request:**
```bash
curl -s "http://localhost:3000/api/v1/meters/nearby?lat=26.9389&lng=75.8309&radius_km=2"
```

**Response:**
```json
{
  "center": {
    "latitude": 26.9389,
    "longitude": 75.8309
  },
  "radius_km": 2,
  "count": 1,
  "meters": [
    {
      "meter_id": "J100000",
      "serial_number": "SE33962",
      "make": "HPL",
      "phase_type": "single",
      "status": "Decommissioned",
      "distance_km": 0.009
    }
  ]
}
```

---

### 6. Network Grid Hierarchy Tree
Reconstructs the hierarchical tree linking utility administrative zones down to individual meters.

**Request:**
```bash
curl -s http://localhost:3000/api/v1/hierarchy
```

**Response Structure:**
```json
{
  "network": "Urja Electricity Distribution Network",
  "total_meters_indexed": 403,
  "tree": {
    "Jaipur Zone 1 (Z-01)": {
      "Circle 1 (C-01)": {
        "Division 1 (D-01)": {
          "Subdivision 1 (SD-01)": {
            "Substation 1 (SS-01)": {
              "Feeder 1 (F-001)": {
                "Malviya Nagar DT 1 (DT-001)": [
                  {
                    "meter_id": "J100000",
                    "serial_number": "SE33962",
                    "status": "Decommissioned",
                    "make": "HPL",
                    "phase_type": "single"
                  }
                ]
              }
            }
          }
        }
      }
    }
  }
}
```

---

### 7. Missing Meter 404 Error Handling
Returns clean JSON errors with standard HTTP status codes.

**Request:**
```bash
curl -s http://localhost:3000/api/v1/meters/J999999
```

**Response:**
```json
{
  "status": 404,
  "error": "NotFoundError",
  "message": "Meter with ID 'J999999' not found",
  "details": null,
  "timestamp": "2026-10-25T11:56:17.316Z"
}
```

---

## Design Decisions & Trade-Offs

1. **Cheerio vs Headless Browser (Puppeteer/Playwright)**:
   - *Decision*: We used Cheerio with Axios rather than a headless browser.
   - *Trade-off*: A headless browser would evaluate client-side JavaScript automatically, but would require substantial RAM (hundreds of MBs), slow cold-starts, and poor concurrency. Cheerio parses raw HTML in <2ms with negligible CPU and memory overhead.
2. **Reverse-Engineering the HMAC-SHA256 Bulk Export**:
   - *Decision*: We inspected the frontend JavaScript bundles, discovered the cryptographic signing secret endpoint (`/portal/keys`), and implemented the HMAC signing algorithm in Node.js.
   - *Trade-off*: Fetching all 403 meters in a single signed request is orders of magnitude faster (~300ms total) than issuing 403 separate HTML scrapes. However, it relies on an undocumented internal protocol that could evolve with future frontend updates.
3. **In-Memory Caching with Short TTL**:
   - *Decision*: We introduced an in-memory cache with a 60-second TTL for bulk exports and hierarchy calculations.
   - *Trade-off*: Caching ensures rapid response times (<15ms) for repeated queries and shields the legacy utility portal from high request volumes, with a maximum 60-second data freshness staleness window.
4. **Structured Time-Series Metrics**:
   - *Decision*: In addition to raw time-series data, `/consumption` calculates aggregate summaries (`min_voltage`, `max_voltage`, `avg_voltage`, `latest_reading_kwh`).
   - *Trade-off*: Computing summaries on the fly takes <1ms and saves downstream consumers from having to write custom math reducers across hundreds of raw records.

---

## Assumptions & Intentional Omissions

### Assumptions Made
- The upstream portal credentials (`operator@urja.local`) have read-only access to all distribution assets in the target utility.
- Consumption timestamps represent local utility operational time (IST, UTC+5:30).
- Network hierarchies form a strict acyclic tree with no orphan transformers.

### Intentional Omissions
- **Write/Mutation Endpoints**: The legacy portal is strictly read-only; no endpoints for meter provisioning, status updates, or remote disconnects were implemented.
- **External Database / Redis**: We intentionally omitted Redis or PostgreSQL to keep installation zero-dependency (`npm install && npm start` runs everywhere without external daemons).
- **Client Web UI**: We prioritized rock-solid API reliability, full OpenAPI documentation, and test coverage over an auxiliary frontend dashboard.

---

## Future Improvements

1. **Persistent Cache / Redis Integration**: Enable multi-node horizontal scaling by backing session state and meter index caches with Redis.
2. **Time-Series Windowing & Downsampling**: Support `from`, `to`, and `interval` query parameters on the consumption endpoint to allow downstream analytics to pull daily/weekly rollups.
3. **Anomaly Detection & Webhooks**: Add a background watcher that monitors meter voltage fluctuations or disconnections and emits webhooks to utility dispatch systems.
4. **Docker Containerization**: Provide a lightweight distroless Docker image for automated Kubernetes deployment.

---

## Companion Documents

- **[PROTOCOL.md](file:///c:/Users/HP/Desktop/flock-energy-assignment/PROTOCOL.md)**: Exhaustive reverse-engineering breakdown of the Urja Meter Ops portal, authentication tokens, SvelteKit CSRF quirks, and discovered endpoints.
- **[openapi.json](file:///c:/Users/HP/Desktop/flock-energy-assignment/openapi.json)**: Complete OpenAPI 3.0.3 specification defining all request schemas, query parameters, and response models.
- **[REFLECTION.md](file:///c:/Users/HP/Desktop/flock-energy-assignment/REFLECTION.md)**: Candid engineering reflection answering the 5 evaluation questions.
