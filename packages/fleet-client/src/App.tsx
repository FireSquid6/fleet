import "./index.css";

import { useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { FleetProvider } from "./data/FleetContext";
import { Shell } from "./layouts/Shell";
import { BridgeRoute } from "./routes/BridgeRoute";
import { RepoRoute } from "./routes/RepoRoute";
import { WorkspaceRoute } from "./routes/WorkspaceRoute";

export type Theme = "dark" | "light";

export function App() {
  const [theme, setTheme] = useState<Theme>("dark");
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <FleetProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell theme={theme} onToggleTheme={toggleTheme} />}>
            <Route index element={<BridgeRoute />} />
            <Route path="repos/:repo" element={<RepoRoute />} />
            <Route path="repos/:repo/workspaces/:name" element={<WorkspaceRoute />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </FleetProvider>
  );
}

export default App;
