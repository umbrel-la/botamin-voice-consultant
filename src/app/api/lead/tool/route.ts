import { NextRequest, NextResponse } from "next/server";
import { runLeadTool } from "@/lib/lead-tools";

export const runtime = "nodejs";

const ALLOWED_TOOLS = new Set([
  "save_company_activity", "save_discovery", "confirm_need_summary",
  "get_available_slots", "select_slot", "save_name", "save_contact",
  "save_work_email", "confirm_booking", "save_qualification",
]);

function sessionFrom(request: NextRequest) {
  const raw = request.cookies.get("botamin_lead")?.value;
  if (!raw) return null;
  const split = raw.indexOf(".");
  return split > 0 ? { leadId: raw.slice(0, split), secret: raw.slice(split + 1) } : null;
}

export async function POST(request: NextRequest) {
  const session = sessionFrom(request);
  if (!session) return NextResponse.json({ success: false, message: "Сессия истекла. Начните разговор заново." }, { status: 401 });
  const body = await request.json().catch(() => null) as { tool?: string; args?: Record<string, unknown>; callId?: string } | null;
  if (!body || !body.tool || !ALLOWED_TOOLS.has(body.tool) || !body.args || typeof body.args !== "object") {
    return NextResponse.json({ success: false, message: "Некорректный запрос." }, { status: 400 });
  }
  const result = await runLeadTool(session.leadId, session.secret, body.tool, body.args, body.callId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
