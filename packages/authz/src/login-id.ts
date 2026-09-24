/**
 * Some people sign in with a username rather than an email: a front desk that
 * shares one login, a government office, a client who simply has no work email.
 *
 * Underneath, every account still has an email, because that is what the auth
 * library keys on. A username becomes a local part under one reserved domain
 * that receives no mail and belongs to nobody, so it can never collide with a
 * real address a person might later sign up with.
 *
 * The cost is deliberate and worth stating: an account created this way has no
 * reachable email, so nobody can send it a reset link. Forgotten passwords are
 * reset by whoever administers the workspace.
 */
export const LOGIN_DOMAIN = "id.jenai.local";

/** Usernames are case-insensitive, and deliberately narrow so they read the same everywhere. */
export const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/;

export function isUsername(input: string): boolean {
  return !input.includes("@");
}

/** What the auth layer should be given, whether they typed a username or an email. */
export function toLoginEmail(input: string): string {
  const v = input.trim().toLowerCase();
  return isUsername(v) ? `${v}@${LOGIN_DOMAIN}` : v;
}

/** What to show a person: their username if that is how they sign in, else their email. */
export function displayLogin(email: string): string {
  return email.endsWith(`@${LOGIN_DOMAIN}`) ? email.slice(0, -(LOGIN_DOMAIN.length + 1)) : email;
}
