import { Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { Theme } from "@/App";
import { useFleet } from "@/data/FleetContext";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * The persistent app frame: sidebar + top bar wrapping the routed page. The
 * theme is applied here by toggling the `.dark` class that switches every
 * Bridge design token (see styles/globals.css).
 */
export function Shell({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { error } = useFleet();
  return (
    <div className={cn("flex h-full w-full bg-bg text-text font-prose", theme === "dark" && "dark")}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar theme={theme} onToggleTheme={onToggleTheme} />
        {error && (
          <div className="flex-none border-b border-term-err/40 bg-term-err/10 px-[22px] py-2 font-mono text-[11px] text-term-err">
            bridge error: {error}
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
