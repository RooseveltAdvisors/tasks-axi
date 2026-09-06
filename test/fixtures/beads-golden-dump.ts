/**
 * Golden-file dump of every BeadsStore read projection, shared by the
 * benchmark script (`scripts/bench-beads.ts`) and the live regression test
 * (`test/backends/beads-golden.test.ts`).
 *
 * The dump is normalized (timestamps stripped, arrays sorted by id) so a
 * fixture generated before a change to `src/backends/beads.ts` can prove the
 * change returned byte-identical read results after.
 */
import type { BeadsStore } from "../../src/backends/beads.js";
import type { SyntheticPlan } from "./synthetic-beads.js";

const VOLATILE_FIELDS = new Set(["created", "updated", "closed"]);

export function normalizeTask(task: unknown): unknown {
  if (Array.isArray(task)) return task.map(normalizeTask);
  if (task && typeof task === "object") {
    const source = task as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (VOLATILE_FIELDS.has(key)) continue;
      out[key] = normalizeTask(source[key]);
    }
    return out;
  }
  return task;
}

function idOf(task: unknown): string {
  return String((task as { id?: string } | null)?.id ?? "");
}

/** Deterministic sample ids covering hubs, closed, deferred, in-flight, plain. */
export function sampleIds(plan: SyntheticPlan): string[] {
  return [
    ...plan.issues.filter((issue) => issue.hub).slice(0, 3),
    ...plan.issues.filter((issue) => issue.status === "closed").slice(0, 3),
    ...plan.issues.filter((issue) => issue.status === "deferred").slice(0, 2),
    ...plan.issues.filter((issue) => issue.status === "in_progress").slice(0, 2),
    plan.issues[10],
    plan.issues[100],
    plan.issues[400],
  ]
    .filter(Boolean)
    .map((issue) => issue.id);
}

export async function dumpStoreReads(
  store: BeadsStore,
  plan: SyntheticPlan,
): Promise<unknown> {
  const ids = sampleIds(plan);

  const gets: Record<string, unknown> = {};
  for (const id of ids) {
    gets[id] = normalizeTask(await store.get(id));
  }
  gets["syn-missing"] = normalizeTask(await store.get("syn-missing"));

  const deps: Record<string, unknown> = {};
  for (const id of ids.slice(0, 6)) {
    try {
      const result = await store.deps(id);
      deps[id] = {
        task: normalizeTask(result.task),
        items: normalizeTask(result.items),
      };
    } catch (error) {
      deps[id] = { error: String((error as Error).message) };
    }
  }

  const byId = (a: unknown, b: unknown) => idOf(a).localeCompare(idOf(b));
  const sorted = (items: unknown[]): unknown[] =>
    (normalizeTask(items) as unknown[]).sort(byId);
  const list = await store.list({});
  const ready = await store.ready({});
  const blocked = await store.blocked({});
  return {
    list: sorted(list.items),
    listTotal: list.total,
    ready: sorted(ready.items),
    readyTotal: ready.total,
    blocked: sorted(blocked.items),
    blockedTotal: blocked.total,
    gets,
    deps,
  };
}
