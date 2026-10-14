import type { Todo } from "@echomind/shared";

/** Character-bigram Dice similarity of two Chinese titles, 0–1. */
export function titleSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const clean = s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
    const out = new Map<string, number>();
    for (let i = 0; i < clean.length - 1; i++) {
      const g = clean.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const n of gb.values()) total += n;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return total ? (2 * overlap) / total : a === b ? 1 : 0;
}

function sameOwner(a: Todo, b: Todo): boolean {
  if (a.ownerPersonId || b.ownerPersonId) return a.ownerPersonId === b.ownerPersonId;
  return (a.ownerSpeakerId ?? a.ownerMention) === (b.ownerSpeakerId ?? b.ownerMention);
}

/**
 * The same task said twice (assigned mid-meeting, repeated in the closing
 * recap, or found by two parts of a long meeting) becomes one todo with both
 * citations. Keeps the first title and the more confident owner.
 */
export function mergeDuplicateTodos(todos: Todo[], order: (id: string) => number, onMerge?: (kept: Todo, dropped: Todo) => void): Todo[] {
  const out: Todo[] = [];
  for (const todo of todos) {
    // Without a known owner there is less to go on, so the titles must agree more.
    const threshold = todo.ownerPersonId ? 0.6 : 0.8;
    const dup = out.find((o) => sameOwner(o, todo) && titleSimilarity(o.title, todo.title) >= threshold);
    if (!dup) {
      out.push({ ...todo, evidence: [...todo.evidence] });
      continue;
    }
    onMerge?.(dup, todo);
    dup.evidence = [...new Set([...dup.evidence, ...todo.evidence])].sort((a, b) => order(a) - order(b));
    if (!dup.detail && todo.detail) dup.detail = todo.detail;
    if (!dup.due && todo.due) {
      dup.due = todo.due;
      dup.dueText = todo.dueText;
    }
    if (todo.ownerConfidence > dup.ownerConfidence) {
      dup.ownerMention = todo.ownerMention;
      dup.ownerSpeakerId = todo.ownerSpeakerId;
      dup.ownerPersonId = todo.ownerPersonId;
      dup.ownerBasis = todo.ownerBasis;
      dup.ownerConfidence = todo.ownerConfidence;
      dup.external = todo.external;
    }
  }
  return out;
}
