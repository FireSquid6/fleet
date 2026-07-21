export const FleetAgentActivation = async ({ $, directory }) => {
  const result = await $`fleet agent in-workspace`.cwd(directory).quiet().nothrow();
  if (result.exitCode !== 0) return {};

  const workspace = result.text().trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(workspace)) return {};

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        `You are running inside fleet workspace ${workspace}. Before doing any work, use the skill tool to activate the fleet-agent skill and follow its instructions for this session.`,
      );
    },
  };
};
