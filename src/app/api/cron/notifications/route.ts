import { NextRequest, NextResponse } from "next/server";
import {
  completeNotification,
  finishNotification,
  getLeadForNotification,
  startNotificationAttempt,
  takeNotifications,
  updateTrustedLead,
} from "@/lib/lead-store";
import { notifyTelegram } from "@/lib/telegram";
import { StoreUnavailableError } from "@/lib/store-errors";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let sent = 0;
  try {
    for (const id of await takeNotifications(10)) {
      const lead = await getLeadForNotification(id);
      if (!lead) { await completeNotification(id); continue; }
      await startNotificationAttempt(id);
      try {
        const delivery = await notifyTelegram(lead);
        if (delivery.configured) {
          await updateTrustedLead(id, { notificationStatus: "sent" });
          await finishNotification(id, "sent", { lastError: null, messageId: delivery.messageId });
          await completeNotification(id);
          sent++;
        } else {
          await updateTrustedLead(id, { notificationStatus: "not_configured" });
          await finishNotification(id, "not_configured", { lastError: null, messageId: null });
          await completeNotification(id);
        }
      } catch {
        await updateTrustedLead(id, { notificationStatus: "failed" });
        await finishNotification(id, "failed", { lastError: "Telegram notification failed", messageId: null });
      }
    }
  } catch (error) {
    if (error instanceof StoreUnavailableError) {
      return NextResponse.json({ sent, error: "store_unavailable" }, { status: 503 });
    }
    throw error;
  }
  return NextResponse.json({ sent });
}
