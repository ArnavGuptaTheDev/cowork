// The whole app is this one Worker:
//  - static Astro build in ./dist served as assets (see [assets] in wrangler.toml),
//  - /api/* handled by the Hono app (run_worker_first),
//  - a cron trigger every 5 minutes for reminders.
import { app } from '../server/app';
import type { Env } from '../server/env';
import { runReminders } from '../server/reminders';

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runReminders(env, Date.now()).then((r) => console.log('reminders', JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
