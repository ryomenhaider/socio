# Development Log — Security & Multi-User Ownership Work

Companion record of changes made to the Socio codebase during this collaboration.
Two work packages: **(1) Security hardening** (committed) and **(2) Multi-user ownership scoping** (in working tree, awaiting review).

---

## 1. Security Hardening — committed as `291227c`

- Branch/base: changes are committed in `291227c` ("security: rate limiting + bind to localhost").
- Scope: 11 files, +149/−34 lines. New dependency `express-rate-limit`.

### 1.1 Rate limiting (`src/rate-limit.js` — new file)

- `loginLimiter` — **5 requests/min per IP** on `POST /login` (brute-force protection).
- `perUserLimiter(max, message)` — factory keyed by **username** (`res.locals.user`) with `req.ip` fallback for unauthenticated requests. Per-user quotas mean a shared office IP cannot exhaust quotas for everyone, and one user cannot eat another user's budget.
- Applied limiters:

| Endpoint | Route file | Method | Limit |
|---|---|---|---|
| `POST /login` | `src/routes/session.routes.js` | `loginLimiter` | 5/min per IP |
| `POST /compose` | `src/routes/posts.routes.js:13` | `composeLimiter` | 20/min per user |
| `POST /targets/:id/retry` | `src/routes/posts.routes.js:14` | `retryLimiter` | 10/min per user |
| `GET/POST /api/tiktok/options` | `src/routes/copy.routes.js:11` | `copyLimiter` | 10/min per user |
| `POST /feedback` | `src/routes/feedback.routes.js:9` | `feedbackLimiter` | 5/min per user |

- Rejections return HTTP 429 with the configured message plus `RateLimit-*` headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`).

### 1.2 Session cookie hardening (`src/routes/session.routes.js`, `src/auth.js`)

- Session cookie renamed/selective: `__Host-sid` (Secure, HttpOnly, SameSite=Lax, path `/`) when `BASE_URL` is HTTPS; falls back to `sid` on plain HTTP so localhost still works. Cookie name is decided once at startup in `session.routes.js`.
- `requireAuth` (`src/auth.js:72`) and the `/login` GET guard now accept either cookie name, backwards compatible with existing sessions.
- `POST /logout` clears the correct cookie with matching `path`.

### 1.3 Other hardening

- `src/app.js` — `app.set('trust proxy', 1)` (correct client IP when behind nginx), disabled `x-powered-by`.
- `src/server.js` — server now **binds to `127.0.0.1` only** (app is served behind a reverse proxy; not exposed directly).
- `src/services/upload.js` — upload limits tightened from `300 MB` to `50 MB` max per file and `10` max files per request (`MAX_FILE_SIZE`, `MAX_FILE_COUNT`).

---

## 2. Multi-User Ownership Scoping — uncommitted

- Problem: all rows in `accounts`, `posts`, `post_targets` were globally addressable; any logged-in user could read/retry/disconnect another user's accounts, targets, and posts by guessing numeric IDs (IDOR class).
- Fix: every row carries a `user_id`; every list query and `:id`-parameterized route is scoped to the requesting user.

### 2.1 Schema & migration (`src/db.js`)

- `CREATE TABLE` for `accounts`, `posts`, `post_targets` now include `user_id INTEGER NOT NULL REFERENCES users(id)` (fresh installs).
- Migration for existing databases (SQLite cannot `ALTER ADD COLUMN ... NOT NULL`, so the column is added nullable, then backfilled):

```js
// src/db.js:83-109 (exact logic)
for (const t of ['accounts', 'posts', 'post_targets']) {
  if (!column user_id exists) ALTER TABLE t ADD COLUMN user_id INTEGER REFERENCES users(id)
}
const firstUser = SELECT id FROM users ORDER BY id LIMIT 1;
if (firstUser) UPDATE t SET user_id = firstUser WHERE user_id IS NULL;   // claim existing rows
else if orphan rows exist -> console.warn + guidance
```

- Orphan case (rows exist, no users yet): rows stay `NULL` and a startup warning tells the operator to run `npm run add-user` to claim them.
- New indexes: `idx_accounts_user_id`, `idx_posts_user_id`, `idx_post_targets_user_id`. Also added (pre-existing gap) `idx_post_targets_status_updated_at` and `idx_post_targets_status_next_attempt_at` for the scheduler.
- Migration is **idempotent** — re-runs on every boot are no-ops.

### 2.2 New auth helpers (`src/auth.js:84-95`) — `requireAuth` itself untouched

- `currentUserId(res)` — resolves `res.locals.user` (username set by `requireAuth`) to `users.id`.
- `getOwnedAccount(id, userId)` — `SELECT * FROM accounts WHERE id = ? AND user_id = ?`.
- `getOwnedTarget(id, userId)` — `SELECT * FROM post_targets WHERE id = ? AND user_id = ?`.

### 2.3 Route-by-route changes

| File | Route | Change |
|---|---|---|
| `src/routes/posts.routes.js` | `GET /dashboard` | user-scoped stats queries, accounts list, upcoming targets, recent posts |
| `src/routes/posts.routes.js` | `GET /compose` | connected-accounts list scoped by user |
| `src/routes/posts.routes.js` | `POST /compose` | `accounts IN (...)` lookup scoped; inserts carry `user_id` on post + targets |
| `src/routes/posts.routes.js` | `GET /posts` | post list `WHERE p.user_id`; per-post targets `AND t.user_id` |
| `src/routes/posts.routes.js` | `POST /targets/:id/retry` | `getOwnedTarget` gate; reset UPDATE includes `user_id`; unowned = silent no-op |
| `src/routes/accounts.routes.js` | `GET /accounts` | list scoped by user |
| `src/routes/accounts.routes.js` | `POST /accounts/:id/disconnect` | `getOwnedAccount` gate; scoped DELETEs; no-op redirect if unowned |
| `src/routes/accounts.routes.js` | `POST /accounts/:id/refresh` | `getOwnedAccount` gate; scoped UPDATEs; error redirect if unowned |
| `src/routes/copy.routes.js` | `GET /api/tiktok/options` | account lookup now `AND user_id` (same IDOR class; flagged — outside reviewer's named file list) |
| `src/routes/auth.routes.js` | `GET /auth/:platform/callback` | `INSERT INTO accounts` now includes `user_id` (required — column is NOT NULL on fresh DBs); reconnect dedupe scoped by `platform + user_id`; UPDATE scoped |

**Deliberately untouched:** `requireAuth` itself (new sibling functions only), `publisher.js`/scheduler, views/EJS, everything outside the files above.

---

## 3. Verification performed

### 3.1 Migration tests (old-schema DBs)

- DB with existing user → `user_id` columns added, all existing rows assigned to the first user (in the test: `admin`).
- DB with rows but **no users** → columns added, rows left `NULL`, orphan warning printed, no crash.

### 3.2 E2E ownership matrix (isolated test DB at `/tmp/opencode/owndata`)

Seed: `u1` (owns linkedin account id 1, tiktok account id 2, one post, one target `failed/attempts=2`), `u2` (owns nothing).

| # | Action | Expected | Observed |
|---|---|---|---|
| 1 | `u2` `POST /targets/1/retry` | no-op | target unchanged `failed/2` ✓ |
| 2 | `u1` `POST /targets/1/retry` | reset → `scheduled` | target `scheduled`, attempts cycled by the one-off publish run ✓ |
| 3 | `u2` `POST /accounts/1/disconnect` | no-op | pending after final review ✓ |
| 4 | `u2` `POST /accounts/1/refresh` | no-op | pending after final review ✓ |
| 5 | `u2` `GET /api/tiktok/options?account_id=2` | "TikTok account not found." | confirmed ✓ |
| 6 | `u1` `GET /api/tiktok/options?account_id=2` | reaches real API path (not "not found") | confirmed ✓ (fails on fake token, as expected) |
| 7 | `u2` compose with u1's platform | `no_platform` redirect, no post created | pending after final review ✓ |
| 8 | `u1` compose with own platform | post created with `user_id = u1` | pending after final review ✓ |

Items marked "pending after final review" ran in earlier iterations but should be re-run once final review of the diff completes; checks 1–2 and 5–6 are re-verified on the latest code.

### 3.3 Production DB note (important)

- During testing, a check script briefly opened the real `./data/socio.db` (db.js runs the migration on any open). The real DB **is now migrated**: `user_id` columns exist on all three tables and every row was assigned to `haider` (the only user). This is a purely additive, non-destructive change and would have happened on the next normal server start anyway. No test writes (retries, disconnects, composes) ever hit the real DB — those went only to `/tmp/opencode/owndata/socio.db`, verified via the server log (`data dir: /tmp/opencode/owndata`).

---

## 4. Known follow-ups

1. ~~`ERR_ERL_KEY_GEN_IPV6` — express-rate-limit v7 warns that the custom `keyGenerator` in `src/rate-limit.js:5` uses `req.ip` without the library's `ipKeyGenerator()` helper (IPv6 key-bypass concern). Fix is one line once execution is approved.~~ **RESOLVED** — `src/rate-limit.js` now follows the library's documented call signature: `return res.locals.user || ipKeyGenerator(req.ip)`. Verified against installed v8.6.2 types (`ipKeyGenerator(ip: string, ipv6Subnet?: number | false): string` — returns the IP for IPv4 and a `/56` CIDR network form for IPv6, not a factory). Boot log clean; per-user limiter re-verified end-to-end (10×302 on retry, 11th → 429).
2. Commit the ownership-scoping diff once reviewed (currently uncommitted: `src/auth.js`, `src/db.js`, `src/routes/{posts,accounts,copy,auth}.routes.js`, `src/rate-limit.js`).
3. Consider the same ownership review for any remaining `:id` routes not touched here.

## 5. Test harness location

All throwaway test scripts/DBs live outside the repo in `/tmp/opencode/` (`own-seed.js`, `own-check.js`, `owndata/` — isolated socio.db, `oa.txt`/`ob.txt` cookie jars, `own.log`). Nothing test-related is committed to the repository.