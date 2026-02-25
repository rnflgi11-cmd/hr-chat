// lib/search/extract.ts
import type { Evidence } from "./types";

/** 매우 단순한 HTML -> text (표/문단 공통) */
function htmlToText(html: string) {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function evidenceToLines(evs: Evidence[]) {
  const all = evs
    .map((e) => {
      if (e.block_type === "p") return e.content_text ?? "";
      // table_html이면 content_html 또는 content_text 둘 다 케이스가 있을 수 있음
      const raw = e.content_html ?? e.content_text ?? "";
      return htmlToText(raw);
    })
    .join("\n");

  return all
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function scoreLineForDayQuestion(line: string, q: string) {
  let score = 0;
  if (/\d+\s*일/.test(line)) score += 10;
  if (/휴가/.test(line)) score += 3;
  if (/경조|조위|결혼|사망|부고|출산/.test(line)) score += 4;

  // 질문 키워드가 있으면 강하게 가중치
  const keys = [
    "외조모",
    "외조부",
    "조모",
    "조부",
    "부모",
    "배우자",
    "자녀",
    "형제",
    "자매",
    "본인",
    "장인",
    "장모",
    "시부모",
  ];
  for (const k of keys) {
    if (q.includes(k) && line.includes(k)) score += 100;
  }

  // 표 헤더/노이즈 감점
  if (/구분|유형|대상|일수|비고|내용/.test(line)) score -= 20;
  if (/연차/.test(line)) score -= 25;

  return score;
}

/**
 * ✅ LLM 없이 “정답 우선” 추출
 * - 성공하면 string 리턴
 * - 못 뽑으면 null → summarize로 fallback
 */
export function tryExtractAnswer(q: string, intent: string, evidenceAll: Evidence[]): string | null {
  const question = (q ?? "").trim();
  const lines = evidenceToLines(evidenceAll);

  if (!lines.length) return null;

  const isDayQ = /며칠|일수|몇일/.test(question);
// 3) "기준/조건/요건/설명" 질문 처리
  if (/기준|조건|요건|설명|어떻게/.test(question)) {
    const idx = lines.findIndex(l =>
      l.includes("안식년") ||
      l.includes("기준") ||
      l.includes("휴가 발생 기준")
    );

    if (idx >= 0) {
      const slice = lines.slice(idx, idx + 10);
      return slice.map(x => `- ${x}`).join("\n");
    }
  }
  
  // 1) 경조/휴가 관련 + 일수 질문: "\d+일" 들어간 라인을 우선 뽑기
  if (isDayQ && /휴가|경조|출산|조위|결혼/.test(intent + " " + question)) {
    const cand = lines
      .filter((l) => /\d+\s*일/.test(l))
      .map((l) => ({ l, s: scoreLineForDayQuestion(l, question) }))
      .sort((a, b) => b.s - a.s);

    if (cand.length) {
      // 질문에 특정 키(외조모/부모 등)가 있으면 1개만, 아니면 상위 몇 개 보여주기
      const hasSpecific =
        /외조모|외조부|조모|조부|부모|배우자|자녀|형제|자매|본인|장인|장모|시부모/.test(question);
      const take = hasSpecific ? 1 : Math.min(6, cand.length);

      return cand
        .slice(0, take)
        .map((x) => `- ${x.l}`)
        .join("\n");
    }
  }

  // 2) “종류/목록/뭐가 있어” 질문: 항목처럼 보이는 라인만 리스트로
  if (/종류|목록|뭐가|항목|리스트|전체/.test(question)) {
    const out: string[] = [];
    for (const l of lines) {
      // 너무 긴 문장 제외(설명 덩어리 방지)
      if (l.length > 120) continue;

      // 항목 후보(키워드는 필요시 계속 추가)
      if (
        /^[-•*]\s+/.test(l) ||
        /민방위|예비군|직무교육|병가|공가|복리후생|지원|수당|제도|휴가/.test(l)
      ) {
        out.push(l.startsWith("-") ? l : `- ${l}`);
      }
      if (out.length >= 15) break;
    }
    if (out.length) return out.join("\n");
  }

  return null;
}