import { useEffect, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { cn, Handoff } from "@echomind/ui";
import { PageHeader } from "../components/Shell";
import { Badge, Button } from "../components/ui";
import { companiesAdd, companiesList, companiesReplaceSecret, companiesUpdate, isTauri, type AppPermissions, type Company } from "../lib/native";
import { useStore } from "../lib/store";

/**
 * 公司管理: every company on EchoMind, each with its own self-built Feishu app. Only the people
 * the server names as admins get here; the server checks again on every call.
 */

type Listing = { companies: Company[]; permissions: AppPermissions };

/** The browser preview has no server: made-up companies show the layout. */
const DEMO: Listing = {
  companies: [
    { id: "demo-1", name: "示例公司甲", appId: "cli_a5d1e0c2b7f4900d", joinCode: "K7M2QX", people: 12, disabled: false, isDefault: true, createdAt: "2026-10-01T08:00:00Z" },
    { id: "demo-2", name: "示例公司乙", appId: "cli_a6f3b2c1d0e9877a", joinCode: "R4TW8N", people: 3, disabled: false, isDefault: false, createdAt: "2026-10-14T08:00:00Z" },
    { id: "demo-3", name: null, appId: "cli_a7c0d9e8f1a2b3c4", joinCode: "H9PZ3E", people: 0, disabled: true, isDefault: false, createdAt: "2026-10-14T09:00:00Z" },
  ],
  permissions: { scopes: { tenant: ["tenant:tenant:readonly"], user: ["offline_access"] } },
};

const FIELD =
  "no-drag h-9 min-w-0 rounded-[10px] border border-border bg-card px-3 text-[13.5px] outline-none placeholder:text-subtle focus:border-ring";

export function Companies() {
  const store = useStore();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    (isTauri ? companiesList() : Promise.resolve(DEMO)).then(setListing, (e) => setLoadError(String(e)));
  };
  useEffect(load, []);

  /** A company the server just changed or added, put in its place. */
  const put = (company: Company) =>
    setListing((l) =>
      l && {
        ...l,
        companies: l.companies.some((c) => c.id === company.id) ? l.companies.map((c) => (c.id === company.id ? company : c)) : [...l.companies, company],
      },
    );

  const copy = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text);
    store.toast(done, "success");
  };

  return (
    <div className="mx-auto max-w-[880px] px-10 pt-9 pb-14">
      <PageHeader
        eyebrow="设置 · 公司管理"
        title="公司管理"
        lead="每家公司用自己的飞书应用接入 EchoMind。添加以后，把加入码发给那家公司的同事，他们第一次登录时输入一次。"
        art={<Handoff />}
      />

      <section className="mt-9">
        <h2 className="serif mb-3 text-[20px]">已添加的公司</h2>
        {listing ? (
          <div className="card divide-y divide-soft-line">
            {listing.companies.map((c) => (
              <CompanyRow key={c.id} company={c} onChange={put} copy={copy} />
            ))}
          </div>
        ) : loadError ? (
          <div className="card flex items-center gap-4 px-5 py-4">
            <p className="selectable min-w-0 flex-1 text-[13px] text-destructive">{loadError}</p>
            <Button size="sm" onClick={load}>
              重试
            </Button>
          </div>
        ) : (
          <div className="card px-5 py-4 text-[13px] text-muted-foreground">正在读取…</div>
        )}
      </section>

      <AddCompany permissions={listing?.permissions ?? null} redirectUri={store.feishu?.redirectUri ?? "http://127.0.0.1:43517/feishu/callback"} onAdded={put} copy={copy} />
    </div>
  );
}

function CompanyRow({ company, onChange, copy }: { company: Company; onChange: (c: Company) => void; copy: (text: string, done: string) => void }) {
  const store = useStore();
  const [busy, setBusy] = useState<"check" | "disable" | "enable" | "secret" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which inline panel is open under the row. */
  const [panel, setPanel] = useState<"secret" | "disable" | null>(null);
  const [secret, setSecret] = useState("");

  const run = async (what: NonNullable<typeof busy>, op: () => Promise<Company>, done: (c: Company) => string) => {
    if (!isTauri) {
      store.toast("这是示例数据，不能修改。");
      return;
    }
    setBusy(what);
    setError(null);
    try {
      const changed = await op();
      onChange(changed);
      setPanel(null);
      setSecret("");
      store.toast(done(changed), "success");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };
  const toggle = (next: typeof panel) => {
    setPanel(panel === next ? null : next);
    setError(null);
  };
  const label = company.name ?? "这家公司";

  return (
    <div className={cn("px-5 py-4", company.disabled && "bg-secondary/40")}>
      <div className="flex items-center gap-5">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-[14.5px] font-medium">
            <span className={cn("truncate", !company.name && "text-muted-foreground")}>{company.name ?? "还没读到企业名"}</span>
            {company.isDefault ? <Badge>你们公司</Badge> : null}
            {company.disabled ? <Badge tone="outline">已停用</Badge> : null}
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
            <span className="font-mono text-[12px]">{company.appId}</span>
            <span className="mx-1.5 text-subtle">·</span>
            {company.people ? `${company.people} 人登录过` : "还没有人登录"}
          </p>
        </div>

        {company.joinCode ? (
          <button
            className="no-drag group flex shrink-0 items-center gap-2 rounded-[10px] border border-border bg-background px-3 py-1.5 transition-colors hover:border-input"
            onClick={() => copy(company.joinCode!, `已复制${company.name ?? ""}的加入码 ${company.joinCode}`)}
            title="复制加入码"
          >
            <span className="text-[11.5px] text-muted-foreground">加入码</span>
            <span className="font-mono text-[15px] tracking-[0.16em]">{company.joinCode}</span>
            <Copy className="size-3.5 text-subtle transition-colors group-hover:text-foreground" aria-hidden />
          </button>
        ) : null}

        {/* A fixed width keeps the join codes in one column whether or not a row can be disabled. */}
        <div className="flex w-[200px] shrink-0 items-center justify-end gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => void run("check", () => companiesUpdate(company.id, "check"), (c) => `${c.name ?? "这家公司"}的飞书应用正常。`)}
          >
            {busy === "check" ? "核对中…" : "核对"}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => toggle("secret")}>
            更换 Secret
          </Button>
          {company.disabled ? (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void run("enable", () => companiesUpdate(company.id, "enable"), () => `已重新启用${label}。`)}>
              {busy === "enable" ? "启用中…" : "启用"}
            </Button>
          ) : company.isDefault ? null : (
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => toggle("disable")}>
              停用
            </Button>
          )}
        </div>
      </div>

      {panel === "secret" ? (
        <div className="mt-3.5 flex items-center gap-2 rounded-[12px] bg-secondary/60 px-4 py-3">
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">在飞书开发者后台重置过 App Secret 后，把新的填在这里。保存前会先向飞书核对。</p>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="新的 App Secret"
            aria-label="新的 App Secret"
            autoComplete="off"
            className={cn(FIELD, "w-[220px]")}
          />
          <Button size="sm" variant="primary" disabled={!secret.trim() || !!busy} onClick={() => void run("secret", () => companiesReplaceSecret(company.id, secret.trim()), () => `已更换${label}的 App Secret。`)}>
            {busy === "secret" ? "核对中…" : "保存"}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => toggle("secret")}>
            取消
          </Button>
        </div>
      ) : null}

      {panel === "disable" ? (
        <div className="mt-3.5 flex items-center gap-2 rounded-[12px] bg-danger-soft/60 px-4 py-3">
          <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed">停用后，{label}的人会马上退出登录，也不能再登录，直到你重新启用。他们的数据不会删除。</p>
          <Button size="sm" variant="danger" disabled={!!busy} onClick={() => void run("disable", () => companiesUpdate(company.id, "disable"), () => `已停用${label}。`)}>
            {busy === "disable" ? "停用中…" : "确认停用"}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => toggle("disable")}>
            取消
          </Button>
        </div>
      ) : null}

      {error ? <p className="selectable mt-2.5 text-[12.5px] leading-relaxed text-destructive">{error}</p> : null}
    </div>
  );
}

function AddCompany({
  permissions,
  redirectUri,
  onAdded,
  copy,
}: {
  permissions: AppPermissions | null;
  redirectUri: string;
  onAdded: (c: Company) => void;
  copy: (text: string, done: string) => void;
}) {
  const store = useStore();
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!appId.trim() && !!secret.trim();

  const add = async () => {
    if (!ready || busy) return;
    if (!isTauri) {
      store.toast("这是示例数据，不能添加。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const company = await companiesAdd(appId.trim(), secret.trim());
      onAdded(company);
      setAppId("");
      setSecret("");
      store.toast(`已添加${company.name ?? "公司"}。把加入码 ${company.joinCode ?? ""} 发给那家公司的同事。`, "success");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-9">
      <h2 className="serif mb-3 text-[20px]">添加公司</h2>
      <div className="card px-6 py-5">
        <p className="text-[13px] text-muted-foreground">先在那家公司的飞书开发者后台（open.feishu.cn/app）把应用准备好：</p>
        <ol className="mt-3.5 space-y-3">
          <SetupStep n={1}>创建一个「企业自建应用」，名字可以叫 EchoMind。</SetupStep>
          <SetupStep
            n={2}
            action={
              <Button size="sm" icon={<Copy className="size-3.5" />} disabled={!permissions} onClick={() => copy(JSON.stringify(permissions, null, 2), "权限清单已复制")}>
                复制权限清单
              </Button>
            }
          >
            在「权限管理 → 批量导入/导出」里粘贴权限清单，一次开通所需的权限。
          </SetupStep>
          <SetupStep n={3}>在「权限管理 → 数据权限 → 通讯录权限范围」里选择全部成员。</SetupStep>
          <SetupStep
            n={4}
            action={
              <Button size="sm" icon={<Copy className="size-3.5" />} onClick={() => copy(redirectUri, "回调地址已复制")}>
                复制地址
              </Button>
            }
          >
            在「安全设置 → 重定向 URL」里添加 <span className="font-mono text-[12.5px] text-foreground">{redirectUri}</span>
          </SetupStep>
          <SetupStep n={5}>在「版本管理与发布」里设好可用范围并发布，等那家公司的管理员审核通过。</SetupStep>
          <SetupStep n={6}>把「凭证与基础信息」里的 App ID 和 App Secret 填到下面。</SetupStep>
        </ol>

        <div className="mt-5 flex items-center gap-2 border-t border-soft-line pt-5">
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="App ID（cli_ 开头）"
            aria-label="App ID"
            autoComplete="off"
            spellCheck={false}
            className={cn(FIELD, "flex-1 font-mono placeholder:font-sans")}
          />
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="App Secret"
            aria-label="App Secret"
            autoComplete="off"
            className={cn(FIELD, "flex-1")}
          />
          <Button variant="primary" disabled={!ready || busy} onClick={() => void add()}>
            {busy ? "正在向飞书核对…" : "添加"}
          </Button>
        </div>
        {error ? (
          <p className="selectable mt-2.5 text-[12.5px] leading-relaxed text-destructive">{error}</p>
        ) : (
          <p className="mt-2.5 text-[12px] leading-relaxed text-subtle">添加时会用这组 App ID 和 App Secret 向飞书核对，并读出企业名称。App Secret 加密保存在 EchoMind 服务器上，这台电脑不保存。</p>
        )}
      </div>
    </section>
  );
}

function SetupStep({ n, action, children }: { n: number; action?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3">
      <span className="serif num grid size-6 shrink-0 place-items-center rounded-full bg-secondary text-[13px] text-secondary-foreground">{n}</span>
      <span className="min-w-0 flex-1 text-[13.5px] leading-relaxed">{children}</span>
      {action}
    </li>
  );
}
