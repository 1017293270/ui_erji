import { type Feishu, FeishuError, HttpError, text } from "./client";

/**
 * Feishu user sign-in. The desktop app runs the browser part (PKCE, a loopback redirect) and
 * hands the code here; the App Secret never leaves the server.
 *
 * v2 rather than accounts.feishu.cn/oauth/v3/token: Feishu checks PKCE only on v2 for now.
 */

/** What sign-in asks for. offline_access brings a refresh token, so EchoMind keeps working with the computer off. */
export const SCOPES = ["offline_access", "task:task:write", "calendar:calendar:read", "calendar:calendar.event:read"];

export function missingScopes(granted: string | null | undefined): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter(Boolean));
  return SCOPES.filter((s) => !have.has(s));
}

export type Tokens = {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string | null;
  refreshExpiresAt: Date | null;
  scopes: string | null;
};

/** Feishu said no: the code (or the refresh token) is spent. */
export class OAuthRejected extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The errors someone setting up the app is likely to hit, in words that say what to fix. */
function explain(code: number, detail: string, redirectUri: string | undefined): string {
  switch (code) {
    case 20010:
      return "你不在这个飞书应用的可用范围里：请在开发者后台「版本管理与发布」里把自己加进可用范围，并发布版本。";
    case 20071:
      return `回调地址不一致：请在飞书开发者后台「安全设置 → 重定向 URL」里添加 ${redirectUri ?? "EchoMind 的回调地址"}。`;
    case 20003:
    case 20004:
    case 20065:
      return "授权码已过期或用过了，请重新登录。";
    case 20049:
      return "飞书的 PKCE 校验没通过，请重新登录；再出现请把这句话发给开发者。";
  }
  return `飞书登录失败（${code}）：${detail}`;
}

async function requestToken(feishu: Feishu, body: Record<string, string>, redirectUri?: string): Promise<Tokens> {
  if (!feishu.app) throw new Error("这家公司还没有配置飞书应用：请管理员在「公司管理」里添加。");
  // Rejections come back as 4xx with a JSON body of their own shape, so read whatever arrives.
  const { status, reply } = await feishu.postRaw(feishu.url(["authen", "v2", "oauth", "token"]), {
    ...body,
    client_id: feishu.app.appId,
    client_secret: feishu.app.appSecret,
  });
  const code = typeof reply.code === "number" ? reply.code : 0;
  const accessToken = text(reply.access_token);
  if (code === 0 && accessToken) {
    const now = Date.now();
    const refreshIn = Number(reply.refresh_token_expires_in);
    return {
      accessToken,
      accessExpiresAt: new Date(now + (Number(reply.expires_in) || 7200) * 1000),
      refreshToken: text(reply.refresh_token) ?? null,
      refreshExpiresAt: refreshIn ? new Date(now + refreshIn * 1000) : null,
      scopes: text(reply.scope) ?? null,
    };
  }
  // Feishu's own trouble is not a verdict on the token: try again later rather than sign out.
  if (status >= 500 || code === 20050) throw new HttpError(status);
  // Nor is a wrong App Secret, which would otherwise sign out everyone in the company.
  if (code === 20002) throw new FeishuError(code, text(reply.error_description) ?? "app_id and app_secret did not match");
  throw new OAuthRejected(code, explain(code, text(reply.error_description) ?? text(reply.error) ?? "", redirectUri));
}

export function exchangeCode(feishu: Feishu, input: { code: string; codeVerifier: string; redirectUri: string }): Promise<Tokens> {
  return requestToken(
    feishu,
    { grant_type: "authorization_code", code: input.code, code_verifier: input.codeVerifier, redirect_uri: input.redirectUri },
    input.redirectUri,
  );
}

/** Refresh tokens are single-use: the reply carries a new one. */
export function refreshTokens(feishu: Feishu, refreshToken: string): Promise<Tokens> {
  return requestToken(feishu, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export type Profile = {
  name: string;
  enName: string | null;
  openId: string;
  unionId: string | null;
  email: string | null;
  tenantKey: string;
  avatarUrl: string | null;
};

export async function fetchProfile(feishu: Feishu, accessToken: string): Promise<Profile> {
  const reply = await feishu.send(feishu.url(["authen", "v1", "user_info"]), { token: accessToken });
  const info = reply.data ?? {};
  const openId = text(info.open_id);
  const tenantKey = text(info.tenant_key);
  if (!openId || !tenantKey) throw new Error("飞书没有返回你的账号信息，请重新登录。");
  return {
    name: text(info.name) ?? openId,
    enName: text(info.en_name) ?? null,
    openId,
    unionId: text(info.union_id) ?? null,
    email: text(info.enterprise_email) ?? text(info.email) ?? null,
    tenantKey,
    avatarUrl: text(info.avatar_middle) ?? text(info.avatar_url) ?? null,
  };
}
