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

  return Array.from(new Set(base)).sort((a, b) => b.length - a.length).slice(0, 4);
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
  const raw = (q ?? "").replace(/\s+/g, " ").trim();

  if (/프로젝트\s*수당|프로젝트수당/.test(raw)) return "수당/프로젝트";
  if (/기타\s*휴가|기타휴가|병역의무|민방위|예비군|직무\s*교육|병가/.test(raw)) return "휴가/기타휴가";
  if (/연차|반차|월차|연차수당|잔여\s*연차|연차\s*생성|연차\s*발생/.test(raw)) return "휴가/연차";
  if (/화환/.test(raw)) return "경조/복리후생";
  if (/복리후생|복지|혜택|지원/.test(raw)) return "복리후생";
  if (/경조|조위|결혼|부고|사망/.test(raw)) return "경조/경조휴가";
  if (/안식년/.test(raw)) return "휴가/안식년";
  if (/휴가/.test(raw)) return "휴가";
  if (/수당|정산|지급/.test(raw)) return "수당/정산";
  return "규정 검색 결과";
}

export function expandQueryTerms(q: string, terms: string[]): string[] {
  const out = new Set<string>();
  const raw = (q ?? "").trim();
  const noSpace = raw.replace(/\s+/g, "");

  if (raw) out.add(raw);
  if (noSpace) out.add(noSpace);

  if (noSpace.includes("기타휴가")) {
    out.add("기타 휴가");
    out.add("기타휴가");
    out.add("기타");
    out.add("휴가");
    out.add("병역의무");
    out.add("민방위");
    out.add("예비군");
    out.add("직무교육");
    out.add("교육 참석");
    out.add("병가");
  }

  if (noSpace.includes("경조휴가") || (/경조/.test(raw) && /휴가/.test(raw))) {
    out.add("경조휴가");
    out.add("경조 휴가");
    out.add("경조");
  }

  if (noSpace.includes("안식년")) {
    out.add("안식년 휴가");
    out.add("장기근속");
    out.add("포상");
  }

  if (noSpace.includes("프로젝트수당") || (/프로젝트/.test(raw) && /수당/.test(raw))) {
    out.add("프로젝트 수당");
    out.add("프로젝트수당");
    out.add("지급 기준");
    out.add("수당");
    out.add("정산");
  }

  if (/연차\s*생성|연차\s*발생|연차\s*기준|잔여\s*연차|연차\s*수당|연차/.test(raw)) {
    out.add("연차");
    out.add("연차 발생");
    out.add("연차 생성");
    out.add("연차 기준");
    out.add("연차수당");
    out.add("잔여연차");
  }

  if (/복리후생|복지|혜택|지원/.test(raw)) {
    out.add("복리후생");
    out.add("복지");
    out.add("혜택");
    out.add("지원");
    out.add("경조");
    out.add("수당");
    out.add("휴가");
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