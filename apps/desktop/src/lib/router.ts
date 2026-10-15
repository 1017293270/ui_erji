import { useSyncExternalStore } from "react";

/**
 * Hash routes (#/meetings/m-1/confirm?seg=seg-0012): they work the same in the
 * browser preview and inside the Tauri webview, with no server.
 */
export type Route =
  | { name: "home" }
  | { name: "meetings" }
  | { name: "meeting"; id: string }
  | { name: "confirm"; id: string }
  | { name: "todos" }
  | { name: "team" }
  | { name: "people" }
  | { name: "settings" }
  | { name: "companies" }
  | { name: "welcome" }
  | { name: "recorder" }
  | { name: "art" };

export type Location = { route: Route; query: URLSearchParams; path: string };

function parse(hash: string): Location {
  const raw = hash.replace(/^#/, "") || "/";
  const [path = "/", search = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const query = new URLSearchParams(search);
  const [head, id, tail] = parts;
  let route: Route = { name: "home" };
  if (head === "meetings" && id && tail === "confirm") route = { name: "confirm", id };
  else if (head === "meetings" && id) route = { name: "meeting", id };
  else if (head === "meetings") route = { name: "meetings" };
  else if (
    head === "todos" ||
    head === "team" ||
    head === "people" ||
    head === "settings" ||
    head === "companies" ||
    head === "welcome" ||
    head === "recorder" ||
    head === "art"
  ) {
    route = { name: head };
  }
  return { route, query, path };
}

let current = parse(window.location.hash);
const listeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  current = parse(window.location.hash);
  listeners.forEach((l) => l());
});

export function useLocation(): Location {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export function navigate(to: string) {
  const next = to.startsWith("#") ? to : `#${to}`;
  if (window.location.hash === next) return;
  window.location.hash = next;
}

export const href = (to: string) => `#${to}`;
