import type { Stat } from "../data/mockData";

export function StatCard({ label, value, detail, icon: Icon, positive }: Stat) {
  return (
    <article className="flex min-h-[112px] flex-col gap-2.5 rounded-[12px] border border-[var(--claude-border)] bg-[var(--claude-surface)] p-[18px] shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between text-[var(--claude-muted)]">
        <span className="text-[11px]">{label}</span>
        <Icon size={17} className="text-[var(--claude-accent)]" />
      </div>
      <div className="mt-auto flex items-end justify-between gap-3">
        <strong className="font-data text-[24px] font-semibold tracking-[-0.04em] text-[var(--claude-text)]">{value}</strong>
        <span className={`pb-1 text-[10px] ${positive ? "text-[var(--success)]" : "text-[var(--claude-muted)]"}`}>{detail}</span>
      </div>
    </article>
  );
}
