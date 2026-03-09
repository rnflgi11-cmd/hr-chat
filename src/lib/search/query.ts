const STOP = new Set([
  "알려줘", "알려", "어떻게", "뭐야", "뭔가", "뭔지", "있어", "없어", "가능", "될까", "되나",
  "합니다", "해주세요", "주세요", "며칠", "몇일", "몇", "일", "기준", "절차", "방법", "종류", "대상",
]);

export const GENERIC_TERMS = new Set([
  "신청", "절차", "방법", "기준", "대상", "지급", "정산", "수당", "휴가", "연차", "규정", "서류", "제출", "작성", "확인", "처리", "안내",
]);

export function tokenize(q: string) {
  const base = (q.match(/[A-Za-z0-9가-힣]+/g) ?? [])
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !STOP.has(t));

  return Array.from(new Set(base)).sort((a, b) => b.length - a.length).slice(0, 4);
}

export function pickAnchors(terms: string[]) {
  const anchors = terms.filter((t) => !GENERIC_TERMS.has(t));
  return anchors.length ? anchors : terms;
}
