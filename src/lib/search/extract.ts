// lib/search/extract.ts
import type { Evidence } from "./types";

function textFromEvidence(evs: Evidence[]) {
  return evs
    .map((e) => (e.content_text ?? "").toString())
    .join("\n")
    .replace(/\r/g, "");
}

export function tryExtractAnswer(intent: string, q: string, evidenceAll: Evidence[]): string | null {
  const text = textFromEvidence(evidenceAll);
  const question = (q ?? "").trim();

  // 1) 경조휴가 "며칠/일수" 질문: 숫자+일 패턴을 가까운 키워드와 함께 뽑기
  if (/경조/.test(intent) && /며칠|일수|몇일/.test(question)) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    const keyHints = [
      "외조모", "외조부", "조모", "조부", "부모", "배우자", "자녀", "형제", "자매",
      "본인", "처", "시부모", "장인", "장모", "조부모",
    ];

    const candidates: { line: string; score: number }[] = [];

    for (const line of lines) {
      const m = line.match(/(\d+)\s*일/);
      if (!m) continue;

      let score = 0;
      if (line.includes("경조")) score += 5;
      if (line.includes("휴가")) score += 3;

      for (const h of keyHints) {
        if (question.includes(h) && line.includes(h)) score += 50;
        else if (line.includes(h)) score += 5;
      }

      // 너무 일반적인 "연차" 쪽은 감점
      if (line.includes("연차")) score -= 30;

      candidates.push({ line, score });
    }

    candidates.sort((a, b) => b.score - a.score);

    const top = candidates.slice(0, 5).map((x) => `- ${x.line}`);
    if (top.length) {
      return top.join("\n");
    }
  }

  // 2) 기타휴가 종류/목록: "기타 휴가" 섹션 근처의 항목 라인만 뽑기
  if (/기타/.test(intent) && /종류|목록|뭐가|항목|리스트|어떤/.test(question)) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    // "기타 휴가"가 시작되는 곳 찾기
    const start = lines.findIndex((l) => l.includes("기타 휴가"));
    if (start >= 0) {
      const out: string[] = [];
      for (let i = start; i < Math.min(lines.length, start + 120); i++) {
        const l = lines[i];
        if (/연차 휴가|경조 휴가/.test(l)) break;

        // 항목처럼 보이는 것만 수집
        if (
          /^[-•*]\s+/.test(l) ||
          /민방위|예비군|직무교육|병가|경조|공가|교육/.test(l)
        ) {
          // 너무 긴 문장은 제외(설명 줄이기)
          if (l.length <= 80) out.push(l.startsWith("-") ? l : `- ${l}`);
        }
        if (out.length >= 20) break;
      }
      if (out.length) return out.join("\n");
    }
  }

  // 3) 복리후생 뭐가 있어: 항목형 라인만 뽑기 (간단 버전)
  if (/복리후생/.test(question) && /뭐가|목록|전체|항목|종류/.test(question)) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const out: string[] = [];
    for (const l of lines) {
      if (/구독|교육|자격증|도서|복리후생|지원/.test(l) && l.length <= 90) {
        out.push(l.startsWith("-") ? l : `- ${l}`);
      }
      if (out.length >= 20) break;
    }
    if (out.length) return out.join("\n");
  }

  return null;
}