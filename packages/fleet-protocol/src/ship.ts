import { z } from "zod";
import { FleetIdentifierSchema } from "./identifier";

export const ShipSchema = z.object({
  name: FleetIdentifierSchema,
  url: z.string(),
});

export type Ship = z.infer<typeof ShipSchema>;
