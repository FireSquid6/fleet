import "./index.css";

import { useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./data/AuthContext";
import { FleetProvider } from "./data/FleetContext";
import { Shell } from "./layouts/Shell";
import { BridgeRoute } from "./routes/BridgeRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { ReposRoute } from "./routes/ReposRoute";
import { RepoRoute } from "./routes/RepoRoute";
import { ShipsRoute } from "./routes/ShipsRoute";
import { WorkspaceRoute } from "./routes/WorkspaceRoute";

export type Theme = "dark" | "light";

export function App() {
  const [theme, setTheme] = useState<Theme>("dark");
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          {/* Fleet data only loads once authenticated, so FleetProvider sits inside RequireAuth. */}
          <Route
            element={
              <RequireAuth>
                <FleetProvider>
                  <Shell theme={theme} onToggleTheme={toggleTheme} />
                </FleetProvider>
              </RequireAuth>
            }
          >
            <Route index element={<BridgeRoute />} />
            <Route path="repos" element={<ReposRoute />} />
            <Route path="ships" element={<ShipsRoute />} />
            <Route path="repos/:repo" element={<RepoRoute />} />
            <Route path="repos/:repo/workspaces/:name" element={<WorkspaceRoute />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
