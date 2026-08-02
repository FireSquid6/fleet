import { treaty } from "@elysiajs/eden";
import type { App } from "fleet-ship/api";

export type FleetClient = ReturnType<typeof treaty<App>>;

export function makeClient(url: string): FleetClient {
  return treaty<App>(url);
}
