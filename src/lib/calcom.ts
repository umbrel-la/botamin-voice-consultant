import "server-only";

import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { addDays, getDay } from "date-fns";
import { ru } from "date-fns/locale";
import { SALES_MANAGER_CONFIG } from "@/lib/manager-config";
import type { Slot } from "@/lib/lead-types";
import type { Lead } from "@/lib/lead-types";

const CAL_API = "https://api.cal.com/v2";
const zone = SALES_MANAGER_CONFIG.schedule.timeZone;

function validSlot(start: Date, end: Date) {
  const local = toZonedTime(start, zone);
  const day = getDay(local);
  const hour = local.getHours();
  return (
    SALES_MANAGER_CONFIG.schedule.weekdays.includes(day as 1 | 2 | 3 | 4 | 5) &&
    hour >= SALES_MANAGER_CONFIG.schedule.startHour &&
    hour <= SALES_MANAGER_CONFIG.schedule.latestStartHour &&
    end.getTime() - start.getTime() >= SALES_MANAGER_CONFIG.schedule.durationMinutes * 60_000
  );
}

function toSlot(start: string, end: string): Slot {
  const startDate = new Date(start);
  const text = formatInTimeZone(startDate, zone, "EEEE, d MMMM 'в' HH:mm", {
    locale: ru,
  });
  return {
    id: `${startDate.toISOString()}_${end}`,
    startAtUtc: startDate.toISOString(),
    endAtUtc: new Date(end).toISOString(),
    label: text.charAt(0).toUpperCase() + text.slice(1),
    date: formatInTimeZone(startDate, zone, "yyyy-MM-dd"),
    time: formatInTimeZone(startDate, zone, "HH:mm"),
    timeZone: zone,
    durationMinutes: SALES_MANAGER_CONFIG.schedule.durationMinutes,
  };
}

export async function getCalcomSlots(): Promise<
  { configured: true; slots: Slot[] } | { configured: false; reason: string }
> {
  const apiKey = process.env.CALCOM_API_KEY;
  if (!apiKey) return { configured: false, reason: "Календарная интеграция не настроена." };

  const now = new Date();
  const tomorrow = addDays(toZonedTime(now, zone), 1);
  const start = formatInTimeZone(tomorrow, zone, "yyyy-MM-dd");
  const end = formatInTimeZone(
    addDays(tomorrow, SALES_MANAGER_CONFIG.schedule.daysToSearch),
    zone,
    "yyyy-MM-dd",
  );
  const params = new URLSearchParams({
    username: SALES_MANAGER_CONFIG.integrations.calcom.username,
    eventTypeSlug: SALES_MANAGER_CONFIG.integrations.calcom.eventTypeSlug,
    start,
    end,
    timeZone: zone,
    format: "range",
  });
  const response = await fetch(`${CAL_API}/slots?${params}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "cal-api-version": "2024-09-04",
    },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Календарь временно недоступен.");
  const json = (await response.json()) as {
    data?: Record<string, Array<{ start: string; end: string }>>;
  };
  const slots = Object.values(json.data ?? {})
    .flat()
    .map(({ start, end: slotEnd }) => ({ start: new Date(start), end: new Date(slotEnd), rawStart: start, rawEnd: slotEnd }))
    .filter(({ start: slotStart, end: slotEnd }) => validSlot(slotStart, slotEnd))
    .slice(0, 2)
    .map(({ rawStart, rawEnd }) => toSlot(rawStart, rawEnd));
  return { configured: true, slots };
}

export async function createCalcomBooking(lead: Lead) {
  const apiKey = process.env.CALCOM_API_KEY;
  if (!apiKey || !lead.selectedSlot || !lead.name || !lead.workEmail) {
    return { configured: false as const };
  }
  const response = await fetch(`${CAL_API}/bookings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "cal-api-version": "2026-02-25",
      "Idempotency-Key": `botamin-${lead.id}-${lead.selectedSlot.startAtUtc}`,
    },
    body: JSON.stringify({
      start: lead.selectedSlot.startAtUtc,
      eventTypeSlug: SALES_MANAGER_CONFIG.integrations.calcom.eventTypeSlug,
      username: SALES_MANAGER_CONFIG.integrations.calcom.username,
      attendee: {
        name: lead.name,
        email: lead.workEmail,
        timeZone: zone,
        language: "ru",
        ...(lead.phone ? { phoneNumber: lead.phone } : {}),
      },
    }),
    cache: "no-store",
  });
  if (response.status === 409 || response.status === 422) return { configured: true as const, conflict: true as const };
  if (!response.ok) throw new Error("Не удалось создать бронирование.");
  const data = (await response.json()) as { data?: { uid?: string; meetingUrl?: string; metadata?: { videoCallUrl?: string } } };
  return { configured: true as const, conflict: false as const, bookingId: data.data?.uid ?? null, meetingUrl: data.data?.meetingUrl ?? data.data?.metadata?.videoCallUrl ?? null };
}
