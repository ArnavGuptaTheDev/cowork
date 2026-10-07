# CoWork: build plan

## Shape

```
src/                Astro (static output) pages + Preact islands
  pages/            one page per view (today, week, month, projects, project, habits, partner, suggestions, settings, admin, not-invited)
  components/       Preact islands and the small UI kit they share
  lib/              browser-side helpers (api client + CSRF, image compression, push subscription)
  content/copy.ts   all user-facing copy in one place
  styles/           design tokens, fonts, global CSS
public/             service worker, web manifest, icons
functions/api/[[route]].ts   Pages Function entry; mounts the Hono app
server/             Hono app, routes, services (D1 / R2), auth (Google OIDC, sessions, CSRF), push sender
shared/             pure, runtime-agnostic logic: time zones, recurrence, streaks, authorisation rules, schemas, Web Push crypto
workers/reminders/  cron Worker (every 5 minutes): materialises today's instances, sends due reminders
migrations/         plain SQL D1 migrations
tests/              Vitest: pure logic + route-level tests against a node:sqlite-backed D1 shim
```

## Core model

* A **todo** is a template: title, notes, project, category, day (`start_date`), optional due/reminder time (local `HH:MM`),
  recurrence rule, privacy flag.
* A **todo instance** is one occurrence on one local date, with its own status (`pending` / `done` / `missed`).
  * One-off todos get exactly one instance when created. If it's still pending after its day it carries over into Today. It is never marked missed.
  * Recurring todos are materialised up to *today* (in the owner's time zone), either lazily on read or by the cron Worker.
    Past pending recurring instances become `missed`. Future occurrences are projected (not stored) for Week/Month views.
  * Each instance stores its reminder as a UTC timestamp (`reminder_at`). The cron Worker sends pushes for due reminders
    and sets `reminded_at`.
* Streaks and completion rates come from the instance history, so editing a rule never rewrites the past.
* All timestamps are UTC epoch milliseconds. Date-only values are local `YYYY-MM-DD` strings in the owner's time zone.

## Access rules (shared/authz.ts, enforced in every route)

* Session required on every `/api/*` route except the OAuth endpoints.
* Mutations: owner only, and they need a valid `X-CSRF-Token` plus a same-origin `Origin` header.
* Reads of another user: only their partner, and only non-private todos in non-private projects.
* Photos: owner, or partner when the parent todo is visible. Suggestion photos: suggester and recipient.
* Sign-in: `SUPER_ADMIN_EMAIL` or an email that has an invite. Nobody else gets an account.

## Schema

See `migrations/0001_init.sql`. It is the source of truth.
