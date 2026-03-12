import { useState } from "react";
import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { client } from "../client";


export interface OpenWorkspaceButtonProps {
  agent: string;
  project: string;
}


export function OpenWorkspaceButton({ agent, project }: OpenWorkspaceButtonProps) {
  const [enabled, setEnabled] = useState<boolean>(agent !== "" && project !== "");


  const onClick = async () => {
    setEnabled(false);
    const result = await client.mutate("openAgentWorkspace", {
      agent,
      project
    });
    setEnabled(true);

    console.log(`Opening agent workspace: ${result}`)
  }

  return (
    <button className="btn btn-primary rounded" onClick={onClick} disabled={!enabled}>
      Open Agent Workspace
      <ArrowTopRightOnSquareIcon className="w-4 h-4" />
    </button>
  )

}
