import {
  execFile as execFileCallback,
  execFileSync,
  spawnSync,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BeadsStore, type BeadsRunner } from "../../src/backends/beads.js";
import { blockedIds } from "../../src/derive.js";

const execFile = promisify(execFileCallback);
const BD_BINARY = process.env.TASKS_AXI_TEST_BD ?? "bd";
const hasBd =
  spawnSync(BD_BINARY, ["--version"], {
    stdio: "ignore",
  }).status === 0;

function run(binary: string, args: string[], cwd: string): string {
  return execFileSync(binary, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, BD_NON_INTERACTIVE: "1" },
  });
}

function runAs(actor: string): BeadsRunner {
  return async (binary, args, cwd) => {
    const result = await execFile(binary, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        BD_NON_INTERACTIVE: "1",
        BEADS_ACTOR: actor,
      },
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  };
}

describe.skipIf(!hasBd)("BeadsStore live bd round-trip", () => {
  it("round-trips native readiness, blockers, deps, and exclusive claims", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-live-"));
    try {
      run("git", ["init", "-q"], dir);
      run("git", ["config", "user.name", "Fixture Agent"], dir);
      run("git", ["config", "user.email", "fixture@example.test"], dir);
      run(
        BD_BINARY,
        [
          "init",
          "--prefix",
          "fx",
          "--skip-agents",
          "--skip-hooks",
          "--non-interactive",
        ],
        dir,
      );

      const first = new BeadsStore({
        path: join(dir, ".beads"),
        binary: BD_BINARY,
        prefix: "fx",
        run: runAs("agent-one"),
      });
      const second = new BeadsStore({
        path: join(dir, ".beads"),
        binary: BD_BINARY,
        prefix: "fx",
        run: runAs("agent-two"),
      });
      await first.create({ id: "fx-blocker", title: "blocker" });
      await first.create({
        id: "fx-dependent",
        title: "dependent",
        body: "live fixture notes",
        kind: "ship",
        repo: "tasks-axi",
        priority: 1,
        meta: { fixture: "live" },
      });
      await first.create({ id: "fx-ready", title: "ready" });
      await first.addDep("fx-dependent", {
        type: "blocked-by",
        id: "fx-blocker",
        reason: "waits on live blocker",
      });

      expect(
        (await first.ready({})).items.map((task) => task.id).sort(),
      ).toEqual(["fx-blocker", "fx-ready"]);
      const blocked = await first.blocked({});
      const blocker = await first.get("fx-blocker");
      expect(blocked.items.map((task) => task.id)).toEqual(["fx-dependent"]);
      expect(blockedIds([...blocked.items, blocker!]).has("fx-dependent")).toBe(
        true,
      );
      await expect(first.deps("fx-dependent")).resolves.toMatchObject({
        items: [
          {
            type: "blocked-by",
            id: "fx-blocker",
            reason: "waits on live blocker",
          },
        ],
      });
      await expect(first.get("fx-dependent")).resolves.toMatchObject({
        body: "live fixture notes",
        kind: "ship",
        repo: "tasks-axi",
        priority: 1,
        meta: { fixture: "live" },
      });

      const claims = await Promise.allSettled([
        first.claim("fx-ready"),
        second.claim("fx-ready"),
      ]);
      expect(
        claims.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        claims.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect((await first.get("fx-ready"))?.state).toBe("in_flight");

      await first.transition("fx-blocker", "done");
      const newlyReady = (await first.ready({})).items.find(
        (task) => task.id === "fx-dependent",
      );
      expect(newlyReady).toMatchObject({
        body: "live fixture notes",
        kind: "ship",
        repo: "tasks-axi",
        deps: [
          {
            type: "blocked-by",
            id: "fx-blocker",
            reason: "waits on live blocker",
          },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
