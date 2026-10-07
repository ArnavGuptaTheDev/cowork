# CoWork

A project, todo and habit app for couples. Each partner keeps their own projects, todos and habits, sees the other's progress, and can share todos and projects, react, nudge, comment and suggest todos. It's built mobile-first as an installable PWA, and it works on desktop too.

## Features

- **Todos.** Each todo has a title, notes, project, category (personal, work or habit), due and reminder times, and photos. They can repeat daily, weekly (on chosen weekdays) or monthly.
  - **Today:** missed repeating occurrences are marked missed, and unfinished one-offs carry over.
  - **Planning:** Week and Month calendars with drag-to-reschedule, and projects with a progress bar.
  - **Habits:** streaks and completion rates.
- **Partner.**
  - **Basics:** pairing by code or link, a read-only view of each other's day, private todos and private projects, and suggestions with accept/deny.
  - **Sharing:** shared todos and shared projects, with an assignee of me, partner or either. Either of you can complete them, and the app records who did.
  - **Interaction:** emoji reactions on completions, nudges (one per todo every 3 hours) and comment threads.
  - **Together:** joint habits that only count when both of you do them, and shared weekly goals.
- **Quick add.** Type "gym mon wed fri 7am #health" or "book dentist for partner tomorrow": a preview shows what it understood, and "More options" opens the full form.
- **Structure.** Checklists (subtasks) whose ticks reset for each occurrence, and templates of todos you can apply in one tap and share.
- **Insight.** A weekly review with completion rate, by-weekday and by-category charts, best and worst day, streaks and time tracked, for both of you side by side. A photo timeline of every completion photo.
- **Time.** Start and stop a timer on a todo (one at a time; it survives reloads), edit entries by hand, and see totals per todo, per project and in the review.
- **Reminders.** Web Push with Done / Snooze 1h / Tomorrow buttons, an evening wrap-up push (21:00 by default) that opens a wrap-up screen for leftovers, and pause mode for holidays (no reminders or nudges, streaks freeze).
- **Integrations.** Optional one-way sync to a "CoWork" Google Calendar, and export of your data as JSON or CSV.

**Stack:** Astro (static, TypeScript strict) + Preact islands · one Cloudflare Worker (static assets + Hono API + cron) · D1 · R2 · Web Push (VAPID) · Google OAuth (PKCE) · Vitest.

```
src/                 Astro pages + Preact islands (one island per page), styles, client libs
  content/copy.ts    all user-facing copy
  styles/tokens.css  design tokens (colours, type, spacing, radii) for light + dark
worker/index.ts      the Worker entry: fetch → Hono app for /api/*, scheduled → reminders
server/              Hono app: routes, auth (Google OIDC, sessions, CSRF), services (D1/R2/push), reminders cron
shared/              pure logic used everywhere: time zones, recurrence, streaks, authz rules, schemas, Web Push crypto
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
npm run preview                          # build + wrangler dev → http://localhost:8787
```

`wrangler dev` runs the same Worker as production: it serves `dist/` as assets, runs the API, and gives you a local D1 and a local R2 bucket. You don't need any cloud resources for this.

**`.dev.vars`:** `npm run vapid` prints a VAPID pair. Generate a session secret with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Set `SUPER_ADMIN_EMAIL` to the first email you seeded. For real Google sign-in, put your OAuth client in `GOOGLE_CLIENT_ID`/`SECRET`.

**Signing in locally without Google:** with `DEV_LOGIN=true` in `.dev.vars`, open
`http://localhost:8787/api/auth/dev-login?email=you@example.com`. It applies the same invite rules as Google sign-in. It only works when the variable is set *and* the request is to localhost; it is never set in Cloudflare. Use a second browser profile with the partner's email to test both sides.

**Seeding:** `npm run db:seed -- a@x.com b@x.com` wipes and recreates two paired demo users, with projects, a private project, habits with streak history, a carried-over todo and a pending suggestion. The second email is invited. The first should be your `SUPER_ADMIN_EMAIL`.

**UI hot reload:** run `npm run dev:api` (the Worker on :8787, after one `npm run build`) and `npm run dev` (Astro on :4321) in two terminals. Vite proxies `/api` to 8787 without rewriting Host/Origin, so cookies, CSRF and OAuth redirects behave the same.

## Build, test, typecheck

```sh
npm run typecheck   # astro check (UI) + tsc for server/worker/tests
npm test            # vitest: recurrence, time zones, streaks, authz rules, API routes, push crypto, ID tokens, reminders
npm run build       # static site → dist/
```

## Deploy

CoWork is a single Cloudflare Worker named `cowork`, connected to this GitHub repo through Cloudflare's Git integration (Workers Builds). There is no GitHub Actions workflow and no Cloudflare credentials in GitHub. On every push to `main`, Cloudflare runs:

- **Build command:** `npm run build`
- **Deploy command:** `npm run deploy`, which runs `wrangler d1 migrations apply cowork --remote && wrangler deploy`

Pending migrations are applied first. If they fail, `wrangler deploy` never runs, so the old version stays live. Run `npm run typecheck && npm test` before pushing.

To deploy manually from your machine (logged in with `wrangler login`): `npm run build && npm run deploy`.

## Adding a migration

Never edit a migration that has been applied; add a new file instead.

```sh
npx wrangler d1 migrations create cowork describe_the_change   # creates migrations/0002_describe_the_change.sql
# write plain SQL, then:
npm run db:migrate:local && npm test
```

Tests run every file in `migrations/` in order. The deploy command applies new migrations to production before deploying code, so keep migrations backward compatible with the currently deployed code (add columns or tables first; drop them in a later release).

## Content, design tokens and fonts

- **Copy:** `src/content/copy.ts` holds every headline, empty state and error. Page titles live in `src/pages/*.astro`.
- **Tokens:** `src/styles/tokens.css` defines the palette (paper, cocoa ink, clay accent, sage = done, honey = streaks, plum = partner), category colours, radii, spacing and type scale. Dark mode is the same token set redefined under `prefers-color-scheme: dark` and `[data-theme='dark']`. Light-theme accents were checked to meet WCAG AA on their tints.
- **Components:** `src/styles/global.css` (no CSS framework).
- **Fonts:** Fraunces (display, "soft" variable cut) and Figtree (text, variable), self-hosted from Fontsource. `src/styles/fonts.css` points `@font-face` at the latin-subset woff2 files only, with `font-display: swap`, and the layout preloads them. To swap a face, install another `@fontsource-variable/*` package and change those URLs.
- **Icons:** `src/components/icons.ts` (inline SVG). The PWA icons are rendered by `npm run icons`.

## One-time setup checklist

1. **D1 + R2** ✅ Created with wrangler on 2026-10-07: D1 `cowork` (`73211149-76f7-499c-9648-7df2a985fd2b`, already in `wrangler.toml`, initial migration applied) and the private R2 bucket `cowork-photos` (r2.dev access disabled).
2. **Google OAuth client:** Google Cloud Console → APIs & Services → Credentials → *OAuth client ID* → *Web application*. Add these authorized redirect URIs:
   - `https://cowork.arnavg.me/api/auth/google/callback`
   - `http://localhost:8787/api/auth/google/callback`
   - `http://localhost:4321/api/auth/google/callback`

   Use scopes `openid email profile`. While the app is in "Testing", add both Google accounts as test users.

   **For Google Calendar sync (optional)**, in the same Google Cloud project:
   - APIs & Services → Library → enable the **Google Calendar API**.
   - OAuth consent screen → Data access / Scopes → add `https://www.googleapis.com/auth/calendar.app.created`. It's a sensitive scope: fine while the app is in Testing with your two accounts as test users. Publishing it to everyone would need Google's verification.
   - Add these redirect URIs to the same OAuth client:
     - `https://cowork.arnavg.me/api/calendar/callback`
     - `http://localhost:8787/api/calendar/callback`
     - `http://localhost:4321/api/calendar/callback`
3. **VAPID keys:** run `npm run vapid` and keep the two values for step 5.
4. **Create the Worker from GitHub:** dash → Workers & Pages → *Create* → *Import a repository* → `ArnavGuptaTheDev/cowork`.
   - Project name: `cowork` (it must match `name` in `wrangler.toml`).
   - Build command: `npm run build`.
   - Deploy command: `npm run deploy`.
   - Production branch: `main`.

   The D1, R2, cron and asset settings all come from `wrangler.toml`.
5. **Secrets:** in the Worker, go to Settings → *Variables and Secrets* and add each of these as a **Secret**:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `SESSION_SECRET` (generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `SUPER_ADMIN_EMAIL`
   - `CALENDAR_TOKEN_KEY` (optional; turns on Google Calendar sync). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. It encrypts calendar refresh tokens at rest. Changing it later disconnects everyone's calendar, and they reconnect from Settings.

   Or from the CLI: `npx wrangler secret put <NAME>`. Never set `DEV_LOGIN` in production.
6. **Custom domain:** Worker → Settings → *Domains & Routes* → *Add* → *Custom domain* → `cowork.arnavg.me`.

Then sign in at https://cowork.arnavg.me with the `SUPER_ADMIN_EMAIL` account, open **Settings → Invites (admin)**, invite your partner, and pair from **Settings → Partner**.

## Security model

- **Sign-in:** Google authorization-code flow with PKCE, plus `state` and `nonce` in an HMAC-signed, HttpOnly, 10-minute cookie. The ID token is verified against Google's JWKS (RS256, issuer, audience, expiry, nonce), and `email_verified` is required. Only `SUPER_ADMIN_EMAIL` or an invited email can get an account. Anyone else is sent to `/not-invited` and nothing is written.
- **Sessions:** a 256-bit random token in an `HttpOnly; Secure; SameSite=Lax` cookie. D1 stores only `HMAC-SHA256(SESSION_SECRET, token)`. Sessions expire after 30 days and slide while in use. Logout deletes the row. Revoking an invite deletes all of that user's sessions.
- **CSRF:** every mutating request needs the per-session `X-CSRF-Token` (from `/api/me`), and a cross-origin `Origin` header is rejected.
- **Calendar tokens:** Google refresh tokens are AES-256-GCM encrypted with `CALENDAR_TOKEN_KEY`, bound to the user id. They're never stored in plaintext and never sent to the browser. Disconnecting revokes the token at Google and deletes it.
- **Authorisation:** every `/api` route requires a session. Writes are owner-only, except that both partners may edit a shared todo. Reads of another user require a mutual partnership and exclude private todos and private projects. Photos follow the same rules, and suggestion photos are visible only to the suggester and the recipient. The rules live in `shared/authz.ts` and are tested both as pure functions and through the real routes.
- **Input:** all bodies and queries are validated with Zod (`shared/schemas.ts`, strict objects). Uploaded photos are type-checked by magic bytes, capped at 4 MB, and served with `Content-Security-Policy: sandbox` and `nosniff`.
- **Pages:** Astro's built-in CSP hashes every script and style. The repo contains no secrets; see `.dev.vars.example`.

## Decisions

- **Instances, not just rules.** A todo is a template. Each occurrence is a `todo_instances` row with its own status. Recurring todos are materialised up to today, lazily on read and by the cron trigger, so history and streaks never change when a rule is edited. Future occurrences in Week/Month are projected from the rule and not stored.
- **No retroactive misses.** Creating a recurring todo with a past start date, or turning a one-off into a recurring one, starts the history today. Earlier days are never filled with "missed".
- **Carry-over.** Unfinished one-off todos show in Today with a "From yesterday" chip until done. Once ticked off, they stay in that day's Today list. Missed recurring instances are marked `missed` at the owner's local midnight and are not carried over.
- **Streaks** count consecutive done *occurrences*, so a Mon/Wed/Fri habit isn't broken by Tuesday. Today's still-pending occurrence doesn't break a streak. The completion rate is done ÷ (done + missed) over the last 30 days.
- **Monthly on the 29th–31st** falls on the last day of shorter months.
- **Weeks start on Monday.**
- **Project progress** counts one-off todos (done / total). Recurring todos in a project show their streak and rate instead, since they never "finish".
- **Private projects.** Besides private todos, a whole project can be private, hiding the project and all its todos and photos from the partner.
- **Partner "everything done" push** fires once per user per local day (de-duplicated in `notification_log`), counting private todos too. The message reveals nothing about them.
- **Reminders** are sent by the Worker's cron trigger (every 5 minutes) within a 30-minute grace window, and each instance is claimed before sending, so overlapping runs never double-send. After an outage, stale reminders are dropped rather than sent late. Editing a reminder or changing time zone re-arms the upcoming ones.
- **Suggestions** have the same fields as a todo, including photos, which move to the accepted todo. Accepting lets the recipient pick a project and privacy. Unpairing withdraws pending suggestions both ways. Accepting is claimed atomically, so a double tap can't create two todos.
- **Pairing codes** are 8 characters from an unambiguous alphabet, valid for 15 minutes, stored hashed and single-use. A share link (`/settings?pair=CODE`) pre-fills the code. One partner per user is enforced by a unique index on `users.partner_id`.
- **Revoking an invite** keeps the person's data but signs them out everywhere, unpairs them and drops their push subscriptions.
- **Deleting** a todo deletes its history and photos (including the R2 objects). Use "Stop repeating after today" to end a habit but keep its record.
- **Time zones.** Defaults to Asia/Kolkata and can be changed in Settings. Everything is stored as UTC epoch ms. Calendar days are local `YYYY-MM-DD` strings in the owner's zone, so two partners in different zones each get their own midnight.
- **Images** are resized client-side to a 1600 px long edge and encoded as WebP (JPEG where the browser can't encode WebP), at most 12 per todo, completion or suggestion.
- **One Worker.** The static site, the API and the reminders cron are a single Worker. Static assets are served without invoking the Worker; only `/api/*` runs code.
- **Static pages + client-side data.** Pages are prebuilt and each page has one Preact island that loads its data from the API. Signed-out visitors are redirected by the API's 401, and nothing private is ever in the HTML.
- **Web Push without dependencies.** RFC 8291 encryption and VAPID signing use WebCrypto (`shared/webpush.ts`), so they run in Workers. A round-trip test decrypts the payload as a browser would.
- **TypeScript 6.** TypeScript 7 is out, but `@astrojs/check` doesn't support it yet.
- **Local dev login.** `/api/auth/dev-login` exists only to test two accounts locally. It requires `DEV_LOGIN=true` and a localhost URL, and still enforces invites.

### Partner interaction (phase 1)

- **Shared todos and projects.** "Shared" is a flag on a todo or a project, and a todo in a shared project is shared too. Shared items appear in both partners' Today, Week, Month, Habits and Projects lists. Either partner can edit and complete them, and the instance records `completed_by`. Recurring shared todos follow the creator's time zone and calendar day.
- **What the partner can't do on a shared todo:** move it to another project, make it private, unshare it, or delete it. Only the creator can, so a todo never disappears on someone else's say-so.
- **Shared vs private.** A todo or project can't be both. A project can't be shared while it holds private todos (the API returns 409 until you move them or make them non-private).
- **Assignee.** `assigned_to` stores a user id, or NULL for "either of us". The UI's "me / partner / either" is relative to whoever is editing. Reminders go to the assignee, or to both of you for "either".
- **Unpairing** turns shared todos and projects into normal ones owned by their creator, clears assignees, and takes any todo one partner had put in the other's project out of that project.
- **Reactions.** One reaction per person per completion, from a fixed set (❤️ 🔥 👏 💪 🎉 😂). You can only react to a completion someone else made, on a todo you can see, never a private one.
- **Nudges.** A nudge goes to the person responsible: the owner, or the assignee of a shared todo ("either" means the other person). You can send one per todo per 3 hours (HTTP 429 with the wait time). Done and private todos can't be nudged.
- **Comments** exist only on non-private todos (including todos not in a private project), for owner and partner. Each new comment pushes the other person. Authors can delete only their own comments.
- **Evening wrap-up.** `users.wrapup_time` defaults to 21:00 (NULL = off). The cron sends it once per local day within an hour of that time; `wrapup_sent_on` is claimed first, so overlapping runs can't double-send. Nothing is sent on an empty day. The partner's count leaves out their private todos.
- **Wrap-up actions.**
  - "Drop" deletes a one-off todo, and only its creator sees that action.
  - For a repeating todo it becomes "Skip today", which marks the occurrence missed.
  - "Tomorrow" and "Pick a date" exist only for one-off todos, because repeating todos follow their rule.
- **Quick add** (`shared/quickadd.ts`) is dependency-free and runs entirely in the browser.
  - **Weekday names:** a bare weekday ("fri") means the next one, never today. "next fri" means the Friday of next week (weeks run Monday to Sunday).
  - **Date order:** "12/10" is day/month. A date with no year rolls into next year once it's past.
  - **"at 7" without am/pm:** 1–6 means afternoon or evening, 7–11 means morning.
  - **Category:** a repeating quick add defaults to the habit category.
  - **Projects:** `#name` matches an exact name first, then a prefix, then a substring.
  - **"for partner"** turns the quick add into a suggestion.
- **Notification actions.** Reminder pushes carry Done / Snooze 1h, plus Tomorrow on one-off todos.
  - **How they run:** the service worker performs them with the session cookie and a CSRF token fetched from `/api/me`, so the normal CSRF rules apply.
  - **Fallback:** if an action fails (signed out, offline), or the platform has no action buttons, the tap opens `/today?todo=<id>` with that todo's sheet open.

### Structure and insight (phase 2)

- **Subtasks** belong to the todo; ticks belong to one occurrence (`subtask_checks` keyed by instance), so a repeating todo starts every day with a clean checklist. Up to 50 per todo. They're reordered with up/down buttons, which are keyboard friendly, instead of drag and drop. Completing a todo with open steps asks for confirmation and doesn't block.
- **Templates** snapshot the chosen todos (fields, recurrence, checklist titles); later edits to the originals don't change them.
  - **Private items:** items made from private todos are flagged private. The owner sees and applies them (they stay private); a partner viewing or applying a shared template never gets them.
  - **Applying:** a template creates fresh todos starting on the chosen date, optionally inside a project.
- **Joint habits** are shared, repeating todos with `is_joint`. Each partner's check-in goes in `instance_completions`; the occurrence becomes `done` only when both have checked in, so one partner alone doesn't count. Unpairing makes them ordinary todos again.
- **Shared goals** ("gym 4 times each") are visible to both partners and editable only by whoever set them.
  - **What counts:** each partner links one of their own (or a shared), non-private repeating todo. A link that later becomes private shows as "hidden" to the other person, count included.
  - **Weekly progress:** completions credited to that person (`completed_by`, or their joint check-in) in their own Monday–Sunday week.
- **Pause mode** covers a date range in your own calendar.
  - **Repeating todos:** occurrences inside it are created or flagged `paused` instead of `missed`. Streaks skip paused days, so they freeze, and paused items don't count in Today's totals.
  - **One-off todos** aren't paused; they just carry over as usual.
  - **Notifications:** reminders and the wrap-up aren't sent while you're paused, and nudges to you are refused (409).
  - **Ending early:** ending or cancelling a pause un-pauses from today on; earlier days stay paused in history.
  - **Partner:** sees "on a break until …".
- **Weekly review** counts with SQL `GROUP BY` (date × category × status) and turns the grouped rows into rates, per-weekday and per-category bars, and best/worst day (`summarizeWeek`, unit-tested).
  - **Streaks:** the per-habit streak list reuses the existing streak code over the last 400 days of that habit's history.
  - **Partner column:** never includes their private todos.
  - **Charts:** inline SVG, each with a screen-reader table.
- **Calendar.** Week and Month views double as the calendar.
  - **Drag:** drag an open one-off todo onto another day, or a month cell, to move it. HTML5 drag and drop, so desktop only.
  - **Tap:** on phones, "Move it" in the todo sheet does the same (Tomorrow / Next week / pick a date).
  - **Repeating todos** follow their rule and can't be dragged.
- **Photo timeline** shows completion photos only (proof or progress), newest first, 24 per page. It pages with a `(created_at, id)` cursor and applies the same rules as `/api/photos/:id`.

### Integrations (phase 3)

- **Calendar scope.** The brief asked for `calendar.events`, but that scope can't create a calendar, and a dedicated "CoWork" calendar is the safer design. CoWork asks for `calendar.app.created` instead, which lets the app create its own calendars and manage only those; it can't read or touch any of your other calendars.
- **Incremental authorisation.** Calendar access is a separate consent (`/api/calendar/connect`) with `include_granted_scopes`, `access_type=offline` and its own PKCE, state and nonce, so sign-in and existing sessions are unaffected. The callback checks that the Google account is the one you sign in with and that the scope was actually granted.
- **What syncs.**
  - **Which todos:** only those with a due time, as 30-minute events in the owner's time zone. Repeating todos become recurring events, and "monthly on the 31st" maps to the month's last day, as in the app.
  - **Completion:** a done one-off shows as "✓ Title". Repeating occurrences don't change the event.
  - **Reminders:** the event has no calendar reminders, because CoWork sends its own.
- **Whose calendar.** A todo always goes to its owner's calendar, and shared todos go to the partner's too if they've connected. Private todos, and todos in private projects, only ever go to the owner's calendar.
  - **When it syncs:** after every change (create, edit, complete, move, delete, share or privacy change), in the background.
  - **Clean-up:** the cron removes any copy someone may no longer see (unshared, made private, unpaired).
  - **No duplicates:** a claimed mapping row stops two concurrent syncs from both creating an event.
- **Disconnect** deletes the CoWork calendar, revokes the refresh token at Google, and deletes the link and event mappings.
- **Time tracking.**
  - **One timer:** a partial unique index (`ended_at IS NULL`) allows one running timer per user. Starting another stops the first, and stopping caps a forgotten timer at 24 hours.
  - **Manual entries:** at most 24 hours long and can't end in the future.
  - **Visibility:** your partner sees time on todos they can see, never on private ones.
  - **Review:** time is bucketed in SQL into 15-minute UTC buckets (every time-zone offset is a multiple of 15 minutes) and placed on your local days.
- **Export.**
  - **JSON:** everything of yours, plus your partner's shared todos and their history, and comments on shared items. Your partner's own data is left out.
  - **CSV:** the two files cover the same todos (`todos.csv`) and their occurrences (`completions.csv`). Cells that start with `=`, `+`, `-` or `@` get a leading `'` so spreadsheets don't run them as formulas.
- **Offline support was deliberately left out** at your request. The service worker still caches the app shell and shows an offline page; queued writes and conflict handling are not implemented.
