# Urja Meter Ops — Protocol Discovery & Reverse-Engineering Report

This document records the architectural findings, authentication mechanisms, internal API endpoints, and data anomalies discovered during reverse-engineering of the legacy **Urja Meter Ops** portal (`https://urja-ops.flockenergy.tech`).

---

## 1. System Architecture Overview

The Urja Meter Ops application is built on **SvelteKit** (Vite-bundled SPA/SSR hybrid) backed by **Better-Auth** for session authentication and a Node.js/Edge backend.
- Response headers include:
  - `x-sveltekit-page: true`
  - Client bundles loaded from `/_app/immutable/entry/` and `/_app/immutable/nodes/`
- The portal renders an initial HTML shell and subsequently fetches JSON data via internal `/portal/*` endpoints or hydrates via SvelteKit `__data.json` loaders.

---

## 2. Authentication & Session Workflow

### Login Request
- **Endpoint**: `POST /login`
- **Content-Type**: `application/x-www-form-urlencoded`
- **Payload**:
  - `email`: `operator@urja.local` (Note: the form input name is `email`, **not** `username`)
  - `password`: `urja-ops-2026`

### Critical CSRF Quirk (SvelteKit Origin Validation)
Submitting standard POST requests to `/login` without browser headers immediately triggers:
```http
HTTP/1.1 403 Forbidden
Cross-site POST form submissions are forbidden
```
- **Discovery**: SvelteKit strictly validates that the HTTP `Origin` header matches the request host.
- **Solution**: The HTTP client adapter must explicitly include:
  ```http
  Origin: https://urja-ops.flockenergy.tech
  Referer: https://urja-ops.flockenergy.tech/login
  ```

### Session Cookie & Response
- **Response**: `HTTP 200 OK` (or `303 See Other`)
  ```json
  { "type": "redirect", "status": 303, "location": "/meters" }
  ```
- **Set-Cookie Header**:
  ```http
  Set-Cookie: __Secure-better-auth.session_token=...; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax
  ```
- **Session Lifespan**: `Max-Age=3600` (1 hour).

### Session Expiry & Auto-Reauthentication
When an unauthenticated or expired session accesses internal portal resources:
1. Internal `/portal/*` endpoints return:
   ```json
   HTTP/1.1 401 Unauthorized
   Content-Type: application/json
   { "error": "unauthorized", "message": "A valid session is required." }
   ```
2. Frontend HTML routes (e.g. `/meters/J100000`) render the login page with title `Urja Meter Ops — Sign in`.
3. **Adapter Strategy**: The API wrapper intercepts `401 Unauthorized`, JSON `error: "unauthorized"`, and detects sign-in HTML redirects. It acquires a mutex lock, triggers automatic re-authentication, and transparently retries the upstream request.

---

## 3. Discovered Endpoints & Protocols

### A. Smart Meter Listing & Search
- **Endpoint**: `GET /portal/meters/search?q={query}&page={page}`
- **Auth**: Requires `__Secure-better-auth.session_token` cookie.
- **Response Format**: JSON
  ```json
  {
    "data": [
      {
        "meterId": "J100000",
        "serialNo": "SE33962",
        "make": "HPL",
        "phaseType": "single",
        "installStatus": "Decommissioned",
        "dtCode": "DT-001"
      }
    ],
    "total": 403
  }
  ```
- **UI Quirk**: When navigating directly to `/meters` via browser without query params, the initial HTML table displays `No meters found.` because the client-side JavaScript issues the search request to `/portal/meters/search?q=&page=1` after page mount.

---

### B. Meter Details & Nameplate
- **Endpoint**: `GET /meters/{meterId}`
- **Format**: Server-Rendered HTML (`text/html`)
- **Structure**:
  - Nameplate specs are rendered inside a `<dl>` definition list with alternating `<dt>` and `<dd>` elements:
    - `Meter ID` (e.g. `J100000`)
    - `Serial No` (e.g. `SE33962`)
    - `Make` (e.g. `HPL`, `L&T`, `Genus`, `Allied`)
    - `Phase Type` (e.g. `single`, `three`)
    - `Installation Status` (e.g. `Installed`, `Decommissioned`)
    - `Installation Type` (e.g. `Whole Current`)
  - Grid hierarchy is rendered inside breadcrumb navigation `<nav class="mt-2 flex flex-wrap gap-1">`:
    ```html
    <span>Jaipur Zone 1 (Z-01)</span> <span class="text-slate-300">›</span>
    <span>Circle 1 (C-01)</span> <span class="text-slate-300">›</span>
    <span>Division 1 (D-01)</span> <span class="text-slate-300">›</span>
    <span>Subdivision 1 (SD-01)</span> <span class="text-slate-300">›</span>
    <span>Substation 1 (SS-01)</span> <span class="text-slate-300">›</span>
    <span>Feeder 1 (F-001)</span> <span class="text-slate-300">›</span>
    <span>Malviya Nagar DT 1 (DT-001)</span>
    ```
- **Parsing**: Extracted using **Cheerio** to parse both `<dl>` attributes and `<nav>` hierarchy paths into structured objects.

---

### C. Meter Geographic Location
- **Endpoint**: `GET /portal/meters/{meterId}/geo`
- **Format**: JSON
- **Response**:
  ```json
  {
    "data": {
      "latitude": "26.938961002479868",
      "longitude": "75.83095696146852"
    }
  }
  ```
- **Quirk**: Coordinates are formatted as strings instead of IEEE floating-point numbers.

---

### D. Time-Series Energy Consumption
- **Endpoint**: `GET /portal/meters/{meterId}/energy`
- **Format**: JSON
- **Response**:
  ```json
  {
    "data": [
      {
        "timestamp": "23/06/2026 23:30",
        "kwh": "48438.74",
        "kvah": "52313.84",
        "voltR": "226"
      }
    ]
  }
  ```
- **Data Quirks**:
  1. `kwh`, `kvah`, and `voltR` are strings rather than floats/integers.
  2. Timestamps are formatted in Indian standard `DD/MM/YYYY HH:mm` rather than ISO-8601 (`YYYY-MM-DDTHH:mm:ssZ`).
  3. No metadata or power summary metrics are provided.

---

### E. Distribution Transformers (DTs)
- **Endpoint**: `GET /portal/dts?page={page}`
- **Format**: JSON
- **Response**:
  ```json
  {
    "data": [
      {
        "code": "DT-001",
        "name": "Malviya Nagar DT 1",
        "feederCode": "F-001",
        "capacityKva": 100
      }
    ],
    "total": 21
  }
  ```

---

### F. Internal Bulk Dataset Export (Signed HMAC-SHA256 API)
Through bundle analysis of client chunk `4.2Bgc2kUI.js` (the Transformers view), we discovered an internal cryptographic bulk export pipeline:
1. **Key Discovery**:
   - `GET /portal/keys`
   - Returns `{ data: { signingSecret: "..." } }`
2. **Signature Protocol**:
   - Request Method: `GET`
   - Request Path: `/portal/export`
   - Query String: `page=1`
   - Timestamp: Unix epoch seconds (e.g. `1792928904`)
   - Payload to sign:
     ```text
     GET\n/portal/export\npage=1\n{timestamp}
     ```
   - Signature: `HMAC-SHA256(payload, signingSecret)` formatted as lowercase hex string.
3. **Bulk Fetch**:
   - `GET /portal/export?page=1`
   - Headers:
     - `x-timestamp`: `{timestamp}`
     - `x-signature`: `{hex_signature}`
   - **Result**: Exports the entire database of **403 smart meters** with complete embedded hierarchy, geo coordinates, and nameplate specs in a single network round-trip.

---

## 4. Normalization Requirements

| Portal Raw Output | Issue | Normalized API Representation |
| :--- | :--- | :--- |
| `"48438.74"` (string) | Numeric field serialized as string | `48438.74` (float) |
| `"226"` (string) | Voltage serialized as string | `226.0` (float) |
| `"23/06/2026 23:30"` | Non-standard Indian date string | `"2026-06-23T23:30:00.000Z"` (ISO-8601) + `epoch_ms` |
| `"26.93896..."` (string) | Geo latitude / longitude strings | `26.93896` (float) |
| HTML `<dl>` & `<nav>` | Messy server-rendered markup | Nested `{ hierarchy: { zone, circle, ... } }` |
| `installStatus` | Inconsistent casing across endpoints | Standardized string with filtering support |
