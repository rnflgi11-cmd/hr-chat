import { retrieveCandidates } from "./retrieve";
import { inferIntent, pickAnchors, tokenize } from "./query";
import { filterByAnchors, makeScorer, pickBestDocId } from "./rank";
import { buildWindowContext, loadDocFilename, toEvidence } from "./context";
import { buildSummary } from "./summarize";
import { SearchAnswer } from "./types";

export async function searchAnswer(q: string): Promise<SearchAnswer> {
  const intent = inferIntent(q);
  const terms = tokenize(q);
  const used = terms.length ? terms : [q];
  const anchors = pickAnchors(used);

  const { sb, hits: rawHits } = await retrieveCandidates(q, used);

  if (!rawHits.length) {
    return { ok: true, answer: buildSummary(intent, []), hits: [], meta: { intent } };
  }

  const hits = filterByAnchors(rawHits, anchors);
  const scoreRow = makeScorer({ q, used, anchors });
  const bestDocId = pickBestDocId(hits, scoreRow);

  const doc = await loadDocFilename(sb, bestDocId);
  const ctx = await buildWindowContext({ sb, q, bestDocId, hits, scoreRow });

  const evidence = toEvidence(doc.filename, ctx);
  const answer = buildSummary(intent, evidence);

  return {
    ok: true,
    answer,
    hits: evidence,
    meta: { intent, best_doc_id: bestDocId, best_filename: doc.filename },
  };
}