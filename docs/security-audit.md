# KernelVerse Security Audit

**Date:** 2026-10-28  
**Audit target:** `ac638e8` plus the uncommitted disk-scheduling changes on `rudraksh`  
**Scope:** FastAPI API, simulation engines, Next.js frontend, build/deployment configuration, dependency state, and local launch scripts  
**Assumption:** public internet exposure, unauthenticated users, no server-side persistence

**Overall result:** Not ready for public release until the P0 items in §5 are complete. No critical exploitable application-code vulnerability was found. The highest actual risk is unauthenticated resource exhaustion. One critical dependency advisory (Next.js 16.3.8) is not currently reachable through the features this app uses, but it must be upgraded before release.

---

## 1. Executive summary

KernelVerse is a stateless teaching simulator. It has no accounts, cookies, database, file uploads, or server-side persistence, which removes several common attack classes. The code review found no XSS sinks, command injection, unsafe deserialization, SSRF, SQL injection, or hardcoded secrets.

The main risk is availability and cost: every engine accepts unbounded inputs and returns full state snapshots on every step. Several engines grow quadratically with input size. A single unauthenticated request can therefore consume hundreds of megabytes of memory or return tens of megabytes of JSON. The public API also has no body-size, rate, or concurrency limits, and the production instructions expose Uvicorn and Next.js directly over HTTP without a TLS reverse proxy.

The Next.js dependency is critical by advisory severity, but the affected features are currently unused: the app does not use `next/image`, Server Actions, or `use cache`, and `/_next/image` rejects SVG because `dangerouslyAllowSVG` is disabled. Upgrading is still a release gate because future code could enable those features.

### Risk summary

| ID | Severity | Finding | Release action |
|---|---|---|---|
| H-1 | High | Unbounded engine inputs and superlinear trace amplification | Add hard caps and stop repeating full state |
| H-2 | High | No body/header/rate/concurrency limits on the public API | Add perimeter and app-level limits |
| H-3 | High | Production instructions expose HTTP directly, with no TLS or reverse proxy | Require TLS reverse proxy and bind apps privately |
| M-1 | Medium | Wildcard CORS (`*`) with all methods and headers | Allowlist production origins |
| M-2 | Medium | Missing security headers and CSP | Add headers at proxy and Next.js |
| M-3 | Medium | Next.js 16.3.8 critical advisories (currently low reachability) | Upgrade to 16.4.3 |
| M-4 | Medium | Unpinned Python dependencies and non-reproducible installs | Add lockfile/hashes and `npm ci` |
| M-5 | Medium | API URL defaults to `localhost` at build time | Require HTTPS API URL in production builds |
| L-1 | Low | Public `/docs`, `/redoc`, and `/openapi.json`; Swagger assets from CDN | Disable in production or protect |
| L-2 | Low | Google Fonts/Material Symbols loaded at runtime | Self-host fonts |
| L-3 | Low | `opentelemetry-api` 1.45.0 advisory (not currently reachable) | Upgrade to 1.45.1 |
| L-4 | Low | Dev-only `zod` 4.6.5 high advisory | Update to 4.6.6 |
| L-5 | Low | `X-Powered-By` and `Server` information disclosure | Remove headers |
| L-6 | Low | Minor `.gitignore` and local-script hygiene issues | Harden |

---

## 2. Scope, assumptions, and method

### In scope

- `api/app/main.py`, all five engine modules, and their validation paths
- `web/src`, `web/next.config.ts`, and the production build output
- `api/requirements.txt`, `web/package.json`, and `web/package-lock.json`
- `README.md`, `start.sh`, `start.ps1`, and `start.bat`
- Runtime behavior on loopback: headers, CORS, docs, malformed input, body size, and response size
- Dependency advisories, secret scanning, and engine resource benchmarks

### Out of scope

- The production host, DNS, TLS certificate, CDN/WAF, reverse-proxy configuration, and OS patching (none are in the repository)
- External penetration testing, browser-based fuzzing, and long-duration load testing
- GitHub account security and third-party font/CDN providers
- Any future authentication, persistence, uploads, or multi-user features

### Method

1. Manual review of API routes, engine validation/run code, frontend rendering, and deployment scripts.
2. Static searches for dangerous DOM/JS sinks, command execution, unsafe deserialization, hardcoded secrets, and unsafe object merging.
3. Dependency audits with `npm audit` and `pip-audit` (PyPI advisory service; single-package OSV queries for confirmation).
4. Targeted secret scan of the working tree and all 9 commits.
5. Runtime tests against local Uvicorn and `next start` instances.
6. Engine microbenchmarks measuring wall time, JSON size, and process RSS.

### Environment

- Next.js `16.3.8`, React `19.2.8`
- FastAPI `0.142.2`, Starlette `1.7.0`, Pydantic `2.13.5`, Uvicorn `0.54.0`
- Python `3.14.7`, Node `22.22.2`, npm `10.9.7`

---

## 3. Findings

### H-1 — Unbounded simulation inputs and superlinear trace amplification

**Severity:** High  
**Impact:** Memory exhaustion, CPU exhaustion, huge responses, browser freeze, worker starvation

The API accepts arbitrarily large engine payloads. Validation checks types and basic ranges but does not cap list lengths or integer magnitudes. The response format then repeats full state on every step.

Key evidence:

- **Paging** (`api/app/engines/paging.py`)
  - `frames` is only checked for `>= 1` (`:56-58`), then allocated directly as `[None] * frame_count` (`:93`). A request with a very large `frames` value can exhaust memory immediately.
  - Every step includes the full reference string (`:283`), so response size is O(R²).
  - Every step also includes a copy of the frame and TLB arrays (`:284-285`), so response size is O(R × (R + F + T)).
- **Disk scheduling** (`api/app/engines/disk_scheduling.py`)
  - `requests` has no length cap (`:80-90`).
  - Every step includes `requests`, `remaining`, `served`, `sequence`, and `seek_distances` (`:183-187`), making the response O(N²).
  - `remaining.remove(served_request)` (`:247`) is O(N) per service, adding O(N²) CPU.
- **CPU scheduling** (`api/app/engines/cpu_scheduling.py`)
  - `MAX_TIME = 5000` (`:37`) caps ticks, but the process count is unbounded (`:63-107`).
  - Every snapshot includes the full process list (`:145-150`), so a 5,000-tick run with N processes is O(5,000 × N) response data.
- **Memory management** (`api/app/engines/memory_management.py`)
  - Processes, holes, and segments are unbounded (`:64-102`).
  - Every step copies the full block list and segment table (`:343-344`), so response size is O(N²).
- **Deadlocks** (`api/app/engines/deadlocks.py`)
  - Process and resource counts are unbounded (`:52-84`).
  - Every step copies allocation, max, need, available, and holder matrices (`:200-215`), so response size is O(P² × R).

Measured with modest inputs (direct engine calls):

| Engine | Input | Time | JSON | Peak RSS |
|---|---|---:|---:|---:|
| CPU | 1,000 processes, burst 1 | 0.416 s | 63.00 MiB | 544.1 MiB |
| Paging | 2,000 refs, 50 frames, 10 TLB | 0.021 s | 11.96 MiB | 544.1 MiB |
| Disk | 1,000 requests | 0.009 s | 10.63 MiB | 544.1 MiB |
| Memory | 1,000 processes | 0.127 s | 34.30 MiB | 544.1 MiB |
| Deadlocks | 100 processes × 10 resources | 0.014 s | 2.56 MiB | 544.1 MiB |

The disk case through the real API returned **11,139,270 bytes in 0.0769 s**. These sizes are not extreme inputs; they are well within what an attacker can send. Scaling is superlinear, and `frames` can OOM with one request.

**Remediation:**

1. Add explicit, configurable caps before running any engine:
   - CPU: processes ≤ 100; arrival/burst ≤ 5,000; quantum ≤ 1,000; max 2,000 trace steps.
   - Paging: references ≤ 1,000; frames ≤ 256; TLB ≤ 256; page numbers ≤ 1,000,000.
   - Disk: requests ≤ 500; disk size ≤ 1,000,000; max 2,000 trace steps.
   - Memory: processes ≤ 100; holes ≤ 100; segments per process ≤ 50; sizes ≤ memory size.
   - Deadlocks: processes ≤ 50; resources ≤ 20; totals/instances ≤ 1,000,000.
   - IDs/names: maximum 64 characters.
2. Stop repeating immutable data in every step:
   - Paging: send the reference string once at the result level, not in every step.
   - Disk: send `requests` once; send only the current/delta state per step.
   - Memory/deadlocks: send deltas or cap the number of recorded steps.
3. Enforce a maximum response size (for example 2 MiB) and a maximum step count (for example 2,000). Return `413` or `422` with a clear message.
4. Enforce a wall-clock simulation budget (for example 1 second) and reject work that exceeds it.
5. Mirror the same caps in the UI so users get immediate feedback.

### H-2 — No body, header, rate, or concurrency limits on the public API

**Severity:** High  
**Impact:** Denial of service, bandwidth/cost amplification, worker starvation

`api/app/main.py` defines `/simulate` (`:74-111`) with no body-size, rate, or concurrency middleware. `SimulateRequest.payload` is an unconstrained `dict` (`:48-60`).

Runtime evidence:

- A **2 MiB** JSON body was accepted and parsed; the unknown-topic path returned `501`.
- A **50 KB** `tracestate` header was accepted.
- A valid 1,000-request disk payload returned **11.1 MiB** in **77 ms**.
- The endpoint is synchronous and CPU-bound; FastAPI runs it in the thread pool, so several large requests can saturate workers and memory.

This is not just a large-body problem: a small body with `frames: 1000000000` can attempt a multi-gigabyte allocation in `paging.py:93`.

**Remediation:**

1. Put a reverse proxy in front of both apps and enforce:
   - request body limit (for example 256 KiB),
   - header size limit (for example 16 KiB),
   - per-IP request rate (for example 30 simulations/minute with a small burst),
   - connection/request concurrency limits.
2. Add app-level defense in depth:
   - reject oversized `Content-Length` before parsing,
   - enforce per-topic caps from H-1,
   - return `413` for oversized bodies and `429` with `Retry-After` for rate limits.
3. Limit concurrent simulations globally and per client. Uvicorn's `--limit-concurrency` limits connections, not per-client simulations, so use a queue/semaphore or proxy policy.
4. Add request timeouts and monitor worker RSS/CPU.
5. For classroom NAT, avoid overly strict per-IP limits that block an entire class; combine generous per-IP burst limits with global concurrency control.

### H-3 — Insecure production deployment defaults

**Severity:** High (release blocker)  
**Impact:** Plaintext traffic, tampering, direct exposure, bypass of any future proxy controls

`README.md:149-157` tells operators to run:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
cd web && npm run build && npm run start
```

There is no TLS, reverse proxy, HSTS, trusted-host handling, body limit, or rate limit in that path. `next start` binds all interfaces (the local run printed a LAN `Network:` URL), and Uvicorn is explicitly bound to `0.0.0.0`.

**Impact:** On a public network, an attacker can read or modify traffic, serve tampered content, and reach both apps directly. If authentication or cookies are added later, this becomes a credential-theft issue. Direct exposure also bypasses proxy-level rate and size limits.

**Remediation:**

1. Terminate TLS at Caddy, Nginx, or a cloud load balancer; expose only 443.
2. Bind Uvicorn and Next.js to loopback or a private interface, not `0.0.0.0`.
3. Add HSTS at the proxy after HTTPS is verified.
4. Configure `--proxy-headers --forwarded-allow-ips=<proxy>` so client IP/scheme are correct.
5. Add proxy-level body/header limits, rate limits, and connection limits.
6. Firewall the app ports from the public internet.
7. Add `TrustedHostMiddleware` with the production hostname.

### M-1 — Wildcard CORS

**Severity:** Medium  
**Impact:** Any website can invoke the API from a visitor's browser; no sensitive data today, but it enables abuse and removes a useful boundary

`api/app/main.py:40-45` sets:

```python
allow_origins=["*"]
allow_methods=["*"]
allow_headers=["*"]
```

A preflight from `https://evil.example` returned:

```text
access-control-allow-origin: *
access-control-allow-methods: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY
access-control-allow-headers: content-type
```

No `access-control-allow-credentials` was returned, so cookies are not exposed. The API has no sensitive data or auth, so this is not data theft. It does let any site trigger simulations in a visitor's browser, which compounds H-1/H-2.

A `text/plain` POST was rejected with `422`, so there is no simple-form bypass; a preflighted JSON request is required, and the wildcard policy allows it.

**Remediation:**

1. Read allowed origins from an environment variable, for example `CORS_ORIGINS=https://kernelverse.example`.
2. Allow only `GET`, `POST`, and `OPTIONS`; allow only `Content-Type`.
3. Keep `allow_credentials=False` unless cookies/auth are added.
4. Better: serve the API under the same origin as the frontend (for example `/api`) through the reverse proxy and remove cross-origin access entirely.

### M-2 — Missing security headers and CSP

**Severity:** Medium  
**Impact:** No defense-in-depth against XSS, clickjacking, MIME sniffing, or referrer leakage

`web/next.config.ts` contains only `allowedDevOrigins`; it has no `headers()` and no `poweredByHeader: false`. Runtime responses from both apps lacked:

- `Content-Security-Policy`
- `Strict-Transport-Security`
- `X-Frame-Options`
- `X-Content-Type-Options`
- `Referrer-Policy`
- `Permissions-Policy`

The web app also returned `X-Powered-By: Next.js`, and the API returned `Server: uvicorn`.

No XSS sink was found, so this is primarily hardening. Clickjacking is low impact today because there are no sensitive actions, but it should still be blocked for an official teaching product.

**Remediation:**

1. Set `poweredByHeader: false` in `web/next.config.ts`.
2. Add headers in `next.config.ts` and/or the reverse proxy:
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: strict-origin-when-cross-origin`
   - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`
   - `X-Frame-Options: DENY`
   - `Content-Security-Policy` with `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`, and appropriate `script-src`, `style-src`, `font-src`, `img-src`, and `connect-src`.
3. Start CSP in report-only mode, then enforce it. The app is statically prerendered, so a nonce-based policy may require dynamic rendering; a hash-based or carefully scoped policy is a reasonable first step.
4. Add HSTS at the proxy.
5. Use Uvicorn `--no-server-header` or hide the header at the proxy.

### M-3 — Next.js critical dependency advisories

**Severity:** Critical advisory; Low current exploitability  
**Impact:** RCE/DoS if affected features are later used

`web/package.json:12` pins Next.js `16.3.8`. `npm audit` reports one critical package with three advisories, fixed in `16.4.3`:

- `GHSA-2464-fhr4-w9xw` — unauthenticated RCE in the Image Optimization API when SVG files are used
- `GHSA-p3m5-59mp-jv5r` — DoS in App Router using Server Actions
- `GHSA-673q-mjm6-r5xr` — RCE in `use cache` functions returning typed arrays

Current reachability is low:

- No `next/image` usage was found.
- No Server Actions were found.
- No `use cache` usage was found.
- `/_next/image?url=%2Fnext.svg&w=64&q=75` returned `400` because `dangerouslyAllowSVG` is disabled.

The critical rating still makes this a release gate. A future feature or configuration change could make it reachable.

**Remediation:**

1. Upgrade `next` and `eslint-config-next` to `16.4.3` (or a later patched release).
2. Rebuild and rerun the production build and tests.
3. Ensure the lockfile resolves `zod` to `>=4.6.6`; if the transitive dev dependency remains at `4.6.5`, add a narrowly scoped override or update the parent.
4. Run `npm audit --omit=dev` in CI. Do not use `npm audit fix --force`; upgrade deliberately and test.

### M-4 — Unpinned Python dependencies and non-reproducible installs

**Severity:** Medium  
**Impact:** Supply-chain drift, unreviewed upgrades, vulnerable stale environments

`api/requirements.txt` contains only lower bounds:

```text
fastapi>=0.115
uvicorn[standard]>=0.30
pydantic>=2.7
```

There is no lockfile, hash, or constraints file. `start.sh:10` runs `pip install -r api/requirements.txt`, and `start.sh:15` runs `npm install`; the Windows scripts do the same. Existing virtualenvs are not updated at all.

`pip-audit` on the installed freeze found:

```text
opentelemetry-api 1.45.0  CVE-2026-114603  fix: 1.45.1
```

`opentelemetry-api` is a direct dependency of FastAPI `0.142.2`, not an unrelated package. The venv also contains packages not declared by this app (for example Pillow and reportlab), which is evidence of environment drift.

**Remediation:**

1. Create `api/requirements.in` with direct dependencies and compile a pinned, hashed `requirements.txt` using `pip-compile --generate-hashes` (or use `uv lock`).
2. Install with `pip install --require-hashes -r requirements.txt`.
3. Use `npm ci` instead of `npm install` in launch/CI scripts; commit `package-lock.json`.
4. Recreate the virtualenv from the lockfile instead of layering upgrades onto an old venv.
5. Add Dependabot/Renovate and run `pip-audit` and `npm audit` in CI.

### M-5 — API URL defaults to `localhost` in the production build

**Severity:** Medium (release/functional; potential mixed-content downgrade)  
**Impact:** Deployed frontend calls each visitor's localhost; if an HTTP URL is used, browsers block it on HTTPS

All five simulator pages fall back to `http://localhost:8000`:

- `web/src/app/simulator/cpu-scheduling/page.tsx:142`
- `web/src/app/simulator/memory-management/page.tsx:621`
- `web/src/app/simulator/paging/page.tsx:280`
- `web/src/app/simulator/disk-scheduling/page.tsx:168`
- `web/src/app/simulator/deadlocks/page.tsx:484`

The current `.next` build contains 15 occurrences of `localhost:8000`. If deployed without setting `NEXT_PUBLIC_API_URL` at build time, every visitor's browser will call its own machine. If the variable is set to `http://` while the site is served over HTTPS, the browser will block the API calls as mixed content.

**Remediation:**

1. Require `NEXT_PUBLIC_API_URL` in production builds and fail the build if it is missing or not `https://`.
2. Centralize the API base URL in one client module instead of five fallbacks.
3. Prefer same-origin `/api` behind the reverse proxy, which removes CORS and simplifies CSP.
4. Document the build-time nature of `NEXT_PUBLIC_*` variables in the deployment guide.

### L-1 — Public API documentation and CDN assets

**Severity:** Low  
**Impact:** Extra attack surface and third-party JavaScript if docs are public

`/docs` and `/openapi.json` return `200`. The Swagger page loads assets from `cdn.jsdelivr.net` and a FastAPI favicon from `fastapi.tiangolo.com`.

**Remediation:** Disable `docs_url`, `redoc_url`, and `openapi_url` in production, or protect them with authentication. If they must stay public, self-host Swagger UI assets and add a CSP.

### L-2 — External Google Fonts and Material Symbols

**Severity:** Low (privacy and availability)  
**Impact:** Visitor IP/user-agent sent to Google; fonts unavailable in some regions; CSP must allow third-party origins

`web/src/app/layout.tsx:14-23` loads Google Fonts and Material Symbols at runtime from `fonts.googleapis.com` and `fonts.gstatic.com`.

**Remediation:** Self-host the fonts with `next/font/local` or local WOFF2 files, remove the preconnect links, and tighten `font-src`/`style-src` in CSP. Add a privacy note if the site is centrally hosted.

### L-3 — `opentelemetry-api` advisory

**Severity:** Low current reachability; Moderate advisory  
**Impact:** Unbounded `tracestate` parsing can block an async worker if telemetry is enabled

`opentelemetry-api` `1.45.0` has `CVE-2026-114603` / `GHSA-xcq7-p3pf-p88h`, fixed in `1.45.1`. FastAPI `0.142.2` depends on `opentelemetry-api>=1.44.0`.

FastAPI's native telemetry is disabled when no OpenTelemetry provider is configured. A 50 KB `tracestate` header against `/health` returned in **0.000892 s**, confirming the vulnerable path is not active in this configuration.

**Remediation:** Upgrade to `1.45.1` and pin it in the lockfile. Recheck if telemetry is ever enabled.

### L-4 — Dev-only `zod` advisory

**Severity:** Low  
**Impact:** Developer tooling only; not shipped in the production bundle

`npm audit` reports `zod@4.6.5` as high (`GHSA-mrhx-c7xc-m3w5`), fixed in `4.6.6`. It is pulled in by `eslint-config-next` → `eslint-plugin-react-hooks` and is marked `dev`. `npm audit --omit=dev` does not include it.

**Remediation:** Update the lockfile to `zod >= 4.6.6` as part of the Next.js upgrade. No production runtime impact.

### L-5 — Information disclosure headers

**Severity:** Low  
**Impact:** Reveals technology stack

Runtime responses include `X-Powered-By: Next.js` and `Server: uvicorn`.

**Remediation:** Set `poweredByHeader: false` in `next.config.ts`; run Uvicorn with `--no-server-header` or hide it at the proxy.

### L-6 — Minor repository and local-script hygiene

**Severity:** Low  
**Impact:** Reduced secret-scanning coverage; accidental local process termination

- Root `.gitignore:7` ignores only `.env`, not `.env.local`, `.env.production`, `*.pem`, or `*.key`. `web/.gitignore` already covers `.env*`.
- `start.ps1:33` force-stops **all** Node processes on the machine, not just the processes it started.
- No `.github` CI workflows, `SECURITY.md`, or secret-scanning configuration are present.

**Remediation:** Broaden `.gitignore` to `.env*`, `*.pem`, and `*.key`; scope `start.ps1` cleanup to the spawned PIDs; add `SECURITY.md` and CI secret scanning.

---

## 4. Positive findings

These controls are working and should be preserved:

- **No XSS sinks found:** no `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `document.write`, `eval`, `new Function`, or `javascript:` URLs in `web/src`. React escapes user-controlled text.
- **No command execution or unsafe deserialization:** no `subprocess`, `os.system`, `shell=True`, `eval`, `exec`, `pickle`, or `yaml.load` in the API.
- **No hardcoded secrets:** targeted regex scan of the working tree and all 9 commits found no obvious API keys, tokens, private keys, or passwords. No `.env` or key files are tracked.
- **No SSRF:** the backend does not fetch user-supplied URLs.
- **No SQL/database:** there is no database layer to inject into.
- **No file uploads:** no upload endpoint or user-controlled filesystem path.
- **CSRF is not applicable:** there are no cookies or authenticated sessions. Revisit if auth is added.
- **LocalStorage handling is guarded:** JSON parsing is wrapped in `try/catch`, and saved data is mapped field-by-field. No unsafe object merge or prototype-pollution sink was found. Only simulation inputs are stored; no PII.
- **Error handling:** malformed JSON returns `422` without a stack trace; unknown topics return `501`; no debug mode was observed.
- **CORS does not allow credentials:** wildcard CORS is still a finding, but cookies are not exposed.
- **SVG image optimization is blocked:** `dangerouslyAllowSVG` is disabled; the endpoint returned `400`.
- **OpenTelemetry vulnerable path is inactive:** the 50 KB `tracestate` test was fast; native telemetry has no provider.
- **No server-side persistence:** simulation results are computed and returned; no teacher/student data is stored.
- **Backend tests and production build pass:** 27 unit tests pass; `next build` succeeds.

Non-security release note: `npm run lint` currently fails with 3 errors and 3 warnings, mostly `react-hooks/set-state-in-effect` in the simulator pages. This is pre-existing and should be fixed before release, but it is not a security vulnerability.

---

## 5. Prioritized remediation plan

### P0 — before any public deployment

1. **Upgrade dependencies**
   - `next` and `eslint-config-next` → `16.4.3` or later.
   - `zod` → `>=4.6.6` in the lockfile.
   - `opentelemetry-api` → `1.45.1` in the Python lockfile.
   - Run `npm ci`, rebuild, rerun all tests, and rerun both audits.

2. **Add hard engine and response caps**
   - Implement the limits from H-1.
   - Remove repeated immutable data from per-step state.
   - Enforce max steps, max response size, and max wall-clock time.
   - Return `413`/`422` with clear messages.

3. **Add perimeter controls**
   - TLS reverse proxy with HSTS.
   - Body/header limits, rate limits, and concurrency limits.
   - Bind Uvicorn and Next.js to loopback/private interfaces.
   - `--proxy-headers --forwarded-allow-ips=<proxy>`.
   - Firewall app ports.

4. **Harden API and web configuration**
   - Replace wildcard CORS with an origin allowlist, or serve the API same-origin under `/api`.
   - Disable `/docs`, `/redoc`, and `/openapi.json` in production, or protect them.
   - Add security headers and CSP.
   - Set `poweredByHeader: false` and hide the Uvicorn server header.
   - Add `TrustedHostMiddleware`.

5. **Fix the production API URL**
   - Require an HTTPS `NEXT_PUBLIC_API_URL` at build time.
   - Fail the build if it is missing.
   - Prefer same-origin `/api`.

### P1 — before broad rollout

6. Self-host Google Fonts and Material Symbols.
7. Add `SECURITY.md` with a disclosure contact and response expectations.
8. Add CI for tests, build, dependency audits, and secret scanning.
9. Fix the lint errors.
10. Add a privacy note describing localStorage use and hosting/telemetry practices.

### P2 — ongoing hardening

11. Move to a nonce/hash-based CSP and enforce it.
12. Add load tests for capped payloads and monitor RSS/CPU/response size.
13. Add structured security logging and alerting for 413/429/5xx spikes.
14. Generate an SBOM and review dependency provenance.
15. Commission an external penetration test before a high-profile public launch.

---

## 6. Release gate checklist

- [ ] Next.js `>=16.4.3`, `zod >=4.6.6`, `opentelemetry-api >=1.45.1`.
- [ ] `npm audit --omit=dev` clean or every exception documented.
- [ ] `pip-audit` on the locked freeze clean or every exception documented.
- [ ] All engines enforce list/integer/ID caps; oversized inputs return `413`/`422`.
- [ ] Max trace steps and max response size enforced.
- [ ] Request body ≤ 256 KiB and headers ≤ 16 KiB at the proxy.
- [ ] Per-IP rate limit and global/per-client concurrency limit active.
- [ ] HTTPS/HSTS active; app ports not publicly reachable.
- [ ] CORS restricted to the production origin, or same-origin `/api`.
- [ ] `/docs`, `/redoc`, `/openapi.json` disabled or protected in production.
- [ ] CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options` present.
- [ ] `X-Powered-By` and Uvicorn `Server` headers removed.
- [ ] `NEXT_PUBLIC_API_URL` is HTTPS and no `localhost:8000` appears in the production bundle.
- [ ] 27 backend tests pass.
- [ ] `npm run build` passes; `npm run lint` passes.
- [ ] A small load test with max-size payloads stays within the memory/CPU budget.
- [ ] `SECURITY.md` exists.

---

## 7. Evidence log

### Runtime checks

| Check | Result |
|---|---|
| API `/health` | `200`, `server: uvicorn`, no security headers |
| Web `/` | `200`, `X-Powered-By: Next.js`, no security headers |
| CORS preflight from `https://evil.example` | `200`, `access-control-allow-origin: *`, all methods |
| `/docs` | `200`, HTML; loads `cdn.jsdelivr.net` assets |
| `/openapi.json` | `200`, JSON |
| Malformed JSON | `422`, no stack trace |
| Unknown topic | `501`, detail message |
| 2 MiB body | Accepted; `501` for unknown topic |
| 50 KB `tracestate` header | Accepted; `/health` in `0.000892 s` |
| 1,000-request disk simulation | `200`, `11,139,270` bytes, `0.0769 s` |
| `/_next/image` local SVG | `400`, "image type is not allowed" |
| `/_next/image` remote URL | `400` |

### Dependency audits

| Tool | Result |
|---|---|
| `npm audit` | 1 critical (Next.js), 1 high (zod, dev-only) |
| `npm audit --omit=dev` | 1 critical (Next.js) |
| `pip-audit -s pypi` on installed freeze | `opentelemetry-api 1.45.0`, CVE-2026-114603, fix `1.45.1` |
| OSV single query | Confirmed `GHSA-xcq7-p3pf-p88h` details |

`npm view next@16.4.3 version` and `npm view zod@4.6.6 version` confirmed the fixed versions exist. The OSV batch endpoint was unreliable during the audit; the PyPI advisory service was used for the full freeze, and single OSV queries confirmed the relevant advisory.

### Build and tests

| Check | Result |
|---|---|
| `python -m unittest discover -s api/tests -v` | 27 tests passed |
| `npm run build` | Passed; 10 static pages generated |
| `npm run lint` | Failed with 3 errors/3 warnings (pre-existing hooks rules) |

---

## 8. Limitations

- This is a point-in-time audit. Dependency advisories and fixed versions change.
- No external penetration test, fuzzing, or browser-automation test was performed.
- No production infrastructure was available; TLS, proxy, DNS, WAF, and OS findings are based on the repository's instructions, not a live deployment.
- The secret scan was a targeted regex scan, not a full entropy-based secret scanner.
- The engine benchmarks are microbenchmarks on one machine; absolute numbers will vary, but the superlinear growth is structural.
- No authentication exists to test; if accounts, persistence, uploads, or teacher workspaces are added, this audit must be extended.
- `npm audit fix --dry-run` hit an `ERESOLVE`/peer-resolution issue in this environment; manual dependency upgrades are recommended.
- The report does not certify the app as secure. It identifies the issues that must be addressed before public release and the residual risks that remain.
