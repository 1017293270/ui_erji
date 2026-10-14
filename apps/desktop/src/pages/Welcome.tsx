import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { clock } from "@echomind/shared";
import { cn, EchoMark, InboxTray, LaptopVoice, MicDoodle, Wave } from "@echomind/ui";
import { FeishuAvatar, useFeishuLogin } from "../components/Feishu";
import { Button } from "../components/ui";
import { isTauri, onCaptureEvent, requestMicrophone, requestSystemAudio, sendCapture, startCapture } from "../lib/native";
import { isWindows } from "../lib/platform";
import { navigate } from "../lib/router";
import { useStore } from "../lib/store";
import { Meter } from "./Recorder";

const STEPS = ["欢迎", "连接飞书", "授权录音", "试录 10 秒"] as const;

/** First run: one centered column, one drawing per step, like a sign-in page. */
export function Welcome() {
  const [step, setStep] = useState(0);
  const [tested, setTested] = useState(false);
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const done = (i: number) => i < step || (tested && i === STEPS.length - 1);
  const passed = useCallback(() => setTested(true), []);
  // macOS asks once per permission, so ask here, before the first recording, one after the other.
  const grant = async () => {
    if (!isTauri || isWindows) return;
    await requestMicrophone().catch(() => undefined);
    await requestSystemAudio().catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div data-tauri-drag-region="deep" className="drag flex h-[52px] shrink-0 items-center gap-2 px-6 [.platform-mac_&]:pl-[88px]">
        <EchoMark className="w-[24px]" />
        <span className="serif text-[15px]">EchoMind</span>
        <span className="flex-1" />
        <button className="no-drag text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => navigate("/")}>
          跳过，先看看
        </button>
      </div>

      {/* Centered a little above the middle, like a sign-in page. */}
      <div className="mx-auto flex w-full max-w-[420px] flex-1 flex-col items-center justify-center px-6 pt-6 pb-[12vh] text-center">
        <ol className="mb-8 flex items-center gap-2" aria-label="步骤">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              {i > 0 ? <span className="h-px w-6 bg-border" /> : null}
              <span
                className={cn(
                  "num grid size-6 place-items-center rounded-full text-[11.5px]",
                  done(i) ? "bg-primary text-primary-foreground" : i === step ? "bg-clay text-white" : "bg-secondary text-muted-foreground",
                )}
                aria-current={i === step ? "step" : undefined}
                title={s}
              >
                {done(i) ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <Step art={<Wave className="w-[150px]" />} title="你好，我是 EchoMind" text="开会时帮你记录，会后几分钟给出纪要，把待办交到对的人手上，再每天提醒他们。">
            <Button variant="primary" size="lg" className="w-full" onClick={next}>
              开始设置
            </Button>
          </Step>
        ) : null}

        {step === 1 ? <ConnectFeishu onDone={next} /> : null}

        {step === 2 ? (
          <Step
            art={null}
            title="允许 EchoMind 录音"
            text={
              isWindows
                ? "麦克风录你自己，系统声音录会议里的其他人。Windows 上只有麦克风需要允许。录音时任务栏和浮窗会一直提示，不会悄悄录。"
                : "需要两项授权：麦克风录你自己，系统录音录会议里的其他人。录音时菜单栏和浮窗会一直提示，不会悄悄录。"
            }
          >
            <div className="grid w-full grid-cols-2 gap-3">
              <Grant art={<MicDoodle className="w-[56px]" />} title="麦克风" text="你的发言" />
              <Grant art={<LaptopVoice className="w-[64px]" />} title={isWindows ? "系统声音" : "系统录音"} text="其他参会人的声音" />
            </div>
            <Button variant="primary" size="lg" className="w-full" onClick={() => void grant().finally(next)}>
              {isTauri && !isWindows ? "授权并继续" : "继续"}
            </Button>
            <p className="text-[12px] leading-relaxed text-subtle">
              {isWindows
                ? "Windows 不会弹窗询问。如果录音时提示麦克风被关闭，到「设置 → 隐私和安全性 → 麦克风」里打开「让桌面应用访问麦克风」。"
                : "macOS 会弹出系统对话框，请选择「允许」。"}
            </p>
          </Step>
        ) : null}

        {step === 3 ? <TestRecording onPassed={passed} onDone={() => navigate("/")} /> : null}

        {step > 0 ? (
          <button className="no-drag mt-6 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground" onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft className="size-3.5" /> 上一步
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Sign in with 飞书 for real in the app; the browser preview just moves on. */
function ConnectFeishu({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const { busy, error, login, cancel } = useFeishuLogin();
  const feishu = store.feishu;
  const user = feishu?.user;
  const intro = "用飞书账号登录。EchoMind 会读取通讯录和日历参会人来认人，把待办建成飞书任务，并每天发一张待办卡片。";

  if (!feishu) {
    return (
      <Step art={<InboxTray className="w-[200px]" />} title="连接飞书" text={intro}>
        <Button variant="primary" size="lg" className="w-full" onClick={onDone}>
          用飞书登录
        </Button>
        <p className="text-[12px] text-subtle">演示版：点击后直接进入下一步，不会真的跳转飞书。</p>
      </Step>
    );
  }
  if (user) {
    return (
      <Step art={<InboxTray className="w-[200px]" />} title="已连接飞书" text="之后的会议纪要和待办，都会用这个账号推送。">
        <div className="card flex w-full items-center gap-3 px-4 py-3 text-left">
          <FeishuAvatar profile={user} size={36} />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium">{user.name}</span>
            <span className="block truncate text-[12px] text-muted-foreground">{user.email ?? "飞书账号"}</span>
          </span>
          <Check className="size-4 text-success" aria-hidden />
        </div>
        <Button variant="primary" size="lg" className="w-full" onClick={onDone}>
          继续
        </Button>
      </Step>
    );
  }
  if (!feishu.configured) {
    return (
      <Step art={<InboxTray className="w-[200px]" />} title="连接飞书" text="还没有配置飞书应用：在 apps/desktop/.env.local 里填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET，重启后再来这一步。">
        <Button variant="primary" size="lg" className="w-full" onClick={onDone}>
          先跳过
        </Button>
      </Step>
    );
  }
  return (
    <Step art={<InboxTray className="w-[200px]" />} title="连接飞书" text={intro}>
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={async () => {
          if (await login()) onDone();
        }}
      >
        {busy ? "正在等你在浏览器里授权…" : "用飞书登录"}
      </Button>
      {busy ? (
        <button className="no-drag text-[12.5px] text-muted-foreground hover:text-foreground" onClick={cancel}>
          取消
        </button>
      ) : error ? (
        <p className="selectable text-[12.5px] leading-relaxed text-destructive">{error}</p>
      ) : (
        <p className="text-[12px] text-subtle">会在浏览器里打开飞书授权页，确认后自动回到这里。</p>
      )}
    </Step>
  );
}

function Step({ art, title, text, children }: { art: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <div className="slide-up flex w-full flex-col items-center">
      {art}
      <h1 className="serif mt-5 text-[30px] leading-tight">{title}</h1>
      <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">{text}</p>
      <div className="mt-7 flex w-full flex-col items-center gap-3">{children}</div>
    </div>
  );
}

function Grant({ art, title, text }: { art: ReactNode; title: string; text: string }) {
  return (
    <div className="card flex flex-col items-center px-4 pt-4 pb-3.5">
      <div className="grid h-[64px] place-items-end">{art}</div>
      <p className="mt-2.5 text-[13.5px] font-medium">{title}</p>
      <p className="text-[12px] text-muted-foreground">{text}</p>
    </div>
  );
}

/** Ten seconds of real (or simulated) recording: both meters should move. */
function TestRecording({ onPassed, onDone }: { onPassed: () => void; onDone: () => void }) {
  const store = useStore();
  const [phase, setPhase] = useState<"idle" | "running" | "done">("idle");
  const [heard, setHeard] = useState({ mic: false, system: false });
  const heardRef = useRef(heard);
  heardRef.current = heard;
  const rec = store.recording;
  const both = heard.mic && heard.system;

  const start = () => {
    setPhase("running");
    setHeard({ mic: false, system: false });
    store.dispatch({ type: "testing", on: true });
    void startCapture();
  };

  useEffect(
    () =>
      onCaptureEvent((e) => {
        if (e.type === "level") setHeard((h) => ({ mic: h.mic || (e.mic ?? -90) > -45, system: h.system || (e.system ?? -90) > -45 }));
        if (e.type === "stopped") {
          setPhase("done");
          if (heardRef.current.mic && heardRef.current.system) onPassed();
        }
      }),
    [onPassed],
  );

  useEffect(() => {
    if (phase === "running" && rec && rec.elapsed >= 10000) void sendCapture("stop");
  }, [phase, rec]);

  return (
    <Step
      art={<MicDoodle className="w-[96px]" live={phase === "running"} />}
      title={phase !== "done" ? "试录 10 秒" : both ? "两路声音都没问题" : "有一路没录到声音"}
      text={
        phase !== "done"
          ? "放一段有人声的视频，同时说几句话。两条音量条都在跳，就说明两路都录到了。"
          : both
            ? "麦克风和系统声音都录到了。之后开会时点「开始记录」，或者等 EchoMind 发现会议时提醒你。"
            : `${heard.mic ? "" : "麦克风"}${!heard.mic && !heard.system ? "和" : ""}${heard.system ? "" : "系统声音"}没有声音。检查一下设置里的授权和输入设备，再试一次。`
      }
    >
      <div className="card w-full px-5 py-4 text-left">
        <Meter label="我（麦克风）" db={rec?.mic ?? -90} ok={heard.mic} />
        <Meter label="远端（系统声音）" db={rec?.system ?? -90} ok={heard.system} className="mt-3" />
        <p className="num mt-3 text-right text-[12px] text-muted-foreground">{clock(rec?.elapsed ?? (phase === "done" ? 10000 : 0))} / 0:10</p>
      </div>
      {phase === "done" && both ? (
        <Button variant="primary" size="lg" className="w-full" onClick={onDone} icon={<ArrowRight className="order-last size-4" />}>
          进入工作台
        </Button>
      ) : (
        <Button variant="primary" size="lg" className="w-full" disabled={phase === "running"} onClick={start}>
          {phase === "running" ? "正在试录…" : phase === "done" ? "再试一次" : "开始试录"}
        </Button>
      )}
      {phase === "done" && !both ? (
        <button className="no-drag text-[12.5px] text-muted-foreground hover:text-foreground" onClick={onDone}>
          先进入工作台
        </button>
      ) : null}
    </Step>
  );
}
