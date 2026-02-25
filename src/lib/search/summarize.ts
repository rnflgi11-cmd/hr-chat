// lib/search/summarize.ts
import type { Evidence } from "./types";

function clean(s: string) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

export function buildSummary(intent: string, evidenceAll: Evidence[], q: string) {
  const lines: string[] = [];

  for (const e of evidenceAll) {
    if (e.block_type !== "p") continue;
    const t = clean(e.content_text ?? "");
    if (t) lines.push(t);
  }

  if (!lines.length) return "";

  return lines.slice(0, 18).map((x) => (x.startsWith("-") ? x : `- ${x}`)).join("\n");
}