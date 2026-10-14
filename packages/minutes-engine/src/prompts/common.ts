export type TaskName = "chapters" | "minutes" | "todos" | "overview";

/**
 * First line of every system prompt. It names the task and prompt version,
 * which keeps logs readable and lets MockProvider route canned answers.
 */
export function marker(task: TaskName, version: string): string {
  return `# EchoMind 任务：${task}（${version}）`;
}

export const ROLE = "你是 EchoMind 的会议纪要助手，处理中文工作会议的逐字稿。";

export const TRANSCRIPT_FORMAT =
  "逐字稿每行是一个片段，格式为「[片段编号 时间 说话人] 内容」，例如「[seg-0012 06:53 李娜] 那如果用户开的是外放呢？」。" +
  "片段编号（如 seg-0012）是引用依据的唯一方式：只能原样使用逐字稿里出现过的编号，不能编造、改写或推算编号。" +
  "说话人是姓名时表示已经识别；是「说话人 5」这样的标签时表示还不知道是谁，照写即可，不要猜。";

export const JSON_ONLY = "只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或其他任何文字。JSON 格式示例：";

/** Appended to the user prompt on the one retry, so the model can fix what code rejected. */
export function feedback(problems: readonly string[]): string {
  return [
    "",
    "## 上一次输出的问题",
    "上一次输出未通过校验，问题如下。请修正后重新输出完整的 JSON（不要只输出修改的部分）：",
    ...problems.map((p) => `- ${p}`),
  ].join("\n");
}

/** A JSON example with one list item per line: valid JSON, easy to read, fewer tokens than full indentation. */
export function exampleJson(example: Record<string, unknown>): string {
  const entries = Object.entries(example).map(([key, value]) =>
    Array.isArray(value) && value.length
      ? `  ${JSON.stringify(key)}: [\n${value.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`
      : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `{\n${entries.join(",\n")}\n}`;
}
