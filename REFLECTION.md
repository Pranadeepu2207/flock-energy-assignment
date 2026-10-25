# Engineering Reflection

This document contains candid reflections on the reverse-engineering and implementation process for the Flock Energy Urja Meter Ops wrapper API.

---

### 1. What assumptions did you make?

1. **Authentication Session Model**:
   We assumed that session cookies issued by Better-Auth (`__Secure-better-auth.session_token`) are scoped across both the frontend HTML pages and the internal `/portal/*` endpoints. This was validated during testing: presenting the cookie unlocks both the SSR pages and JSON endpoints.
2. **Grid Hierarchy Invariance**:
   We assumed the electrical distribution hierarchy follows a strict 7-level acyclic tree: `Zone -> Circle -> Division -> Subdivision -> Substation -> Feeder -> Distribution Transformer (DT) -> Meter`. We verified this across the 403 meters in the dataset; all follow this structure without circular dependencies.
3. **Consumption Time-Zone**:
   The legacy portal emits timestamps in Indian standard date-time format (`DD/MM/YYYY HH:mm`) without an explicit UTC offset (e.g., `23/06/2026 23:30`). Because Urja Meter Ops manages utility grids in Rajasthan (Jaipur Zone), we assumed these timestamps are recorded in Indian Standard Time (IST, UTC+5:30) or system local utility time. We preserved the raw string while providing normalized ISO-8601 UTC representation and epoch milliseconds.
4. **Read-Only Concurrency**:
   In accordance with the prompt's ground rules, we assumed the portal is strictly read-only. We implemented an in-memory cache with configurable TTL (default 60 seconds) for bulk meters and hierarchy trees to dramatically reduce latency and avoid overwhelming the legacy backend with redundant round-trips.

---

### 2. Which part was the most difficult, and how did you get unstuck?

**The most difficult part was the initial authentication and CSRF mechanism.**
When attempting the first programmatic `POST /login` using standard credentials, the server immediately rejected the request with `HTTP 403: Cross-site POST form submissions are forbidden`. Furthermore, standard inspect attempts against `/login` showed no hidden CSRF token fields in the form body.

**How we got unstuck:**
1. We inspected the response headers and discovered `x-sveltekit-page: true`.
2. Knowing that SvelteKit implements origin-based CSRF protection (validating `request.headers.get('origin') === url.origin`), we realized the client was either omitting the `Origin` header or Axios was not sending it on redirects.
3. We checked the SvelteKit client bundles (`app.03ZTmlg3.js` and `7.OkXSQ8CK.js`) to inspect the form action bindings and discovered that the form field for username was actually named `email`, not `username`.
4. By configuring the persistent Axios client with explicit `Origin: https://urja-ops.flockenergy.tech` and `Referer: https://urja-ops.flockenergy.tech/login`, the POST succeeded immediately with `HTTP 200` / `303 redirect` and set the `__Secure-better-auth.session_token` cookie.

A second breakthrough was discovering the `/portal/export` endpoint inside `4.2Bgc2kUI.js`. Inspecting the client bundle revealed that `/portal/export` was guarded by an HMAC-SHA256 signature calculated from a dynamically fetched signing key from `/portal/keys` and a timestamp. Reverse-engineering that signing routine allowed us to fetch the full 403-meter dataset in a single call rather than issuing hundreds of individual HTML scrapes.

---

### 3. If you had another day, what would you improve?

1. **Persistent Cache / Storage Layer**:
   Replace the in-memory cache with Redis or SQLite. This would allow multiple API worker processes to share cached meter listings, transformers, and hierarchy models across restarts.
2. **Background Sync Worker / Webhooks**:
   Instead of on-demand fetching of meter details, run a background cron worker that periodically reconciles meter records and checks for consumption anomalies (e.g. voltage drop below 210V or sudden spikes). An event webhook could notify downstream utility systems when a meter status transitions to `Decommissioned`.
3. **Advanced Time-Series Querying**:
   Extend `/api/v1/meters/:id/consumption` with query parameters like `from`, `to`, and `interval` (e.g. `interval=1h` or `interval=1d`), aggregating the raw 30-minute interval readings into hourly or daily averages.
4. **Dockerization & CI/CD**:
   Add a multi-stage `Dockerfile`, `docker-compose.yml`, and GitHub Actions workflow running linting, automated endpoint tests, and contract testing against `openapi.json`.

---

### 4. What mistake did you make while solving this (there's always one)?

**The initial assumption that the meters list on `/meters` was an HTML table pre-populated by SSR.**
When we first logged in and fetched `GET /meters`, we expected to parse an HTML `<table>` populated with meters using Cheerio. However, Cheerio returned only a single row: `<td colspan="6">No meters found.</td>`.

Initially, we wondered if our session cookie had failed to persist. But upon inspecting the network scripts and `5.C4dYcCRt.js`, we realized the page was a SvelteKit client component that rendered an empty table shell and subsequently fired an asynchronous client-side call to `GET /portal/meters/search?q=&page=1`.

Recognizing that the legacy portal was actually a hybrid app (server-rendered HTML for meter details, but internal JSON APIs for search and consumption) allowed us to build an adapter that uses Cheerio where HTML is returned (`/meters/:id`), and consumes JSON directly where available (`/portal/meters/search`, `/portal/meters/:id/energy`).

---

### 5. If you were reviewing your own submission, what would you criticise?

1. **Coupling to Portal Bundle Endpoints**:
   The service leverages internal `/portal/*` endpoints and the HMAC signing protocol discovered in the client bundles. While this provides massive performance gains (retrieving 403 meters in one request instead of 403 individual HTTP scrapes), internal APIs can be changed without warning if the portal developers deploy a new frontend build. A resilient fallback scraper that falls back to paginated scraping would provide an extra layer of defense.
2. **Single Global User Session**:
   The adapter currently uses a single persistent session pool under `operator@urja.local`. In a multi-tenant production environment, the client adapter should support session pooling or proxying individual end-user credentials if different staff members have different RBAC permission tiers on the grid.
3. **In-Memory Hierarchy Tree Construction**:
   The grid hierarchy is constructed in memory from all 403 meters. While 403 meters is tiny (takes ~2ms to assemble), in a utility with 500,000 smart meters, constructing an in-memory nested JavaScript object would consume significant memory and CPU. For larger scale, this should be modeled in a graph database (such as Neo4j) or indexed in PostgreSQL with LTREE.
