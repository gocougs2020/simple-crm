/**
 * Shows what a live refresh changed. While the page re-renders after a change someone else made
 * (the agent working for this teammate, a teammate, an email arriving), whatever appears or changes
 * inside `root` glows for a moment, so the work is seen happening instead of the page quietly being
 * different. It only watches: the page's own markup decides what's there.
 *
 * Returns a function that stops watching. A refresh that swaps most of the page (a navigation
 * landing at the same moment) highlights nothing.
 */
const CLASS = "live-arrived";
const MAX_AT_ONCE = 24;
const SKIP = "script, style, template, [hidden], [aria-hidden='true'], [data-live-quiet]";

export function watchArrivals(root: HTMLElement): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver((records) => {
    const found = new Set<HTMLElement>();
    const consider = (node: Node | null) => {
      const el = node instanceof HTMLElement ? node : node instanceof Text && node.data.trim() ? node.parentElement : null;
      if (!el || el === root || !el.isConnected || !root.contains(el) || el.closest(SKIP)) return;
      // What the teammate is typing in is theirs.
      if (el.isContentEditable || el.matches("input, textarea, select") || el.contains(document.activeElement)) return;
      found.add(el);
    };
    for (const r of records) {
      if (r.type === "characterData") consider(r.target);
      else r.addedNodes.forEach(consider);
    }
    // The outermost of what changed: a new row glows once, not each of its cells.
    const outer = [...found].filter((el) => ![...found].some((other) => other !== el && other.contains(el)));
    const viewport = window.innerHeight * 0.9;
    const shown = outer.filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.height < viewport;
    });
    if (!shown.length || shown.length > MAX_AT_ONCE) return;
    for (const el of shown) {
      el.classList.remove(CLASS);
      // Reading layout between the two restarts the glow on something that changes twice.
      void el.offsetWidth;
      el.classList.add(CLASS);
      el.addEventListener("animationend", () => el.classList.remove(CLASS), { once: true });
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
