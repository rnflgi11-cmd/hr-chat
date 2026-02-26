export type Row = {
  content_text?: string | null;
  id: string;
  document_id: string;
  block_index: number;
  kind: string; // "paragraph" | "table"
  text: string | null;
  table_html: string | null;
};

export type Evidence = {
  table_ok: boolean;
  filename: string;
  block_type: "p" | "table_html";
  content_text?: string | null;
  content_html?: string | null;
};

export type SearchMeta = {
  intent: string;
  best_doc_id?: string;
  best_filename?: string;
};

export type SearchAnswer = {
  ok: true;
  answer: string;
  hits: Evidence[];
  meta: SearchMeta;
};