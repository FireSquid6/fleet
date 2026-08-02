export interface TargetParts {
  /** Session name or id (`$N`). */
  session?: string;
  /** Window name, index, or id (`@N`). */
  window?: string | number;
  /** Pane index or id (`%N`). */
  pane?: string | number;
}

/**
 * Build a tmux target of the form `session:window.pane`. tmux server-unique ids
 * (`$N`, `@N`, `%N`) are valid targets on their own, so this is only needed when
 * addressing entities by name/index; the handle classes accept ids directly.
 */
export function buildTarget(parts: TargetParts): string {
  let target = parts.session ?? "";
  if (parts.window !== undefined) target += `:${parts.window}`;
  if (parts.pane !== undefined) target += `.${parts.pane}`;
  return target;
}
