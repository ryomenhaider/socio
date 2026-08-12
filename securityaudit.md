Audit complete — I read every source file, view, script, deploy config, and verified git tracking + npm audit. Report follows.
Socio Security Audit
Stack: Express 4.21.2, better-sqlite3 11.x (WAL), EJS 3.1.10, custom signed-cookie sessions, multer 2.x, nodemailer, server-side scheduler. npm audit: 0 vulnerabilities. .env is gitignored and never committed (verified via git ls-files). All deps are maintained (Express 4.x, multer 2.x, nodemailer 9.x, ejs 3.1.10 — none abandoned).
CRITICAL
C1. Hardcoded session secret — cookie forgery → full account takeover
- File: src/config.js:9
- The fallback sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me' is active on this instance: .env contains no SESSION_SECRET (verified by grep). Any attacker who knows the codebase can compute the HMAC and forge a valid sid for any username (src/auth.js:52-54 — payload is just {username, exp}). verifySession has no other integrity check.
- Fix: Require a real secret: if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET required') in config.js, generate with openssl rand -hex 32, and add it to .env (install.sh already does this — the repo's own .env just hasn't been updated). Prefer __Host-sid cookie name + prefix.
C2. No rate limiting anywhere — brute force + OpenRouter cost abuse + disk DoS
- Files: src/routes/session.routes.js:28 (login), src/routes/copy.routes.js:12 (/api/copy), src/routes/feedback.routes.js:29, src/routes/posts.routes.js:81
- No express-rate-limit (or equivalent) anywhere. Consequences:
- Login brute force on scrypt hashes (session.routes.js:28-44) — unlimited guesses, no lockout. High.
- OpenRouter cost abuse: /api/copy fires up to 5 parallel LLM calls (src/services/ai.js:159-169), each up to 900 tokens, with a user-controlled topic of unbounded length (no server-side max — only client maxlength on the textarea), and a user-selectable model (up to gpt-4o). Any authenticated user can drain the API budget. High.
- Feedback spam: /feedback/submit with force=1 skips both length and AI-score gates (src/routes/feedback.routes.js:32,44-65) → unlimited oversized submissions to the mail relay.
- Disk DoS: upload.any() with a 300 MB/file limit and no file-count limit (src/services/upload.js:20-27) → authenticated attacker uploads unlimited 300 MB files to fill the disk.
- Fix: Add express-rate-limit (e.g., 5/min on /login, 10/min on /api/copy + /feedback/submit, 20/min on /compose); cap topic/text server-side (e.g., 3000 chars); cap uploads count in upload.any() (e.g., MAX_COUNT) and lower fileSize to a sane bound; enforce MAX_LENGTH even when force=1.
HIGH
H1. No per-user isolation — any user controls all data (IDOR by design)
- Files: src/db.js:14-67 (schema: users table exists, but posts, accounts, post_targets have no user_id column); src/routes/posts.routes.js:253 (/targets/:id/retry), src/routes/accounts.routes.js:36-61 (disconnect/refresh by id), src/routes/auth.routes.js (all accounts land in one global pool)
- The app ships an add-user script (src/scripts/users.js) supporting multiple users, yet every account, post, and target is global. Any authenticated user can list, retry, delete, or disconnect any account/post by guessing the integer id. requireAuth (src/auth.js:72) checks authentication only, never ownership.
- Fix: Add user_id FK to accounts/posts; scope every query with WHERE user_id = ?; add ownership check in requireAuth for :id params. If this is intentionally single-user, remove the multi-user users table/scripts and document it.
H2. Stored XSS via uploads (SVG / spoofed MIME) served same-origin
- Files: src/services/upload.js:14-18 (filter trusts client-supplied file.mimetype — image/svg+xml starts with image/ and passes), src/app.js:42 (/media served via express.static under the app's origin)
- A malicious user uploads an SVG containing <script> → served from /media/<hash>.svg with Content-Type: image/svg+xml same-origin → executes with the victim's session. Same for an .html file with a spoofed image/png mimetype. No magic-byte validation, no Content-Disposition: attachment, no CSP on /media.
- Fix: Validate magic bytes (PNG/JPEG/GIF/WebP/MP4 signatures) in addition to MIME; hard-deny image/svg+xml, text/html, application/xml, etc.; serve /media with Content-Disposition: inline-safe headers plus X-Content-Type-Options: nosniff and a sandbox CSP (Content-Security-Policy: sandbox or default-src 'none' for that mount).
H3. Scheduler: no cross-instance locking; stuck/dead targets; duplicate posts
- Files: src/services/publisher.js:87-141
- The in-process runOnce.locked flag prevents double-runs within one process, but there is no DB-level lock: two instances (or a node --watch restart overlap, or the crash-restart window in socio.service Restart=always / RestartSec=5) will both select the same status='scheduled' rows and publish duplicates. The lock flag is process-local only.
- Crash window: a target set to 'publishing' (line 102) that crashes mid-publish stays 'publishing' forever — the scheduler only selects status='scheduled' (line 96), so it's never retried and never failed. Also, if the process dies after the external platform post succeeds but before the DB update (lines 105-108), the restart republishes → permanent duplicates.
- Fix: Claim jobs transactionally — db.transaction(() => { UPDATE post_targets SET status='publishing' WHERE id=? AND status='scheduled' }) and check changes === 1 before publishing (works across instances). Add a stale-timeout recovery: treat status='publishing' AND updated_at < now()-10min as failed/retryable. Make external publish idempotent where the API allows (TikTok already reuses external_id — do the same pattern for the crash case), or persist the external id before the publish completes where the API supports two-phase commit.
H4. SQLite DB + WAL files world-readable → local token theft
- Files: src/db.js:6-9, src/server.js:7 — data/ is 755, socio.db, socio.db-wal, socio.db-shm are all 644 (verified via stat)
- On any shared/multi-user host, any local account can read the DB, which contains OAuth access + refresh tokens for LinkedIn/Facebook/Instagram/YouTube/TikTok (accounts.token), plus user password hashes. deploy/socio.service runs as __APP_USER__ with no hardening.
- Fix: fs.chmodSync(config.dataDir, 0o700) and 0o600 for the DB + WAL/SHM after open (chmod 600 on the DB file each startup — SQLite may recreate WAL); run the service under a dedicated user; keep data/ outside the web root.
MEDIUM
M1. Session cookie missing Secure (and __Host-) — session hijack over HTTP
- File: src/routes/session.routes.js:38-42 — only httpOnly + sameSite:'lax'; no secure: true, no path, no __Host- prefix
- App sits behind nginx TLS (deploy/install.sh) but app itself sees http; cookie is transmitted in cleartext if a user hits http://<domain> (nginx config has listen 80 with certbot redirect, but the redirect window still exposes it). express-session isn't used; the cookie is the only credential.
- Fix: res.cookie('sid', ..., { httpOnly: true, secure: config.baseUrl.startsWith('https'), sameSite: 'strict', path: '/', maxAge }) — and set app.set('trust proxy', 1) behind nginx.
M2. Open redirect via next=//evil.com
- File: src/routes/session.routes.js:17,31 — req.query.next.startsWith('/') accepts //evil.com, and res.redirect('//evil.com') resolves as protocol-relative → phishing vector (and login-page only, but it can also be used on POST /login to send victims to a lookalike after entering credentials).
- Fix: Require next to start with / and not //: next.startsWith('/') && !next.startsWith('//'), and whitelist to known paths (e.g., /dashboard, /posts, /compose, /accounts).
M3. No CSRF tokens; only sameSite=lax (defense in depth missing)
- Files: all POST routes (/compose, /logout, /accounts/:id/disconnect|refresh, /targets/:id/retry, /api/copy, /feedback/submit)
- sameSite=lax blocks cross-site POST cookies, so the practical exposure is low today, but there are no CSRF tokens and no Origin/Referer checks on the HTMX endpoints (hx-post in compose.ejs:91, feedback.ejs:11). If anything ever relaxes the cookie flags (M1 fix without strict), or the app gets a browser extension/same-site-subdomain context, every state-changing route becomes CSRF-able. Also logout CSRF is silently tolerated and session tokens are never revocable server-side (stateless cookie, 30-day TTL — src/auth.js:5,52-54; POST /logout merely clears the client cookie).
- Fix: Add a per-session CSRF token (double-submit cookie or signed token in a hidden field checked by middleware) applied to every POST; verify Origin on HTMX requests; make logout server-side revocable by adding a sid nonce table or storing a session id in the token and deleting it on logout (revocation also limits the damage of a stolen cookie).
M4. Internal error details leaked to the client
- File: src/app.js:53-60 — 500 handler renders String(err.message || err); src/routes/copy.routes.js:26-31 and feedback.routes.js:101-110 render err.message into HTML partials
- Provider error bodies (paths, fs errors, API internals) get displayed to the user. Not credentials today, but it's an information-disclosure habit that will eventually leak a token/path.
- Fix: Log full error server-side; render only a generic "Something went wrong" to the client.
M5. /media served behind auth — Instagram public-URL fetch breaks (and media exposure semantics)
- File: src/app.js:42 (mounted after requireAuth), src/platforms/meta.js:314-319 (builds {baseUrl}/media/{name} as a public URL for IG)
- Two issues: (1) Meta's Graph API fetching that URL gets a 401 → Instagram image posts silently fail on any public deployment (functional); (2) if you "fix" it by moving /media in front of auth, all uploaded media becomes world-readable, including draft media. Decide explicitly.
- Fix: Serve /media via a separate authenticated endpoint that allows an expiring signed URL for Meta only (or upload IG images directly to Meta's upload endpoint instead of pulling a public URL); keep the auth gate.
M6. next_attempt_at backoff okay, but retry endpoint allows API abuse + scheduler lock monopolization
- Files: src/routes/posts.routes.js:253-262, src/services/publisher.js:82-85
- POST /targets/:id/retry resets attempts=0 and immediately runs runOnce(); an authenticated user can hammer it, generating repeated publish attempts (platform API rate-limit spam and duplicate post attempts). Meanwhile any long publish (IG polls up to 4 min, TikTok up to 2 min, YouTube uploads up to 10 min — meta.js:284-295, tiktok.js:210-219) holds the process-wide lock, stalling the whole queue and making POST /compose ... publish_mode=now block for minutes.
- Fix: Rate-limit /targets/:id/retry; run publishes with a concurrency pool instead of a global serialized lock (the DB claim from H3 makes the in-process lock unnecessary); don't await runOnce() in the compose request path — redirect immediately and let the scheduler pick it up.
LOW
- L1. oauth_states never expire — src/routes/auth.routes.js:16-20 inserts states with no TTL and no cleanup; the table grows forever (minor). Add expires_at + periodic purge.
- L2. No security headers — src/app.js — no CSP, X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy. Add helmet (or the handful of headers manually). Note the app already loads Tailwind/HTMX/Alpine from CDNs without SRI (head.ejs:24,49,50) — pin + integrity attributes if you keep CDNs.
- L3. No server-side length enforcement on post text/topic — posts.routes.js:82 relies on client maxlength; oversized text → DB bloat and platform API failures. Truncate/validate server-side (3000–5000 chars per platform).
- L4. users.js script prints generated passwords to stdout — src/scripts/users.js:32 (terminal history leak). Prompt for the password instead.
- L5. No request-body size limits set explicitly — app.js:20-21 relies on Express defaults (100kb urlencoded/json). Fine today, but state them explicitly; also express.urlencoded({extended:true}) uses qs (patched, but pin it).
- L6. Error messages from provider APIs include response bodies — e.g., ai.js:127 (body.slice(0,300)) and platform token errors — could embed provider-side user info; truncate and log only.
Verified-clean (checked per your brief)
- SQL injection: all queries are prepared statements; the only interpolation is db.exec with static strings (db.js:14-77) and the IN (...) placeholder expansion (posts.routes.js:98). No exec() with user input.
- EJS escaping: all user-controlled values render via <%= (escaped); <%- is used only for static include() of partials. No x-html/v-html/innerHTML on user data anywhere (grep-verified).
- Password hashing: scrypt with per-user salt + timingSafeEqual (auth.js:7-19). No plaintext/md5/sha1.
- Secrets: OpenRouter key only in .env (never in git, never logged, never sent to the client — views get booleans/model ids only, ai.js key stays server-side). All OAuth client secrets server-side.
- CORS: no CORS middleware → same-origin only (not permissive).
- OAuth state: generated server-side, single-use, deleted after callback (auth.routes.js:40-44), bound to platform.
- Upload path traversal: safe — filenames are Date.now() + random hex (upload.js:8-11), basename-only used when building URLs (posts.routes.js:223,239).
- Dependencies: npm audit clean; no abandonware.
Priority order to fix: C1 (session secret) → H3 (scheduler locking) → C2 (rate limits) → H1 (ownership scoping) → H2 (upload XSS) → H4 (file perms) → M1–M3 (cookie/redirect/CSRF) → rest.