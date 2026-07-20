import { z } from "zod";

const utf8 = new TextEncoder();

export const FleetIdentifierSchema = z
  .string()
  .min(1)
  .refine((value) => utf8.encode(value).byteLength <= 128, "must be at most 128 UTF-8 bytes")
  .refine((value) => value !== "." && value !== "..", "must not be . or ..")
  .refine((value) => !value.includes("/") && !value.includes("\\"), "must not contain path separators")
  .refine((value) => !/\p{Cc}/u.test(value), "must not contain Unicode control characters")
  .refine((value) => !/\p{Cs}/u.test(value), "must be well-formed Unicode");

export type FleetIdentifier = z.infer<typeof FleetIdentifierSchema>;

export function parseFleetIdentifier(value: unknown): FleetIdentifier {
  return FleetIdentifierSchema.parse(value);
}
