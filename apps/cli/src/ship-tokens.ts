import { promptSecret } from "fleet-cli-kit";

export const REGISTER_SHIP_TOKEN_ENV_VAR = "FLEET_REGISTER_SHIP_TOKEN";
export const REGISTER_BRIDGE_TOKEN_ENV_VAR = "FLEET_REGISTER_BRIDGE_TOKEN";

export interface ShipRegistrationTokens {
  shipToken?: string;
  bridgeToken?: string;
}

export interface ShipTokenDeps {
  env?: Record<string, string | undefined>;
  isTty?: boolean;
  promptSecret?: (question: string) => Promise<string>;
}

export async function resolveShipRegistrationTokens(deps: ShipTokenDeps = {}): Promise<ShipRegistrationTokens> {
  const env = deps.env ?? process.env;
  const fromEnv: ShipRegistrationTokens = {
    shipToken: env[REGISTER_SHIP_TOKEN_ENV_VAR]?.trim() || undefined,
    bridgeToken: env[REGISTER_BRIDGE_TOKEN_ENV_VAR]?.trim() || undefined,
  };

  const isTty = deps.isTty ?? Boolean(process.stdin.isTTY);
  if (fromEnv.shipToken || fromEnv.bridgeToken || !isTty) return fromEnv;

  const ask = deps.promptSecret ?? promptSecret;
  const shipToken = (await ask("ship token (blank to register without credentials): ")).trim();
  if (!shipToken) return {};
  const bridgeToken = (await ask("bridge token: ")).trim();
  return { shipToken, bridgeToken: bridgeToken || undefined };
}
