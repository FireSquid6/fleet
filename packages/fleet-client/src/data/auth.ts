/**
 * data/auth.ts — browser calls to the bridge's `/auth/*` routes.
 *
 * Plain `fetch` (not Eden) keeps the hyphenated `ws-ticket` path simple. Every
 * call is same-origin against the client server's `/bridge` proxy with
 * `credentials: "include"`, so the httpOnly session cookie rides along.
 */

import { bridgeBaseUrl } from "./client";

export interface AuthConfig {
  authRequired: boolean;
}

export interface AuthUser {
  username: string;
}

function authUrl(path: string): string {
  return `${bridgeBaseUrl()}${path}`;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(authUrl(path), {
    method: "POST",
    credentials: "include",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function getAuthConfig(): Promise<AuthConfig> {
  const res = await fetch(authUrl("/auth/config"), { credentials: "include" });
  if (!res.ok) throw new Error("could not load auth config");
  return res.json();
}

/** Returns the current user, or `null` when unauthenticated. */
export async function whoami(): Promise<AuthUser | null> {
  const res = await fetch(authUrl("/auth/whoami"), { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error("could not load session");
  return res.json();
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await post("/auth/login", { username, password });
  if (res.status === 401) throw new Error("Invalid username or password");
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  return res.json();
}

export async function logout(): Promise<void> {
  await post("/auth/logout");
}

/** Mint a single-use ticket to authenticate the terminal WebSocket. */
export async function fetchWsTicket(): Promise<string> {
  const res = await fetch(authUrl("/auth/ws-ticket"), { credentials: "include" });
  if (!res.ok) throw new Error("could not get a terminal ticket");
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
}
