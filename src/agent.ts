import { streamText, generateText, stepCountIs, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { CodeRepository } from "./code-repository";
import type { Filesystem } from "./filesystem";
import { getToolkitFromFilesystem } from "./toolkits/filesystem";
import { getToolkitFromCodeRepository } from "./toolkits/code-repository";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolName: string; input: unknown }
  | { type: "tool-result"; toolName: string; result: unknown }
  | { type: "error"; error: unknown };

export interface AgentInputs {
  id: string;
  fs: Filesystem;
  repo: CodeRepository;
  instructions?: string;
}

export class Agent {
  readonly id: string;
  private messages: ModelMessage[] = [];
  private tools: ReturnType<typeof buildTools>;

  private systemPrompt: string;

  constructor({ id, fs, repo, instructions }: AgentInputs) {
    this.id = id;
    this.tools = buildTools(fs, repo);
    this.systemPrompt = instructions ?? "";
  }

  async *send(input: string): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: "user", content: input });

    const result = streamText({
      model: anthropic("claude-sonnet-4-5"),
      system: this.systemPrompt,
      tools: this.tools,
      stopWhen: stepCountIs(10),
      messages: this.messages,
    });

    try {
      for await (const event of result.fullStream) {
        if (event.type === "text-delta") {
          yield { type: "text", text: event.text };
        } else if (event.type === "tool-call") {
          yield { type: "tool-call", toolName: event.toolName, input: event.input };
        } else if (event.type === "tool-result") {
          yield { type: "tool-result", toolName: event.toolName, result: event.output };
        } else if (event.type === "error") {
          yield { type: "error", error: event.error };
        }
      }
    } finally {
      const response = await Promise.resolve(result.response).catch(() => null);
      if (response) {
        this.messages.push(...(response.messages as ModelMessage[]));
      }
    }
  }

  // Summarizes the conversation history into a single compact message, reducing
  // token usage for long-running sessions without losing important context.
  async compact(): Promise<void> {
    if (this.messages.length === 0) return;

    const result = await generateText({
      model: anthropic("claude-haiku-4-5-20251001"),
      system: "Summarize the following conversation concisely. Preserve key decisions, file paths, code written or modified, errors encountered, and the current state of work.",
      messages: [
        ...this.messages,
        { role: "user", content: "Summarize our conversation so far." },
      ],
    });

    this.messages = [
      { role: "user", content: `[Compacted context from previous conversation]\n\n${result.text}` },
      { role: "assistant", content: "I have the context from our previous session. Ready to continue." },
    ];
  }

  clear(): void {
    this.messages = [];
  }

  get messageCount(): number {
    return this.messages.length;
  }
}

function buildTools(fs: Filesystem, repo: CodeRepository) {
  return {
    ...getToolkitFromFilesystem(fs),
    ...getToolkitFromCodeRepository(repo),
  };
}

