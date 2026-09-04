import { requirePositionals, takeBoolFlag } from "../args.js";
import { requireCtx, type TasksContext } from "../context.js";
import { countPriorities } from "../derive.js";
import type { PriorityCounts } from "../model.js";
import { getSuggestions } from "../suggestions.js";
import {
  field,
  renderDetail,
  renderHelp,
  renderOutput,
  renderScalar,
  type FieldDef,
} from "../toon.js";

export const PRIORITIES_HELP = `usage: tasks-axi priorities
Prints the count per priority level and the P0+P1 share of the backlog.
flags:
  --json   print the histogram as a JSON object
examples:
  tasks-axi priorities
  tasks-axi priorities --json`;

const PRIORITY_FIELDS: FieldDef[] = [
  field("P0"),
  field("P1"),
  field("P2"),
  field("P3"),
  field("P4"),
  field("unset"),
];

export interface PrioritiesSummary {
  counts: PriorityCounts;
  total: number;
  /** Tasks at P0 or P1 - the number that must stay small to mean anything. */
  high: number;
  /** Share of P0+P1 over all tasks, rounded to a whole percent. */
  percent: number;
}

export function summarizePriorities(counts: PriorityCounts): PrioritiesSummary {
  const total = counts.counts.reduce((sum, n) => sum + n, 0) + counts.unset;
  const high = counts.counts[0] + counts.counts[1];
  return {
    counts,
    total,
    high,
    percent: total === 0 ? 0 : Math.round((high * 100) / total),
  };
}

export async function prioritiesCommand(
  rawArgs: string[],
  context?: TasksContext,
): Promise<string> {
  const { store } = requireCtx(context);
  const args = [...rawArgs];
  const json = takeBoolFlag(args, "--json");
  requirePositionals(args, 0, 0, PRIORITIES_HELP.split("\n")[0]);

  // Backends with a cheap native histogram (beads: one `bd list`) answer
  // directly; everyone else derives it from the same core `list` read.
  const counts = store.priorities
    ? await store.priorities()
    : countPriorities((await store.list({})).items);
  const summary = summarizePriorities(counts);

  if (json) {
    return JSON.stringify(
      {
        ok: true,
        action: "priorities",
        counts: {
          "0": counts.counts[0],
          "1": counts.counts[1],
          "2": counts.counts[2],
          "3": counts.counts[3],
          "4": counts.counts[4],
          unset: counts.unset,
        },
        total: summary.total,
        p0p1: {
          count: summary.high,
          total: summary.total,
          percent: summary.percent,
        },
      },
      null,
      2,
    );
  }

  const blocks = [
    renderDetail(
      "priorities",
      {
        P0: counts.counts[0],
        P1: counts.counts[1],
        P2: counts.counts[2],
        P3: counts.counts[3],
        P4: counts.counts[4],
        unset: counts.unset,
      },
      PRIORITY_FIELDS,
    ),
    renderScalar(
      "p0p1",
      `${summary.high} of ${summary.total} (${summary.percent}%)`,
    ),
    renderHelp(
      getSuggestions({
        action: "priorities",
        isEmpty: summary.total === 0,
        globals: context?.suggestionGlobals,
      }),
    ),
  ];
  return renderOutput(blocks);
}
