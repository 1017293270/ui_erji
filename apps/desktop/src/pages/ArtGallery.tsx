import { Clipboard, EchoMark, Handoff, InboxTray, LaptopVoice, ListenNote, MicDoodle, PluckSlip, SearchArt, Toolbox, VoiceCard, Wave, WeekCalendar } from "@echomind/ui";

/** Dev-only sheet of every drawing at review size (#/art). */
export function ArtGallery() {
  const items: [string, React.ReactNode][] = [
    ["EchoMark", <EchoMark key="m" />],
    ["ListenNote · 工作台", <ListenNote key="l" />],
    ["MicDoodle", <MicDoodle key="mi" />],
    ["MicDoodle live", <MicDoodle key="ml" live />],
    ["LaptopVoice", <LaptopVoice key="lv" />],
    ["WeekCalendar · 团队", <WeekCalendar key="w" />],
    ["VoiceCard · 声纹", <VoiceCard key="v" />],
    ["Handoff · 确认待办", <Handoff key="h" />],
    ["PluckSlip · 会议", <PluckSlip key="p" />],
    ["Clipboard · 待办", <Clipboard key="c" />],
    ["Toolbox · 设置", <Toolbox key="t" />],
    ["InboxTray · 转写中", <InboxTray key="i" />],
    ["Wave · 欢迎", <Wave key="wa" />],
    ["SearchArt", <SearchArt key="s" />],
  ];
  return (
    <div className="h-full overflow-y-auto p-10">
      <div className="grid grid-cols-4 gap-10">
        {items.map(([name, art]) => (
          <figure key={name} className="flex flex-col items-center">
            <div className="flex h-[260px] w-[260px] items-center justify-center">{art}</div>
            <figcaption className="mt-2 text-[12px] text-muted-foreground">{name}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
