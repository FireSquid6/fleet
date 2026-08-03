import { resolve } from "node:path";
import { z } from "zod";

export const BridgeConfigSchema = z.object({
  /** Directory the bridge persists its ship roster (`ships.json`) to. */
  dataDirectory: z.string().min(1),
  port: z.number().int(),
  name: z.string().min(1),
  /**
   * URL *ships* use to reach this bridge — it is handed to each ship so it can
   * pull the armory, so it has to resolve from the ships' hosts, not just from
   * the bridge's own machine. Optional here because a config assembled outside
   * `resolveBridgeConfig` may omit it; `defaultPublicUrl` fills the gap.
   */
  publicUrl: z.string().min(1).optional(),
  /** Development escape hatch: serve every route without authentication. */
  insecureNoAuth: z.boolean().default(false),
});

/** The *input* shape: defaulted fields stay optional for configs assembled by hand. */
export type BridgeConfig = z.input<typeof BridgeConfigSchema>;

export function defaultPublicUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** Validate a raw (flag-assembled) config, resolving `dataDirectory` to an absolute path. */
export function resolveBridgeConfig(
  raw: unknown,
  deps?: { env?: Record<string, string | undefined> },
): BridgeConfig {
  const config = BridgeConfigSchema.parse(raw);
  const env = deps?.env ?? process.env;
  return {
    ...config,
    dataDirectory: resolve(config.dataDirectory),
    publicUrl: config.publicUrl ?? defaultPublicUrl(config.port),
    insecureNoAuth: config.insecureNoAuth || env.FLEET_INSECURE_NO_AUTH === "1",
  };
}
