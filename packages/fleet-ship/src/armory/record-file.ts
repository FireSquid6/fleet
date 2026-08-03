import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZodType } from "zod";

export async function readOwnershipRecord<T>(
  path: string,
  schema: ZodType<T[]>,
  warnings: string[],
  subject: string,
): Promise<T[]> {
  let parsed: unknown;
  try {
    parsed = await Bun.file(path).json();
  } catch (error) {
    // A first run has no record; an unusable one must not block this run, but it
    // does mean this run cannot undo what the last one did.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`ignored unreadable ${path}: ${subject} cannot be removed`);
    }
    return [];
  }
  const record = schema.safeParse(parsed);
  if (!record.success) {
    warnings.push(`ignored invalid ${path}: ${subject} cannot be removed`);
    return [];
  }
  return record.data;
}

/** Written through a temporary sibling, so a crash leaves the previous record intact. */
export async function writeRecordAtomically(path: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(temporary, body);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
