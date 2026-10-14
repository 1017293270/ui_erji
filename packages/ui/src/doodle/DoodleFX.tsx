
import { useEffect } from "react";

/**
 * Starts each hand-drawn illustration the first time it scrolls into view
 * (data-in) and keeps its idle motion running only while it is on screen
 * (data-live). Mounted once for the whole site; drawings stay plain server
 * markup, so their path data is sent only once.
 */
export function DoodleFX() {
  useEffect(() => {
    const watched = new WeakSet<Element>();

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (entry.isIntersecting) {
            el.setAttribute("data-in", "");
            el.setAttribute("data-live", "");
          } else {
            el.removeAttribute("data-live");
          }
        }
      },
      { threshold: 0.18 },
    );

    const watch = (root: ParentNode) => {
      root.querySelectorAll(".dd").forEach((el) => {
        if (watched.has(el)) return;
        watched.add(el);
        io.observe(el);
      });
    };

    watch(document);

    // Pages swap in as visitors navigate, so keep looking for new drawings.
    const mo = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (node.matches(".dd") && !watched.has(node)) {
            watched.add(node);
            io.observe(node);
          }
          watch(node);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, []);

  return null;
}
