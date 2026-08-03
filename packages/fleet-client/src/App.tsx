import "./index.css";

import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { FleetProvider } from "./data/FleetContext";
import { Shell } from "./layouts/Shell";
import { ArmoryRoute } from "./routes/ArmoryRoute";
import { BridgeRoute } from "./routes/BridgeRoute";
import { ReposRoute } from "./routes/ReposRoute";
import { RepoRoute } from "./routes/RepoRoute";
import { ShipsRoute } from "./routes/ShipsRoute";
import { WorkspaceRoute } from "./routes/WorkspaceRoute";

export type Theme = "dark" | "light";

export function App() {
  const [theme, setTheme] = useState<Theme>("dark");
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // On the document root rather than a wrapper element so that content
  // portalled to `document.body` — the combobox list — is themed too.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <FleetProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell theme={theme} onToggleTheme={toggleTheme} />}>
            <Route index element={<BridgeRoute />} />
            <Route path="repos" element={<ReposRoute />} />
            <Route path="ships" element={<ShipsRoute />} />
            <Route path="armory" element={<ArmoryRoute />} />
            <Route path="repos/:repo" element={<RepoRoute />} />
            <Route path="repos/:repo/workspaces/:name" element={<WorkspaceRoute />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </FleetProvider>
  );
}

export default App;
