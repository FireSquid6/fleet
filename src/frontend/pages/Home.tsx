import { useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
import { client } from "../client";

const ART = `

-----Autosmith-----

    /───────────┐
   /             │
┌──┘             │
│   ╔═════════╗  │
└───╚═╗     ╔═╝──┘
   ╔══╝     ╚══╗
   ╚═══════════╝
▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
`.trim();

const GREETINGS = [
  "What are we building today, {user}?",
  "Welcome back, {user}.",
  "Good to see you, {user}.",
  "Ready to ship something great, {user}?",
  "Let's get to work, {user}.",
  "What's on the agenda, {user}?",
];

function greeting(name: string): string {
  const idx = Math.floor(Math.random() * GREETINGS.length);
  const template = GREETINGS[idx] ?? "Welcome back, {user}.";
  return name.trim()
    ? template.replace("{user}", name.trim())
    : template.replace(", {user}", "").replace(" {user}", "");
}

export default function Home() {
  const { data: user } = client.useListenedQuery("getUser", null);
  const { data: running } = client.useListenedQuery("listRunningAgents", null);

  const phrase = useMemo(() => greeting(user?.name ?? ""), [user?.name]);

  // Poll running agents every 3 seconds
  useEffect(() => {
    const id = setInterval(() => client.invalidateCache("listRunningAgents", null), 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 gap-8">
      <div className="text-center">
        <h1 className="mt-6 text-4xl text-base-content/70">{phrase}</h1>
        <pre className="text-lg text-primary bg-base-200 rounded-xl p-6 inline-block text-left border border-base-300 shadow-sm">
          {ART}
        </pre>
      </div>

      <div className="w-full max-w-sm">
        {running && running.length > 0 ? (
          <div className="bg-base-200 border border-base-300 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-base-300 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
              <span className="text-xs font-semibold uppercase tracking-wider text-base-content/50">
                {running.length} agent{running.length !== 1 ? "s" : ""} running
              </span>
            </div>
            <ul className="divide-y divide-base-300">
              {running.map(({ projectName, agentName }) => (
                <li key={`${projectName}/${agentName}`}>
                  <Link
                    to={`/projects/${projectName}/agents/${agentName}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-base-300/50 transition-colors group"
                  >
                    <div>
                      <p className="text-sm font-medium">{agentName}</p>
                      <p className="text-xs text-base-content/40">{projectName}</p>
                    </div>
                    <span className="text-xs text-base-content/30 group-hover:text-primary transition-colors">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-center text-base-content/30 text-sm">No agents currently running.</p>
        )}
      </div>
    </div>
  );
}
