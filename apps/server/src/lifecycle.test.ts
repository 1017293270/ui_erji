import { describe, expect, it } from "vitest";
import { every } from "./lifecycle";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("every", () => {
  it("runs at once, never overlaps, survives errors, and stop waits for the run in progress", async () => {
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    let finished = 0;
    const stop = every(5, "test", async () => {
      runs += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(15);
      running -= 1;
      finished += 1;
      if (runs === 2) throw new Error("boom");
    });
    expect(runs).toBe(1);
    await sleep(80);
    await stop();
    const after = runs;
    expect(maxRunning).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(finished).toBe(runs);
    await sleep(30);
    expect(runs).toBe(after);
  });
});
