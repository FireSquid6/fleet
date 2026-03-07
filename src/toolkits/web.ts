import { tool } from "ai";
import { z } from "zod";

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function getWebToolkit(params: { braveApiKey: string }) {
  return {
    webFetch: tool({
      description: "Fetch the contents of a URL and return it as plain text",
      inputSchema: z.object({
        url: z.string().describe("The URL to fetch"),
      }),
      execute: async ({ url }) => {
        const response = await fetch(url);
        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        return contentType.includes("text/html") ? htmlToText(body) : body;
      },
    }),

    webSearch: tool({
      description: "Search the web and return a list of results with titles, URLs, and descriptions",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
      }),
      execute: async ({ query }) => {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "X-Subscription-Token": params.braveApiKey,
          },
        });

        if (!response.ok) {
          throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as {
          web?: { results?: Array<{ title: string; url: string; description: string }> };
        };

        return (data.web?.results ?? []).map(r => ({
          title: r.title,
          url: r.url,
          description: r.description,
        }));
      },
    }),
  };
}
