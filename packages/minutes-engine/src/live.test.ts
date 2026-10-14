import { describe, expect, it } from "vitest";
import { Minutes, Todo } from "@echomind/shared";
import { people, reviewMeeting, reviewSegments } from "@echomind/shared/fixtures";
import { runPipeline } from "./pipeline";
import { DeepSeekProvider } from "./provider/deepseek";

/**
 * Calls the real DeepSeek API with the fixture meeting. Runs only when
 * DEEPSEEK_API_KEY is set; costs well under ¥0.1 per run.
 */
describe.skipIf(!process.env.DEEPSEEK_API_KEY)("DeepSeek live", () => {
  it("writes grounded minutes and todos for the fixture meeting", { timeout: 600_000 }, async () => {
    const provider = DeepSeekProvider.fromEnv();
    const { minutes, todos, usage, issues } = await runPipeline(reviewMeeting, { provider, directory: people });

    expect(() => Minutes.parse(minutes)).not.toThrow();
    for (const t of todos) expect(() => Todo.parse(t)).not.toThrow();

    const real = new Set(reviewSegments.map((s) => s.id));
    const cited = [...minutes.conclusions, ...minutes.decisions, ...minutes.openQuestions, ...todos].flatMap((p) => p.evidence);
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((id) => !real.has(id))).toEqual([]);

    const ch = minutes.chapters;
    expect(ch.length).toBeGreaterThanOrEqual(2);
    expect(ch[0]!.firstSegmentId).toBe("seg-0001");
    expect(ch[ch.length - 1]!.lastSegmentId).toBe("seg-0054");

    // The meeting assigns five clear owners; the model should find most of them.
    const owners = new Set(todos.map((t) => t.ownerPersonId));
    expect(["p-wang", "p-li", "p-zhou", "p-zhao", "p-chen"].filter((id) => owners.has(id)).length).toBeGreaterThanOrEqual(4);
    expect(minutes.generation.provider).toBe("deepseek");

    console.info(
      `[live] ${provider.model}: ${usage.calls} calls, in ${usage.inputTokens} (cached ${usage.cachedInputTokens}), out ${usage.outputTokens}; ` +
        `${ch.length} chapters, ${todos.length} todos, ${issues.length} repairs`,
    );
  });
});
