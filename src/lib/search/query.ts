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

export function expandQueryTerms(q: string, terms: string[]): string[] {
  const out = new Set<string>();
  const raw = (q ?? "").trim();
  const noSpace = raw.replace(/\s+/g, "");

  // 기본: 원문/공백제거 버전도 후보에
  if (raw) out.add(raw);
  if (noSpace) out.add(noSpace);

  // ✅ 붙여쓴 "기타휴가" → "기타 휴가"
  if (noSpace.includes("기타휴가")) {
    out.add("기타 휴가");
    out.add("기타");
    out.add("휴가");
    // 기타휴가 문서에서 자주 나오는 대표 키워드(검색 보강)
    out.add("병역의무");
    out.add("민방위");
    out.add("예비군");
    out.add("직무교육");
    out.add("교육 참석");
    out.add("병가");
  }

  // ✅ 경조휴가/안식년/프로젝트수당 등 붙여쓰기 보강
  if (noSpace.includes("경조휴가")) {
    out.add("경조 휴가");
    out.add("경조");
    out.add("휴가");
  }
  if (noSpace.includes("안식년")) {
    out.add("안식년 휴가");
    out.add("장기근속");
    out.add("포상");
  }
  if (noSpace.includes("프로젝트수당")) {
    out.add("프로젝트 수당");
    out.add("수당");
    out.add("정산");
  }

    if (noSpace.includes("화환")) {
    out.add("화환 신청");
    out.add("화환신청서");
    out.add("발주");
    out.add("도착");
    out.add("배송");
  }
  
  // ✅ terms 중 "OO휴가" 형태도 띄어쓰기 버전 추가 (예: 경조휴가, 기타휴가)
  for (const t of terms ?? []) {
    const tt = (t ?? "").trim();
    if (!tt) continue;

    out.add(tt);

    const ns = tt.replace(/\s+/g, "");
    if (ns.endsWith("휴가") && ns.length > 2 && !tt.includes(" ")) {
      out.add(ns.slice(0, ns.length - 2) + " 휴가");
      out.add("휴가");
    }
  }

  return Array.from(out);
}