import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase-rest";
import { hashSessionSecret } from "@/lib/session-secret";
import { STORE_RETRY_MESSAGE } from "@/lib/store-errors";
import type { Slot } from "@/lib/lead-types";

const slots: Slot[] = [
  {
    id: "slot-a",
    startAtUtc: "2026-09-16T07:00:00.000Z",
    endAtUtc: "2026-09-16T07:20:00.000Z",
    label: "Вторник, 16 сентября в 10:00",
    date: "2026-09-16",
    time: "10:00",
    timeZone: "Europe/Moscow",
    durationMinutes: 20,
  },
  {
    id: "slot-b",
    startAtUtc: "2026-09-16T11:00:00.000Z",
    endAtUtc: "2026-09-16T11:20:00.000Z",
    label: "Вторник, 16 сентября в 14:00",
    date: "2026-09-16",
    time: "14:00",
    timeZone: "Europe/Moscow",
    durationMinutes: 20,
  },
];

const { getCalcomSlots, createCalcomBooking } = vi.hoisted(() => ({
  getCalcomSlots: vi.fn(),
  createCalcomBooking: vi.fn(),
}));

vi.mock("@/lib/calcom", () => ({
  getCalcomSlots,
  createCalcomBooking,
}));

import {
  createLead,
  getLead,
  isolateServerlessInstanceForTests,
} from "@/lib/lead-store";
import { runLeadTool } from "@/lib/lead-tools";

describe("serverless lead session", () => {
  let fake: ReturnType<typeof createFakeSupabase>;

  beforeEach(() => {
    fake = createFakeSupabase();
    vi.stubEnv("SUPABASE_URL", "https://fake.supabase.test");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role");
    vi.stubGlobal("fetch", fake.fetch);
    getCalcomSlots.mockReset().mockResolvedValue({ configured: true, slots });
    createCalcomBooking.mockReset().mockImplementation(async () => {
      throw new Error("Cal.com booking must not be created in automated checks");
    });
    isolateServerlessInstanceForTests();
  });

  afterEach(() => {
    isolateServerlessInstanceForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function nextInstance(leadId: string, secret: string) {
    isolateServerlessInstanceForTests();
    const restored = await getLead(leadId, secret);
    expect(restored).not.toBeNull();
    return restored!;
  }

  it("restores the lead from Supabase on every independent request and keeps contacts from one utterance", async () => {
    const created = await createLead();
    const cookie = { leadId: created.id, secret: created.sessionSecret };
    const stored = fake.db.leads.get(created.id);

    expect(stored?.session_hash).toBe(hashSessionSecret(created.sessionSecret));
    expect(stored?.session_hash).not.toBe(created.sessionSecret);
    await nextInstance(cookie.leadId, cookie.secret);

    const activity = await runLeadTool(cookie.leadId, cookie.secret, "save_company_activity", {
      activity: "школа английского",
    }, "call-activity-1");
    expect(activity.success).toBe(true);
    await nextInstance(cookie.leadId, cookie.secret);

    const corrected = await runLeadTool(cookie.leadId, cookie.secret, "save_company_activity", {
      activity: "онлайн-школа испанского",
    }, "call-activity-2");
    expect(corrected.lead?.companyActivity).toBe("онлайн-школа испанского");
    await nextInstance(cookie.leadId, cookie.secret);

    const discovery = await runLeadTool(cookie.leadId, cookie.secret, "save_discovery", {
      currentProcess: "менеджеры отвечают вручную",
      need: "быстрее квалифицировать заявки",
      desiredResult: "ИИ обрабатывает первую линию",
    }, "call-discovery");
    expect(discovery.success).toBe(true);
    await nextInstance(cookie.leadId, cookie.secret);

    const offered = await runLeadTool(cookie.leadId, cookie.secret, "get_available_slots", {}, "call-slots");
    expect(offered.success).toBe(true);
    expect(offered.slots).toHaveLength(2);
    await nextInstance(cookie.leadId, cookie.secret);

    const replayedSlots = await runLeadTool(cookie.leadId, cookie.secret, "get_available_slots", {}, "call-slots");
    expect(replayedSlots.slots).toEqual(offered.slots);
    expect(getCalcomSlots).toHaveBeenCalledTimes(1);

    const selected = await runLeadTool(cookie.leadId, cookie.secret, "select_slot", {
      slot: slots[0],
    }, "call-select");
    expect(selected.success).toBe(true);
    expect(selected.lead?.selectedSlot?.id).toBe("slot-a");
    await nextInstance(cookie.leadId, cookie.secret);

    const name = await runLeadTool(cookie.leadId, cookie.secret, "save_name", { name: "Анна" }, "call-name");
    const phone = await runLeadTool(cookie.leadId, cookie.secret, "save_contact", {
      type: "phone",
      value: "+7 999 123-45-67",
    }, "call-phone");
    const email = await runLeadTool(cookie.leadId, cookie.secret, "save_work_email", {
      email: "anna@company.ru",
    }, "call-email");

    expect(name.success && phone.success && email.success).toBe(true);
    const afterContacts = await nextInstance(cookie.leadId, cookie.secret);
    expect(afterContacts).toMatchObject({
      companyActivity: "онлайн-школа испанского",
      need: "быстрее квалифицировать заявки",
      name: "Анна",
      phone: "+7 999 123-45-67",
      workEmail: "anna@company.ru",
      selectedSlot: expect.objectContaining({ id: "slot-a" }),
    });

    const invalidEmail = await runLeadTool(cookie.leadId, cookie.secret, "save_work_email", {
      email: "not-an-email",
    }, "call-invalid-email");
    expect(invalidEmail.success).toBe(false);
    expect(invalidEmail.message).toContain("почты");
    const stillIntact = await nextInstance(cookie.leadId, cookie.secret);
    expect(stillIntact.name).toBe("Анна");
    expect(stillIntact.workEmail).toBe("anna@company.ru");

    const replayedName = await runLeadTool(cookie.leadId, cookie.secret, "save_name", { name: "Мария" }, "call-name");
    expect(replayedName.lead?.name).toBe("Анна");
    expect(createCalcomBooking).not.toHaveBeenCalled();
  });

  it("returns a retryable store error without discarding the lead", async () => {
    const created = await createLead();
    vi.stubGlobal("fetch", async () => {
      throw new Error("supabase offline");
    });
    isolateServerlessInstanceForTests();
    const result = await runLeadTool(created.id, created.sessionSecret, "save_name", { name: "Анна" }, "call-offline");
    expect(result.success).toBe(false);
    expect(result.message).toBe(STORE_RETRY_MESSAGE);
    expect(result.message).not.toMatch(/заново/);

    vi.stubGlobal("fetch", fake.fetch);
    const restored = await nextInstance(created.id, created.sessionSecret);
    expect(restored.id).toBe(created.id);
    expect(restored.name).toBeNull();
  });
});
