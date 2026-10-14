import { LlmError } from "./errors";

/**
 * Parses the text a model returned in JSON mode. JSON mode normally yields a
 * bare object, but OpenAI-compatible servers without it (private vLLM, older
 * gateways) like to wrap it in ```json fences or add a sentence around it.
 */
export function parseModelJson(content: string | null | undefined, provider: string, finishReason?: string): unknown {
  const text = (content ?? "").trim();
  if (!text) {
    throw new LlmError({ kind: "invalid_json", provider, finishReason, detail: "模型返回了空内容" });
  }
  if (finishReason === "length") {
    throw new LlmError({ kind: "invalid_json", provider, finishReason, detail: "finish_reason=length" });
  }
  for (const candidate of candidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  throw new LlmError({
    kind: "invalid_json",
    provider,
    finishReason,
    detail: `无法解析：${text.length > 120 ? `${text.slice(0, 120)}…` : text}`,
  });
}

function* candidates(text: string): Generator<string> {
  yield text;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) yield fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) yield text.slice(first, last + 1);
}
