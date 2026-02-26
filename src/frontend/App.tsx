import "./index.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Project from "./pages/Project";
import ProjectAgents from "./pages/ProjectAgents";
import NewProject from "./pages/NewProject";
import Armory from "./pages/Armory";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="project/:projectId" element={<Project />} />
          <Route path="project/:projectId/agents" element={<ProjectAgents />} />
          <Route path="new-project" element={<NewProject />} />
          <Route path="armory" element={<Armory />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
