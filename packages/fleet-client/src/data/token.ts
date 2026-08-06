const TOKEN_KEY = "fleet.bridge.token";

let memoryToken: string | null = null;

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function getToken(): string | null {
  return storage()?.getItem(TOKEN_KEY) ?? memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  storage()?.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  memoryToken = null;
  storage()?.removeItem(TOKEN_KEY);
}

type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Not only an expiry path: `POST /users/:name/password` revokes every session of
 * that user, so changing your own password signs your own browser out by design.
 */
export function onUnauthorized(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function reportUnauthorized(): void {
  clearToken();
  unauthorizedHandler?.();
}
