import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";

/**
 * These tests exercise the production default runner (a real spawned
 * subprocess, not the `run` seam), because the bug lived there: execFile's
 * default 1 MiB maxBuffer killed `bd list --all --json` the moment the
 * backlog crossed 1,048,576 bytes (fleet incident 2026-09-04: 797 rows,
 * 1,057,156 bytes, every read on gpu failed with a bare "beads list
 * failed").
 *
 * The fake bd must be spawnable on every CI OS, so instead of a shebang
 * script the store's binary is `process.execPath` and each bd verb is an
 * extensionless entry file in the workspace cwd: spawning
 * `node list --all ... --json` makes node run `<cwd>/list` with the flags
 * passed through to the script. Same mechanism on Linux, macOS, and Windows.
 */

const ROW_PAD = 2_560;
const TARGET_BYTES = Math.round(2.2 * 1024 * 1024);

interface FakeRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  issue_type: string;
  created_at: string;
  updated_at: string;
}

/** The exact rows the fake `list` emits; mirrored into rows.json so the
 * subprocess payload and the test's expectations share one source. */
function fakeRows(): FakeRow[] {
  const proto: Omit<FakeRow, "id"> = {
    title: "x".repeat(ROW_PAD),
    description: "",
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-09-04T00:00:00Z",
    updated_at: "2026-09-04T00:00:00Z",
  };
  const perRow = JSON.stringify({ id: "bd-row-0", ...proto }).length + 1;
  const count = Math.ceil(TARGET_BYTES / perRow);
  return Array.from({ length: count }, (_, index) => ({
    id: `bd-row-${index}`,
    ...proto,
  }));
}

const rows = fakeRows();

const workspaces: string[] = [];

async function fakeBdWorkspace(failOnList = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tasks-axi-bd-runner-"));
  workspaces.push(dir);
  await mkdir(join(dir, ".beads"));
  await writeFile(join(dir, "rows.json"), JSON.stringify(rows));
  // Verb entry files: node resolves each first argument from the cwd, and
  // the extensionless entries default to CommonJS.
  await writeFile(
    join(dir, "list"),
    failOnList
      ? [
          "process.stderr.write('fake bd: database is locked');",
          "process.exit(3);",
          "",
        ].join("\n")
      : "process.stdout.write(require('node:fs').readFileSync('rows.json', 'utf8'));\n",
  );
  await writeFile(join(dir, "blocked"), 'process.stdout.write("[]");\n');
  await writeFile(join(dir, "dep"), 'process.stdout.write("[]");\n');
  return dir;
}

afterAll(async () => {
  await Promise.all(
    workspaces.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("BeadsStore default runner", () => {
  it("streams a >2 MiB bd list through the spawned runner", async () => {
    // The incident threshold was 1 MiB; prove the fixture doubles it.
    expect(JSON.stringify(rows).length).toBeGreaterThan(2 * 1024 * 1024);
    const dir = await fakeBdWorkspace();
    const store = new BeadsStore({
      path: join(dir, ".beads"),
      binary: process.execPath,
    });

    const listed = await store.list({});

    expect(listed.total).toBe(rows.length);
    expect(listed.items[0]).toMatchObject({
      id: "bd-row-0",
      state: "queued",
    });
    expect(listed.items.at(-1)?.id).toBe(`bd-row-${rows.length - 1}`);
  }, 30_000);

  it("surfaces a bd failure's stderr and exit status", async () => {
    const dir = await fakeBdWorkspace(true);
    const store = new BeadsStore({
      path: join(dir, ".beads"),
      binary: process.execPath,
    });

    await expect(store.list({})).rejects.toThrow(
      /beads list failed: exit 3: fake bd: database is locked/,
    );
  });
});
