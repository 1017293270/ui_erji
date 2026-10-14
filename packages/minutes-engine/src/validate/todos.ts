import { listOf } from "./chapters";
import { flagHeavyLoss, type IssueLog } from "./issues";
import type { SegmentIndex } from "./segment-index";

/** A todo as the model described it, with citations checked. Owner and date are resolved later, in code. */
export interface TodoDraft {
  title: string;
  detail?: string;
  ownerMention: string | null;
  ownerSegmentId: string | null;
  dueText: string | null;
  evidence: string[];
}

export function repairTodos(json: unknown, index: SegmentIndex, log: IssueLog): TodoDraft[] | null {
  const list = listOf(json, "todos");
  if (!list) {
    log.fatal("输出里没有 todos 数组");
    return null;
  }
  const out: TodoDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      log.minor("有一条待办格式不对，已忽略");
      continue;
    }
    const r = item as Record<string, unknown>;
    const title = str(r.title);
    if (!title) {
      log.minor("有一条待办没有标题，已删除");
      continue;
    }
    const unknown: string[] = [];
    const evidence = index.evidence(r.evidence, (id) => unknown.push(id));
    const ownerSegmentRaw = r.ownerSegmentId ?? r.assignedSegmentId;
    const ownerSegmentId = index.resolve(ownerSegmentRaw);
    if (ownerSegmentRaw != null && !ownerSegmentId) unknown.push(String(ownerSegmentRaw));
    if (unknown.length) log.minor(`待办「${title}」引用了不存在的片段 ${[...new Set(unknown)].join("、")}，已去掉`);
    if (ownerSegmentId && !evidence.includes(ownerSegmentId)) {
      evidence.push(ownerSegmentId);
      evidence.sort((a, b) => index.indexOf(a) - index.indexOf(b));
    }
    if (!evidence.length) {
      log.minor(`待办「${title}」没有有效依据，已删除`);
      continue;
    }
    const detail = str(r.detail);
    out.push({
      title,
      ...(detail ? { detail } : {}),
      ownerMention: str(r.ownerMention) ?? null,
      ownerSegmentId,
      dueText: str(r.dueText) ?? null,
      evidence,
    });
  }
  flagHeavyLoss(log, "待办", list.length, out.length);
  return out;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && !/^(null|none|无)$/i.test(s) ? s : undefined;
}
