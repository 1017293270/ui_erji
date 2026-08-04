import {
  AudioLines,
  Headphones,
  LayoutDashboard,
  Menu,
  Settings,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

export type NavKey = "工作台" | "会议记录" | "AI 纪要" | "耳机设备" | "团队成员";

interface NavItem {
  label: NavKey;
  icon: LucideIcon;
}

interface SidebarProps {
  active: NavKey;
  open: boolean;
  onClose: () => void;
  onSelect: (item: NavKey) => void;
}

const navItems: NavItem[] = [
  { label: "工作台", icon: LayoutDashboard },
  { label: "会议记录", icon: AudioLines },
  { label: "AI 纪要", icon: Sparkles },
  { label: "耳机设备", icon: Headphones },
  { label: "团队成员", icon: Users },
];

export function Sidebar({ active, open, onClose, onSelect }: SidebarProps) {
  return (
    <>
      <button
        aria-label="关闭侧边栏"
        className={`fixed inset-0 z-30 bg-[var(--overlay)] transition-opacity lg:hidden ${open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={onClose}
      />
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[272px] p-[12px_14px_14px_12px] transition-transform duration-200 lg:static lg:z-auto lg:h-screen lg:shrink-0 lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="font-body flex h-full flex-col gap-7 rounded-[16px] border border-[var(--claude-border)] bg-[var(--sidebar)] px-5 py-7 shadow-[0_1px_3px_rgba(75,56,42,0.07),3px_4px_9px_rgba(75,56,42,0.12)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-[10px] bg-[var(--claude-accent)] text-white">
                <Headphones size={21} strokeWidth={2} />
              </div>
              <span className="font-heading text-[19px] font-bold tracking-[-0.02em] text-[var(--claude-text)]">EchoMind</span>
            </div>
            <button className="rounded-lg p-2 text-[var(--claude-muted)] hover:bg-[var(--claude-surface-2)] lg:hidden" onClick={onClose} aria-label="收起导航">
              <X size={18} />
            </button>
          </div>

          <div className="rounded-[12px] border border-[var(--claude-border)] bg-[var(--device-card)] p-4 shadow-[inset_0_1px_3px_rgba(107,84,64,0.12)]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-[var(--claude-text)]">Echo Buds Pro</span>
              <span className="flex items-center gap-1.5 rounded-full bg-[var(--success-soft)] px-2 py-1 text-[10px] font-semibold text-[var(--success)]">
                <span className="size-1.5 rounded-full bg-[var(--success)]" />在线
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--claude-muted)]">
              <span>耳机电量</span>
              <span className="font-data font-semibold text-[var(--claude-text)]">82%</span>
            </div>
          </div>

          <nav aria-label="主导航" className="flex flex-col gap-2">
            {navItems.map(({ label, icon: Icon }) => {
              const selected = label === active;
              return (
                <button
                  key={label}
                  onClick={() => {
                    onSelect(label);
                    onClose();
                  }}
                  className={`flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] transition ${
                    selected
                      ? "bg-[var(--claude-accent)] font-semibold text-white shadow-[0_4px_10px_rgba(217,119,87,0.18)]"
                      : "text-[var(--nav-text)] hover:bg-[var(--claude-surface-2)] hover:text-[var(--claude-text)]"
                  }`}
                >
                  <Icon size={17} strokeWidth={selected ? 2.2 : 1.8} />
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="mt-auto">
            <button className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-[var(--nav-text)] transition hover:bg-[var(--claude-surface-2)] hover:text-[var(--claude-text)]">
              <Settings size={17} />系统设置
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="flex size-10 items-center justify-center rounded-[10px] border border-[var(--claude-border)] bg-[var(--claude-surface)] text-[var(--claude-text)] lg:hidden" onClick={onClick} aria-label="打开导航">
      <Menu size={19} />
    </button>
  );
}
