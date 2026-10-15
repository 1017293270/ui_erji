import { Feishu, type Fetch } from "../feishu/client";

export type FakeRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  body: unknown;
};

/** What a handler answers: a status and a JSON body, or a thrown error for a network failure. */
export type Answer = [number, unknown];

export const ok = (data: unknown): Answer => [200, { code: 0, msg: "success", data }];

/** A fetch that records requests and answers them from `handler`. */
export function fakeFetch(handler: (req: FakeRequest) => Answer | Promise<Answer>): { fetch: Fetch; requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // Keep the text.
      }
    }
    const req: FakeRequest = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, authorization: headers.get("authorization"), body };
    requests.push(req);
    const [status, reply] = await handler(req);
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, requests };
}

/** A Feishu client against `handler`; paths in requests start with /open-apis. `client` makes one for another app. */
export function fakeFeishu(handler: (req: FakeRequest) => Answer | Promise<Answer>) {
  const { fetch, requests } = fakeFetch(handler);
  const client = (app: { appId: string; appSecret: string }) => new Feishu({ app, base: "https://feishu.test/open-apis", fetch });
  return { feishu: client({ appId: "cli_test", appSecret: "secret" }), client, requests };
}
