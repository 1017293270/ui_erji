import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { dayLabel, duration, timeOfDay } from "@echomind/shared";
import { SearchArt } from "@echomind/ui";
import { Button, MeetingStatusBadge, Tabs } from "../components/ui";
import { href, navigate, useLocation } from "../lib/router";
import { useStore } from "../lib/store";
import { Centered, Processing } from "../pages/MeetingDetail";
import { DetailProvider } from "../pages/meeting/context";
import { MinutesTab, SpeakersTab, TodosTab } from "../pages/meeting/Side";
import { TranscriptView } from "../pages/meeting/Transcript";

type Tab = "minutes" | "transcript" | "todos" | "speakers";

/** One meeting on the phone: the desktop's three panes as tabs, the player under the transcript. */
export function MobileMeeting({ id }: { id: string }) {
  const store = useStore();
  const { query } = useLocation();
  const meeting = store.meetings.find((m) => m.id === id);
  const [tab, setTab] = useState<Tab>(query.get("seg") ? "transcript" : "minutes");
  const [naming, setNaming] = useState<string | null>(null);

  if (!meeting) {
    return (
      <Centered art={<SearchArt className="w-[90px]" />} title="找不到这场会议" text="它可能已被删除。">
        <Button onClick={() => navigate("/")}>回到会议列表</Button>
      </Centered>
    );
  }

  const todos = store.todos.filter((t) => t.meetingId === id).length;
  const unnamed = meeting.transcript?.speakers.filter((s) => !s.personId).length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-4 pt-2.5 pb-1">
        <a href={href("/")} className="-ml-1 inline-flex h-8 items-center gap-0.5 text-[13.5px] text-muted-foreground">
          <ChevronLeft className="size-[18px]" aria-hidden /> 会议
        </a>
        <h1 className="serif mt-1 text-[22px] leading-snug">{meeting.title}</h1>
        <p className="num mt-1 flex items-center gap-2.5 text-[12.5px] text-muted-foreground">
          <span>
            {dayLabel(meeting.startedAt)} {timeOfDay(meeting.startedAt)}
          </span>
          <span>{duration(meeting.durationMs)}</span>
          <MeetingStatusBadge status={meeting.status} />
        </p>
      </header>

      {meeting.transcript && meeting.minutes ? (
        <DetailProvider meeting={meeting} initialSegment={query.get("seg")} onJump={() => setTab("transcript")}>
          <Tabs
            className="shrink-0 px-4"
            value={tab}
            onChange={setTab}
            options={[
              { value: "minutes", label: "纪要" },
              { value: "transcript", label: "逐字稿" },
              { value: "todos", label: "待办", count: todos },
              { value: "speakers", label: "说话人", count: unnamed ? undefined : meeting.transcript.speakers.length },
            ]}
          />
          {tab === "transcript" ? (
            <TranscriptView
              chapters={meeting.minutes.chapters}
              onNameSpeaker={(speakerId) => {
                setTab("speakers");
                setNaming(speakerId);
              }}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-10">
              {tab === "minutes" ? <MinutesTab minutes={meeting.minutes} /> : null}
              {tab === "todos" ? <TodosTab /> : null}
              {tab === "speakers" ? <SpeakersTab naming={naming} onNaming={setNaming} /> : null}
            </div>
          )}
        </DetailProvider>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <Processing meeting={meeting} />
        </div>
      )}
    </div>
  );
}
