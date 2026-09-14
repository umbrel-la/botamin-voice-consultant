import "server-only";

import { randomUUID } from "crypto";
import { createCalcomBooking, getCalcomSlots } from "@/lib/calcom";
import {
  enqueueNotification,
  finishNotification,
  getLead,
  getSlots,
  getToolCall,
  saveSlots,
  saveToolCall,
  startNotificationAttempt,
  toPublicLead,
  updateLead,
  withLeadLock,
} from "@/lib/lead-store";
import { STORE_RETRY_MESSAGE, StoreUnavailableError } from "@/lib/store-errors";
import { notifyTelegram } from "@/lib/telegram";
import type { ContactType, Lead, ToolResult } from "@/lib/lead-types";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function result(lead: Lead, success: boolean, message: string, extra: Omit<ToolResult, "success" | "message" | "lead"> = {}): ToolResult {
  return { success, message, lead: toPublicLead(lead), ...extra };
}

async function notifyManagerImmediately(leadId: string, sessionSecret: string) {
  const lead = await getLead(leadId, sessionSecret);
  if (!lead) return null;

  await startNotificationAttempt(leadId);
  try {
    const delivery = await notifyTelegram(lead);
    if (!delivery.configured) {
      await finishNotification(leadId, "not_configured", { lastError: null, messageId: null });
      return updateLead(leadId, sessionSecret, { notificationStatus: "not_configured" });
    }
    await finishNotification(leadId, "sent", { lastError: null, messageId: delivery.messageId });
    return updateLead(leadId, sessionSecret, { notificationStatus: "sent" });
  } catch (error) {
    const lastError = error instanceof Error ? error.message : "Telegram notification failed";
    await finishNotification(leadId, "failed", { lastError, messageId: null });
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
  return withLeadLock(leadId, async () => {
    try {
      const cached = await getToolCall(leadId, callId);
      if (cached) return cached as ToolResult;
      const lead = await getLead(leadId, sessionSecret);
      if (!lead) return { success: false, message: STORE_RETRY_MESSAGE };

      let output: ToolResult;
      switch (toolName) {
        case "save_company_activity": {
          const activity = String(args.activity ?? "").trim();
          output = activity
            ? result((await updateLead(leadId, sessionSecret, { companyActivity: activity }))!, true, "Деятельность компании сохранена.")
            : result(lead, false, "Уточните, пожалуйста, чем занимается компания.");
          break;
        }
        case "save_discovery": {
          const update = {
            currentProcess: args.currentProcess ? String(args.currentProcess).trim() : undefined,
            need: args.need ? String(args.need).trim() : undefined,
            desiredResult: args.desiredResult ? String(args.desiredResult).trim() : undefined,
          };
          output = result((await updateLead(leadId, sessionSecret, update))!, true, "Потребность клиента сохранена.");
          break;
        }
        case "confirm_need_summary": {
          const confirmed = args.confirmed === true;
          output = result((await updateLead(leadId, sessionSecret, { summaryConfirmed: confirmed }))!, true, confirmed ? "Резюме подтверждено." : "Резюме требует уточнения.");
          break;
        }
        case "save_conversation_context": {
          const lastUserMessage = String(args.lastUserMessage ?? "").trim();
          output = result(
            lastUserMessage
              ? (await updateLead(leadId, sessionSecret, { lastUserMessage }))!
              : lead,
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
              await saveSlots(leadId, sessionSecret, cal.slots);
              const latest = (await getLead(leadId, sessionSecret)) ?? lead;
              output = result(latest, true, cal.slots.length ? "Получены доступные слоты." : "Свободных слотов пока нет.", { slots: cal.slots });
            }
          } catch {
            output = result(lead, false, "Не удалось проверить календарь. Попробуйте запросить варианты чуть позже.");
          }
          break;
        }
        case "select_slot": {
          const slotId = typeof args.slot === "object" && args.slot ? (args.slot as { id?: string }).id : "";
          const slot = (await getSlots(leadId, sessionSecret)).find((item) => item.id === slotId);
          if (!slot) output = result(lead, false, "Выберите один из вариантов, возвращённых календарём.");
          else {
            const updated = (await updateLead(leadId, sessionSecret, { selectedSlot: slot, bookingStatus: "selected" }))!;
            output = result(updated, true, "Время выбрано.", { booking: { status: "selected", slot, meetingUrl: null } });
          }
          break;
        }
        case "save_contact": {
          const type = args.type as ContactType;
          const value = String(args.value ?? "").trim();
          const valid = type === "phone" ? value.replace(/\D/g, "").length >= 10 : type === "telegram" && /^@[A-Za-z0-9_]{4,}$/.test(value);
          if (!valid) output = result(lead, false, type === "phone" ? "Телефон должен содержать минимум 10 цифр." : "Telegram должен начинаться с @ и содержать минимум 5 символов.");
          else {
            const updated = (await updateLead(leadId, sessionSecret, {
              phone: type === "phone" ? value : undefined,
              telegram: type === "telegram" ? value : undefined,
            }))!;
            output = result(updated, true, "Контакт сохранён.");
          }
          break;
        }
        case "save_name": {
          const name = String(args.name ?? "").trim();
          output = name
            ? result((await updateLead(leadId, sessionSecret, { name }))!, true, "Имя сохранено.")
            : result(lead, false, "Укажите имя.");
          break;
        }
        case "save_work_email": {
          const email = String(args.email ?? "").trim().toLowerCase();
          output = emailPattern.test(email)
            ? result((await updateLead(leadId, sessionSecret, { workEmail: email, stages: ["contacts_collected"] }))!, true, "Рабочая почта сохранена.")
            : result(lead, false, "Укажите корректный адрес рабочей почты.");
          break;
        }
        case "confirm_booking": {
          const latest = (await getLead(leadId, sessionSecret)) ?? lead;
          const missing = [
            !latest.selectedSlot && "выбранное время",
            !latest.name && "имя",
            !latest.phone && !latest.telegram && "телефон или Telegram",
            !latest.workEmail && "рабочая почта",
            args.consent !== true && "явное согласие на запись",
          ].filter(Boolean) as string[];
          if (missing.length) {
            output = result(latest, false, `Для записи не хватает: ${missing.join(", ")}.`, { missing });
            break;
          }
          if (latest.bookingStatus === "confirmed") {
            output = result(latest, true, "Встреча уже подтверждена.", { booking: { status: latest.bookingStatus, slot: latest.selectedSlot, meetingUrl: latest.meetingUrl } });
            break;
          }
          const bookingLead = (await updateLead(leadId, sessionSecret, { bookingStatus: "booking", stages: ["booking_attempted"] }))!;
          try {
            const refreshed = await getCalcomSlots();
            if (!refreshed.configured) {
              output = result((await updateLead(leadId, sessionSecret, { bookingStatus: "pending_consent" }))!, false, refreshed.reason);
              break;
            }
            if (!refreshed.slots.some((slot) => slot.id === bookingLead.selectedSlot?.id)) {
              await saveSlots(leadId, sessionSecret, refreshed.slots);
              output = result((await updateLead(leadId, sessionSecret, { bookingStatus: "conflict" }))!, false, "Выбранное время уже занято. Выберите другой вариант.", { slots: refreshed.slots });
              break;
            }
            const booking = await createCalcomBooking(bookingLead);
            if (!booking.configured) {
              output = result((await updateLead(leadId, sessionSecret, { bookingStatus: "pending_consent" }))!, false, "Интеграция календаря пока не настроена. Запись не создана.");
            } else if (booking.conflict) {
              output = result((await updateLead(leadId, sessionSecret, { bookingStatus: "conflict" }))!, false, "Это время уже занято. Запросите два других варианта.");
            } else if (!booking.bookingId) {
              output = result((await updateLead(leadId, sessionSecret, { bookingStatus: "failed" }))!, false, STORE_RETRY_MESSAGE);
            } else {
              let updated = (await updateLead(leadId, sessionSecret, {
                bookingStatus: "confirmed", bookingId: booking.bookingId, meetingUrl: booking.meetingUrl,
                notificationStatus: "pending",
                stages: ["booking_confirmed"],
              }))!;
              await enqueueNotification(leadId);
              updated = (await notifyManagerImmediately(leadId, sessionSecret)) ?? updated;
              output = result(updated, true, "Встреча назначена.", { booking: { status: "confirmed", slot: updated.selectedSlot, meetingUrl: updated.meetingUrl } });
            }
          } catch {
            output = result((await updateLead(leadId, sessionSecret, { bookingStatus: "failed" }))!, false, "Не удалось подтвердить запись. Повторите позже.");
          }
          break;
        }
        case "save_qualification": {
          const updated = (await updateLead(leadId, sessionSecret, {
            leadsPerMonth: args.leadsPerMonth ? String(args.leadsPerMonth) : undefined,
            salesManagersCount: args.salesManagersCount ? String(args.salesManagersCount) : undefined,
          }))!;
          output = result(updated, true, updated.leadsPerMonth && updated.salesManagersCount
            ? "Квалификация завершена. Можно завершить разговор."
            : "Часть квалификационных данных сохранена. Спросите только недостающий показатель.");
          break;
        }
        default:
          output = result(lead, false, "Неизвестная операция.");
      }
      const stored = await saveToolCall(leadId, callId, output);
      return (stored as ToolResult) ?? output;
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        return { success: false, message: STORE_RETRY_MESSAGE };
      }
      throw error;
    }
  });
}
