import { BRIDGE_TOKEN_ENV_VAR, SHIP_TOKEN_ENV_VAR } from "../src/config";

delete process.env[BRIDGE_TOKEN_ENV_VAR];
delete process.env[SHIP_TOKEN_ENV_VAR];
