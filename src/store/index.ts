import YAML from "yaml";
import z from "zod";



export const projectSchema = z.object({
  provider: z.string(),
  owner: z.string(),
  repository: z.string(),
  tokenName: z.string(),
});



export class FleetStore {
  constructor(directory: string) {

  }
}
