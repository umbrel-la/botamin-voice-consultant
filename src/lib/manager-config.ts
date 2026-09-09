export const SALES_MANAGER_CONFIG = {
  business: {
    name: "Botamin",
    service: "консультация по внедрению ИИ в продажи",
    meetingDurationMinutes: 20,
    allowedFacts: [
      "На консультации эксперт разбирает текущий процесс обработки обращений и возможные сценарии применения ИИ в продажах.",
      "Консультация длится 20 минут.",
    ],
  },
  qualification: {
    discoveryQuestions: [
      "Как сейчас обрабатываются обращения?",
      "Что в этом процессе хотелось бы улучшить?",
      "Какой результат вы хотите получить?",
    ],
    optionalMetrics: ["leadsPerMonth", "salesManagersCount"] as const,
  },
  requiredContacts: ["name", "phoneOrTelegram", "workEmail"] as const,
  schedule: {
    timeZone: "Europe/Moscow",
    durationMinutes: 20,
    weekdays: [1, 2, 3, 4, 5],
    startHour: 9,
    latestStartHour: 17,
    daysToSearch: 21,
  },
  integrations: {
    calcom: {
      username: process.env.CALCOM_USERNAME || "diego-bolt-zdsas2",
      eventTypeSlug: process.env.CALCOM_EVENT_TYPE_SLUG || "consultation",
    },
  },
} as const;

export const REQUIRED_INTEGRATION_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CALCOM_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_MANAGER_CHAT_ID",
] as const;

export function missingIntegrationEnv() {
  return REQUIRED_INTEGRATION_ENV.filter((name) => !process.env[name]);
}
