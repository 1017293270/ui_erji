import { Check, Sparkles } from "lucide-react";
import { useState } from "react";
import { insightTasks } from "../data/mockData";

export function InsightPanel() {
  const [completed, setCompleted] = useState<number[]>([]);

  const toggleTask = (id: number) => {
    setCompleted((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <aside className="flex min-h-[520px] flex-col rounded-[12px] border border-[var(--claude-border)] bg-[var(--claude-surface)] p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] xl:min-h-0">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-[17px] font-semibold tracking-[-0.02em] text-[var(--claude-text)]">AI 今日洞察</h2>
        <span className="flex size-8 items-center justify-center rounded-lg bg-[var(--claude-accent-soft)] text-[var(--claude-accent-dark)]"><Sparkles size={16} /></span>
      </div>

      <div className="mt-[18px] rounded-[10px] bg-[var(--insight-dark)] p-4 text-white">
        <p className="text-[10px] font-semibold text-[var(--insight-label)]">关键结论</p>
        <p className="font-heading mt-2 text-[15px] font-semibold leading-[1.45]">Q3 路线图已确认：优先交付离线转写与企业词库，目标 9 月灰度。</p>
      </div>

      <h3 className="mt-[18px] text-[11px] font-semibold text-[var(--claude-text)]">需要跟进的事项</h3>
      <div className="mt-3 space-y-3.5">
        {insightTasks.map((task) => {
          const checked = completed.includes(task.id);
          return (
            <button key={task.id} onClick={() => toggleTask(task.id)} className="group flex w-full items-start gap-2.5 text-left">
              <span className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition ${checked ? "border-[var(--claude-accent)] bg-[var(--claude-accent)] text-white" : "border-[var(--claude-border)] bg-[var(--claude-surface)] group-hover:border-[var(--claude-accent)]"}`}>
                {checked && <Check size={12} strokeWidth={2.5} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[11px] font-medium ${checked ? "text-[var(--claude-muted)] line-through" : "text-[var(--claude-text)]"}`}>{task.title}</span>
                <span className="mt-0.5 block text-[9px] text-[var(--claude-muted)]">{task.meta}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-[var(--claude-border)] pt-3 text-[10px]">
        <span className="text-[var(--claude-muted)]">自动识别语言</span>
        <span className="font-data font-semibold text-[var(--claude-text)]">中文 + English</span>
      </div>
    </aside>
  );
}
