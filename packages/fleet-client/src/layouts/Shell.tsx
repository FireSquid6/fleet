import { useState } from "react";
import { Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { Theme } from "@/App";
import { useFleet } from "@/data/FleetContext";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * The persistent app frame: sidebar + top bar wrapping the routed page. The
 * theme is applied here by toggling the `.dark` class that switches every
 * Bridge design token (see styles/globals.css). On mobile the sidebar collapses
 * into a slide-out drawer whose open state lives here.
 */
export function Shell({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { error } = useFleet();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  return (
    <div className={cn("flex h-full w-full bg-bg text-text font-prose", theme === "dark" && "dark")}>
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar theme={theme} onToggleTheme={onToggleTheme} onOpenSidebar={() => setSidebarOpen(true)} />
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
