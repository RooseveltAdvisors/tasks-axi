import { describe, expect, it } from "vitest";
import { makeBacklog } from "../helpers.js";
import {
  PRIORITIES_HELP,
  prioritiesCommand,
} from "../../src/commands/priorities.js";

const GRAPH = [
  "# Backlog",
  "",
  "## In flight",
  "- [ ] hot-zero - hottest (priority: 0)",
  "  priority-why: the launch train leaves without it",
  "- [ ] warm-one - warm (priority: 1)",
  "  priority-why: feeds the zero above",
  "",
  "## Queued",
  "- [ ] plain-two - ordinary (priority: 2)",
  "- [ ] deep-four - background (priority: 4)",
  "- [ ] unranked - nothing special",
  "",
  "## Done",
  "- [x] shipped-zero - already landed (priority: 0)",
  "",
].join("\n");

describe("priorities command", () => {
  it("counts the open backlog in the headline histogram and share", async () => {
    const b = makeBacklog(GRAPH);
    try {
      const out = await prioritiesCommand([], b.ctx);
      expect(out).toContain("open_priorities:");
      // The Done P0 is excluded: spent work must not relieve the cap.
      expect(out).toContain("P0: 1");
      expect(out).toContain("P1: 1");
      expect(out).toContain("P2: 1");
      expect(out).toContain("P3: 0");
      expect(out).toContain("P4: 1");
      expect(out).toContain("unset: 1");
      expect(out).toContain("p0p1: 2 of 5 (40%)");
    } finally {
      b.cleanup();
    }
  });

  it("reports the all-time share on its own line beneath the open one", async () => {
    const b = makeBacklog(GRAPH);
    try {
      const out = await prioritiesCommand([], b.ctx);
      expect(out).toContain("all_time_p0p1: 3 of 6 (50%)");
      expect(out.indexOf("p0p1: 2 of 5")).toBeLessThan(
        out.indexOf("all_time_p0p1:"),
      );
    } finally {
      b.cleanup();
    }
  });

  it("closing a task moves it out of the open share but not the all-time one", async () => {
    const b = makeBacklog(GRAPH);
    try {
      const before = JSON.parse(await prioritiesCommand(["--json"], b.ctx));
      await b.ctx.store.transition("hot-zero", "done");
      const after = JSON.parse(await prioritiesCommand(["--json"], b.ctx));
      expect(before.p0p1).toEqual({ count: 2, total: 5, percent: 40 });
      expect(after.p0p1).toEqual({ count: 1, total: 4, percent: 25 });
      expect(after.all_time.p0p1).toEqual(before.all_time.p0p1);
    } finally {
      b.cleanup();
    }
  });

  it("answers --json with both the open and all-time histograms", async () => {
    const b = makeBacklog(GRAPH);
    try {
      const out = await prioritiesCommand(["--json"], b.ctx);
      const payload = JSON.parse(out) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        action: "priorities",
        scope: "open",
        total: 5,
        counts: { "0": 1, "1": 1, "2": 1, "3": 0, "4": 1, unset: 1 },
        p0p1: { count: 2, total: 5, percent: 40 },
        all_time: {
          total: 6,
          counts: { "0": 2, "1": 1, "2": 1, "3": 0, "4": 1, unset: 1 },
          p0p1: { count: 3, total: 6, percent: 50 },
        },
      });
    } finally {
      b.cleanup();
    }
  });

  it("handles an empty backlog", async () => {
    const b = makeBacklog("# Backlog\n");
    try {
      const out = await prioritiesCommand([], b.ctx);
      expect(out).toContain("unset: 0");
      expect(out).toContain("p0p1: 0 of 0 (0%)");
      expect(out).toContain("all_time_p0p1: 0 of 0 (0%)");
      const json = JSON.parse(await prioritiesCommand(["--json"], b.ctx));
      expect(json.p0p1).toEqual({ count: 0, total: 0, percent: 0 });
      expect(json.all_time.p0p1).toEqual({ count: 0, total: 0, percent: 0 });
    } finally {
      b.cleanup();
    }
  });

  it("exposes usage help text", () => {
    expect(PRIORITIES_HELP).toContain("usage: tasks-axi priorities");
  });
});
