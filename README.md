# CoWork

A project, todo and habit app for couples. Each partner keeps their own projects, todos and habits, sees the other's progress (read-only), and can suggest todos to each other. Built mobile-first as an installable PWA.

**Stack:** Astro (static, TypeScript strict) + Preact islands · Cloudflare Pages Functions with Hono · D1 · R2 · a cron Worker for reminders · Web Push (VAPID) · Google OAuth (PKCE) · Vitest.

```
src/                 Astro pages + Preact islands (one island per page), styles, client libs
  content/copy.ts    all user-facing copy
  styles/tokens.css  design tokens (colours, type, spacing, radii) for light + dark
functions/api/       Pages Function entry ([[route]].ts) that mounts the Hono app
server/              Hono app: routes, auth (Google OIDC, sessions, CSRF), services (D1/R2/push)
shared/              pure logic used everywhere: time zones, recurrence, streaks, authz rules, schemas, Web Push crypto
workers/reminders/   cron Worker (*/5): materialises today's instances, sends due reminders
migrations/          D1 SQL migrations (append-only)
tests/               Vitest (pure logic + route tests against real migrations on node:sqlite)
scripts/             seed, VAPID key generator, icon renderer
docs/PLAN.md         short architecture plan
```

## Local development

Requirements: Node 22.13+ (Node 24 recommended; tests use the built-in `node:sqlite`).

```sh
npm install
cp .dev.vars.example .dev.vars          # then fill it in (see below)
npm run db:migrate:local                 # local D1 (stored in .wrangler/)
npm run db:seed -- you@example.com partner@example.com
npm run preview                          # build + wrangler pages dev → http://localhost:8788
```

`wrangler pages dev` serves the built site, runs the Functions, and gives you a local D1 and a local R2 bucket. You don't need any cloud resources for this.

**`.dev.vars`:** `npm run vapid` prints a VAPID pair. Generate a session secret with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Set `SUPER_ADMIN_EMAIL` to the first email you seeded. For real Google sign-in, put your OAuth client in `GOOGLE_CLIENT_ID`/`SECRET`.

**Signing in locally without Google:** with `DEV_LOGIN=true` in `.dev.vars`, open
`http://localhost:8788/api/auth/dev-login?email=you@example.com`. It applies the same invite rules as Google sign-in. It only works when the variable is set *and* the request is to localhost; it is never set in Cloudflare. Use a second browser profile with the partner's email to test both sides.

**Seeding:** `npm run db:seed -- a@x.com b@x.com` wipes and recreates two paired demo users, with projects, a private project, habits with streak history, a carried-over todo and a pending suggestion. The second email is invited. The first should be your `SUPER_ADMIN_EMAIL`.

**UI hot reload:** run `npm run dev:api` (Functions on :8788, after one `npm run build`) and `npm run dev` (Astro on :4321) in two terminals. Vite proxies `/api` to 8788 without rewriting Host/Origin, so cookies, CSRF and OAuth redirects behave the same.

## Build, test, typecheck

```sh
npm run typecheck   # astro check (UI) + tsc for server/worker/tests
npm test            # vitest: recurrence, time zones, streaks, authz rules, API routes, push crypto, ID tokens, reminders
npm run build       # static site → dist/
```

## Deploy

Pushing to `main` runs `.github/workflows/ci.yml`: install, typecheck, test, build, then **apply D1 migrations → deploy Pages → deploy the reminders Worker**. These steps run in order and the job stops at the first failure, so a failed migration means nothing is deployed. Pull requests only typecheck, test and build.

Manual deploy (same steps):

```sh
npm run build
npm run db:migrate:remote
npm run deploy:pages
npm run deploy:worker
```

## Adding a migration

Never edit a migration that has been applied; add a new file instead.

```sh
npx wrangler d1 migrations create cowork describe_the_change   # creates migrations/0002_describe_the_change.sql
# write plain SQL, then:
npm run db:migrate:local && npm test
```

Tests run every file in `migrations/` in order. CI applies new migrations to production before deploying code, so keep migrations backward compatible with the currently deployed code (add columns or tables first; drop them in a later release).

## Content, design tokens and fonts

- **Copy:** `src/content/copy.ts` holds every headline, empty state and error. Page titles live in `src/pages/*.astro`.
- **Tokens:** `src/styles/tokens.css` defines the palette (paper, cocoa ink, clay accent, sage = done, honey = streaks, plum = partner), category colours, radii, spacing and type scale. Dark mode is the same token set redefined under `prefers-color-scheme: dark` and `[data-theme='dark']`. Light-theme accents were checked to meet WCAG AA on their tints.
- **Components:** `src/styles/global.css` (no CSS framework).
- **Fonts:** Fraunces (display, "soft" variable cut) and Figtree (text, variable), self-hosted from Fontsource. `src/styles/fonts.css` points `@font-face` at the latin-subset woff2 files only, with `font-display: swap`, and the layout preloads them. To swap a face, install another `@fontsource-variable/*` package and change those URLs.
- **Icons:** `src/components/icons.ts` (inline SVG). The PWA icons are rendered by `npm run icons`.

## One-time setup checklist

Steps marked ✅ were already done from this machine on 2026-10-07 with your logged-in wrangler.

1. **D1 + R2** ✅
   - `wrangler d1 create cowork` created DB `73211149-76f7-499c-9648-7df2a985fd2b`. It's already in `wrangler.toml` and `workers/reminders/wrangler.toml`.
   - `wrangler r2 bucket create cowork-photos` created the bucket. Its public r2.dev URL is disabled, so keep it that way.
   - `wrangler pages project create cowork --production-branch main` created the project at https://cowork-48h.pages.dev.
   - The initial migration has been applied remotely.
2. **Google OAuth client** (you): Google Cloud Console → APIs & Services → Credentials → *Create credentials* → *OAuth client ID* → *Web application*.
   - Authorized redirect URIs:
     - `https://cowork.arnavg.me/api/auth/google/callback`
     - `http://localhost:8788/api/auth/google/callback`
     - `http://localhost:4321/api/auth/google/callback`
     - `https://cowork-48h.pages.dev/api/auth/google/callback` (optional, to test before the domain is attached)
   - On the OAuth consent screen, the scopes are `openid`, `email` and `profile`. While the app is in "Testing", add both of your Google accounts as test users (or publish it).
3. **VAPID keys** ✅ A pair was generated in memory and set as secrets on both the Pages project and the Worker; it was never written to disk. To rotate: run `npm run vapid` and set both secrets on both targets (step 4). Existing browser subscriptions then need re-enabling in Settings.
4. **Secrets**
   - Cloudflare Pages: `SESSION_SECRET`, `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are ✅ set. You still need to set:
     ```sh
     npx wrangler pages secret put GOOGLE_CLIENT_ID     --project-name cowork
     npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name cowork
     npx wrangler pages secret put SUPER_ADMIN_EMAIL    --project-name cowork
     # (rotating any of these later)
     npx wrangler pages secret put SESSION_SECRET       --project-name cowork
     npx wrangler pages secret put VAPID_PUBLIC_KEY     --project-name cowork
     npx wrangler pages secret put VAPID_PRIVATE_KEY    --project-name cowork
     ```
     Pages secrets apply to new deployments, so redeploy afterwards (push to `main`, or `npm run build && npm run deploy:pages`).
   - Reminders Worker: `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are ✅ set. To rotate:
     ```sh
     npx wrangler secret put VAPID_PUBLIC_KEY  --config workers/reminders/wrangler.toml
     npx wrangler secret put VAPID_PRIVATE_KEY --config workers/reminders/wrangler.toml
     ```
   - GitHub Actions (you): repo → Settings → Secrets and variables → Actions → *New repository secret*, or with the GitHub CLI:
     ```sh
     gh secret set CLOUDFLARE_API_TOKEN  --repo ArnavGuptaTheDev/cowork
     gh secret set CLOUDFLARE_ACCOUNT_ID --repo ArnavGuptaTheDev/cowork --body cc4f813bc1be5518c9940738e0bf44bd
     ```
5. **Cloudflare API token for CI** (you): dash → My Profile → API Tokens → *Create Custom Token*. Scope it to your account only, with these permissions:
   - Account · **Cloudflare Pages** · Edit: deploy Pages.
   - Account · **D1** · Edit: apply migrations.
   - Account · **Workers Scripts** · Edit: deploy the Worker and its cron trigger.

   Nothing else is needed: the Worker uses no routes or zones, and CI never creates R2 buckets. If a Pages deploy ever complains about validating the R2 binding, add Account · **Workers R2 Storage** · Read.
6. **Custom domain** (you): dash → Workers & Pages → `cowork` → *Custom domains* → *Set up a custom domain* → `cowork.arnavg.me`. If `arnavg.me` uses Cloudflare DNS, the CNAME is created for you. Otherwise add `CNAME cowork → cowork-48h.pages.dev` at your DNS provider. `APP_ORIGIN` is already `https://cowork.arnavg.me` in both wrangler configs.

After steps 2, 4 and 6, sign in at https://cowork.arnavg.me with the `SUPER_ADMIN_EMAIL` account, open **Settings → Invites (admin)**, invite your partner, then pair from **Settings → Partner**.

## Security model

- **Sign-in:** Google authorization-code flow with PKCE, plus `state` and `nonce` in an HMAC-signed, HttpOnly, 10-minute cookie. The ID token is verified against Google's JWKS (RS256, issuer, audience, expiry, nonce), and `email_verified` is required. Only `SUPER_ADMIN_EMAIL` or an invited email can get an account. Anyone else is sent to `/not-invited` and nothing is written.
- **Sessions:** a 256-bit random token in an `HttpOnly; Secure; SameSite=Lax` cookie. D1 stores only `HMAC-SHA256(SESSION_SECRET, token)`. Sessions expire after 30 days and slide while in use. Logout deletes the row. Revoking an invite deletes all of that user's sessions.
- **CSRF:** every mutating request needs the per-session `X-CSRF-Token` (from `/api/me`), and a cross-origin `Origin` header is rejected.
- **Authorisation:** every `/api` route requires a session. Writes are owner-only. Reads of another user require a mutual partnership and exclude private todos and private projects. Photos follow the same rules, and suggestion photos are visible only to the suggester and the recipient. The rules live in `shared/authz.ts` and are tested both as pure functions and through the real routes.
- **Input:** all bodies and queries are validated with Zod (`shared/schemas.ts`, strict objects). Uploaded photos are type-checked by magic bytes, capped at 4 MB, and served with `Content-Security-Policy: sandbox` and `nosniff`.
- **Pages:** Astro's built-in CSP hashes every script and style. The repo contains no secrets; see `.dev.vars.example` and `.env.example`.

## Decisions

- **Instances, not just rules.** A todo is a template. Each occurrence is a `todo_instances` row with its own status. Recurring todos are materialised up to today, lazily on read and by the cron Worker, so history and streaks never change when a rule is edited. Future occurrences in Week/Month are projected from the rule and not stored.
- **No retroactive misses.** Creating a recurring todo with a past start date, or turning a one-off into a recurring one, starts the history today. Earlier days are never filled with "missed".
- **Carry-over.** Unfinished one-off todos show in Today with a "From yesterday" chip until done. Once ticked off, they stay in that day's Today list. Missed recurring instances are marked `missed` at the owner's local midnight and are not carried over.
- **Streaks** count consecutive done *occurrences*, so a Mon/Wed/Fri habit isn't broken by Tuesday. Today's still-pending occurrence doesn't break a streak. The completion rate is done ÷ (done + missed) over the last 30 days.
- **Monthly on the 29th–31st** falls on the last day of shorter months.
- **Weeks start on Monday.**
- **Project progress** counts one-off todos (done / total). Recurring todos in a project show their streak and rate instead, since they never "finish".
- **Private projects.** Besides private todos, a whole project can be private, hiding the project and all its todos and photos from the partner.
- **Partner "everything done" push** fires once per user per local day (de-duplicated in `notification_log`), counting private todos too. The message reveals nothing about them.
- **Reminders** are sent by the cron Worker within a 30-minute grace window, and each instance is claimed before sending, so overlapping runs never double-send. After an outage, stale reminders are dropped rather than sent late. Editing a reminder or changing time zone re-arms the upcoming ones.
- **Suggestions** have the same fields as a todo, including photos, which move to the accepted todo. Accepting lets the recipient pick a project and privacy. Unpairing withdraws pending suggestions both ways. Accepting is claimed atomically, so a double tap can't create two todos.
- **Pairing codes** are 8 characters from an unambiguous alphabet, valid for 15 minutes, stored hashed and single-use. A share link (`/settings?pair=CODE`) pre-fills the code. One partner per user is enforced by a unique index on `users.partner_id`.
- **Revoking an invite** keeps the person's data but signs them out everywhere, unpairs them and drops their push subscriptions.
- **Deleting** a todo deletes its history and photos (including the R2 objects). Use "Stop repeating after today" to end a habit but keep its record.
- **Time zones.** Defaults to Asia/Kolkata and can be changed in Settings. Everything is stored as UTC epoch ms. Calendar days are local `YYYY-MM-DD` strings in the owner's zone, so two partners in different zones each get their own midnight.
- **Images** are resized client-side to a 1600 px long edge and encoded as WebP (JPEG where the browser can't encode WebP), at most 12 per todo, completion or suggestion.
- **Static pages + client-side data.** Pages are prebuilt and each page has one Preact island that loads its data from the API. Signed-out visitors are redirected by the API's 401, and nothing private is ever in the HTML.
- **Web Push without dependencies.** RFC 8291 encryption and VAPID signing use WebCrypto (`shared/webpush.ts`), so they run in Workers. A round-trip test decrypts the payload as a browser would.
- **TypeScript 6.** TypeScript 7 is out, but `@astrojs/check` doesn't support it yet.
- **Local dev login.** `/api/auth/dev-login` exists only to test two accounts locally. It requires `DEV_LOGIN=true` and a localhost URL, and still enforces invites.
