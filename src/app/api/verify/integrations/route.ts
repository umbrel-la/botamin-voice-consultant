import { NextRequest, NextResponse } from "next/server";
import { getCalcomSlots } from "@/lib/calcom";

export const runtime = "nodejs";

type Check = { configured: boolean; reachable: boolean; detail: string };

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function checkSupabase(): Promise<Check> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { configured: false, reachable: false, detail: "not configured" };
  try {
    const response = await fetch(`${url}/rest/v1/leads?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    return { configured: true, reachable: response.ok, detail: response.ok ? "reachable" : `HTTP ${response.status}` };
  } catch {
    return { configured: true, reachable: false, detail: "unreachable" };
  }
}

async function checkCalcom(): Promise<Check> {
  try {
    const slots = await getCalcomSlots();
    if (!slots.configured) return { configured: false, reachable: false, detail: "not configured" };
    return { configured: true, reachable: true, detail: "reachable" };
  } catch {
    return { configured: true, reachable: false, detail: "unreachable" };
  }
}

async function checkTelegram(): Promise<Check> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_MANAGER_CHAT_ID;
  if (!token || !chatId) return { configured: false, reachable: false, detail: "not configured" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { cache: "no-store" });
    return { configured: true, reachable: response.ok, detail: response.ok ? "reachable" : `HTTP ${response.status}` };
  } catch {
    return { configured: true, reachable: false, detail: "unreachable" };
  }
}

export async function GET(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) return unauthorized();

  const [supabase, calcom, telegram] = await Promise.all([checkSupabase(), checkCalcom(), checkTelegram()]);
  return NextResponse.json({
    ok: [supabase, calcom, telegram].every((check) => check.configured && check.reachable),
    integrations: { supabase, calcom, telegram },
    checks: "read-only; no booking was created and no Telegram message was sent",
  }, { headers: { "Cache-Control": "no-store" } });
}
