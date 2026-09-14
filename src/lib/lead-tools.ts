import "server-only";

import { randomUUID } from "crypto";
import { getCalcomSlots } from "@/lib/calcom";
import { createCalcomBooking } from "@/lib/calcom";
import { enqueueNotification, finishNotification, getLead, getSlots, getToolCall, saveSlots, saveToolCall, startNotificationAttempt, toPublicLead, updateLead } from "@/lib/lead-store";
import { persistLead } from "@/lib/supabase-repository";
import { persistNotificationJob } from "@/lib/supabase-repository";
import { notifyTelegram } from "@/lib/telegram";
import type { ContactType, Lead, ToolResult } from "@/lib/lead-types";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function result(lead: Lead, success: boolean, message: string, extra: Omit<ToolResult, "success" | "message" | "lead"> = {}): ToolResult {
  return { success, message, lead: toPublicLead(lead), ...extra };
}

async function notifyManagerImmediately(leadId: string, sessionSecret: string) {
  const lead = getLead(leadId, sessionSecret);
  if (!lead) return null;

  await persistNotificationJob(startNotificationAttempt(leadId));
  try {
    const delivery = await notifyTelegram(lead);
    if (!delivery.configured) {
      await persistNotificationJob(finishNotification(leadId, "not_configured", { lastError: null, messageId: null }));
      return updateLead(leadId, sessionSecret, { notificationStatus: "not_configured" });
    }
    await persistNotificationJob(finishNotification(leadId, "sent", { lastError: null, messageId: delivery.messageId }));
    return updateLead(leadId, sessionSecret, { notificationStatus: "sent" });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : "Telegram notification failed";
    await persistNotificationJob(finishNotification(leadId, "failed", { lastError, messageId: null }));
    return updateLead(leadId, sessionSecret, { notificationStatus: "failed" });
  }
}

export async function runLeadTool(
  leadId: string,
  sessionSecret: string,
  toolName: string,
  args: Record<string, unknown>,
  callId: string = randomUUID(),
): Promise<ToolResult> {
  const cached = getToolCall(`${leadId}:${callId}`);
  if (cached) return cached as ToolResult;
  const lead = getLead(leadId, sessionSecret);
  if (!lead) return { success: false, message: "Сессия заявки недоступна." };

  let output: ToolResult;
  switch (toolName) {
    case "save_company_activity": {
      const activity = String(args.activity ?? "").trim();
      output = activity
        ? result(updateLead(leadId, sessionSecret, { companyActivity: activity })!, true, "Деятельность компании сохранена.")
        : result(lead, false, "Уточните, пожалуйста, чем занимается компания.");
      break;
    }
    case "save_discovery": {
      const update = {
        currentProcess: args.currentProcess ? String(args.currentProcess).trim() : lead.currentProcess,
        need: args.need ? String(args.need).trim() : lead.need,
        desiredResult: args.desiredResult ? String(args.desiredResult).trim() : lead.desiredResult,
      };
      output = result(updateLead(leadId, sessionSecret, update)!, true, "Потребность клиента сохранена.");
      break;
    }
    case "confirm_need_summary": {
      const confirmed = args.confirmed === true;
      output = result(updateLead(leadId, sessionSecret, { summaryConfirmed: confirmed })!, true, confirmed ? "Резюме подтверждено." : "Резюме требует уточнения.");
      break;
    }
    case "save_conversation_context": {
      const lastUserMessage = String(args.lastUserMessage ?? "").trim();
      output = result(
        updateLead(leadId, sessionSecret, {
          lastUserMessage: lastUserMessage || lead.lastUserMessage,
        })!,
        true,
        "Контекст разговора сохранён.",
      );
      break;
    }
    case "get_available_slots": {
      try {
        const cal = await getCalcomSlots();
        if (!cal.configured) output = result(lead, false, cal.reason);
        else {
          saveSlots(leadId, cal.slots);
          output = result(lead, true, cal.slots.length ? "Получены доступные слоты." : "Свободных слотов пока нет.", { slots: cal.slots });
        }
      } catch {
        output = result(lead, false, "Не удалось проверить календарь. Попробуйте запросить варианты чуть позже.");
      }
      break;
    }
    case "select_slot": {
      const slotId = typeof args.slot === "object" && args.slot ? (args.slot as { id?: string }).id : "";
      const slot = getSlots(leadId).find((item) => item.id === slotId);
      if (!slot) output = result(lead, false, "Выберите один из вариантов, возвращённых календарём.");
      else output = result(updateLead(leadId, sessionSecret, { selectedSlot: slot, bookingStatus: "selected" })!, true, "Время выбрано.", { booking: { status: "selected", slot, meetingUrl: null } });
      break;
    }
    case "save_contact": {
      const type = args.type as ContactType;
      const value = String(args.value ?? "").trim();
      const valid = type === "phone" ? value.replace(/\D/g, "").length >= 10 : type === "telegram" && /^@[A-Za-z0-9_]{4,}$/.test(value);
      if (!valid) output = result(lead, false, type === "phone" ? "Телефон должен содержать минимум 10 цифр." : "Telegram должен начинаться с @ и содержать минимум 5 символов.");
      else {
        const updated = updateLead(leadId, sessionSecret, {
          phone: type === "phone" ? value : lead.phone,
          telegram: type === "telegram" ? value : lead.telegram,
        })!;
        output = result(updated, true, "Контакт сохранён.");
      }
      break;
    }
    case "save_name": {
      const name = String(args.name ?? "").trim();
      output = name ? result(updateLead(leadId, sessionSecret, { name })!, true, "Имя сохранено.") : result(lead, false, "Укажите имя.");
      break;
    }
    case "save_work_email": {
      const email = String(args.email ?? "").trim().toLowerCase();
      output = emailPattern.test(email) ? result(updateLead(leadId, sessionSecret, { workEmail: email, stages: ["contacts_collected"] })!, true, "Рабочая почта сохранена.") : result(lead, false, "Укажите корректный адрес рабочей почты.");
      break;
    }
    case "confirm_booking": {
      const missing = [
        !lead.selectedSlot && "выбранное время",
        !lead.name && "имя",
        !lead.phone && !lead.telegram && "телефон или Telegram",
        !lead.workEmail && "рабочая почта",
        args.consent !== true && "явное согласие на запись",
      ].filter(Boolean) as string[];
      if (missing.length) {
        output = result(lead, false, `Для записи не хватает: ${missing.join(", ")}.`, { missing });
        break;
      }
      if (lead.bookingStatus === "confirmed") {
        output = result(lead, true, "Встреча уже подтверждена.", { booking: { status: lead.bookingStatus, slot: lead.selectedSlot, meetingUrl: lead.meetingUrl } });
        break;
      }
      const bookingLead = updateLead(leadId, sessionSecret, { bookingStatus: "booking", stages: ["booking_attempted"] })!;
      try {
        const refreshed = await getCalcomSlots();
        if (!refreshed.configured) {
          output = result(updateLead(leadId, sessionSecret, { bookingStatus: "pending_consent" })!, false, refreshed.reason);
          break;
        }
        if (!refreshed.slots.some((slot) => slot.id === bookingLead.selectedSlot?.id)) {
          saveSlots(leadId, refreshed.slots);
          output = result(updateLead(leadId, sessionSecret, { bookingStatus: "conflict" })!, false, "Выбранное время уже занято. Выберите другой вариант.", { slots: refreshed.slots });
          break;
        }
        const booking = await createCalcomBooking(bookingLead);
        if (!booking.configured) {
          output = result(updateLead(leadId, sessionSecret, { bookingStatus: "pending_consent" })!, false, "Интеграция календаря пока не настроена. Запись не создана.");
        } else if (booking.conflict) {
          output = result(updateLead(leadId, sessionSecret, { bookingStatus: "conflict" })!, false, "Это время уже занято. Запросите два других варианта.");
        } else {
          let updated = updateLead(leadId, sessionSecret, {
            bookingStatus: "confirmed", bookingId: booking.bookingId, meetingUrl: booking.meetingUrl,
            notificationStatus: "pending",
            stages: ["booking_confirmed"],
          })!;
          enqueueNotification(leadId);
          updated = (await notifyManagerImmediately(leadId, sessionSecret)) ?? updated;
          output = result(updated, true, "Встреча назначена.", { booking: { status: "confirmed", slot: updated.selectedSlot, meetingUrl: updated.meetingUrl } });
        }
      } catch {
        output = result(updateLead(leadId, sessionSecret, { bookingStatus: "failed" })!, false, "Не удалось подтвердить запись. Повторите позже.");
      }
      break;
    }
    case "save_qualification": {
      const updated = updateLead(leadId, sessionSecret, {
        leadsPerMonth: args.leadsPerMonth ? String(args.leadsPerMonth) : lead.leadsPerMonth,
        salesManagersCount: args.salesManagersCount ? String(args.salesManagersCount) : lead.salesManagersCount,
      })!;
      output = result(updated, true, updated.leadsPerMonth && updated.salesManagersCount
        ? "Квалификация завершена. Можно завершить разговор."
        : "Часть квалификационных данных сохранена. Спросите только недостающий показатель.");
      break;
    }
    default:
      output = result(lead, false, "Неизвестная операция.");
  }
  if (output.lead) {
    const current = getLead(leadId, sessionSecret);
    if (current && !(await persistLead(current)) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return { success: false, message: "Не удалось сохранить изменения. Попробуйте ещё раз." };
    }
  }
  saveToolCall(`${leadId}:${callId}`, output);
  return output;
}
