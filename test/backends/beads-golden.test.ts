/**
 * Golden-file regression test: every BeadsStore read projection on a
 * deterministic synthetic store must match the fixture byte for byte.
 *
 * The fixture (`test/fixtures/beads-golden.json`) was generated BEFORE the
 * fleet-scale read-path rework landed, through the same shared dump module
 * (`test/fixtures/beads-golden-dump.ts`). Any change to how deps, native
 * blockers, statuses, or projections hydrate that alters read output fails
 * here — performance work must be behavior-preserving.
 *
 * Requires the real `bd` binary; skipped otherwise (same rule as
 * `beads-live.test.ts`). The store is built fresh in a temp directory from a
 * fixed seed: synthetic data only, never a live store.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { dumpStoreReads } from "../fixtures/beads-golden-dump.js";
import {
  SYNTHETIC_PREFIX,
  buildSyntheticStore,
  planSyntheticStore,
} from "../fixtures/synthetic-beads.js";

const BD_BINARY = process.env.TASKS_AXI_TEST_BD ?? "bd";
const hasBd = spawnSync(BD_BINARY, ["--version"], { stdio: "ignore" }).status === 0;
const GOLDEN_ISSUES = 40;
const fixtureUrl = new URL("../fixtures/beads-golden.json", import.meta.url);
const fixturePath = fileURLToPath(fixtureUrl);

describe.skipIf(!hasBd)("BeadsStore golden reads", () => {
  it("returns identical read results to the pre-rework fixture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-golden-"));
    try {
      buildSyntheticStore({
        dir,
        issueCount: GOLDEN_ISSUES,
        binary: BD_BINARY,
      });
      const store = new BeadsStore({
        path: join(dir, ".beads"),
        binary: BD_BINARY,
        prefix: SYNTHETIC_PREFIX,
      });

      const dump = await dumpStoreReads(
        store,
        planSyntheticStore(GOLDEN_ISSUES),
      );
      const actual = `${JSON.stringify(dump, null, 1)}\n`;
      const expected = readFileSync(fixturePath, "utf8");
      expect(actual).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
