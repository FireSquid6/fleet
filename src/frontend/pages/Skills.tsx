import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { client } from "../client";

function SkillCard({ skill }: { skill: { name: string; title: string; description: string; content: string } }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-base-300 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-start gap-4 px-5 py-4 bg-base-200 hover:bg-base-300/60 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <p className="font-semibold">{skill.title}</p>
          <p className="text-xs font-mono text-base-content/40 mt-0.5">{skill.name}</p>
          {skill.description && (
            <p className="text-sm text-base-content/60 mt-1">{skill.description}</p>
          )}
        </div>
        <span className="text-base-content/30 shrink-0 pt-0.5 text-xs">
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded && (
        <div className="px-6 py-5 border-t border-base-300 bg-base-100">
          {skill.content ? (
            <div className="prose prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{skill.content}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-base-content/40 italic">No content.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Skills() {
  const { data: skills, loading } = client.useListenedQuery("listSkills", null);

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Skills</h1>
        <p className="text-base-content/50 text-sm mt-1">
          Reusable instruction sets available to assign to agents.
        </p>
      </div>

      {loading && (
        <div className="flex justify-center py-20">
          <span className="loading loading-spinner loading-lg" />
        </div>
      )}

      {!loading && skills?.length === 0 && (
        <div className="text-center py-20 text-base-content/40">
          <p className="text-lg mb-1">No skills yet</p>
          <p className="text-sm">
            Add a skill by creating a directory under{" "}
            <code className="text-xs bg-base-300 px-1.5 py-0.5 rounded">skills/</code>{" "}
            with a <code className="text-xs bg-base-300 px-1.5 py-0.5 rounded">SKILL.md</code> file.
          </p>
        </div>
      )}

      {skills && skills.length > 0 && (
        <div className="space-y-3">
          {skills.map((skill) => (
            <SkillCard key={skill.name} skill={skill} />
          ))}
        </div>
      )}
    </div>
  );
}
