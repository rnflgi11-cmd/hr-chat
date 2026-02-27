import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "hr-docs";
const SIGNED_URL_EXPIRES_IN = 60 * 10; // 10분

function canPreview(filename: string) {
  const lower = filename.toLowerCase();
  return (
    lower.endsWith(".pdf") ||
    lower.endsWith(".docx") ||
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".webp")
  );
}

function normalizeCell(c: string): string {
  const plain = c
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r/g, "")
    .trim();

  // markdown table cell 안전화
  return plain
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" <br> ")
    .replace(/\|/g, "\\|");
}


function getTableCellSet(html: string): Set<string> {
  const cells = html.match(/<(td|th)[\s\S]*?<\/\1>/gi) ?? [];
  const out = new Set<string>();
  for (const c of cells) {
    const v = normalizeCell(c).replace(/\s*<br>\s*/g, " ").trim();
    if (v) out.add(v);
  }
  return out;
}

function toMarkdownTable(html: string): string {
  const tr = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const rows = tr
    .map((row) => {
      const cells = row.match(/<(td|th)[\s\S]*?<\/\1>/gi) ?? [];
      return cells.map(normalizeCell);
    })
    .filter((r) => r.some(Boolean));

  if (!rows.length) return "";

  const header = rows[0];
  const body = rows.slice(1);
  const cols = Math.max(1, header.length);
  const lines = [
    `| ${new Array(cols).fill("").map((_, i) => header[i] ?? "").join(" | ")} |`,
    ...body.map((r) =>
      `| ${new Array(cols)
        .fill("")
        .map((_, i) => r[i] ?? "")
        .join(" | ")} |`
    ),
  ];

  return lines.join("\n");
}

function tokenizeKorean(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function normalizeHeading(line: string): string {
  return line
    .replace(/^([#■✅◊]|📌|▶|•|●|◦|\d+[.)])\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeHeading(line: string): boolean {
  return /^([#■✅◊📌]|\d+[.)]|[A-Za-z가-힣][A-Za-z가-힣\s]+:)/u.test(line);
}

function pickQuestionTemplate(heading: string): string[] {
  if (/신청|절차|결재|보고|공유|작성|경로/.test(heading)) {
    return [
      `${heading}를 단계별로 알려줘.`,
      `${heading}에서 결재선/담당자까지 포함해 정리해줘.`,
    ];
  }
  if (/유의|주의|예외|불가|제외|중복/.test(heading)) {
    return [`${heading}에서 반드시 지켜야 할 제한/예외를 알려줘.`];
  }
  if (/지급|일정|시행일|기한|유효기간/.test(heading)) {
    return [
      `${heading}의 적용 시점과 일정을 알려줘.`,
      `${heading}이 지연/미충족될 때 처리 기준을 알려줘.`,
    ];
  }
  if (/계산|산정|일수|금액|수당/.test(heading)) {
    return [
      `${heading}의 산정 기준을 예시와 함께 알려줘.`,
      `${heading} 계산식을 항목별로 풀어서 설명해줘.`,
    ];
  }
  if (/대상|자격|조건|기준|정의|인정/.test(heading)) {
    return [
      `${heading}에 해당하는 대상/조건을 알려줘.`,
      `${heading}에서 제외 대상이 있다면 함께 알려줘.`,
    ];
  }
  return [`${heading} 핵심 내용을 원문 기준으로 정리해줘.`];
}

function buildSuggestedQuestions(markdown: string, filename?: string): string[] {
  const lines = markdown
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const headingLines = lines
    .filter((line) => looksLikeHeading(line))
    .map(normalizeHeading)
    .filter((line) => line.length >= 2)
    .filter((line) => !/^(구분|유형|대상|비고|내용|첨부서류|지급 비용)$/u.test(line))
    .filter((line) => !/^(담당자|업무 담당자|문의)\s*:/u.test(line));

  const uniqueHeadings = [...new Set(headingLines)].slice(0, 12);

  const keywordCounts = new Map<string, number>();
  for (const token of tokenizeKorean(markdown)) {
    keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
  }

  const stopwords = new Set([
    "휴가",
    "기준",
    "사용",
    "안내",
    "경우",
    "가능",
    "신청",
    "관련",
    "해당",
    "기타",
  ]);

  const topKeywords = [...keywordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter((k) => !stopwords.has(k))
    .slice(0, 4);

  const questions = new Set<string>();

  for (const heading of uniqueHeadings) {
    for (const q of pickQuestionTemplate(heading)) {
      questions.add(q);
    }
  }

  if (markdown.includes("|")) {
    questions.add("표에 나온 항목을 빠짐없이 정리해줘.");
    questions.add("표 기준으로 대상별 지급기준/금액/비고를 비교해줘.");
  }

  for (const keyword of topKeywords) {
    questions.add(`${keyword} 관련 조건과 예외를 알려줘.`);
  }

  if (/문의|담당자|연락처|메일|전화/u.test(markdown)) {
    questions.add("문의 담당자와 연락 방법을 알려줘.");
  }

  if (/별도 신청 없음|일괄 정산|자동 지급/u.test(markdown)) {
    questions.add("별도 신청이 필요한지 여부와 자동 처리 기준을 알려줘.");
  }

  if (/예:|case\s*\d+/iu.test(markdown)) {
    questions.add("문서의 예시(CASE)를 기준으로 지급/미지급 판단을 설명해줘.");
  }

  questions.add("원문 기준으로 필수 규정만 누락 없이 요약해줘.");

  if (filename) {
    const name = filename.replace(/\.[^.]+$/, "").trim();
    if (name) questions.add(`${name} 문서에서 실무자가 가장 자주 묻는 질문 5개를 뽑아줘.`);
  }

  return [...questions].slice(0, 16);
}


// ✅ 관리자 체크: 프론트에서 headers["x-user"] = JSON.stringify(user) 로 전달
function isAdmin(req: NextRequest) {
  const raw = req.headers.get("x-user");
  if (!raw) return false;
  try {
    const u = JSON.parse(raw);
    return u?.role === "admin";
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const docId = req.nextUrl.searchParams.get("docId")?.trim();

  // 단건 원문 조회 모드: /api/admin/docs?docId=<id>
  if (docId) {
    const { data: doc, error: docErr } = await supabaseAdmin
      .from("documents")
      .select("id, filename")
      .eq("id", docId)
      .single();

    if (docErr || !doc) {
      return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });
    }

    const { data: blocks, error } = await supabaseAdmin
      .from("document_blocks")
      .select("block_index, kind, text, table_html")
      .eq("document_id", docId)
      .order("block_index", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const lines: string[] = [];
    const tableCells = new Set<string>();

    for (const b of blocks ?? []) {
      if (b.kind === "table" && b.table_html) {
        const table = toMarkdownTable(b.table_html);
        if (table) lines.push(table);
        for (const c of getTableCellSet(b.table_html)) tableCells.add(c);
        continue;
      }

      const text = (b.text ?? "").toString().trim();
      if (!text) continue;

      const compact = text.replace(/\s+/g, " ").trim();
      if (compact.length <= 40 && tableCells.has(compact)) continue; // 표 셀 중복 텍스트 제거

      lines.push(text);
    }

    const markdown = lines.join("\n\n");
    const includeCases = req.nextUrl.searchParams.get("suggestCases") === "1";

    return NextResponse.json({
      ok: true,
      id: docId,
      filename: doc.filename,
      markdown,
      block_count: (blocks ?? []).length,
      suggested_questions: includeCases ? buildSuggestedQuestions(markdown) : undefined,
    });
  }

  // 기존 목록 조회 모드
    const { data, error } = await supabaseAdmin
    .from("documents")
    .select("id, filename, content_type, size_bytes, created_at, storage_path")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const docs = await Promise.all(
    (data ?? []).map(async (d) => {
      const preview = canPreview(d.filename);

      if (!d.storage_path) {
        return { ...d, open_url: null, can_preview: preview };
      }

      const { data: signed, error: sErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUrl(d.storage_path, SIGNED_URL_EXPIRES_IN);

      return {
        ...d,
        open_url: sErr ? null : signed?.signedUrl ?? null,
        can_preview: preview,
      };
    })
  );

  return NextResponse.json({ docs });
}

/**
 * ✅ 일괄 삭제
 * body: { ids: string[] }
 * - document_chunks 삭제
 * - documents 삭제
 * - storage 파일 삭제
 * - 관리자만 가능
 */
export async function DELETE(req: NextRequest) {
  try {
    if (!isAdmin(req)) {
      return NextResponse.json({ error: "관리자만 삭제 가능합니다." }, { status: 403 });
    }

    const body = await req.json().catch(() => null);
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];

    if (!ids.length) {
      return NextResponse.json({ error: "ids가 비었습니다." }, { status: 400 });
    }

    // 1) storage_path 확보
    const { data: docs, error: fetchErr } = await supabaseAdmin
      .from("documents")
      .select("id, storage_path")
      .in("id", ids);

    if (fetchErr) {
      return NextResponse.json(
        { error: `documents fetch failed: ${fetchErr.message}` },
        { status: 500 }
      );
    }

    const paths = (docs ?? [])
      .map((d) => d.storage_path)
      .filter((p): p is string => !!p);

    // 2) chunks 삭제
    const { error: chunkErr } = await supabaseAdmin
      .from("document_chunks")
      .delete()
      .in("document_id", ids);

    if (chunkErr) {
      return NextResponse.json(
        { error: `chunk delete failed: ${chunkErr.message}` },
        { status: 500 }
      );
    }

    // 3) documents 삭제
    const { error: docErr } = await supabaseAdmin.from("documents").delete().in("id", ids);

    if (docErr) {
      return NextResponse.json(
        { error: `documents delete failed: ${docErr.message}` },
        { status: 500 }
      );
    }

    // 4) storage 파일 삭제 (실패해도 DB는 이미 삭제됐을 수 있음)
    let deletedStorageFiles = 0;
    let storageError: string | null = null;

    if (paths.length) {
      const { data: removed, error: stErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .remove(paths);

      if (stErr) storageError = stErr.message;
      else deletedStorageFiles = Array.isArray(removed) ? removed.length : 0;
    }

    return NextResponse.json({
      ok: true,
      deleted_documents: ids.length,
      deleted_storage_files: deletedStorageFiles,
      storage_error: storageError,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
