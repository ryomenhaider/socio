# Security Audit Verification Report

Every claim in `securityaudit.md` verified against the actual codebase (source files, views, deploy config, `.env` key scan, file permissions via `stat`, `npm audit`, and targeted greps). Verified 2026-08-12.

## Results summary

| Section | Findings | Result |
|---|---|---|
| CRITICAL (C1-C2) | 2 | 2 CONFIRMED |
| HIGH (H1-H4) | 4 | 4 CONFIRMED |
| MEDIUM (M1-M6) | 6 | 6 CONFIRMED |
| LOW (L1-L6) | 6 | 6 CONFIRMED |
| Verified-clean | 8 claims | 8 CONFIRMED clean |
| Missed-by-audit sweep | 4 categories | nothing new found |

No fabricated line numbers, no behavior mismatches found. Two uncited variants of existing findings noted below.

## Verification table

| Finding ID | Status | Evidence |
|---|---|---|
| **C1** Hardcoded session secret — cookie forgery → account takeover | CONFIRMED | `src/config.js:9` — `sessionSecret: process.env.SESSION_SECRET \|\| 'dev-only-change-me'`. `.env` exists but key-scan shows no `SESSION_SECRET` (only BASE_URL, `*_CLIENT_ID/SECRET`, OPENROUTER_*, PORT, DATA_DIR). `src/auth.js:52-54` — `createSession` → `signSession({username, exp})`; `verifySession` (auth.js:32-50) checks HMAC + expiry only. `deploy/install.sh:41-44` does generate a random `SESSION_SECRET`, so the repo's own `.env` is genuinely stale. |
| **C2** No rate limiting anywhere — brute force + OpenRouter cost abuse + disk DoS | CONFIRMED | No rate-limiting package in `package.json` (deps: better-sqlite3, dotenv, ejs, express, multer, nodemailer); grep `rate.limit\|helmet` = 0 hits. Cited lines all exist: login POST `src/routes/session.routes.js:28`, `/api/copy` `src/routes/copy.routes.js:12`, feedback submit `src/routes/feedback.routes.js:29`, `/compose` `src/routes/posts.routes.js:81`. Cost abuse: `src/services/ai.js:159-169` — `Promise.all` over ≤5 platforms, `maxTokens: 900` (ai.js:165), `openai/gpt-4o` in `AI_MODELS` (ai.js:14), no server-side topic length check in copy.routes.js:12-21. Feedback spam: `force === '1'` (feedback.routes.js:32) skips length + AI-score gates inside `if (!force)` (feedback.routes.js:44-65). Disk DoS: `src/services/upload.js:22` `fileSize: 300MB`, `upload.any()` has no file-count cap. |
| **H1** No per-user isolation — any user controls all data (IDOR by design) | CONFIRMED | `src/db.js:15-48` — `accounts`, `posts`, `post_targets` have **no** `user_id` column; `users` table (db.js:61-66) exists separately. `src/routes/posts.routes.js:253-258` — retry by bare `:id`, no ownership check. `src/routes/accounts.routes.js:36-61` — disconnect/refresh by bare `:id`. `requireAuth` (`src/auth.js:72-82`) checks authentication only, never ownership. Multi-user `src/scripts/users.js` ships with the app. |
| **H2** Stored XSS via uploads (SVG / spoofed MIME) served same-origin | CONFIRMED | `src/services/upload.js:14-18` — `isMediaAllowed` trusts client-supplied `file.mimetype` (`mime.startsWith('image/')` → `image/svg+xml` passes). Original extension preserved (`upload.js:9` `path.extname(file.originalname)`), so a `.html` file with spoofed `image/png` mimetype is stored with `.html` and served as HTML. No magic-byte validation. `src/app.js:42` — `/media` served via `express.static` on the app's own origin. No `nosniff`/CSP/`Content-Disposition` headers anywhere. |
| **H3** Scheduler: no cross-instance locking; stuck/dead targets; duplicate posts | CONFIRMED | `src/services/publisher.js:87-141` — `runOnce.locked` is a process-local flag (publisher.js:88-89); selects only `WHERE status = 'scheduled'` (publisher.js:96); sets `'publishing'` (publisher.js:101-103); publish then DB update (publisher.js:105-108) — a crash in between republishes. No DB-level claim, no stale-`publishing` recovery. `deploy/socio.service:12-13` — `Restart=always` / `RestartSec=5` makes restart overlap real. |
| **H4** SQLite DB + WAL files world-readable → local token theft | CONFIRMED | `stat` verified: `data/` = 755, `socio.db` / `socio.db-wal` / `socio.db-shm` all 644. `src/db.js:6-9` — mkdir + open, no chmod. `src/server.js:7` logs data dir. `deploy/socio.service:8` runs as `__APP_USER__`, no hardening. `accounts.token` holds OAuth access/refresh tokens as JSON (see `JSON.parse(account.token)` at publisher.js:18, accounts.routes.js:14). |
| **M1** Session cookie missing Secure (and `__Host-`) | CONFIRMED | `src/routes/session.routes.js:38-42` — cookie set with only `httpOnly`, `sameSite: 'lax'`, `maxAge`; no `secure`, no `path`, no `__Host-` prefix. `app.set('trust proxy', ...)` absent (grep = 0). Repo `deploy/nginx-socio.conf` is a plain `listen 80` proxy block (TLS added by certbot at install time), so the app sees plain HTTP. |
| **M2** Open redirect via `next=//evil.com` | CONFIRMED | `src/routes/session.routes.js:17,31` — `next.startsWith('/')` accepts `//evil.com`; `res.redirect(next)` at session.routes.js:43. Uncited variant at session.routes.js:14 — already-authenticated users hitting `/login?next=//evil.com` get a raw `req.query.next` redirect with no validation at all. |
| **M3** No CSRF tokens; only sameSite=lax | CONFIRMED | grep `csrf`/`_token` = 0 hits. `sameSite: 'lax'` only. Logout (`session.routes.js:46-49`) just clears the client cookie — sid not revocable server-side. `auth.js:5` — 30-day TTL; payload `{username, exp}` (auth.js:52-54). `hx-post` endpoints at `src/web/views/pages/compose.ejs:91`, `src/web/views/pages/feedback.ejs:11`. Variant: a deleted user's sid remains valid until expiry (stateless token, no DB check in `verifySession`). |
| **M4** Internal error details leaked to the client | CONFIRMED | `src/app.js:53-60` — 500 handler renders `String(err.message \|\| err)` (app.js:58). `src/routes/copy.routes.js:26-31` — `error: String(err.message \|\| err)` (copy.routes.js:29). `src/routes/feedback.routes.js:101-110` — same (feedback.routes.js:105). |
| **M5** /media served behind auth — Instagram public-URL fetch breaks | CONFIRMED | `src/app.js:42` mounted after `requireAuth` (app.js:40). `src/platforms/meta.js:313-319` — builds `${config.baseUrl}/media/${encodeURIComponent(media.name)}` as a public URL (meta.js:319); Meta's Graph API fetch of that URL gets 401 when /media is auth-gated, so IG image posts fail on any public deployment. `media.name` at that point is `path.basename(content.media_path)` (publisher.js:65), consistent naming. |
| **M6** Retry endpoint abuse + scheduler lock monopolization | CONFIRMED | `src/routes/posts.routes.js:253-262` — retry resets `attempts = 0` (posts.routes.js:257) and calls `await runOnce()` per request (posts.routes.js:260). Backoff `computeNextAttempt` `src/services/publisher.js:82-85`. Long publishes hold the process-wide lock: `meta.js:284-295` 24×10s polls → "after 4 min" (meta.js:294); `tiktok.js:210-219` 24×5s = 2 min; YouTube up to 10 min via `AbortSignal.timeout(10 * 60 * 1000)` (`src/platforms/youtube.js:134` — a request timeout, not a poll). `runOnce()` also awaited in the compose request path (`posts.routes.js:203`). |
| **L1** oauth_states never expire | CONFIRMED | `src/routes/auth.routes.js:16-20` — INSERT `state`/`platform`/`created_at`, no expiry column, no cleanup/purge code anywhere in the repo. |
| **L2** No security headers | CONFIRMED | `src/app.js` — no CSP, X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy. CDNs without SRI: `src/web/views/partials/head.ejs:24` (Tailwind `cdn.tailwindcss.com`), `:49` (htmx unpkg), `:50` (Alpine jsdelivr); also Google Fonts at `:9` (uncited by audit, same class). |
| **L3** No server-side length enforcement on post text/topic | CONFIRMED | `src/routes/posts.routes.js:81-82` — `text`/`topic` taken from body with no server-side length checks; only client `maxlength` (compose.ejs:26 → 3000, compose.ejs:131 → 3000). |
| **L4** users.js prints generated passwords to stdout | CONFIRMED | `src/scripts/users.js:32` — `console.log(\`Generated password: ${pw}\`)` when no password arg is given (random one generated at users.js:21). |
| **L5** No explicit request-body size limits | CONFIRMED | `src/app.js:20-21` — `express.urlencoded({ extended: true })` + `express.json()` with Express defaults (100kb), no explicit `limit` set. |
| **L6** Provider error bodies include response content | CONFIRMED | `src/services/ai.js:127` — `throw new Error(\`OpenRouter error ${res.status}: ${body.slice(0, 300)}\`)`. Same echo pattern in `accounts.routes.js:58` and `auth.routes.js:82`. |

## Verified-clean spot checks (all CONFIRMED clean)

| Claim | Status | Evidence |
|---|---|---|
| SQL injection: prepared statements only | CONFIRMED | All queries use `?` params. Only interpolation: static `db.exec` strings (`src/db.js:14-77`, ALTER loop uses a hardcoded const array) and IN-placeholder expansion at `posts.routes.js:98` (built from `?` placeholders, coerced via `Number()`). Grep for `${` inside `prepare(` = 0 hits. |
| EJS escaping: `<%=` everywhere, `<%-` only for includes | CONFIRMED | All 20 `<%-` occurrences in views are `include()` of partials. User/provider data — including error pages (`error.ejs:6`), `tiktok_options.ejs`, `feedback_result.ejs` — renders via `<%=`. No `innerHTML`/`v-html`/`document.write` on dynamic data (grep = 0). |
| Password hashing: scrypt + salt + timingSafeEqual | CONFIRMED | `src/auth.js:7-19` — 16-byte random salt, scryptSync 64 bytes, `timingSafeEqual` compare. |
| Secrets: OpenRouter key only in .env, never client-side | CONFIRMED | Keys read from env in `src/config.js`; views receive only booleans (`aiConfigured`) and model id lists (`AI_MODELS`). No apiKey/token values rendered in any view. Only hardcoded secret in repo is the C1 fallback. |
| CORS: same-origin only | CONFIRMED | No `cors` middleware or dependency in `package.json`. |
| OAuth state: single-use, deleted after callback | CONFIRMED | `src/routes/auth.routes.js:40-44` — state looked up, platform-bound, deleted immediately after callback. |
| Upload path traversal: safe filenames, basename-only URLs | CONFIRMED | `src/services/upload.js:8-11` — `Date.now()` + `crypto.randomBytes(6).toString('hex')` + sanitized extension (`slice(0, 10)`); URLs built from `path.basename` only (`posts.routes.js:223,239`). |
| Dependencies: npm audit clean, maintained | CONFIRMED | `npm audit` ran live: 0 vulnerabilities. Deps current: express 4.21.2, ejs 3.1.10, multer 2.2.0, nodemailer 9.0.5, better-sqlite3 11.10.0. |

## Missed-by-audit sweep

Grep categories requested (hardcoded secrets, missing auth middleware, raw SQL concatenation, unescaped output): **nothing new found**.

- Hardcoded secrets: only the C1 fallback secret in `config.js:9`. No committed keys (git tracks only `.env.example`; `.env` is gitignored — verified via `git ls-files`).
- Missing auth middleware: all state-changing routes are mounted after `requireAuth` (`src/app.js:40-47`). Public surface is intentional: `/`, `/terms`, `/privacy`, `/healthz`, `/login`, `/logout`, `/web/static`.
- Raw SQL concatenation: none with user input.
- Unescaped output: none.

Two uncited variants of existing findings (not new categories, no separate IDs assigned):
1. `GET /login` (already authenticated) redirects raw `req.query.next` without the `startsWith('/')` check — same open-redirect class as M2 (`session.routes.js:14`).
2. Sessions are never validated against the DB — a deleted user's cookie remains valid until expiry — variant of the non-revocable-session point in M3.

## Minor imprecision notes (no impact on findings)

- H3 cites `publisher.js:102` for the `'publishing'` update; the statement actually spans lines 101-103. Semantics identical.
- M6 "YouTube up to 10 min" is an `AbortSignal.timeout` on the upload request (youtube.js:134), not a polling loop like IG/TikTok. The claim's substance (long publish holds the lock) holds.
- M1/M2 nginx statements refer to the post-certbot state; the repo's `nginx-socio.conf` is plain HTTP `listen 80`, with TLS + redirect added by `install.sh`'s `certbot --nginx --redirect` step.

## Conclusion

All 18 findings (C1-C2, H1-H4, M1-M6, L1-L6) and all 8 Verified-clean claims in `securityaudit.md` are accurate against the current codebase. No fabricated line numbers or behavior mismatches. Priority order proposed by the audit (C1 → H3 → C2 → H1 → H2 → H4 → M1-M3 → rest) remains valid.
