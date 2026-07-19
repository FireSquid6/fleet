import { useLocation } from "react-router-dom";
import type { Theme } from "@/App";

/** `bridge` / `bridge / {repo}` / `bridge / {repo} / {name}` from the URL. */
function breadcrumb(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "repos" && parts[1]) {
    if (parts[2] === "workspaces" && parts[3]) return `bridge / ${parts[1]} / ${parts[3]}`;
    return `bridge / ${parts[1]}`;
  }
  return "bridge";
}

export function TopBar({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { pathname } = useLocation();

  return (
    <header className="flex h-[53px] flex-none items-center justify-between border-b border-line bg-panel px-[22px]">
      <div className="font-mono text-[12px] font-medium tracking-[.02em] text-dim">{breadcrumb(pathname)}</div>
      <button
        type="button"
        onClick={onToggleTheme}
        className="flex items-center gap-1.5 rounded-[3px] border border-line px-[11px] py-1.5 font-mono text-[10.5px] font-medium text-text transition-colors hover:bg-panel2"
      >
        <span>◐</span>
        <span>{theme}</span>
      </button>
    </header>
  );
}
