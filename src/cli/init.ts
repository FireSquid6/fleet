import path from "path";
import os from "os";
import { input, password } from "@inquirer/prompts";
import { Command } from "@commander-js/extra-typings";
import { AutosmithStore } from "../store";

async function runInit(options: { dir?: string | boolean }) {
  const defaultDir = path.join(os.homedir(), "autosmith");

  const storeDir = path.resolve(
    typeof options.dir === "string"
      ? options.dir
      : await input({ message: "Store directory", default: defaultDir })
  );

  const store = new AutosmithStore(storeDir);
  await store.initialize();

  // Provider keys
  const providerKeys: string[] = [];
  while (true) {
    const name = await input({ message: "Provider key name (e.g. ANTHROPIC_API_KEY, blank to finish)" });
    if (!name) break;
    const value = await password({ message: `Value for ${name}` });
    if (value) {
      await store.providers.set(name, value);
      providerKeys.push(name);
    }
  }

  // Git tokens
  const tokenKeys: string[] = [];
  while (true) {
    const name = await input({ message: "Token name (e.g. github, blank to finish)" });
    if (!name) break;
    const value = await password({ message: `Value for ${name}` });
    if (value) {
      await store.tokens.set(name, value);
      tokenKeys.push(name);
    }
  }

  // User info
  const userName = await input({ message: "Your name (blank to skip)" });
  const userEmail = await input({ message: "Your email (blank to skip)" });
  if (userName || userEmail) {
    await store.updateUser({ name: userName || undefined, email: userEmail || undefined });
  }

  console.log("\nInitialized autosmith store:");
  console.log(`  Directory: ${storeDir}`);
  console.log(`  Created:   AGENT.md, projects/, skills/`);
  if (providerKeys.length > 0) {
    console.log(`  Providers: ${providerKeys.join(", ")}`);
  }
  if (tokenKeys.length > 0) {
    console.log(`  Tokens:    ${tokenKeys.join(", ")}`);
  }
  if (userName || userEmail) {
    console.log(`  User:      ${[userName, userEmail].filter(Boolean).join(", ")}`);
  }
}

export const initCommand = new Command()
  .name("init")
  .description("Initialize an autosmith data directory")
  .option("-d, --dir [dir]", "store directory (default: ~/autosmith)")
  .action(async (options) => {
    await runInit(options);
  });
