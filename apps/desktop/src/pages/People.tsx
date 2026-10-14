import { ShieldCheck } from "lucide-react";
import type { Person } from "@echomind/shared";
import { dayLabel, localDate } from "@echomind/shared";
import { VoiceCard } from "@echomind/ui";
import { PageHeader } from "../components/Shell";
import { Avatar, Badge, Button } from "../components/ui";
import { SectionTitle } from "./Home";
import { today, useStore } from "../lib/store";

export function People() {
  const store = useStore();
  const colleagues = store.people.filter((p) => !p.external);
  const outside = store.people.filter((p) => p.external);
  const enrolled = colleagues.filter((p) => store.voiceprints[p.id]?.status === "enrolled").length;

  return (
    <div className="mx-auto max-w-[1080px] px-10 pt-9 pb-14">
      <PageHeader
        eyebrow="工作空间 · 人员与声纹"
        title="认得出声音，才分得清是谁说的"
        lead={`已有 ${enrolled} 位同事建立了声纹，开会时会自动标出是谁在说话。称呼别名用来把「小王」「赵总」对应到具体的人。`}
        art={<VoiceCard />}
      />

      <div className="mt-8 flex items-start gap-3 rounded-[16px] bg-secondary px-5 py-4">
        <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-clay" strokeWidth={1.8} aria-hidden />
        <p className="text-[13px] leading-relaxed text-secondary-foreground">
          声纹属于敏感个人信息。每次保存都要本人在飞书卡片上点同意；只保存声音特征，不保存原始录音；本人可以随时删除。外部联系人默认不保存声纹。
        </p>
      </div>

      <section className="mt-8">
        <SectionTitle title="同事" />
        <div className="card divide-y divide-soft-line overflow-hidden">
          {colleagues.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
        </div>
      </section>

      <section className="mt-8">
        <SectionTitle title="外部联系人" />
        <div className="card divide-y divide-soft-line overflow-hidden">
          {outside.map((p) => (
            <div key={p.id} className="flex items-center gap-4 px-5 py-3.5">
              <Avatar person={p} size={34} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium">
                  {p.name} <span className="ml-1 text-[12.5px] font-normal text-muted-foreground">{p.company} · {p.title}</span>
                </p>
                <Aliases person={p} />
              </div>
              <span className="text-[12.5px] text-muted-foreground">不保存声纹 · 待办提醒记录人跟进</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Aliases({ person }: { person: Person }) {
  if (!person.aliases.length) return null;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
      会上被叫作
      {person.aliases.map((a) => (
        <span key={a} className="rounded-full border border-border px-2 py-px text-[11.5px]">
          {a}
        </span>
      ))}
    </p>
  );
}

function PersonRow({ person }: { person: Person }) {
  const store = useStore();
  const vp = store.voiceprints[person.id] ?? { status: "none" as const };

  const invite = () => {
    store.dispatch({ type: "setVoiceprint", personId: person.id, voiceprint: { status: "pending", since: localDate(today()) } });
    store.toast(`已给 ${person.name} 发送声纹同意卡片（演示：尚未连接真实飞书）。`, "success");
  };
  const remove = () => {
    store.dispatch({ type: "setVoiceprint", personId: person.id, voiceprint: { status: "none" } });
    store.toast(`已删除 ${person.name} 的声纹。以后的会议里需要重新命名。`);
  };

  return (
    <div className="flex items-center gap-4 px-5 py-3.5">
      <Avatar person={person} size={34} />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">
          {person.name} <span className="ml-1 text-[12.5px] font-normal text-muted-foreground">{person.department} · {person.title}</span>
        </p>
        <Aliases person={person} />
      </div>
      <div className="w-[180px] text-right">
        {vp.status === "enrolled" ? (
          <>
            <Badge tone="success" dot>
              已建立声纹
            </Badge>
            <p className="mt-1 text-[11.5px] text-subtle">
              {vp.since ? `${dayLabel(vp.since)} 本人同意` : ""}
              {vp.samples ? ` · ${vp.samples} 段样本` : ""}
            </p>
          </>
        ) : vp.status === "pending" ? (
          <>
            <Badge tone="clay" dot>
              等待本人同意
            </Badge>
            <p className="mt-1 text-[11.5px] text-subtle">{vp.since ? `${dayLabel(vp.since)} 已发卡片` : ""}</p>
          </>
        ) : (
          <Badge tone="outline">未建立</Badge>
        )}
      </div>
      <div className="flex w-[104px] justify-end">
        {vp.status === "enrolled" ? (
          <Button variant="ghost" size="sm" onClick={remove}>
            删除声纹
          </Button>
        ) : vp.status === "pending" ? (
          <Button variant="ghost" size="sm" onClick={invite}>
            再次提醒
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={invite}>
            邀请建立
          </Button>
        )}
      </div>
    </div>
  );
}
