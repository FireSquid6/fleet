import { join } from "node:path";

export type Provider = "claude-code" | "opencode" | "copilot" | "codex";

export const PROVIDERS = ["claude-code", "opencode", "copilot", "codex"] as const satisfies readonly Provider[];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** The directory whose existence proves the provider is installed for this user. */
export function configRootFor(homeDirectory: string, provider: Provider): string {
  switch (provider) {
    case "claude-code":
      return join(homeDirectory, ".claude");
    case "opencode":
      return join(homeDirectory, ".config", "opencode");
    case "copilot":
      return join(homeDirectory, ".copilot");
    case "codex":
      return join(homeDirectory, ".codex");
  }
}

/**
 * Every directory the provider discovers skills in, shallowest-owned first.
 * Codex reads both its own `~/.codex/skills` and the cross-tool
 * `~/.agents/skills`, so it contributes two.
 */
export function skillRootsFor(homeDirectory: string, provider: Provider): string[] {
  const own = join(configRootFor(homeDirectory, provider), "skills");
  return provider === "codex" ? [own, join(homeDirectory, ".agents", "skills")] : [own];
}
