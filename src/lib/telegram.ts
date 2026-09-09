import "server-only";

import type { Lead } from "@/lib/lead-types";

export function telegramMessage(lead: Lead) {
  const contact = lead.phone ?? lead.telegram ?? "не уточнено";
  const slot = lead.selectedSlot ? `${lead.selectedSlot.label}, МСК` : "не уточнено";
  return [
    "Новая запись",
    `Имя: ${lead.name ?? "не уточнено"}`,
    `Компания / деятельность: ${lead.companyActivity ?? "не уточнено"}`,
    `Запрос клиента: ${lead.need ?? "не уточнено"}`,
    `Желаемый результат: ${lead.desiredResult ?? "не уточнено"}`,
    `Телефон / Telegram: ${contact}`,
    `Email: ${lead.workEmail ?? "не уточнено"}`,
    `Встреча: ${slot}`,
    `Заявок в месяц: ${lead.leadsPerMonth ?? "не уточнено"}`,
    `Менеджеров: ${lead.salesManagersCount ?? "не уточнено"}`,
    `ID заявки: ${lead.id}`,
    `Ссылка на встречу: ${lead.meetingUrl ?? "ещё не получена"}`,
  ].join("\n");
}

export async function notifyTelegram(lead: Lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_MANAGER_CHAT_ID;
  if (!token || !chatId) return { configured: false as const };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: telegramMessage(lead) }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Telegram notification failed");
  const json = (await response.json()) as { result?: { message_id?: number } };
  return { configured: true as const, messageId: String(json.result?.message_id ?? "") };
}
