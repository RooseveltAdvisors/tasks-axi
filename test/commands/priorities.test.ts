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
  it("prints the count per level and the P0+P1 share from a fixture graph", async () => {
    const b = makeBacklog(GRAPH);
    try {
      const out = await prioritiesCommand([], b.ctx);
      expect(out).toContain("priorities:");
      expect(out).toContain("P0: 2");
      expect(out).toContain("P1: 1");
      expect(out).toContain("P2: 1");
      expect(out).toContain("P3: 0");
      expect(out).toContain("P4: 1");
      expect(out).toContain("unset: 1");
      expect(out).toContain("p0p1: 3 of 6 (50%)");
    } finally {
      b.cleanup();
    }
  });

  it("answers --json with a machine-readable histogram", async () => {
    const b = makeBacklog(GRAPH);
    try {
      const out = await prioritiesCommand(["--json"], b.ctx);
      const payload = JSON.parse(out) as Record<string, unknown>;
      expect(payload).toMatchObject({
        ok: true,
        action: "priorities",
        total: 6,
        counts: { "0": 2, "1": 1, "2": 1, "3": 0, "4": 1, unset: 1 },
        p0p1: { count: 3, total: 6, percent: 50 },
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
      const json = JSON.parse(await prioritiesCommand(["--json"], b.ctx));
      expect(json.p0p1).toEqual({ count: 0, total: 0, percent: 0 });
    } finally {
      b.cleanup();
    }
  });

  it("exposes usage help text", () => {
    expect(PRIORITIES_HELP).toContain("usage: tasks-axi priorities");
  });
});
