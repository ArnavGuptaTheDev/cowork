import { isSuperAdmin } from '../../shared/authz';
import { meUpdateSchema, pairAcceptSchema } from '../../shared/schemas';
import { localDate } from '../../shared/time';
import { publicUser, type UserRow } from '../db';
import { sha256Hex } from '../crypto';
import { badRequest, conflict } from '../http';
import { getPartner, getUser } from '../services/access';
import { sendPushToUser } from '../services/notify';
import { activePause } from '../services/pause';
import { recomputeReminders } from '../services/todos';
import { unpair } from '../services/users';
import { body, defer, router } from './common';

export const meRoutes = router();

meRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const partner = await getPartner(c.env.DB, user);
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM suggestions WHERE to_user_id = ? AND status = 'pending'`,
  )
    .bind(user.id)
    .first<{ n: number }>();
  const [myPause, theirPause] = await Promise.all([
    activePause(c.env.DB, user, c.get('now')),
    partner ? activePause(c.env.DB, partner, c.get('now')) : null,
  ]);
  return c.json({
    user: { ...publicUser(user), pausedUntil: myPause?.end_date ?? null },
    partner: partner ? { ...publicUser(partner), pausedUntil: theirPause?.end_date ?? null } : null,
    pairedAt: partner ? user.paired_at : null,
    csrfToken: c.get('session').csrfToken,
    isAdmin: isSuperAdmin(user.email, c.env.SUPER_ADMIN_EMAIL),
    vapidPublicKey: c.env.VAPID_PUBLIC_KEY || null,
    today: localDate(c.get('now'), user.timezone),
    pendingSuggestions: pending?.n ?? 0,
    wrapupTime: user.wrapup_time,
    serverNow: c.get('now'),
  });
});

meRoutes.patch('/me', async (c) => {
  const user = c.get('user');
  const input = await body(c, meUpdateSchema);
  await c.env.DB.prepare(
    `UPDATE users SET name = COALESCE(?, name), timezone = COALESCE(?, timezone),
       wrapup_time = CASE WHEN ? THEN ? ELSE wrapup_time END WHERE id = ?`,
  )
    .bind(input.name ?? null, input.timezone ?? null, input.wrapupTime !== undefined ? 1 : 0, input.wrapupTime ?? null, user.id)
    .run();
  const updated = (await getUser(c.env.DB, user.id))!;
  if (input.timezone && input.timezone !== user.timezone) await recomputeReminders(c.env.DB, updated, c.get('now'));
  return c.json({ user: publicUser(updated), wrapupTime: updated.wrapup_time });
});

// --- Pairing ---

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_TTL_MS = 15 * 60_000;

function pairingCode(): string {
  const out: string[] = [];
  while (out.length < 8) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    for (const x of b) {
      if (x < 248 && out.length < 8) out.push(CODE_ALPHABET[x % 31]!);
    }
  }
  return out.join('');
}

meRoutes.post('/pairing/code', async (c) => {
  const user = c.get('user');
  if (user.partner_id) throw conflict('You are already paired');
  const code = pairingCode();
  const now = c.get('now');
  const expiresAt = now + PAIR_CODE_TTL_MS;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM pairing_codes WHERE user_id = ? OR expires_at < ?').bind(user.id, now),
    c.env.DB.prepare('INSERT INTO pairing_codes (code_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(
      await sha256Hex(code),
      user.id,
      expiresAt,
      now,
    ),
  ]);
  const origin = new URL(c.req.url).origin;
  return c.json({ code, url: `${origin}/settings?pair=${code}`, expiresAt });
});

meRoutes.post('/pairing/accept', async (c) => {
  const user = c.get('user');
  const { code } = await body(c, pairAcceptSchema);
  const now = c.get('now');
  if (user.partner_id) throw conflict('You are already paired');
  const row = await c.env.DB.prepare('SELECT user_id FROM pairing_codes WHERE code_hash = ? AND expires_at > ?')
    .bind(await sha256Hex(code), now)
    .first<{ user_id: string }>();
  if (!row) throw badRequest('That code is invalid or has expired');
  if (row.user_id === user.id) throw badRequest("That's your own code. Send it to your partner");
  const inviter = await getUser(c.env.DB, row.user_id);
  if (!inviter || inviter.partner_id) throw conflict('That person is already paired');

  try {
    // Atomic: the unique index on users.partner_id rejects a concurrent second pairing.
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE users SET partner_id = ?, paired_at = ? WHERE id = ? AND partner_id IS NULL').bind(inviter.id, now, user.id),
      c.env.DB.prepare('UPDATE users SET partner_id = ?, paired_at = ? WHERE id = ? AND partner_id IS NULL').bind(user.id, now, inviter.id),
      c.env.DB.prepare('DELETE FROM pairing_codes WHERE user_id IN (?, ?)').bind(user.id, inviter.id),
    ]);
  } catch {
    throw conflict('Pairing failed, one of you is already paired');
  }
  const [me, them] = await Promise.all([getUser(c.env.DB, user.id), getUser(c.env.DB, inviter.id)]);
  if (me?.partner_id !== inviter.id || them?.partner_id !== user.id) {
    // Lost a race: undo our half so nobody is left half-paired.
    await c.env.DB.prepare('UPDATE users SET partner_id = NULL, paired_at = NULL WHERE id = ? AND partner_id = ?').bind(user.id, inviter.id).run();
    throw conflict('Pairing failed, one of you is already paired');
  }
  defer(
    c,
    sendPushToUser(c.env, inviter.id, {
      title: 'You are paired 💞',
      body: `${publicUser(user).name} accepted your pairing code.`,
      url: '/partner',
      tag: 'pairing',
    }),
  );
  return c.json({ partner: publicUser(them as UserRow) });
});

meRoutes.delete('/pairing', async (c) => {
  await unpair(c.env.DB, c.get('user'), c.get('now'));
  return c.json({ ok: true });
});
