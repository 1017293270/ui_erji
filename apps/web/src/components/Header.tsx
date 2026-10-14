import { Bell, Search, X } from "lucide-react";
import { MobileMenuButton } from "./Sidebar";

interface HeaderProps {
  section: string;
  search: string;
  notificationsOpen: boolean;
  onMenuOpen: () => void;
  onSearch: (value: string) => void;
  onNotificationsToggle: () => void;
}

export function Header({ section, search, notificationsOpen, onMenuOpen, onSearch, onNotificationsToggle }: HeaderProps) {
  return (
    <header className="relative flex min-h-[52px] items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <MobileMenuButton onClick={onMenuOpen} />
        <div className="min-w-0">
          <h1 className="font-heading truncate text-[18px] font-semibold tracking-[-0.02em] text-[var(--claude-text)]">
            {section === "工作台" ? "早上好，林墨" : section}
          </h1>
          <p className="mt-0.5 truncate text-[11px] text-[var(--claude-muted)]">2026年8月3日 · 周一</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <label className="group hidden h-10 w-[244px] items-center gap-2 rounded-[10px] border border-[var(--claude-border)] bg-[var(--claude-surface)] px-3.5 transition focus-within:border-[var(--claude-accent)] focus-within:ring-2 focus-within:ring-[var(--accent-ring)] sm:flex">
          <Search size={16} className="shrink-0 text-[var(--claude-muted)]" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--claude-text)] outline-none placeholder:text-[var(--placeholder)]"
            placeholder="搜索会议、成员或关键词"
            aria-label="搜索会议"
          />
          {search && (
            <button type="button" onClick={() => onSearch("")} className="text-[var(--claude-muted)] hover:text-[var(--claude-text)]" aria-label="清空搜索">
              <X size={14} />
            </button>
          )}
        </label>

        <button
          className={`relative flex size-10 items-center justify-center rounded-[10px] border transition ${notificationsOpen ? "border-[var(--claude-accent)] bg-[var(--claude-accent-soft)] text-[var(--claude-accent-dark)]" : "border-[var(--claude-border)] bg-[var(--claude-surface)] text-[var(--claude-text)] hover:bg-[var(--claude-surface-2)]"}`}
          onClick={onNotificationsToggle}
          aria-label="通知"
          aria-expanded={notificationsOpen}
        >
          <Bell size={18} />
          <span className="absolute right-2 top-2 size-1.5 rounded-full bg-[var(--claude-accent)]" />
        </button>
        <button className="font-heading flex size-10 items-center justify-center rounded-full bg-[var(--avatar)] text-[12px] font-bold text-white" aria-label="打开个人资料">
          LM
        </button>
      </div>

      {notificationsOpen && (
        <div className="absolute right-12 top-12 z-20 w-[280px] rounded-[12px] border border-[var(--claude-border)] bg-[var(--claude-surface)] p-4 shadow-[0_14px_30px_rgba(75,56,42,0.16)]">
          <div className="flex items-center justify-between">
            <strong className="font-heading text-[13px] text-[var(--claude-text)]">通知</strong>
            <span className="rounded-full bg-[var(--claude-accent-soft)] px-2 py-0.5 text-[9px] font-semibold text-[var(--claude-accent-dark)]">2 条新消息</span>
          </div>
          <div className="mt-3 space-y-3 text-[11px]">
            <p className="rounded-lg bg-[var(--claude-bg)] p-3 text-[var(--claude-text)]">“产品 Q3 路线图评审”纪要已生成。</p>
            <p className="rounded-lg bg-[var(--claude-bg)] p-3 text-[var(--claude-text)]">Echo Buds Pro 固件可更新至 2.4.1。</p>
          </div>
        </div>
      )}
    </header>
  );
}
