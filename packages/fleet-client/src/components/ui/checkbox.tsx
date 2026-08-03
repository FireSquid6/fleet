import { cn } from "@/lib/utils";

/**
 * ui/checkbox.tsx — a real `<input type="checkbox">` with a label, styled to the
 * Bridge design language. Native rather than a composed widget: `accent-color`
 * is enough to tint the box, and the browser's own control keeps keyboard and
 * screen-reader behaviour for free.
 */
export function Checkbox({
  checked,
  onChange,
  disabled,
  children,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex w-fit cursor-pointer items-center gap-2 font-mono text-[11px] text-dim transition-colors hover:text-text",
        disabled && "cursor-not-allowed opacity-50 hover:text-dim",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="size-[13px] accent-accent"
      />
      {children}
    </label>
  );
}
