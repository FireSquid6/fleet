export const FleetAgentActivation = async ({ $, directory }) => {
  const result = await $`fleet agent in-workspace`.cwd(directory).quiet().nothrow();
  if (result.exitCode !== 0) return {};

  const workspace = result.text().trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(workspace)) return {};

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        `MANDATORY: You are an agent working in a fleet workspace (${workspace}). Your first action MUST be to use the skill tool to activate the fleet-agent skill. Do not inspect files, run commands, plan, answer the user, or take any other action before activating it. After activation, follow every fleet-agent instruction for the entire session.`,
      );
    },
  };
};
