import { describe, expect, it } from "vitest";
import { buildConversationSummary, buildRealtimeResumeInstructions } from "./resume-context";
import type { Lead } from "./lead-types";

const lead: Lead = {
  id: "lead-1", sessionSecret: "secret", name: null,
  companyActivity: "Интернет-магазин мебели", currentProcess: null,
  need: "Хотим быстрее отвечать на обращения", desiredResult: null,
  summaryConfirmed: null, phone: null, telegram: null, workEmail: null,
  leadsPerMonth: null, salesManagersCount: null, selectedSlot: null,
  bookingStatus: "none", bookingId: null, meetingUrl: null,
  notificationStatus: "not_configured",
  lastUserMessage: "Нам важно сократить время первого ответа",
  conversationSummary: "", createdAt: "", updatedAt: "",
  stages: ["conversation_started"],
};

describe("Realtime resume context", () => {
  it("continues from saved lead data without restarting the discovery", () => {
    const summary = buildConversationSummary(lead);
    const instructions = buildRealtimeResumeInstructions("BASE", {
      ...lead,
      conversationSummary: summary,
    });

    expect(instructions).toContain("Не здоровайся заново");
    expect(instructions).toContain(lead.companyActivity);
    expect(instructions).toContain(lead.lastUserMessage);
  });
});
