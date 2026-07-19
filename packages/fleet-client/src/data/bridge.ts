import { EdenFleetBridge } from "./eden";
import { MockFleetBridge } from "./mock";
import type { FleetBridge } from "./provider";

/**
 * The data source the app talks to. Defaults to the real Eden-backed bridge;
 * set `BUN_PUBLIC_USE_MOCK=true` (off-browser, e.g. tests) to run against the
 * in-memory fixtures. `process` is undefined in the browser bundle, so the
 * `typeof` guard keeps this from throwing there — the browser always gets Eden.
 */
const useMock = typeof process !== "undefined" && process.env.BUN_PUBLIC_USE_MOCK === "true";

export const bridge: FleetBridge = useMock ? new MockFleetBridge() : new EdenFleetBridge();
