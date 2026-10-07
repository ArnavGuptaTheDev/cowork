import { useState } from 'preact/hooks';
import { errorMessage, get, getMe, send } from '../lib/api';
import type { Invite } from '../lib/types';
import { ErrorBox, Icon, Loading, Toasts, toast, useLoad } from './ui';

export default function AdminIsland() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const state = useLoad(async () => {
    const me = await getMe();
    if (!me.isAdmin) throw new Error('Only the admin can manage invites.');
    return get<{ invites: Invite[] }>('/api/admin/invites');
  });

  const invite = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await send('POST', '/api/admin/invites', { email });
      toast(`Invited ${email}`);
      setEmail('');
      await state.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (i: Invite) => {
    if (!confirm(`Revoke ${i.email}? They'll be signed out and can't sign in again. Their data is kept.`)) return;
    try {
      await send('DELETE', `/api/admin/invites/${encodeURIComponent(i.email)}`);
      toast('Revoked');
      await state.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <>
      <header class="page-head">
        <div>
          <p class="eyebrow">Admin</p>
          <h1 class="page-title">Invites</h1>
          <p class="lede">Only invited emails (and you) can sign in. Everyone else sees a polite “not invited” page.</p>
        </div>
      </header>
      {state.error && <ErrorBox message={state.error} />}
      {state.loading && !state.data && <Loading />}
      {state.data && (
        <>
          <form class="card" onSubmit={invite}>
            <div class="field">
              <label class="label" for="inv-email">
                Invite by Google email
              </label>
              <div class="row">
                <input
                  id="inv-email"
                  class="input grow"
                  type="email"
                  required
                  autoComplete="off"
                  value={email}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                  placeholder="partner@gmail.com"
                />
                <button type="submit" class="btn" disabled={busy || !email}>
                  <Icon name="plus" /> Invite
                </button>
              </div>
            </div>
          </form>
          <section class="section card">
            <h2 class="section-title">
              Invited <small>{state.data.invites.length}</small>
            </h2>
            {state.data.invites.length === 0 && <p class="faint">No one yet.</p>}
            <ul class="list-plain">
              {state.data.invites.map((i) => (
                <li key={i.email} class="row">
                  <div>
                    <strong>{i.email}</strong>
                    <div class="faint">
                      {i.joined ? `Joined${i.lastLoginAt ? ` · last seen ${new Date(i.lastLoginAt).toLocaleDateString()}` : ''}` : 'Not signed in yet'}
                    </div>
                  </div>
                  <span class="spacer" />
                  <button type="button" class="btn danger" onClick={() => revoke(i)}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <Toasts />
    </>
  );
}
