export interface LoginForm {
  readonly username: string;
  readonly password: string;
}

/** The username is trimmed and the password is not: whitespace can be part of a password. */
export function loginCredentials(form: LoginForm): LoginForm | null {
  const username = form.username.trim();
  if (username.length === 0 || form.password.length === 0) return null;
  return { username, password: form.password };
}

/**
 * Prefers the bridge's own wording: it answers wrong password and unknown user
 * identically on purpose, and paraphrasing risks telling the caller which it was.
 */
export function loginErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message.length > 0 ? message : "could not sign in";
}
