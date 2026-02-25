import { declareCovenant, query } from "@covenant-rpc/core";
import { z } from "zod";


export const covenant = declareCovenant({
  procedures: {
    testHello: query({
      input: z.object({
        name: z.string(),
      }),
      output: z.object({
        message: z.string(),
      })
    })
  },
  channels: {},
})
