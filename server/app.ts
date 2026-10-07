import { Hono } from 'hono';
import type { AppEnv } from './env';
import { HttpError } from './http';
import { clock, requireCsrf, requireSession, securityHeaders } from './middleware';
import { adminRoutes } from './routes/admin';
import { interactRoutes } from './routes/interact';
import { structureRoutes } from './routes/structure';
import { calendarRoutes } from './routes/calendar';
import { exportRoutes } from './routes/export';
import { timeRoutes } from './routes/time';
import { authRoutes } from './routes/auth';
import { meRoutes } from './routes/me';
import { photoRoutes } from './routes/photos';
import { pushRoutes } from './routes/push';
import { suggestionRoutes } from './routes/suggestions';
import { todoRoutes } from './routes/todos';

export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', clock, securityHeaders);

  // Public: the OAuth flow (logout applies its own session + CSRF checks).
  app.route('/auth', authRoutes);

  // Everything else requires a session, and CSRF on mutating methods.
  const authed = new Hono<AppEnv>();
  authed.use('*', requireSession, requireCsrf);
  authed.route('/', meRoutes);
  authed.route('/', todoRoutes);
  authed.route('/', interactRoutes);
  authed.route('/', structureRoutes);
  authed.route('/', timeRoutes);
  authed.route('/', calendarRoutes);
  authed.route('/', exportRoutes);
  authed.route('/', suggestionRoutes);
  authed.route('/', photoRoutes);
  authed.route('/', pushRoutes);
  authed.route('/', adminRoutes);
  authed.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));
  app.route('/', authed);

  app.notFound((c) => c.json({ error: 'not_found', message: 'Not found' }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.code, message: err.message, details: err.details }, err.status);
    }
    console.error('unhandled', err);
    return c.json({ error: 'internal', message: 'Something went wrong' }, 500);
  });
  return app;
}

export const app = createApp();
