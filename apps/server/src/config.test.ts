import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const base = { DATABASE_URL: "postgres://u:p@localhost/db" };

describe("loadConfig", () => {
  it("fills in defaults and treats empty variables as unset", () => {
    const config = loadConfig({ ...base, FEISHU_APP_ID: "", FEISHU_APP_SECRET: " ", DEEPSEEK_BASE_URL: "", TLS_CERT: "" , TLS_KEY: ""});
    expect(config).toMatchObject({
      production: false,
      port: 8443,
      host: "0.0.0.0",
      tls: null,
      feishu: null,
      deepseek: { apiKey: null, baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
      dataKey: null,
    });
  });

  it("reads the optional settings", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const config = loadConfig({
      ...base,
      NODE_ENV: "production",
      PORT: "9443",
      TLS_CERT: "/certs/server.pem",
      TLS_KEY: "/certs/server.key",
      FEISHU_APP_ID: "cli_x",
      FEISHU_APP_SECRET: "s",
      DEEPSEEK_API_KEY: "sk",
      DEEPSEEK_BASE_URL: "https://example.test/v1/",
      ECHOMIND_DATA_KEY: key,
    });
    expect(config.production).toBe(true);
    expect(config.port).toBe(9443);
    expect(config.tls).toEqual({ cert: "/certs/server.pem", key: "/certs/server.key" });
    expect(config.feishu).toEqual({ appId: "cli_x", appSecret: "s" });
    expect(config.deepseek).toEqual({ apiKey: "sk", baseUrl: "https://example.test/v1", model: "deepseek-flash" });
    expect(config.dataKey?.length).toBe(32);
  });

  it("says which setting is wrong without echoing values", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
    expect(() => loadConfig({ ...base, TLS_CERT: "/a" })).toThrow("TLS_CERT 和 TLS_KEY");
    expect(() => loadConfig({ ...base, FEISHU_APP_SECRET: "top-secret" })).toThrow(/^FEISHU_APP_ID 和 FEISHU_APP_SECRET/);
    expect(() => loadConfig({ ...base, ECHOMIND_DATA_KEY: "c2hvcnQ=" })).toThrow("32 字节");
    try {
      loadConfig({ ...base, FEISHU_APP_SECRET: "top-secret" });
    } catch (e) {
      expect(String(e)).not.toContain("top-secret");
    }
  });
});
