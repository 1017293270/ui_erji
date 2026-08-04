import { CheckCircle2, Headphones, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { Header } from "./components/Header";
import { InsightPanel } from "./components/InsightPanel";
import { MeetingTable } from "./components/MeetingTable";
import { Sidebar, type NavKey } from "./components/Sidebar";
import { StatCard } from "./components/StatCard";
import { meetings, stats } from "./data/mockData";

export function App() {
  const [activeNav, setActiveNav] = useState<NavKey>("工作台");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [generationState, setGenerationState] = useState<"idle" | "loading" | "done">("idle");
  const [showAll, setShowAll] = useState(false);

  const filteredMeetings = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const matches = keyword ? meetings.filter((meeting) => meeting.title.toLowerCase().includes(keyword) || meeting.status.includes(keyword)) : meetings;
    return showAll ? matches : matches.slice(0, 5);
  }, [search, showAll]);

  const generateSummary = () => {
    if (generationState === "loading") return;
    setGenerationState("loading");
    window.setTimeout(() => setGenerationState("done"), 1100);
    window.setTimeout(() => setGenerationState("idle"), 3600);
  };

  return (
    <div className="font-body min-h-screen bg-[var(--claude-bg)] text-[var(--claude-text)] lg:flex lg:h-screen lg:overflow-hidden">
      <Sidebar active={activeNav} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSelect={setActiveNav} />

      <main className="min-w-0 flex-1 px-4 pb-8 pt-4 sm:px-6 lg:h-screen lg:overflow-y-auto lg:px-8 lg:pb-8 lg:pt-6">
        <div className="mx-auto flex min-h-full max-w-[1180px] flex-col gap-5">
          <Header
            section={activeNav}
            search={search}
            notificationsOpen={notificationsOpen}
            onMenuOpen={() => setSidebarOpen(true)}
            onSearch={setSearch}
            onNotificationsToggle={() => setNotificationsOpen((current) => !current)}
          />

          <label className="flex h-11 items-center gap-2 rounded-[10px] border border-[var(--claude-border)] bg-[var(--claude-surface)] px-3.5 sm:hidden">
            <span className="text-[12px] text-[var(--claude-muted)]">搜索</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="会议、状态或关键词" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--placeholder)]" />
          </label>

          <section className="flex min-h-[136px] flex-col justify-between gap-5 rounded-[16px] bg-[var(--claude-accent)] px-6 py-6 text-white sm:flex-row sm:items-center sm:px-7">
            <div className="max-w-[670px]">
              <h2 className="font-heading text-[24px] font-bold leading-tight tracking-[-0.03em] sm:text-[27px]">把每一次讨论，变成可执行的结论</h2>
              <p className="mt-2 text-[12px] leading-relaxed text-[var(--hero-muted)] sm:text-[13px]">上传录音或同步耳机内容，AI 自动识别发言人、提炼决策与待办。</p>
            </div>
            <button onClick={generateSummary} className="flex h-[46px] shrink-0 items-center justify-center gap-2 rounded-[10px] bg-white px-[18px] text-[12px] font-semibold text-[var(--claude-accent-dark)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 disabled:opacity-70" disabled={generationState === "loading"}>
              {generationState === "done" ? <CheckCircle2 size={17} /> : generationState === "loading" ? <span className="size-4 animate-spin rounded-full border-2 border-[var(--claude-accent-soft)] border-t-[var(--claude-accent)]" /> : <Upload size={17} />}
              {generationState === "done" ? "纪要已生成" : generationState === "loading" ? "AI 生成中…" : "生成会议纪要"}
            </button>
          </section>

          <section aria-label="关键指标" className="grid grid-cols-1 gap-[18px] sm:grid-cols-3">
            {stats.map((stat) => <StatCard key={stat.label} {...stat} />)}
          </section>

          {activeNav !== "工作台" && (
            <div className="flex items-center gap-3 rounded-[12px] border border-[var(--claude-border)] bg-[var(--claude-surface)] px-4 py-3 text-[11px] text-[var(--claude-muted)]">
              <Headphones size={16} className="text-[var(--claude-accent)]" />已切换至“{activeNav}”，当前展示关联的会议工作台数据。
            </div>
          )}

          <div className="grid min-h-[520px] flex-1 grid-cols-1 gap-4 xl:min-h-[608px] xl:grid-cols-[minmax(0,760px)_minmax(300px,1fr)]">
            <MeetingTable meetings={filteredMeetings} onViewAll={() => setShowAll((current) => !current)} />
            <InsightPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
