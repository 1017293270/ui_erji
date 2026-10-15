import { useEffect, useState, type ReactNode } from "react";
import { Copy, Download, FolderOpen } from "lucide-react";
import { applyTheme, cn, readTheme, Toolbox, type ThemeChoice } from "@echomind/ui";
import { companyLabel, FeishuAvatar, JoinCodeInput, joinCodeReady, useFeishuLogin } from "../components/Feishu";
import { PageHeader } from "../components/Shell";
import { Badge, Button, Segmented, Toggle } from "../components/ui";
import {
  isTauri,
  llmStatus,
  openPrivacySettings,
  permissions,
  requestMicrophone,
  requestSystemAudio,
  revealRecordings,
  type LlmStatus,
  type PermissionState,
  type PrivacySettings,
} from "../lib/native";
import { formatBytes } from "../lib/process";
import { isWindows } from "../lib/platform";
import { navigate } from "../lib/router";
import { LIVE, useStore } from "../lib/store";
import { Bar } from "./MeetingDetail";

const NOTICE = "本次会议将使用 EchoMind 录音并生成纪要，仅用于会议记录和待办跟进。如有异议，请现在告诉我。";

export function Settings() {
  const store = useStore();
  const s = store.settings;
  const set = (patch: Partial<typeof s>) => store.dispatch({ type: "settings", patch });
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [perm, setPerm] = useState<{ microphone: PermissionState; systemAudio: PermissionState } | null>(null);

  const [llm, setLlm] = useState<LlmStatus | null>(null);

  const refreshPerm = () => void permissions().then(setPerm).catch(() => setPerm(null));
  useEffect(() => {
    refreshPerm();
    void llmStatus().then(setLlm).catch(() => setLlm(null));
  }, []);

  return (
    <div className="mx-auto max-w-[880px] px-10 pt-9 pb-14">
      <PageHeader eyebrow="工作空间 · 设置" title="设置" lead="录音范围、系统权限、飞书连接和大模型，都在这里调整。" art={<Toolbox />} />

      <Group title="录音">
        <Row label="系统声音的范围" hint="默认录下电脑播放的全部声音（不含 EchoMind 自己）。部分会议软件的声音来自子进程，只录会议软件可能漏录。">
          <Segmented
            value={s.systemScope}
            onChange={(v) => set({ systemScope: v })}
            options={[
              { value: "global", label: "全部系统声音" },
              { value: "process", label: "仅会议软件" },
            ]}
          />
        </Row>
        <Row label="发现会议时提醒我" hint="检测到腾讯会议、飞书会议正在通话时提醒你开始记录。不会自动录音。">
          <Toggle checked={s.autoDetect} onChange={(v) => set({ autoDetect: v })} label="发现会议时提醒我" />
        </Row>
        {LIVE ? null : (
          <Row label="分段上传" hint="边录边按段上传，会议结束后几分钟就有纪要；断网时先存在本地，恢复后续传。">
            <Segmented
              value={String(s.segmentSeconds)}
              onChange={(v) => set({ segmentSeconds: Number(v) })}
              options={[
                { value: "30", label: "30 秒" },
                { value: "60", label: "1 分钟" },
                { value: "120", label: "2 分钟" },
              ]}
            />
          </Row>
        )}
        {LIVE ? null : (
          <Row label="本地录音保留" hint="上传成功后，本机上的录音文件保留多久。">
            <Segmented
              value={String(s.keepDays)}
              onChange={(v) => set({ keepDays: Number(v) })}
              options={[
                { value: "1", label: "1 天" },
                { value: "7", label: "7 天" },
                { value: "30", label: "30 天" },
              ]}
            />
          </Row>
        )}
        <Row label="录音文件夹" hint={isTauri ? "每场会议一个文件夹：麦克风、系统声音两路 WAV 和 manifest.json。" : "在桌面应用里可以打开录音所在的文件夹。"}>
          <Button size="sm" icon={<FolderOpen className="size-3.5" />} disabled={!isTauri} onClick={() => void revealRecordings()}>
            打开
          </Button>
        </Row>
      </Group>

      <Group title="系统权限">
        <Row
          label="麦克风"
          hint={
            isWindows
              ? "录下你自己的发言。在 Windows 的「设置 → 隐私和安全性 → 麦克风」里管理。"
              : "录下你自己的发言。拒绝过的话 macOS 不会再问，要到「系统设置 → 隐私与安全性 → 麦克风」里打开。"
          }
        >
          <PermissionBadge state={perm?.microphone ?? "unknown"} />
          <PermissionAction kind="microphone" state={perm?.microphone} onAnswered={refreshPerm} />
        </Row>
        {isWindows ? (
          <Row label="系统声音" hint="录下会议里其他人的声音。Windows 上不需要授权。">
            <Badge tone="success" dot>无需授权</Badge>
          </Row>
        ) : (
          <Row
            label="系统录音"
            hint="录下会议里其他人的声音。拒绝过的话 macOS 不会再问，要到「系统设置 → 隐私与安全性 → 屏幕与系统录音」里打开 EchoMind 的「仅系统录音」。"
          >
            <PermissionBadge state={perm?.systemAudio ?? "unknown"} />
            <PermissionAction kind="systemAudio" state={perm?.systemAudio} onAnswered={refreshPerm} />
          </Row>
        )}
        <Row label="首次使用向导" hint="重新走一遍：连接飞书、授权、试录 10 秒。">
          <Button size="sm" onClick={() => navigate("/welcome")}>
            打开向导
          </Button>
        </Row>
      </Group>

      <Group title="飞书">
        {store.feishu ? <FeishuAccountRow /> : null}
        {store.feishu?.admin && store.feishu.user ? (
          <Row label="公司管理" hint="添加使用 EchoMind 的公司。把加入码发给那家公司的同事，他们第一次登录时输入一次。">
            <Button size="sm" onClick={() => navigate("/companies")}>
              打开
            </Button>
          </Row>
        ) : null}
        {store.feishu ? null : (
          <Row label="连接状态" hint="用于登录、读取通讯录和日历参会人、创建飞书任务、发送每日待办卡片。">
            {s.feishuConnected ? <Badge tone="success" dot>已连接 · 演示租户</Badge> : <Badge tone="outline">未连接</Badge>}
            <Button size="sm" variant="ghost" onClick={() => set({ feishuConnected: !s.feishuConnected })}>
              {s.feishuConnected ? "断开" : "连接"}
            </Button>
          </Row>
        )}
        <Row label="每日待办推送" hint="每个人每天收到一张卡片：本周待办和完成情况，可以直接点完成、延期或有阻碍。">
          <Segmented
            value={s.digestTime}
            onChange={(v) => set({ digestTime: v })}
            options={[
              { value: "08:30", label: "08:30" },
              { value: "09:00", label: "09:00" },
              { value: "09:30", label: "09:30" },
            ]}
          />
        </Row>
      </Group>

      {LIVE ? (
        <Group title="转写与纪要">
          <ModelsRow />
          {llm?.configured ? (
            <Row
              label="纪要模型"
              hint={
                llm.via === "server"
                  ? "议题、纪要和待办由 DeepSeek 根据文字稿生成，请求经 EchoMind 服务器转发，密钥只在服务器上。"
                  : "议题、纪要和待办由 DeepSeek 根据文字稿生成。密钥只在应用的原生进程里，页面拿不到。"
              }
            >
              <span className="text-[13.5px]">DeepSeek · {llm.model}</span>
            </Row>
          ) : (
            <Row label="纪要模型" hint="还没有配置 DeepSeek：在 apps/desktop/.env.local 里填写 DEEPSEEK_API_KEY，然后重启 EchoMind。">
              <Badge tone="outline">未配置</Badge>
            </Row>
          )}
          <Row label="数据去向" hint="录音和转写只在这台电脑上；只有文字稿发给 DeepSeek（中国大陆）生成纪要，确认后的待办写进你们的飞书。">
            <Badge tone="neutral">中国大陆</Badge>
          </Row>
        </Group>
      ) : (
        <Group title="大模型与数据">
          <Row label="纪要模型" hint="纪要、议题和待办由服务端调用 DeepSeek 生成，桌面端不保存模型密钥。私有化部署时可以换成客户机房里的模型。">
            <span className="text-[13.5px]">DeepSeek · deepseek-flash</span>
          </Row>
          <Row label="数据处理地" hint="录音、转写和纪要都在中国大陆境内处理和存储。">
            <Badge tone="neutral">中国大陆</Badge>
          </Row>
          <Row label="服务状态" hint="当前展示的是示例数据；转写与纪要服务接入后，这里会显示连接状态和本月用量。">
            <Badge tone="outline">演示数据</Badge>
          </Row>
        </Group>
      )}

      <Group title="隐私与告知">
        <Row label="录音告知语" hint={NOTICE}>
          <Button
            size="sm"
            icon={<Copy className="size-3.5" />}
            onClick={() => {
              void navigator.clipboard?.writeText(NOTICE);
              store.toast("告知语已复制，可以贴到会议聊天里。", "success");
            }}
          >
            复制
          </Button>
        </Row>
      </Group>

      <Group title="外观">
        <Row label="主题" hint="深色模式下插画会变成黑板上的粉笔画。">
          <Segmented
            value={theme}
            onChange={(v) => {
              applyTheme(v);
              setTheme(v);
            }}
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
              { value: "system", label: "跟随系统" },
            ]}
          />
        </Row>
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="serif mb-3 text-[20px]">{title}</h2>
      <div className="card divide-y divide-soft-line">{children}</div>
    </section>
  );
}

/** The real 飞书 account, in the app (the browser preview keeps the demo toggle). */
function FeishuAccountRow() {
  const store = useStore();
  const { busy, error, login, cancel, logout, switchCompany } = useFeishuLogin();
  const [code, setCode] = useState("");
  const feishu = store.feishu!;
  const user = feishu.user;
  const company = feishu.company;

  if (!feishu.configured) {
    return (
      <Row label="飞书账号" hint="还没有配置飞书应用：在 apps/desktop/.env.local 里填写 FEISHU_APP_ID 和 FEISHU_APP_SECRET，然后重启 EchoMind。">
        <Badge tone="outline">未配置</Badge>
      </Row>
    );
  }
  if (user) {
    const missing = feishu.missingScopes?.length ? missingText(feishu.missingScopes) : null;
    return (
      <div className="flex items-center gap-3.5 px-5 py-4">
        <FeishuAvatar profile={user} size={40} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[14px] font-medium">
            {user.name}
            {missing ? <Badge tone="clay" dot>需要重新登录</Badge> : <Badge tone="success" dot>已连接</Badge>}
          </p>
          <p className={cn("mt-0.5 text-[12.5px]", error ? "text-destructive" : missing ? "text-clay-text" : "truncate text-muted-foreground")}>
            {error ??
              (missing ? (
                `还没有${missing}权限，重新登录一次就能授予。`
              ) : (
                <>
                  {[company ? companyLabel(company) : null, user.email ?? user.enName].filter(Boolean).join(" · ") || "飞书账号"}
                  {feishu.server ? (
                    <button className="no-drag ml-1.5 text-clay-text underline-offset-2 hover:underline" onClick={() => void switchCompany()}>
                      换一家公司
                    </button>
                  ) : null}
                </>
              ))}
          </p>
        </div>
        {missing ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void login()}>
            {busy ? "等待授权…" : "重新登录"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void logout()}>
          退出登录
        </Button>
      </div>
    );
  }
  // Through the server, the company comes first: its join code says which Feishu app to open.
  const needsCode = !!feishu.server && !company;
  const go = () => {
    if (!busy && (!needsCode || joinCodeReady(code))) void login(needsCode ? code : undefined);
  };
  return (
    <Row
      label="飞书账号"
      hint={
        error ? (
          <span className="text-destructive">{error}</span>
        ) : busy ? (
          "已在浏览器打开飞书授权页，确认后会自动回到这里。"
        ) : needsCode ? (
          "先输入公司加入码（向你们公司的 EchoMind 管理员要），再用飞书登录。"
        ) : company ? (
          <>
            登录到 {company.name || `加入码为 ${company.joinCode} 的公司`}，用于读取通讯录和日历参会人、创建飞书任务。
            <button className="no-drag ml-1.5 text-clay-text underline-offset-2 hover:underline" onClick={() => void switchCompany()}>
              换一家公司
            </button>
          </>
        ) : (
          "用于登录、读取通讯录和日历参会人、创建飞书任务、发送每日待办卡片。"
        )
      }
    >
      {busy ? (
        <Button size="sm" variant="ghost" onClick={cancel}>
          取消
        </Button>
      ) : needsCode ? (
        <JoinCodeInput value={code} onChange={setCode} onEnter={go} className="h-8 w-[136px]" />
      ) : null}
      <Button size="sm" variant="primary" disabled={busy || (needsCode && !joinCodeReady(code))} onClick={go}>
        {busy ? "等待授权…" : "用飞书登录"}
      </Button>
    </Row>
  );
}

/** 「读取日历和创建任务」 from the scopes the saved sign-in lacks. */
function missingText(scopes: string[]) {
  const parts = [scopes.some((s) => s.startsWith("calendar")) ? "读取日历" : null, scopes.some((s) => s.startsWith("task")) ? "创建任务" : null].filter(Boolean);
  return parts.length ? parts.join("和") : scopes.join("、");
}

/** The on-device speech models: transcription works offline once they are here. */
function ModelsRow() {
  const store = useStore();
  const models = store.models;
  const download = store.download;
  const hint = "转写在这台电脑上完成，录音不上传。模型只需下载一次。";
  if (!models) {
    return (
      <Row label="语音转写" hint="本机转写模块还没有装好，暂时不能转写。录音照常保存，装好后会自动补转。">
        <Badge tone="outline">未就绪</Badge>
      </Row>
    );
  }
  if (models.ready) {
    return (
      <Row label="语音转写" hint={`${hint}已安装：${models.models.map((m) => m.name).join("、")}。`}>
        <Badge tone="success" dot>本机 · 已就绪</Badge>
      </Row>
    );
  }
  return (
    <Row label="语音转写" hint={`${hint}还需要下载约 ${formatBytes(models.downloadBytes)}。`}>
      {download ? (
        <div className="w-[180px]">
          <Bar value={download.total ? download.received / download.total : 0} />
          <p className="num mt-1.5 text-right text-[11.5px] text-muted-foreground">
            {formatBytes(download.received)}
            {download.total ? ` / ${formatBytes(download.total)}` : ""}
          </p>
        </div>
      ) : (
        <Button size="sm" variant="primary" icon={<Download className="size-3.5" />} onClick={() => void store.downloadModels()}>
          下载模型
        </Button>
      )}
    </Row>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium">{label}</p>
        {hint ? <p className="selectable mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** Asks when the question is still open; points to the settings page once it was refused. */
function PermissionAction({ kind, state, onAnswered }: { kind: PrivacySettings; state?: PermissionState; onAnswered: () => void }) {
  if (state === "undetermined") {
    const request = kind === "microphone" ? requestMicrophone : requestSystemAudio;
    return (
      <Button size="sm" onClick={() => void request().finally(onAnswered)}>
        授权
      </Button>
    );
  }
  if (state === "denied" || state === "restricted") {
    return (
      <Button size="sm" onClick={() => void openPrivacySettings(kind)}>
        {isWindows ? "打开设置" : "打开系统设置"}
      </Button>
    );
  }
  return null;
}

function PermissionBadge({ state }: { state: PermissionState }) {
  switch (state) {
    case "granted":
      return <Badge tone="success" dot>已授权</Badge>;
    case "denied":
    case "restricted":
      return <Badge tone="danger" dot>已拒绝</Badge>;
    case "undetermined":
      return <Badge tone="clay" dot>未询问</Badge>;
    default:
      return <Badge tone="outline">{isTauri ? "录音时确认" : "桌面应用里可查看"}</Badge>;
  }
}
