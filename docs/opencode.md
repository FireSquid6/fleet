# OpenCode startup activation

OpenCode automatically loads JavaScript and TypeScript modules from
`~/.config/opencode/plugins/` at startup. Fleet installs a global
`fleet-agent.js` plugin there alongside the global `fleet-agent` skill; no
`opencode.json` changes or npm package are required.

The plugin runs `fleet-agent in-workspace` once during plugin initialization,
using OpenCode's current project directory. A missing executable, non-zero exit,
or output other than a single `repo/name` causes the plugin to return no hooks
and remain silent.

When detection succeeds, the plugin registers
`experimental.chat.system.transform`. That hook appends a system instruction
identifying the workspace and tells the agent to activate the `fleet-agent`
skill before doing any work. A system transform is preferable to changing a
user or project instruction file because the global check only affects OpenCode
sessions that actually start inside a fleet workspace.

The source plugin is `packages/fleet-ship/plugins/opencode.js`; `fleet-ship`
copies it to `~/.config/opencode/plugins/fleet-agent.js` whenever the OpenCode
config directory exists. OpenCode reads plugins only at startup, so an already
running OpenCode process must be restarted after the first installation or an
update.

Reference: [OpenCode plugins](https://opencode.ai/docs/plugins/).
