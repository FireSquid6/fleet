/**
 * api/system-resources.ts — the ship's `GET /system-resources` route, as its own
 * Elysia plugin. Reports a point-in-time snapshot of the host (uptime, OS, CPU,
 * memory) via `node:os`. One Elysia chain so route types stay inferable for Eden.
 */

import os from "node:os";
import { Elysia } from "elysia";
import type { SystemResources } from "fleet-protocol";

/** Aggregate CPU idle/total tick counts across all logical cores. */
function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Sample CPU busy fraction (0..1) across all cores over `sampleMs`. */
async function sampleCpuUsage(sampleMs = 100): Promise<number> {
  const a = cpuTicks();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const b = cpuTicks();
  const idle = b.idle - a.idle;
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

/** Collect a full system-resources snapshot for this host. */
export async function collectSystemResources(): Promise<SystemResources> {
  const cpus = os.cpus();
  const [load1, load5, load15] = os.loadavg();
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    uptimeSeconds: os.uptime(),
    os: {
      type: os.type(),
      platform: os.platform(),
      release: os.release(),
      version: os.version(),
      arch: os.arch(),
      machine: os.machine(),
      hostname: os.hostname(),
    },
    cpu: {
      model: cpus[0]?.model ?? "unknown",
      cores: cpus.length,
      usage: await sampleCpuUsage(),
      loadAverage: [load1 ?? 0, load5 ?? 0, load15 ?? 0],
    },
    memory: {
      total,
      free,
      used,
      usage: total > 0 ? used / total : 0,
    },
  };
}

/** Elysia plugin exposing `GET /system-resources`. */
export function systemResourcesPlugin() {
  return new Elysia({ name: "ship-system-resources" }).get(
    "/system-resources",
    () => collectSystemResources(),
  );
}
