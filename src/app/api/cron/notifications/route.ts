import { NextRequest, NextResponse } from "next/server";
import { completeNotification, finishNotification, getLeadForNotification, startNotificationAttempt, takeNotifications, updateLead } from "@/lib/lead-store";
import { persistLead, persistNotificationJob } from "@/lib/supabase-repository";
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
    await persistNotificationJob(startNotificationAttempt(id));
    try {
      const delivery = await notifyTelegram(lead);
      if (delivery.configured) {
        const updated = updateLead(id, lead.sessionSecret, { notificationStatus: "sent" });
        await persistNotificationJob(finishNotification(id, "sent", { lastError: null, messageId: delivery.messageId }));
        if (updated) await persistLead(updated);
        completeNotification(id);
        sent++;
      } else {
        const updated = updateLead(id, lead.sessionSecret, { notificationStatus: "not_configured" });
        await persistNotificationJob(finishNotification(id, "not_configured", { lastError: null, messageId: null }));
        if (updated) await persistLead(updated);
        completeNotification(id);
      }
    } catch {
      const updated = updateLead(id, lead.sessionSecret, { notificationStatus: "failed" });
      await persistNotificationJob(finishNotification(id, "failed", { lastError: "Telegram notification failed", messageId: null }));
      if (updated) await persistLead(updated);
    }
  }
  return NextResponse.json({ sent });
}
