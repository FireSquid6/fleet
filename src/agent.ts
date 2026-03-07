import type { CodeRepository } from "./code-repository";

export interface AgentInputs {
  id: string;
  fs: FileSystem;
  repo: CodeRepository;
}


export class Agent {
  constructor({ id, fs, repo }: AgentInputs) {

  }

  async startUp() {

  }

}
