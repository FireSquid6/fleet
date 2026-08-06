import { treaty } from "@elysiajs/eden";
import type { App } from "fleet-ship/api";

export type FleetClient = ReturnType<typeof treaty<App>>;

/**
 * A ship credential is only ever taken from the environment, never a flag —
 * `ps` and shell history would otherwise carry it.
 */
export const SHIP_TOKEN_ENV_VAR = "FLEET_BRIDGE_TOKEN";

export function makeClient(url: string, token?: string): FleetClient {
  return treaty<App>(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}
