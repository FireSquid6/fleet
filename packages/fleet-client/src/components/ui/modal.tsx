import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * Minimal centered dialog in the Bridge design language. Closes on backdrop click
 * and Esc. Not focus-trapped — the app has no other overlay competing for focus,
 * so a full a11y dialog primitive would be more machinery than this UI needs.
 */
export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[calc(100dvh-2rem)] w-full max-w-[420px] flex-col overflow-hidden rounded-md border border-line bg-panel shadow-xl",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex-none border-b border-line px-5 py-[14px] font-mono text-[13px] font-semibold text-text">
          {title}
        </div>
        <div className="overflow-y-auto px-5 py-[18px]">{children}</div>
      </div>
    </div>
  );
}
