# socio

Lightweight social media scheduler that runs on a 1 GB RAM instance.

- **Node.js + Express + SQLite** (better-sqlite3, WAL mode) — no Redis, no Postgres
- **EJS + HTMX + Tailwind + Alpine** — server-rendered UI, no build step
- **OpenRouter AI captions** — pick a tone, length and topic, get a caption
- Compose once, tick the platforms you want, post now or schedule
- In-process scheduler (polls every 30 s, retries with backoff, no cron needed)

## Quick start

```bash
cp .env.example .env   # then fill in credentials
openssl rand -hex 32   # put the output in SESSION_SECRET
npm install
node src/scripts/users.js add yourname      # create your login (first user)
npm start              # http://localhost:3000 → sign in
```

Pages: `/` landing (public) · `/login` sign in · `/dashboard` stats · `/compose` write a post · `/posts` history · `/accounts` connect · `/settings` OpenRouter key.

## Access control

The app is invite-only: every page behind `/login` requires a session, and only users you create can sign in.

```bash
npm run add-user yourname          # prompts-free: creates user (generates a password if you omit it)
npm run remove-user yourname
npm run list-users
```

Passwords are stored as salted scrypt hashes; sessions are signed HMAC cookies that last 30 days. Uploaded media is served only to authenticated users. Set a strong `SESSION_SECRET` in `.env` (the install script generates one automatically on the server).

## Platform support

| Platform | Status | API |
|---|---|---|
| LinkedIn | ✅ | UGC Posts API (`w_member_social`), direct media upload |
| Facebook | ✅ | Graph API (text / photos / videos via multipart) |
| Instagram | ✅ | Graph API container → publish; video via resumable upload, image needs a public `BASE_URL` |
| YouTube | ✅ | Data API v3 resumable upload (videos only) |
| TikTok | ✅ | Content Posting API Direct Post, chunked `FILE_UPLOAD` (videos only, audit required for public posts) |
| WhatsApp | 🔜 later | Cloud API broadcast mode (messaging, not a feed) |

## Setup: LinkedIn

1. Create an app at https://www.linkedin.com/developers/apps
2. In the app, add the **Share on LinkedIn** product (grants `w_member_social`)
3. Set the OAuth redirect URL to `http://localhost:3000/auth/linkedin/callback` (or your instance URL)
4. Put `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in `.env`
5. Open `/accounts` → **Connect LinkedIn**

Notes:
- Access tokens expire (~60 days); a refresh token is used automatically, or use the "Refresh token" button.
- Text posts are limited to 3000 characters.

## Setup: Facebook + Instagram (one Meta app)

1. Create a **Business type** app at https://developers.facebook.com/apps and pick the use cases **"Manage everything on your Page"** + **"Manage messaging & content on Instagram"** (adds Facebook Login for Business + Instagram Graph API).
2. **Facebook Login for Business → Settings → Valid OAuth Redirect URIs:** add `http://localhost:3000/auth/meta/callback` (and `https://vektorlabs.xyz/auth/meta/callback` later).
3. **Facebook Login for Business → Configurations → Create configuration:**
   - Access token type: **User access token**
   - Assets: Facebook Pages + Instagram accounts
   - Permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`
   - Save, copy the **Configuration ID**
4. `META_CLIENT_ID` + `META_CLIENT_SECRET` + `META_CONFIG_ID` in `.env` → **Connect Meta** on `/accounts`
5. Connecting imports every Facebook page you admin + every linked Instagram business account as separate accounts
6. Testing as the app admin works in **Development** mode (no App Review); other users need review + Live mode

Notes:
- Instagram must be a **business/creator** account linked to a page you admin; text-only posts are not possible on Instagram.
- IG **videos** use Meta's resumable upload (no public URL needed). IG **images** are fetched by Meta from your server, so `BASE_URL` must be a public HTTPS domain.
- Facebook page tokens don't expire; the user token (60 days) is stored and refreshed when needed.

## Setup: YouTube

1. Google Cloud project → enable **YouTube Data API v3**
2. OAuth consent screen (External) → add your domain, set redirect URI `http://localhost:3000/auth/youtube/callback`
3. Create OAuth Client ID (Web application), put `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in `.env`
4. **Connect YouTube** on `/accounts` (scope: `youtube.upload`). Videos only — images/text won't post.

Note: API projects created after July 2020 that haven't passed Google's compliance audit can only upload as **private** — pick "Private" in the compose YouTube settings until yours is verified.

## Setup: TikTok

1. App at https://developers.tiktok.com with **Content Posting API** product + **Direct Post** config
2. Add the redirect URI — **must be HTTPS** — `https://your-domain.com/auth/tiktok/callback`
3. `TIKTOK_CLIENT_KEY` + `TIKTOK_CLIENT_SECRET` in `.env` → **Connect TikTok** on `/accounts`
4. When TikTok is selected in Compose, you get the required per-post controls: privacy level (from the creator's options), commercial-content disclosure, consent checkbox, and an AI-content toggle

Caveats (TikTok policy, not code):
- Until your app passes TikTok's **content-posting audit**, posts are forced to private view (`SELF_ONLY`) with a ~5-user daily cap
- Photos require a TikTok-verified domain URL — only **videos** are supported here
- Access tokens last 24 h; socio refreshes them automatically with the refresh token
- A video can take a few minutes (occasionally longer with moderation) to appear; socio keeps polling the publish status

## Setup: AI captions

1. Get a key at https://openrouter.ai/keys
2. Add it in `/settings` (or `OPENROUTER_API_KEY` in `.env`)
3. On `/compose`, enter a topic, pick tone/length, hit **Generate caption**, then **Use this caption**

The model is configurable in `/settings` (default `openai/gpt-4o-mini`; free models like `meta-llama/llama-3.3-70b-instruct` work too).

## Deploying on a 1 GB VPS (Oracle Cloud free instance)

Domain: `vektorlabs.xyz` (A record → `141.148.15.111`).

1. **DNS:** A record `vektorlabs.xyz` → `141.148.15.111` (already set at Namecheap).
2. **OCI console:** VCN → subnet Security List → add ingress rules for TCP 80 and TCP 443.
3. **Instance OS firewall** (Oracle Ubuntu images use iptables):
   ```bash
   sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
4. **Deploy** (installs Node 22, nginx, certbot; sets up the systemd service + TLS for vektorlabs.xyz):
   ```bash
   git clone git@github.com:ryomenhaider/socio.git && cd socio
   bash deploy/install.sh /home/ubuntu/socio
   ```
5. **Configure:**
   ```bash
   vim /home/ubuntu/socio/.env   # paste API credentials
   cd /home/ubuntu/socio && node src/scripts/users.js add you  # create your login
   sudo systemctl restart socio
   ```
6. **OAuth redirect URIs** (add in each developer console):
   - LinkedIn: `https://vektorlabs.xyz/auth/linkedin/callback`
   - Meta: `https://vektorlabs.xyz/auth/meta/callback`
   - Google: `https://vektorlabs.xyz/auth/youtube/callback`
   - TikTok: `https://vektorlabs.xyz/auth/tiktok/callback`

Ops:
```bash
systemctl status socio
journalctl -u socio -f
sudo certbot renew --dry-run
tar czf backup.tar.gz data/   # full backup: SQLite db + media
```

## Data

Everything lives in `data/`: `socio.db` (SQLite) and `media/` (uploads). Back up the directory to back up everything.

## Roadmap

- WhatsApp broadcast mode (Meta Cloud API — messaging, not a feed)
- Multiple media per post (carousels), post drafts, analytics from platform webhooks
