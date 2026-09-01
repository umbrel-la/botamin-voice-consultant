import { addDays, getDay } from "date-fns";
import { ru } from "date-fns/locale";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

export const MOSCOW_TIME_ZONE = "Europe/Moscow";

export type ContactType = "phone" | "telegram";

export type Slot = {
  id: string;
  iso: string;
  label: string;
  date: string;
  time: string;
  timeZone: typeof MOSCOW_TIME_ZONE;
  durationMinutes: 20;
};

export type SessionState = {
  companyActivity: string | null;
  availableSlots: Slot[];
  selectedSlot: Slot | null;
  contact: { type: ContactType; value: string } | null;
  workEmail: string | null;
  bookingConfirmed: boolean;
  qualification: {
    leadsPerMonth: string;
    salesManagersCount: string;
  } | null;
};

export type ToolResult = {
  success: boolean;
  message: string;
  missing?: string[];
  slots?: Slot[];
  booking?: {
    slot: Slot;
    contact: { type: ContactType; value: string };
    workEmail: string;
    status: "Встреча подтверждена";
  };
};

export const createInitialSessionState = (): SessionState => ({
  companyActivity: null,
  availableSlots: [],
  selectedSlot: null,
  contact: null,
  workEmail: null,
  bookingConfirmed: false,
  qualification: null,
});

function isWeekday(date: Date) {
  const day = getDay(date);
  return day >= 1 && day <= 5;
}

function nextBusinessDays(now = new Date(), count = 2) {
  const days: Date[] = [];
  let candidate = addDays(toZonedTime(now, MOSCOW_TIME_ZONE), 1);

  while (days.length < count) {
    if (isWeekday(candidate)) days.push(candidate);
    candidate = addDays(candidate, 1);
  }

  return days;
}

function makeSlot(day: Date, hour: 11 | 15): Slot {
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  const time = `${String(hour).padStart(2, "0")}:00`;
  const instant = fromZonedTime(`${date}T${time}:00`, MOSCOW_TIME_ZONE);
  const rawLabel = formatInTimeZone(
    instant,
    MOSCOW_TIME_ZONE,
    "EEEE, d MMMM 'в' HH:mm",
    { locale: ru },
  );

  return {
    id: `${date}_${time.replace(":", "-")}`,
    iso: instant.toISOString(),
    label: rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1),
    date,
    time,
    timeZone: MOSCOW_TIME_ZONE,
    durationMinutes: 20,
  };
}

export function saveCompanyActivity(
  state: SessionState,
  activity: string,
): [SessionState, ToolResult] {
  const value = activity.trim();
  if (!value) {
    return [state, { success: false, message: "Не указана деятельность компании." }];
  }
  return [
    { ...state, companyActivity: value },
    { success: true, message: "Деятельность компании сохранена." },
  ];
}

export function getAvailableSlots(
  state: SessionState,
  now = new Date(),
): [SessionState, ToolResult] {
  const [firstDay, secondDay] = nextBusinessDays(now, 2);
  const slots = [makeSlot(firstDay, 11), makeSlot(secondDay, 15)];
  return [
    {
      ...state,
      availableSlots: slots,
      selectedSlot: null,
      bookingConfirmed: false,
    },
    {
      success: true,
      message: "Доступны ровно два слота по Москве.",
      slots,
    },
  ];
}

export function selectSlot(
  state: SessionState,
  slotId: string,
): [SessionState, ToolResult] {
  const slot = state.availableSlots.find((item) => item.id === slotId);
  if (!slot) {
    return [
      state,
      {
        success: false,
        message:
          "Этот слот недоступен. Снова вызовите get_available_slots и предложите два полученных варианта.",
      },
    ];
  }
  return [
    { ...state, selectedSlot: slot, bookingConfirmed: false },
    { success: true, message: `Выбран слот: ${slot.label} по Москве.` },
  ];
}

export function saveContact(
  state: SessionState,
  type: ContactType,
  value: string,
): [SessionState, ToolResult] {
  const normalized = value.trim();
  const valid =
    type === "phone"
      ? normalized.replace(/\D/g, "").length >= 10
      : /^@[A-Za-z0-9_]{4,}$/.test(normalized);

  if (!valid) {
    return [
      state,
      {
        success: false,
        message:
          type === "phone"
            ? "Телефон должен содержать минимум 10 цифр."
            : "Telegram должен начинаться с @ и содержать минимум 5 символов.",
      },
    ];
  }

  return [
    { ...state, contact: { type, value: normalized }, bookingConfirmed: false },
    { success: true, message: `${type === "phone" ? "Телефон" : "Telegram"} сохранён.` },
  ];
}

export function saveWorkEmail(
  state: SessionState,
  email: string,
): [SessionState, ToolResult] {
  const normalized = email.trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized);
  if (!valid) {
    return [
      state,
      { success: false, message: "Укажите корректный адрес рабочей почты." },
    ];
  }
  return [
    { ...state, workEmail: normalized, bookingConfirmed: false },
    { success: true, message: "Рабочая почта сохранена." },
  ];
}

export function confirmBooking(
  state: SessionState,
): [SessionState, ToolResult] {
  const missing: string[] = [];
  if (!state.selectedSlot) missing.push("выбранный слот");
  if (!state.contact) missing.push("телефон или Telegram");
  if (!state.workEmail) missing.push("рабочая почта");

  if (missing.length || !state.selectedSlot || !state.contact || !state.workEmail) {
    return [
      state,
      {
        success: false,
        message: `Бронь не подтверждена. Не хватает: ${missing.join(", ")}.`,
        missing,
      },
    ];
  }

  const nextState = { ...state, bookingConfirmed: true };
  return [
    nextState,
    {
      success: true,
      message: "Встреча подтверждена. Календарная интеграция не выполнялась.",
      booking: {
        slot: state.selectedSlot,
        contact: state.contact,
        workEmail: state.workEmail,
        status: "Встреча подтверждена",
      },
    },
  ];
}

export function saveQualification(
  state: SessionState,
  leadsPerMonth: string,
  salesManagersCount: string,
): [SessionState, ToolResult] {
  if (!state.bookingConfirmed) {
    return [
      state,
      {
        success: false,
        message: "Сначала нужно успешно подтвердить встречу.",
      },
    ];
  }
  if (!leadsPerMonth.trim() || !salesManagersCount.trim()) {
    return [
      state,
      {
        success: false,
        message: "Нужны обе метрики: заявки в месяц и число менеджеров.",
      },
    ];
  }
  return [
    {
      ...state,
      qualification: {
        leadsPerMonth: leadsPerMonth.trim(),
        salesManagersCount: salesManagersCount.trim(),
      },
    },
    { success: true, message: "Квалификационные данные сохранены." },
  ];
}

export function maskSensitiveText(text: string) {
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, "***@***.***")
    .replace(/@[A-Za-z0-9_]{4,}/g, "@***")
    .replace(/(?:\+?\d[\s().-]*){10,}/g, "+* (***) ***-**-**");
}
