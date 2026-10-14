import { Check, Copy, Ellipsis, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { Meeting, MeetingStatus } from "../data/mockData";

interface MeetingTableProps {
  meetings: Meeting[];
  onViewAll: () => void;
}

const statusClass: Record<MeetingStatus, string> = {
  已生成: "bg-[var(--success-soft)] text-[var(--success)]",
  生成中: "bg-[var(--claude-accent-soft)] text-[var(--claude-accent-dark)]",
  待处理: "bg-[var(--warning-soft)] text-[var(--warning)]",
};

export function MeetingTable({ meetings, onViewAll }: MeetingTableProps) {
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const copyLink = async (meeting: Meeting) => {
    await navigator.clipboard?.writeText(`https://echomind.local/meetings/${meeting.id}`);
    setCopied(meeting.id);
    window.setTimeout(() => setCopied(null), 1400);
  };

  return (
    <section className="flex min-h-[470px] flex-col rounded-[12px] border border-[var(--claude-border)] bg-[var(--claude-surface)] p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] xl:min-h-0">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-heading text-[17px] font-semibold tracking-[-0.02em] text-[var(--claude-text)]">最近会议</h2>
          <p className="mt-1 text-[11px] text-[var(--claude-muted)]">自动同步并生成结构化纪要</p>
        </div>
        <button onClick={onViewAll} className="text-[11px] font-semibold text-[var(--claude-accent-dark)] hover:underline">查看全部 →</button>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-x-auto">
        <table className="h-full min-w-[680px] w-full table-fixed text-left">
          <thead>
            <tr className="h-[42px] border-b border-[var(--claude-border)] bg-[var(--table-head)] text-[10px] font-semibold text-[var(--claude-muted)]">
              <th className="w-[36%] px-2.5">会议</th>
              <th className="w-[22%] px-2.5">时间</th>
              <th className="w-[14%] px-2.5">时长</th>
              <th className="w-[16%] px-2.5">状态</th>
              <th className="px-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {meetings.map((meeting) => (
              <tr key={meeting.id} className="h-[88px] border-b border-[var(--claude-border)] last:border-b-0 hover:bg-[var(--row-hover)]">
                <td className="px-2.5">
                  <strong className="block truncate text-[11px] font-semibold text-[var(--claude-text)]">{meeting.title}</strong>
                  <span className="mt-1 block text-[9px] text-[var(--claude-muted)]">{meeting.attendees} 位参会者</span>
                </td>
                <td className="px-2.5 text-[10px] text-[var(--claude-muted)]">{meeting.time}</td>
                <td className="font-data px-2.5 text-[10px] text-[var(--claude-muted)]">{meeting.duration}</td>
                <td className="px-2.5">
                  <span className={`inline-flex rounded-full px-2 py-1 text-[9px] font-semibold ${statusClass[meeting.status]}`}>{meeting.status}</span>
                </td>
                <td className="relative px-2.5 text-right">
                  <button onClick={() => setOpenMenu(openMenu === meeting.id ? null : meeting.id)} className="rounded-lg p-2 text-[var(--claude-muted)] hover:bg-[var(--claude-surface-2)] hover:text-[var(--claude-text)]" aria-label={`${meeting.title}操作`}>
                    <Ellipsis size={17} />
                  </button>
                  {openMenu === meeting.id && (
                    <div className="absolute right-2 top-12 z-20 w-32 rounded-[10px] border border-[var(--claude-border)] bg-[var(--claude-surface)] p-1.5 text-left shadow-[0_10px_24px_rgba(75,56,42,0.15)]">
                      <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[10px] text-[var(--claude-text)] hover:bg-[var(--claude-bg)]" onClick={() => setOpenMenu(null)}><ExternalLink size={13} />查看纪要</button>
                      <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[10px] text-[var(--claude-text)] hover:bg-[var(--claude-bg)]" onClick={() => copyLink(meeting)}>{copied === meeting.id ? <Check size={13} /> : <Copy size={13} />}{copied === meeting.id ? "已复制" : "复制链接"}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {meetings.length === 0 && (
              <tr><td colSpan={5} className="py-16 text-center text-[12px] text-[var(--claude-muted)]">没有找到匹配的会议</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
