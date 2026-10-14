import type { TaskName } from "../prompts/common";

/**
 * Something code found wrong with a model answer.
 *  - minor: fixed deterministically, recorded for logs
 *  - major: fixed, but the answer looks unreliable: worth one retry
 *  - fatal: nothing usable: retry once, then fail
 */
export type IssueSeverity = "minor" | "major" | "fatal";

export interface Issue {
  task: TaskName;
  severity: IssueSeverity;
  /** Chinese, shown to the model on retry and in logs. */
  message: string;
}

export class IssueLog {
  readonly items: Issue[] = [];
  constructor(readonly task: TaskName) {}

  minor(message: string): void {
    this.items.push({ task: this.task, severity: "minor", message });
  }
  major(message: string): void {
    this.items.push({ task: this.task, severity: "major", message });
  }
  fatal(message: string): void {
    this.items.push({ task: this.task, severity: "fatal", message });
  }
  get hasFatal(): boolean {
    return this.items.some((i) => i.severity === "fatal");
  }
  get needsRetry(): boolean {
    return this.items.some((i) => i.severity !== "minor");
  }
}

/** When most of a list had to be thrown away, the answer is not trustworthy. */
export function flagHeavyLoss(log: IssueLog, what: string, total: number, kept: number): void {
  const dropped = total - kept;
  if (total >= 2 && dropped * 2 > total) {
    log.major(`${what}共 ${total} 条，其中 ${dropped} 条没有有效的片段编号被删除，请确保每条都引用逐字稿里真实存在的编号`);
  }
}
