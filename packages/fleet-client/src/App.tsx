import "./index.css";

import { useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./data/AuthContext";
import { FleetProvider } from "./data/FleetContext";
import { Shell } from "./layouts/Shell";
import { ArmoryRoute } from "./routes/ArmoryRoute";
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

  // On the document root rather than a wrapper element so that content
  // portalled to `document.body` — the combobox list — is themed too.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return (
    <AuthProvider>
      <SignedIn>
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
      </SignedIn>
    </AuthProvider>
  );
}

/**
 * Nothing at all until the session is settled: mounting the children early would
 * fetch fleet data unauthenticated, and rendering the login screen would flash
 * it at someone whose stored token is about to check out.
 */
function SignedIn({ children }: { children: ReactNode }) {
  const { resolved, authRequired, user } = useAuth();
  if (!resolved) return null;
  if (authRequired && !user) return <LoginRoute />;
  return <>{children}</>;
}

export default App;
