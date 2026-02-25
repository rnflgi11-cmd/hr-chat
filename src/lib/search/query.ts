const STOP = new Set([
  "알려줘","알려","어떻게","뭐야","뭔가","뭔지","있어","없어","가능","될까","되나",
  "합니다","해주세요","주세요","며칠","몇일","몇","일","기준","절차","방법","종류","대상",
]);

export const GENERIC_TERMS = new Set([
  "신청","절차","방법","기준","대상","지급","정산","수당","휴가","연차","규정","서류","제출","작성","확인","처리","안내",
]);

export function tokenize(q: string) {
  const base = (q.match(/[A-Za-z0-9가-힣]+/g) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP.has(t));

  return Array.from(new Set(base)).sort((a, b) => b.length - a.length).slice(0, 3);
}

export function buildWebsearchQuery(q: string) {
  return q.replace(/[':()&|!]/g, " ").replace(/\s+/g, " ").trim();
}

export function escapeLike(s: string) {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function pickAnchors(terms: string[]) {
  const anchors = terms.filter((t) => !GENERIC_TERMS.has(t));
  return anchors.length ? anchors : terms;
}

export function inferIntent(q: string) {
  if (/화환/.test(q)) return "경조/복리후생";
  if (/경조|조위|결혼|부고|사망/.test(q)) return "경조/경조휴가";
  if (/연차|반차|휴가/.test(q)) return "휴가";
  if (/수당|정산|지급/.test(q)) return "수당/정산";
  return "규정 검색 결과";
}