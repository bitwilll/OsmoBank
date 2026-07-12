/* Home / landing: auth-aware header buttons. */
export async function hydrate(root, ctx) {
  const authed = !!ctx.me();
  const login = root.querySelector('[data-action="goLogin"]');
  const signup = root.querySelector('[data-action="goSignup"]');
  if (login) login.textContent = authed ? 'Open vault' : 'Log in';
  if (signup && authed) signup.textContent = 'Dashboard';

  if (!root.dataset.hydrated) {
    root.dataset.hydrated = '1';
    ctx.setAction('goLogin', () => ctx.nav(ctx.me() ? 'dash' : 'login'));
    ctx.setAction('goSignup', () => ctx.nav(ctx.me() ? 'dash' : 'signup'));
  }
}
