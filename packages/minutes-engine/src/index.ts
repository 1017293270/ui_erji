export type { LlmProvider, LlmRequest, LlmResult, LlmUsage } from "./provider/types";
export { LlmError, MissingApiKeyError, type LlmErrorKind } from "./provider/errors";
export { OpenAICompatibleProvider, mapUsage, type OpenAICompatibleOptions, type FetchLike, type ChatCompletionBody } from "./provider/openai-compatible";
export { DeepSeekProvider, DEEPSEEK_BASE_URL, DEEPSEEK_DEFAULT_MODEL, type DeepSeekOptions } from "./provider/deepseek";
export { MockProvider, MockRaw, MockFailure, TASK_MARKER, type MockReply, type MockCall } from "./provider/mock";
export { parseModelJson } from "./provider/json";

export {
  createMinutesEngine,
  DefaultMinutesEngine,
  MinutesEngineError,
  shanghaiIso,
  type MeetingContext,
  type MinutesEngine,
  type MinutesEngineOptions,
} from "./engine";
export { runPipeline, meetingContext, type PipelineOptions, type PipelineResult, type PipelineStep } from "./pipeline";
export { UsageMeter, type PipelineUsage, type TaskUsage } from "./usage";
export type { Issue, IssueSeverity } from "./validate/issues";

export { resolveOwner, cleanMention, claimsFirstPerson, selfMention, type OwnerInput, type OwnerContext, type OwnerResolution } from "./resolve/owner";
export { resolveDue, shanghaiDay, parseCnNumber } from "./resolve/due";
export { mergeDuplicateTodos, titleSimilarity } from "./resolve/dedupe";

export { renderTranscript, renderSegment, renderSpeakers, renderPeople, renderChapters, speakerName, stamp, peopleById } from "./prompts/render";
export { CHAPTERS_PROMPT_VERSION } from "./prompts/chapters";
export { MINUTES_PROMPT_VERSION } from "./prompts/minutes";
export { TODOS_PROMPT_VERSION } from "./prompts/todos";
export { OVERVIEW_PROMPT_VERSION } from "./prompts/overview";
export { estimateTokens } from "./tokens";
