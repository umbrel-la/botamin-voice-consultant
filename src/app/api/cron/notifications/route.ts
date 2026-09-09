import { NextRequest, NextResponse } from "next/server";
import { completeNotification, getLeadForNotification, takeNotifications, updateLead } from "@/lib/lead-store";
import { notifyTelegram } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let sent = 0;
  for (const id of takeNotifications(10)) {
    const lead = getLeadForNotification(id);
    if (!lead) { completeNotification(id); continue; }
    try {
      const delivery = await notifyTelegram(lead);
      if (delivery.configured) {
        updateLead(id, lead.sessionSecret, { notificationStatus: "sent" });
        completeNotification(id);
        sent++;
      }
    } catch {
      updateLead(id, lead.sessionSecret, { notificationStatus: "failed" });
    }
  }
  return NextResponse.json({ sent });
}
