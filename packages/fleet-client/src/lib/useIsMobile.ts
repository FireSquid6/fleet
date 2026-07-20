import { useEffect, useState } from "react";

/**
 * True below Tailwind's `md` breakpoint (768px). Used to swap dense desktop
 * grids for stacked mobile layouts that can't be expressed with `md:` classes
 * alone (see BridgeRoute). Client-only SPA, so reading `matchMedia` at mount is
 * safe — there's no server render to mismatch.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
