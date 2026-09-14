import type { Lead } from "@/lib/lead-types";

export function buildConversationSummary(lead: Lead) {
  const parts = [
    lead.companyActivity && `Компания: ${lead.companyActivity}.`,
    lead.currentProcess && `Текущий процесс: ${lead.currentProcess}.`,
    lead.need && `Потребность: ${lead.need}.`,
    lead.desiredResult && `Желаемый результат: ${lead.desiredResult}.`,
    lead.selectedSlot && `Выбран слот: ${lead.selectedSlot.label} МСК.`,
    lead.bookingStatus === "confirmed" && "Встреча подтверждена.",
  ].filter(Boolean);
  return parts.join(" ") || "Диалог начат, данные о компании ещё не получены.";
}

export function buildRealtimeResumeInstructions(systemPrompt: string, lead: Lead) {
  return `${systemPrompt}

Это новая техническая Realtime-сессия внутри уже начатого диалога. Не здоровайся заново, не упоминай переподключение и не повторяй уже заданные вопросы. Продолжай с единственного следующего логичного шага по данным сервера.
Состояние лида:
- Этапы: ${lead.stages.join(", ")}.
- Краткое резюме: ${lead.conversationSummary}
- Последняя реплика клиента: ${lead.lastUserMessage ?? "нет"}.
- Выбранный слот: ${lead.selectedSlot?.label ?? "нет"}.
- Имя: ${lead.name ? "получено" : "не получено"}; контакт: ${lead.phone || lead.telegram ? "получен" : "не получен"}; рабочая почта: ${lead.workEmail ? "получена" : "не получена"}.
- Статус бронирования: ${lead.bookingStatus}.
`.trim();
}
