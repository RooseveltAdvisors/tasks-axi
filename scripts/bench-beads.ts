/**
 * Fleet-scale Beads benchmark on a synthetic store.
 *
 *   pnpm build
 *   tsx scripts/bench-beads.ts                       # build store + timed scenarios
 *   tsx scripts/bench-beads.ts --store <dir>          # reuse a previously built store
 *   tsx scripts/bench-beads.ts --golden-out f.json    # dump all reads (pre-change baseline)
 *   tsx scripts/bench-beads.ts --store <dir> --golden-compare f.json
 *
 * Everything is synthetic: the store is generated from a fixed seed into a
 * temp directory (or a --store directory previously produced by this script).
 * It never touches a live beads database, and refuses --store paths outside
 * the system temp directory.
 *
 * Each timed scenario runs the real CLI (dist/bin/tasks-axi.js) as a
 * subprocess against the store, and counts bd invocations through a logging
 * shim so the table reports both wall time and subprocess fan-out.
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { BeadsStore } from "../src/backends/beads.js";
import {
  SYNTHETIC_ACTOR,
  SYNTHETIC_PREFIX,
  buildSyntheticStore,
  planSyntheticStore,
  syntheticId,
} from "../test/fixtures/synthetic-beads.js";
import { dumpStoreReads } from "../test/fixtures/beads-golden-dump.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distCli = join(repoRoot, "dist", "bin", "tasks-axi.js");

interface Options {
  issues: number;
  store?: string;
  keep: boolean;
  goldenOut?: string;
  goldenCompare?: string;
  skipTimings: boolean;
  /** Measure `list` while a concurrent bd reader holds the store lock. */
  contended: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    issues: 894,
    keep: false,
    skipTimings: false,
    contended: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--issues") {
      options.issues = Number(next);
      i += 1;
    } else if (arg === "--store") {
      options.store = next;
      i += 1;
    } else if (arg === "--keep") {
      options.keep = true;
    } else if (arg === "--golden-out") {
      options.goldenOut = next;
      i += 1;
    } else if (arg === "--golden-compare") {
      options.goldenCompare = next;
      i += 1;
    } else if (arg === "--skip-timings") {
      options.skipTimings = true;
    } else if (arg === "--contended") {
      options.contended = true;
    } else {
      console.error(`unknown flag: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function assertTempPath(path: string): void {
  const absolute = resolve(path);
  if (!absolute.startsWith(resolve(tmpdir()) + "/")) {
    throw new Error(
      `--store must point inside the system temp directory (got ${absolute}); ` +
        `this benchmark only ever runs against synthetic stores`,
    );
  }
}

/** A bd shim that logs one line per invocation, then execs the real binary. */
function writeBdShim(dir: string, realBinary: string, logPath: string): string {
  const shim = join(dir, "bd-count.sh");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `echo x >> ${JSON.stringify(logPath)}`,
      `exec ${JSON.stringify(realBinary)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  return shim;
}

interface ScenarioResult {
  scenario: string;
  seconds: number;
  bdCalls: number;
}

function runCli(
  cli: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { seconds: number; stdout: string } {
  const started = performance.now();
  const result = spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const seconds = (performance.now() - started) / 1000;
  if (result.status !== 0) {
    throw new Error(
      `CLI failed (${result.status}): tasks-axi ${args.join(" ")}\n` +
        `${result.stderr || result.stdout}`,
    );
  }
  return { seconds, stdout: result.stdout };
}

function timedScenario(
  name: string,
  cli: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  callLog: string,
): ScenarioResult {
  writeFileSync(callLog, "");
  const { seconds } = runCli(cli, args, cwd, env);
  const bdCalls = readFileSync(callLog, "utf8").split("\n").filter(Boolean).length;
  return { scenario: name, seconds, bdCalls };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const bdBinary = process.env.TASKS_AXI_TEST_BD ?? "bd";
  if (spawnSync(bdBinary, ["--version"], { stdio: "ignore" }).status !== 0) {
    console.error("bd binary not found; set TASKS_AXI_TEST_BD");
    process.exit(1);
  }
  if (!options.skipTimings && !existsSync(distCli)) {
    console.error(`${distCli} not found; run \`pnpm build\` first`);
    process.exit(1);
  }

  let storeDir = options.store;
  let built = false;
  if (storeDir) {
    assertTempPath(storeDir);
    if (!existsSync(join(storeDir, ".beads"))) {
      throw new Error(`--store ${storeDir} has no .beads; drop --store to build fresh`);
    }
  } else {
    storeDir = mkdtempSync(join(tmpdir(), "tasks-axi-bench-"));
    built = true;
    console.log(`building synthetic store (${options.issues} issues) in ${storeDir} ...`);
    const buildStarted = performance.now();
    buildSyntheticStore({
      dir: storeDir,
      issueCount: options.issues,
      binary: bdBinary,
    });
    console.log(
      `built in ${((performance.now() - buildStarted) / 1000).toFixed(0)}s`,
    );
  }

  const plan = planSyntheticStore(options.issues);
  const edgeCount = plan.edges.length;
  console.log(
    `store: ${storeDir} (${options.issues} issues, ${edgeCount} dependency edges)`,
  );

  const store = new BeadsStore({
    path: join(storeDir, ".beads"),
    binary: bdBinary,
    prefix: SYNTHETIC_PREFIX,
  });

  if (options.goldenOut) {
    const dump = await dumpStoreReads(store, plan);
    writeFileSync(options.goldenOut, `${JSON.stringify(dump, null, 1)}\n`);
    console.log(`golden dump written: ${options.goldenOut}`);
  }
  if (options.goldenCompare) {
    const dump = await dumpStoreReads(store, plan);
    const expected = readFileSync(options.goldenCompare, "utf8");
    const actual = `${JSON.stringify(dump, null, 1)}\n`;
    if (actual === expected) {
      console.log(`golden compare: MATCH (${options.goldenCompare})`);
    } else {
      writeFileSync(join(tmpdir(), "tasks-axi-golden-actual.json"), actual);
      console.error(
        `golden compare: MISMATCH; actual written to ${join(tmpdir(), "tasks-axi-golden-actual.json")}`,
      );
      process.exit(1);
    }
  }

  if (options.skipTimings) {
    if (!options.keep && built) {
      console.log(`(pass --keep to retain ${storeDir})`);
      rmSync(storeDir, { recursive: true, force: true });
    } else if (built) {
      console.log(`store retained at ${storeDir}`);
    }
    return;
  }

  if (options.contended) {
    // The embedded-dolt store serializes on .beads/embeddeddolt/.lock, so a
    // fleet actor reading the same store makes every bd subprocess wait.
    // A background loop of real bd reads models that load; the measured CLI
    // run pays one lock acquisition per bd subprocess it spawns.
    const stopFile = join(storeDir, ".bench-load-stop");
    writeFileSync(stopFile, "");
    rmSync(stopFile);
    const load = spawn(
      "/bin/sh",
      [
        "-c",
        `while [ ! -f ${JSON.stringify(stopFile)} ]; do ${JSON.stringify(
          resolveBd(bdBinary),
        )} list --all --no-pager -n 0 --json >/dev/null 2>&1; sleep 0.05; done`,
      ],
      { cwd: storeDir, stdio: "ignore", detached: true },
    );
    const stopLoad = async (): Promise<void> => {
      writeFileSync(stopFile, "");
      const stopped = new Promise<void>((resolve) => {
        load.on("exit", () => resolve());
      });
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      await Promise.race([stopped, timeout]);
      try {
        process.kill(-load.pid!, "SIGTERM");
      } catch {
        // already gone
      }
      rmSync(stopFile, { force: true });
    };
    const workDir = mkdtempSync(join(tmpdir(), "tasks-axi-bench-run-"));
    const configPath = join(storeDir, ".tasks.toml");
    const originalConfig = readFileSync(configPath, "utf8");
    let result: ScenarioResult;
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const callLog = join(workDir, "bd-calls.log");
      const shim = writeBdShim(workDir, resolveBd(bdBinary), callLog);
      writeFileSync(
        configPath,
        originalConfig.replace(/^binary = ".*"$/m, `binary = "${shim}"`),
      );
      result = timedScenario(
        "list (contended)",
        distCli,
        ["list"],
        storeDir,
        { BD_NON_INTERACTIVE: "1", BEADS_ACTOR: SYNTHETIC_ACTOR },
        callLog,
      );
    } finally {
      writeFileSync(configPath, originalConfig);
      await stopLoad();
      rmSync(workDir, { recursive: true, force: true });
    }
    console.log("");
    console.log(
      `| ${"list (contended)".padEnd(30)} | ${result.seconds
        .toFixed(2)
        .padEnd(9)} | ${String(result.bdCalls).padEnd(8)} |`,
    );
    console.log(
      "(concurrent bd reader holding the store lock; wall time includes lock waits)",
    );
    if (!options.keep && built) {
      rmSync(storeDir, { recursive: true, force: true });
    }
    return;
  }

  // Timed scenarios through the real CLI, counting bd spawns via a shim.
  const workDir = mkdtempSync(join(tmpdir(), "tasks-axi-bench-run-"));
  const callLog = join(workDir, "bd-calls.log");
  const shim = writeBdShim(workDir, resolveBd(bdBinary), callLog);
  const cliEnv = {
    BD_NON_INTERACTIVE: "1",
    BEADS_ACTOR: SYNTHETIC_ACTOR,
  };
  // The store's .tasks.toml names the real bd; point it at the counting shim
  // for the timed runs so subprocess fan-out is measurable.
  const configPath = join(storeDir, ".tasks.toml");
  const originalConfig = readFileSync(configPath, "utf8");
  writeFileSync(
    configPath,
    originalConfig.replace(/^binary = ".*"$/m, `binary = "${shim}"`),
  );

  const stamp = Date.now();
  const addedId = `syn-bench-${stamp}`;
  const blockerId = syntheticId(Math.min(6, options.issues - 1));
  const showId = syntheticId(Math.min(100, options.issues - 1));
  const results: ScenarioResult[] = [
    timedScenario("list", distCli, ["list"], storeDir, cliEnv, callLog),
    timedScenario("show", distCli, ["show", showId], storeDir, cliEnv, callLog),
    timedScenario("ready", distCli, ["ready"], storeDir, cliEnv, callLog),
    timedScenario("blocked", distCli, ["blocked"], storeDir, cliEnv, callLog),
    timedScenario(
      "add",
      distCli,
      ["add", addedId, "bench: add scenario", "--kind", "ship", "--repo", "bench"],
      storeDir,
      cliEnv,
      callLog,
    ),
    timedScenario(
      "block (dep-touching mutation)",
      distCli,
      ["block", addedId, "--by", blockerId],
      storeDir,
      cliEnv,
      callLog,
    ),
    timedScenario(
      "update",
      distCli,
      ["update", addedId, "--body", "bench: replacement body"],
      storeDir,
      cliEnv,
      callLog,
    ),
  ];

  writeFileSync(configPath, originalConfig);

  const pad = (value: string, width: number): string =>
    value.padEnd(width, " ");
  console.log("");
  console.log(`| ${pad("scenario", 30)} | ${pad("seconds", 9)} | bd calls |`);
  console.log(`| ${"-".repeat(30)} | ${"-".repeat(9)} | ${"-".repeat(8)} |`);
  for (const result of results) {
    console.log(
      `| ${pad(result.scenario, 30)} | ${pad(result.seconds.toFixed(2), 9)} | ${pad(String(result.bdCalls), 8)} |`,
    );
  }

  rmSync(workDir, { recursive: true, force: true });
  if (!options.keep && built) {
    rmSync(storeDir, { recursive: true, force: true });
    console.log(`\n(temp store removed; pass --keep to retain it)`);
  } else {
    console.log(`\nstore retained at ${storeDir}`);
  }
}

function resolveBd(binary: string): string {
  if (isAbsolute(binary)) return binary;
  const which = spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf8" });
  const found = (which.stdout || "").trim();
  if (!found) return binary;
  return found;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
