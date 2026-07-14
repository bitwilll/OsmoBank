/* Home / landing: auth-aware header controls + single-active-session guard.
 *
 * Not signed in            → Log in + Get started.
 * Signed in, sole session  → Open dashboard + Sign out.
 * Signed in, live elsewhere→ Sign out only; the dashboard is withheld and a
 *                            warning banner offers to sign out the other devices.
 * Liveness comes from me().session.othersLive (see GET /api/me → sessionStatus). */

const show = (elm, on) => { if (elm) elm.style.display = on ? '' : 'none'; };

function apply(root, ctx) {
  const me = ctx.me();
  const authed = !!me;
  const othersLive = me?.session?.othersLive || 0;
  const liveElsewhere = authed && othersLive > 0;
  const canDash = authed && !liveElsewhere;      // sole active session

  show(ctx.slot(root, 'home.login'), !authed);
  show(ctx.slot(root, 'home.signup'), !authed);
  show(ctx.slot(root, 'home.dash'), canDash);
  show(ctx.slot(root, 'home.signout'), authed);

  const warn = ctx.slot(root, 'home.sessionWarn');
  if (warn) warn.style.display = liveElsewhere ? 'flex' : 'none';
}

export async function hydrate(root, ctx) {
  if (!root.dataset.hydrated) {
    root.dataset.hydrated = '1';
    ctx.setAction('signOutOthers', async () => {
      try {
        const r = await ctx.api.post('/api/auth/logout-all');
        await ctx.refreshMe();               // othersLive should now be 0
        apply(root, ctx);
        const n = r.revoked || 0;
        ctx.toast(`SIGNED OUT ${n} OTHER DEVICE${n === 1 ? '' : 'S'}`);
      } catch (e) { ctx.errToast(e); }
    });
  }
  // Re-check session liveness each time the landing page is shown.
  await ctx.refreshMe();
  apply(root, ctx);
}
