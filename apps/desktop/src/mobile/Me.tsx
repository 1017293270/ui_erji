import { useState, type ReactNode } from "react";
import { cn } from "@echomind/ui";
import { Badge, Button } from "../components/ui";
import { companyLabel, FeishuAvatar, JoinCodeInput, joinCodeReady, useFeishuLogin } from "../components/Feishu";
import { formatBytes } from "../lib/process";
import { useStore } from "../lib/store";
import { Bar } from "../pages/MeetingDetail";

/** 「我的」: the Feishu account, the speech models, and where the data goes. */
export function MobileMe() {
  return (
    <div className="px-5 pt-6 pb-10">
      <h1 className="serif text-[28px] leading-tight">我的</h1>
      <Section title="飞书">
        <FeishuCard />
      </Section>
      <Section title="语音识别">
        <ModelsCard />
      </Section>
      <Section title="你的数据在哪里">
        <ul className="flex flex-col gap-3 px-4 py-4 text-[13px] leading-relaxed text-muted-foreground">
          <li>
            <span className="text-foreground">录音和逐字稿</span>只保存在这台手机上，不会备份到云端，也不会搬到新手机。
          </li>
          <li>
            <span className="text-foreground">生成纪要时</span>，文字稿经 EchoMind 服务器转给 DeepSeek，服务器不保存。
          </li>
          <li>
            <span className="text-foreground">你确认后的待办</span>会用你的飞书账号建成飞书任务。
          </li>
        </ul>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 px-1 text-[13px] font-medium text-muted-foreground">{title}</h2>
      <div className="card">{children}</div>
    </section>
  );
}

function FeishuCard() {
  const store = useStore();
  const { busy, error, login, cancel, logout, switchCompany } = useFeishuLogin();
  const [code, setCode] = useState("");
  const feishu = store.feishu;

  if (!feishu) {
    return <p className="px-4 py-4 text-[13px] text-muted-foreground">演示版不连接飞书。</p>;
  }
  const { user, company } = feishu;
  if (user) {
    return (
      <div className="px-4 py-4">
        <div className="flex items-center gap-3">
          <FeishuAvatar profile={user} size={44} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[15px] font-medium">
              {user.name} <Badge tone="success" dot>已连接</Badge>
            </p>
            <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{company ? companyLabel(company) : "飞书账号"}</p>
          </div>
        </div>
        {error ? <p className="mt-3 text-[12.5px] text-destructive">{error}</p> : null}
        <div className="mt-4 flex gap-2">
          <Button className="flex-1" onClick={() => void logout()}>
            退出登录
          </Button>
          {feishu.server ? (
            <Button className="flex-1" variant="ghost" onClick={() => void switchCompany()}>
              换一家公司
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // Through the server the company comes first: its join code says which Feishu app to open.
  const needsCode = !!feishu.server && !company;
  const go = () => {
    if (!busy && (!needsCode || joinCodeReady(code))) void login(needsCode ? code : undefined);
  };
  return (
    <div className="px-4 py-4">
      <p className={cn("text-[13px] leading-relaxed", error ? "text-destructive" : "text-muted-foreground")}>
        {error ??
          (busy
            ? "已在浏览器打开飞书授权页，确认后回到 EchoMind。"
            : needsCode
              ? "先输入公司加入码（向公司的 EchoMind 管理员要），再用飞书登录。登录后，确认的待办会推送到飞书任务。"
              : `登录到${company ? companyLabel(company) : "你的公司"}。登录后，确认的待办会推送到飞书任务。`)}
      </p>
      {needsCode && !busy ? <JoinCodeInput value={code} onChange={setCode} onEnter={go} className="mt-3 h-11 w-full text-center text-[16px]" /> : null}
      <div className="mt-3 flex gap-2">
        {busy ? (
          <Button className="flex-1" onClick={cancel}>
            取消
          </Button>
        ) : null}
        <Button className="h-11 flex-1" variant="primary" disabled={busy || (needsCode && !joinCodeReady(code))} onClick={go}>
          {busy ? "等待授权…" : "用飞书登录"}
        </Button>
      </div>
      {company && !busy ? (
        <button className="mt-3 text-[12.5px] text-clay-text" onClick={() => void switchCompany()}>
          换一家公司
        </button>
      ) : null}
    </div>
  );
}

function ModelsCard() {
  const store = useStore();
  const { models, download } = store;
  if (download) {
    return (
      <div className="px-4 py-4">
        <p className="text-[13px] text-muted-foreground">正在安装语音模型…</p>
        <div className="mt-3">
          <Bar value={download.total ? download.received / download.total : 0} />
        </div>
        <p className="num mt-2 text-[12px] text-muted-foreground">
          {formatBytes(download.received)}
          {download.total ? ` / ${formatBytes(download.total)}` : ""}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted-foreground">
        {models?.ready ? "语音模型已就绪，没有网络也能转写。" : "转写在这台手机上完成。语音模型随安装包提供，第一次使用前要解压出来。"}
      </p>
      {models && !models.ready ? (
        <Button variant="primary" onClick={() => void store.downloadModels()}>
          安装
        </Button>
      ) : models?.ready ? (
        <Badge tone="success" dot>
          已就绪
        </Badge>
      ) : null}
    </div>
  );
}
