import { NextRequest, NextResponse } from "next/server";

// Backward-compatible shim: forward /api/admin/docs/:id to /api/admin/docs?docId=:id
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const url = new URL(req.url);
  url.pathname = "/api/admin/docs";
  url.searchParams.set("docId", id);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: req.headers,
    cache: "no-store",
  });

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
