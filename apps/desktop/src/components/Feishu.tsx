import { useRef, useState } from "react";
import { cn } from "@echomind/ui";
import { feishuCancel, feishuForgetCompany, feishuLogin, feishuLogout, feishuStatus, type FeishuProfile } from "../lib/native";
import { useStore } from "../lib/store";

/**
 * Signing in with 飞书 from any screen: the browser opens Feishu's consent page,
 * and this resolves when the person comes back (or gives up).
 */
export function useFeishuLogin() {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  /** `joinCode` picks the company; without it, the one this computer signed in to last. */
  const login = async (joinCode?: string): Promise<FeishuProfile | null> => {
    cancelled.current = false;
    setBusy(true);
    setError(null);
    try {
      const user = await feishuLogin(joinCode);
      // Ask again rather than patching in the user: a fresh sign-in also changes which scopes are missing.
      const status = await feishuStatus().catch(() => null);
      if (status) store.dispatch({ type: "feishu", status });
      else if (store.feishu) store.dispatch({ type: "feishu", status: { ...store.feishu, user, missingScopes: [] } });
      store.toast(`已连接飞书：${user.name}`, "success");
      return user;
    } catch (e) {
      if (!cancelled.current) setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    cancelled.current = true;
    void feishuCancel();
  };

  const logout = async () => {
    await feishuLogout();
    if (store.feishu) store.dispatch({ type: "feishu", status: { ...store.feishu, user: null } });
    store.toast("已退出飞书登录");
  };

  /** Forgets the company, so the next sign-in asks for a join code. */
  const switchCompany = async () => {
    await feishuForgetCompany();
    setError(null);
    if (store.feishu) store.dispatch({ type: "feishu", status: { ...store.feishu, company: null } });
  };

  return { busy, error, login, cancel, logout, switchCompany };
}

/** Enough characters for a join code; spaces and dashes do not count. */
export const joinCodeReady = (code: string) => code.replace(/[\s-]/g, "").length >= 6;

/** The company's join code, as its EchoMind admin hands it out: six letters and digits. */
export function JoinCodeInput({ value, onChange, onEnter, className }: { value: string; onChange: (code: string) => void; onEnter?: () => void; className?: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value.toUpperCase())}
      onKeyDown={(e) => {
        if (e.key === "Enter") onEnter?.();
      }}
      placeholder="公司加入码"
      aria-label="公司加入码"
      maxLength={12}
      autoComplete="off"
      autoCapitalize="characters"
      spellCheck={false}
      className={cn(
        "no-drag h-9 rounded-[10px] border border-border bg-card px-3 font-mono text-[14px] tracking-[0.16em] outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-subtle focus:border-ring",
        className,
      )}
    />
  );
}

/** The 飞书 avatar, or the first character of the name on a warm disc. */
export function FeishuAvatar({ profile, size = 30, className }: { profile: FeishuProfile; size?: number; className?: string }) {
  if (profile.avatar) {
    return <img src={profile.avatar} alt="" width={size} height={size} className={cn("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />;
  }
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-full bg-clay-soft font-medium text-clay-text", className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      aria-hidden
    >
      {profile.name.slice(0, 1)}
    </span>
  );
}
