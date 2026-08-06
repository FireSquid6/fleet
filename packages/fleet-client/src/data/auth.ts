import type { User } from "fleet-protocol";
import { makeBridgeClient, wsBridgeUrl, type BridgeClient } from "./client";
import { clearToken, getToken, setToken } from "./token";

const sharedClient = makeBridgeClient();

type EdenError = { status?: unknown; value?: unknown };

function bridgeError(error: EdenError): Error {
  const value = error.value;
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") {
    return new Error(value.error);
  }
  return new Error(`fleet-bridge request failed: ${JSON.stringify(value ?? error)}`);
}

export async function login(
  username: string,
  password: string,
  client: BridgeClient = sharedClient,
): Promise<User> {
  const { data, error } = await client.auth.login.post({ username, password });
  if (error) throw bridgeError(error);
  setToken(data.token);
  return data.user;
}

export async function logout(client: BridgeClient = sharedClient): Promise<void> {
  try {
    await client.auth.logout.post();
  } catch {
    // Unconditional: unreachable bridge, token already revoked — someone who
    // clicked sign out must end up signed out regardless.
  }
  clearToken();
}

export async function fetchMe(client: BridgeClient = sharedClient): Promise<User | null> {
  const { data, error } = await client.auth.me.get();
  if (error) {
    if (error.status === 401 || error.status === 403) return null;
    throw bridgeError(error);
  }
  return data;
}

export async function fetchAuthMode(client: BridgeClient = sharedClient): Promise<boolean> {
  const { data, error } = await client.auth.mode.get();
  if (error) throw bridgeError(error);
  return data.authRequired;
}

export async function requestWsTicket(client: BridgeClient = sharedClient): Promise<string> {
  const { data, error } = await client.auth["ws-ticket"].post();
  if (error) throw bridgeError(error);
  return data.ticket;
}

/**
 * {@link wsBridgeUrl} carrying a freshly-minted ticket. Tickets are single-use
 * and die 30 seconds after issue: call this inside every connection attempt,
 * reconnects included, and never cache or hoist the result.
 *
 * Falls back to the bare URL when no ticket can be had — refusing a socket that
 * cannot authenticate is the bridge's job, not the browser's.
 */
export async function ticketedWsUrl(path: string, client?: BridgeClient): Promise<string> {
  const url = wsBridgeUrl(path);
  if (!getToken()) return url;
  try {
    const ticket = await requestWsTicket(client);
    const ticketed = new URL(url);
    ticketed.searchParams.set("ticket", ticket);
    return ticketed.toString();
  } catch {
    return url;
  }
}
