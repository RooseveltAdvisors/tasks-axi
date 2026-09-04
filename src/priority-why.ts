/**
 * The `priority-why:` body line: the one-line reason that must accompany
 * priority 0/1 on the beads backend (the priority-cap rule).
 *
 * The reason is persisted as a dedicated line at the top of the item body -
 * `priority-why: <text>` - on both backends, so it is human-visible in the
 * stored artifact (markdown body block / beads description). Reads lift the
 * line into the structured `task.priority_why` field and keep it out of the
 * displayed body; every persist path re-emits it, so a wholesale body
 * replacement (`update --body`) cannot silently strip the reason.
 */

import { AxiError } from "./errors.js";

export const PRIORITY_WHY_PREFIX = "priority-why:";

const PRIORITY_WHY_LINE_RE = /^priority-why:[ \t]?(.*)$/;

/** Validate and normalize a caller-supplied reason (single line, non-empty). */
export function normalizePriorityWhy(flag: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new AxiError(`${flag} requires a value`, "VALIDATION_ERROR", [
      `Pass ${flag}=... with a non-empty one-line reason`,
    ]);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new AxiError(`${flag} must be a single line`, "VALIDATION_ERROR", [
      `Pass ${flag}=... without line breaks`,
    ]);
  }
  return trimmed;
}

export function formatPriorityWhyLine(why: string): string {
  return `${PRIORITY_WHY_PREFIX} ${why}`;
}

/** Does this (unindented) body line carry the managed `priority-why:` form? */
export function isPriorityWhyLine(line: string): boolean {
  return PRIORITY_WHY_LINE_RE.test(line);
}

/**
 * The reserved-line rule: caller-supplied task bodies must not carry the
 * managed `priority-why:` form. On markdown the parse would silently lift the
 * line into the reason field (losing the body text and fabricating a reason
 * on an unprioritized item); on beads the create-time persistence check would
 * fail with an internal-sounding error. Refuse it up front instead - the
 * same fail-loud contract as the hold-reason parentheses rule.
 */
export function assertNoManagedPriorityWhyLine(body: string): void {
  for (const line of body.split("\n")) {
    if (!isPriorityWhyLine(line)) continue;
    throw new AxiError(
      'Task body must not contain the reserved "priority-why:" managed line',
      "VALIDATION_ERROR",
      [
        "State the priority reason via --why with --priority 0 or 1, or reword that body line",
      ],
    );
  }
}

/**
 * Split unindented body lines into the reason and the remaining lines.
 * The last matching line wins (hand edits can accumulate); every match is
 * removed so the canonical re-render never duplicates the line.
 */
export function splitPriorityWhyLines(lines: string[]): {
  lines: string[];
  why: string | undefined;
} {
  let why: string | undefined;
  const kept: string[] = [];
  for (const line of lines) {
    const match = line.match(PRIORITY_WHY_LINE_RE);
    if (match) {
      const value = match[1].trim();
      if (value !== "") why = value;
      continue;
    }
    kept.push(line);
  }
  return { lines: kept, why };
}

/**
 * Rebuild a stored body string with the reason line as its first line.
 * `undefined` why strips any existing line (the reason no longer applies).
 */
export function withPriorityWhyLine(
  body: string | undefined,
  why: string | undefined,
): string | undefined {
  const split = splitPriorityWhyLines(body ? body.split("\n") : []);
  const lines = why
    ? [formatPriorityWhyLine(why), ...split.lines]
    : split.lines;
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}
