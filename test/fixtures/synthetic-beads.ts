/**
 * Deterministic synthetic Beads store builder for fleet-scale benchmarks and
 * golden-file regression tests.
 *
 * Everything is generated from a fixed seed into a caller-supplied (fresh)
 * directory: git repo, `bd init`, issues, and a heterogeneous dependency
 * graph (chains, hub fan-in, fan-out, parent-child, discovered-from) with a
 * realistic status mix (open / in_progress / closed / deferred holds).
 *
 * Never point this at a live store: it writes and mutates everything under
 * `dir`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SYNTHETIC_PREFIX = "syn";
export const SYNTHETIC_ACTOR = "syn-bench";

/** Deterministic PRNG (mulberry32) so every run builds the same store. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticIssue {
  index: number;
  id: string;
  /** Planned final status: open | in_progress | closed | deferred. */
  status: "open" | "in_progress" | "closed" | "deferred";
  priority: number;
  body?: string;
  held: boolean;
  hub: boolean;
}

export interface SyntheticEdge {
  from: string;
  to: string;
  type: "blocks" | "parent-child" | "discovered-from";
}

export interface SyntheticPlan {
  issues: SyntheticIssue[];
  edges: SyntheticEdge[];
}

export function syntheticId(index: number, prefix = SYNTHETIC_PREFIX): string {
  return `${prefix}-b${String(index + 1).padStart(4, "0")}`;
}

/**
 * The shape of the plan: N issues where the first ~5% are "hubs" that much of
 * the backlog blocks on, chains threaded through the middle, and a tail of
 * parent-child / discovered-from edges. Statuses are mixed afterwards so a
 * realistic share of blockers is closed (dependents flip to ready) and some
 * dependents are themselves closed.
 */
export function planSyntheticStore(
  issueCount: number,
  seed = 20260905,
  prefix = SYNTHETIC_PREFIX,
): SyntheticPlan {
  const rand = prng(seed);
  const hubCount = Math.max(4, Math.ceil(issueCount * 0.05));
  const issues: SyntheticIssue[] = [];
  for (let i = 0; i < issueCount; i += 1) {
    const roll = rand();
    const status: SyntheticIssue["status"] =
      roll < 0.15
        ? "in_progress"
        : roll < 0.35
          ? "closed"
          : roll < 0.39
            ? "deferred"
            : "open";
    const priorityRoll = rand();
    const priority =
      priorityRoll < 0.02 ? 0 : priorityRoll < 0.08 ? 1 : priorityRoll < 0.7 ? 2 : priorityRoll < 0.9 ? 3 : 4;
    const bodyRoll = rand();
    const body =
      bodyRoll < 0.2
        ? `Synthetic body for issue ${i + 1}.\n\nSecond paragraph kept deterministic.`
        : bodyRoll < 0.4
          ? `Synthetic body for issue ${i + 1}.`
          : undefined;
    issues.push({
      index: i,
      id: syntheticId(i, prefix),
      status,
      priority,
      ...(body !== undefined ? { body } : {}),
      held: status === "deferred",
      hub: i < hubCount,
    });
  }

  const edges: SyntheticEdge[] = [];
  // bd (and tasks-axi) reject two relationship types between the same pair,
  // so the plan never schedules a duplicate pair.
  const pairs = new Set<string>();
  const pushEdge = (
    from: SyntheticIssue,
    to: SyntheticIssue,
    type: SyntheticEdge["type"],
  ) => {
    if (from.id === to.id) return;
    const key = `${from.id}->${to.id}`;
    if (pairs.has(key)) return;
    pairs.add(key);
    edges.push({ from: from.id, to: to.id, type });
  };
  const earlier = (i: number): SyntheticIssue =>
    issues[Math.floor(rand() * i)];

  for (let i = hubCount; i < issueCount; i += 1) {
    const issue = issues[i];
    const roll = rand();
    if (roll < 0.35) {
      // chain: blocked by the previous issue
      pushEdge(issue, issues[i - 1], "blocks");
    } else if (roll < 0.8) {
      // hub fan-in: blocked by a random hub
      pushEdge(issue, issues[Math.floor(rand() * hubCount)], "blocks");
    }
    // extra blockers on some issues (fan-out of dependents, multi-blocker tasks)
    if (rand() < 0.15) pushEdge(issue, earlier(i), "blocks");
    if (rand() < 0.05) pushEdge(issue, earlier(i), "blocks");
    if (rand() < 0.08) pushEdge(issue, earlier(i), "parent-child");
    if (rand() < 0.08) pushEdge(issue, earlier(i), "discovered-from");
  }
  return { issues, edges };
}

export function hasBd(binary: string): boolean {
  return (
    spawnSync(binary, ["--version"], { stdio: "ignore" }).status === 0
  );
}

export interface BuildSyntheticStoreOptions {
  /** Fresh directory for the git repo + .beads database. */
  dir: string;
  issueCount?: number;
  seed?: number;
  prefix?: string;
  binary?: string;
  plan?: SyntheticPlan;
}

export interface SyntheticStore {
  dir: string;
  plan: SyntheticPlan;
  prefix: string;
  /** Written .tasks.toml cwd for CLI invocations against this store. */
  configPath: string;
}

function run(
  binary: string,
  args: string[],
  cwd: string,
): void {
  execFileSync(binary, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      BD_NON_INTERACTIVE: "1",
      BEADS_ACTOR: SYNTHETIC_ACTOR,
    },
  });
}

/**
 * Builds the synthetic store on disk. `dir` must not already contain a beads
 * database (the caller creates a fresh temp dir).
 */
export function buildSyntheticStore(
  options: BuildSyntheticStoreOptions,
): SyntheticStore {
  const binary = options.binary ?? process.env.TASKS_AXI_TEST_BD ?? "bd";
  const prefix = options.prefix ?? SYNTHETIC_PREFIX;
  const plan =
    options.plan ??
    planSyntheticStore(options.issueCount ?? 894, options.seed ?? 20260905, prefix);
  const dir = options.dir;

  if (existsSync(join(dir, ".beads"))) {
    throw new Error(
      `refusing to build synthetic store: ${dir} already contains .beads`,
    );
  }
  mkdirSync(dir, { recursive: true });
  run("git", ["init", "-q"], dir);
  run("git", ["config", "user.name", "Synthetic Bench"], dir);
  run("git", ["config", "user.email", "synthetic@example.test"], dir);
  run(
    binary,
    [
      "init",
      "--prefix",
      prefix,
      "--skip-agents",
      "--skip-hooks",
      "--non-interactive",
    ],
    dir,
  );

  for (const issue of plan.issues) {
    const args = [
      "create",
      `synthetic issue ${issue.index + 1}`,
      "--id",
      issue.id,
      "--type",
      "task",
      "--priority",
      String(issue.priority),
    ];
    if (issue.body !== undefined) args.push("--description", issue.body);
    if (issue.held) args.push("--labels", "tasks-axi-held");
    if (issue.status === "deferred") args.push("--defer", "2031-06-01");
    args.push("--json");
    run(binary, args, dir);
  }
  for (const edge of plan.edges) {
    run(
      binary,
      [
        "dep",
        "add",
        edge.from,
        edge.to,
        "--type",
        edge.type,
        "--json",
      ],
      dir,
    );
  }
  for (const issue of plan.issues) {
    if (issue.status === "in_progress") {
      run(binary, ["update", issue.id, "--status", "in_progress", "--json"], dir);
    } else if (issue.status === "closed") {
      run(binary, ["close", issue.id, "--force", "--json"], dir);
    }
  }

  const configPath = join(dir, ".tasks.toml");
  writeFileSync(
    configPath,
    [
      'backend = "beads"',
      "",
      "[beads]",
      'path = ".beads"',
      `binary = "${binary}"`,
      `prefix = "${prefix}"`,
      "",
    ].join("\n"),
  );

  return { dir, plan, prefix, configPath };
}
