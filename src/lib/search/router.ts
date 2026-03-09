import type { Row } from "./types";

type TopicKey =
  | "annual_leave"
  | "condolence_leave"
  | "etc_leave"
  | "sabbatical"
  | "project_allowance"
  | "wreath"
  | "welfare"
  | "general_leave"
  | "general";

export type TopicProfile = {
  key: TopicKey;
  intent: string;
  docHints: string[];
  queryTerms: string[];
  include: RegExp | null;
  exclude: RegExp | null;
  preferTable: boolean;
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map((x) => x.trim()).filter(Boolean)));
}

export function classifyTopic(questionRaw: string): TopicProfile {
  const question = (questionRaw ?? "").replace(/\s+/g, " ").trim();

  if (/프로젝트\s*수당|프로젝트수당/.test(question)) {
    return {
      key: "project_allowance",
      intent: "수당/프로젝트",
      docHints: ["프로젝트 수당", "프로젝트수당"],
      queryTerms: ["프로젝트 수당", "프로젝트수당", "지급 기준", "PM팀", "개발자", "상주 근무"],
      include: /(프로젝트\s*수당|프로젝트수당|지급\s*기준|PM팀|개발자|상주\s*근무|1일\s*\d+[\d,]*\s*원)/,
      exclude: /(경조|결혼|조사|사망|화환|안식년|연차|기타\s*휴가|병역의무)/,
      preferTable: true,
    };
  }

  if (/기타\s*휴가|기타휴가|병역의무|민방위|예비군|직무\s*교육|병가/.test(question)) {
    return {
      key: "etc_leave",
      intent: "휴가/기타휴가",
      docHints: ["기타휴가", "기타 휴가"],
      queryTerms: ["기타휴가", "기타 휴가", "병역의무", "민방위", "예비군", "직무교육", "병가"],
      include: /(기타|병역의무|민방위|예비군|직무\s*교육|교육\s*참석|병가|훈련\s*증명서|연차\s*차감\s*없음|사전\s*기안)/,
      exclude: /(경조|결혼|조사|사망|부고|조의|조문|출산|조위금|경조금)/,
      preferTable: true,
    };
  }

  if (/연차|반차|월차|연차수당|잔여\s*연차|연차\s*생성|연차\s*발생/.test(question)) {
    return {
      key: "annual_leave",
      intent: "휴가/연차",
      docHints: ["연차", "연차수당", "잔여연차"],
      queryTerms: ["연차", "반차", "월차", "연차 발생", "연차 생성", "연차 기준", "연차수당", "잔여연차"],
      include: /(연차|반차|월차|연차수당|잔여\s*연차|연차\s*생성|연차\s*발생|발생\s*기준|사용\s*기준|소멸|이월)/,
      exclude: /(경조|결혼|조사|사망|병역|민방위|예비군|안식년|화환|프로젝트\s*수당)/,
      preferTable: true,
    };
  }

  if (/경조\s*휴가|경조휴가|경조|조위|결혼|부고|사망/.test(question)) {
    return {
      key: "condolence_leave",
      intent: "경조/경조휴가",
      docHints: ["경조휴가", "경조 휴가", "경조"],
      queryTerms: ["경조휴가", "경조 휴가", "경조", "경조유형", "휴가일수"],
      include: /(경조\s*휴가|경조휴가|경조유형|조의|조문|부고|사망|결혼|휴가일수|\d+\s*일)/,
      exclude: /(안식년|선연차|프로젝트\s*수당|프로젝트수당|수당\s*정산|화환\s*신청|화환신청)/,
      preferTable: true,
    };
  }

  if (/화환/.test(question)) {
    return {
      key: "wreath",
      intent: "경조/복리후생",
      docHints: ["화환"],
      queryTerms: ["화환 신청", "화환신청서", "발주", "도착", "배송"],
      include: /(화환|발주|신청서|도착|배송)/,
      exclude: /(경조금|조위금|근속\s*2년|근속2년)/,
      preferTable: false,
    };
  }

  if (/복리후생|복지|혜택|지원/.test(question)) {
    return {
      key: "welfare",
      intent: "복리후생",
      docHints: ["복리후생", "복지", "혜택", "지원"],
      queryTerms: ["복리후생", "복지", "혜택", "지원", "휴가", "수당", "경조", "화환", "안식년"],
      include: /(복리후생|복지|혜택|지원|수당|휴가|경조|화환|안식년|연차)/,
      exclude: null,
      preferTable: false,
    };
  }

  if (/안식년/.test(question)) {
    return {
      key: "sabbatical",
      intent: "휴가/안식년",
      docHints: ["안식년"],
      queryTerms: ["안식년", "장기근속", "포상"],
      include: /(안식년|장기근속|포상|휴가일수|유효기간|사용\s*절차)/,
      exclude: /(경조|화환|프로젝트\s*수당)/,
      preferTable: true,
    };
  }

  if (/휴가/.test(question)) {
    return {
      key: "general_leave",
      intent: "휴가",
      docHints: ["휴가", "연차"],
      queryTerms: ["휴가", "연차", "신청", "절차"],
      include: /(휴가|연차|반차|신청|절차)/,
      exclude: /(구독|OTT|넷플릭스|유튜브|리디북스|티빙)/,
      preferTable: false,
    };
  }

  return {
    key: "general",
    intent: "규정 검색 결과",
    docHints: [],
    queryTerms: [],
    include: null,
    exclude: null,
    preferTable: false,
  };
}

export function buildTopicQueryTerms(question: string, baseTerms: string[], topic: TopicProfile): string[] {
  const noSpace = (question ?? "").replace(/\s+/g, "").trim();
  const merged = uniq([question, noSpace, ...baseTerms, ...topic.queryTerms]);
  return merged;
}

export function applyTopicFilter(hits: Row[], topic: TopicProfile): Row[] {
  if (!hits.length) return hits;
  if (!topic.include && !topic.exclude) return hits;

  const strict = hits.filter((h) => {
    const hay = `${h.text ?? ""}\n${h.table_html ?? ""}`;
    if (topic.include && !topic.include.test(hay)) return false;
    if (topic.exclude && topic.exclude.test(hay)) return false;
    return true;
  });

  return strict.length ? strict : hits;
}