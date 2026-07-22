import { useLocation } from "react-router-dom";
import { LogOut, Menu } from "lucide-react";
import type { Theme } from "@/App";
import { useAuth } from "@/data/AuthContext";

/** `bridge` / `bridge / {repo}` / `bridge / {repo} / {name}` from the URL. */
function breadcrumb(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "repos" && parts[1]) {
    if (parts[2] === "workspaces" && parts[3]) return `bridge / ${parts[1]} / ${parts[3]}`;
    return `bridge / ${parts[1]}`;
  }
  return "bridge";
}

export function TopBar({
  theme,
  onToggleTheme,
  onOpenSidebar,
}: {
  theme: Theme;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
}) {
  const { pathname } = useLocation();
  const { authRequired, user, logout } = useAuth();

  return (
    <header className="flex h-[53px] flex-none items-center gap-2 border-b border-line bg-panel px-4 md:justify-between md:px-[22px]">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open navigation"
        className="-ml-1.5 flex size-10 flex-none items-center justify-center rounded-[3px] text-text transition-colors hover:bg-panel2 md:hidden"
      >
        <Menu className="size-[18px]" />
      </button>
      <div className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium tracking-[.02em] text-dim md:flex-none">
        {breadcrumb(pathname)}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex items-center gap-1.5 rounded-[3px] border border-line px-[11px] py-1.5 font-mono text-[10.5px] font-medium text-text transition-colors hover:bg-panel2"
        >
          <span>◐</span>
          <span>{theme}</span>
        </button>
        {authRequired && user && (
          <button
            type="button"
            onClick={() => void logout()}
            title={`Sign out ${user.username}`}
            aria-label="Sign out"
            className="flex items-center gap-1.5 rounded-[3px] border border-line px-[11px] py-1.5 font-mono text-[10.5px] font-medium text-text transition-colors hover:bg-panel2"
          >
            <LogOut className="size-[13px]" />
            <span className="hidden sm:inline">{user.username}</span>
          </button>
        )}
      </div>
    </header>
  );
}
