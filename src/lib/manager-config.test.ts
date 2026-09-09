import { describe, expect, it } from "vitest";
import { SALES_MANAGER_CONFIG } from "./manager-config";

describe("sales manager defaults", () => {
  it("keeps the meeting inside the configured Moscow working window", () => {
    expect(SALES_MANAGER_CONFIG.schedule.timeZone).toBe("Europe/Moscow");
    expect(SALES_MANAGER_CONFIG.schedule.startHour).toBe(9);
    expect(SALES_MANAGER_CONFIG.schedule.latestStartHour).toBe(17);
    expect(SALES_MANAGER_CONFIG.schedule.durationMinutes).toBe(20);
  });

  it("requires three server-validated contact fields", () => {
    expect(SALES_MANAGER_CONFIG.requiredContacts).toEqual([
      "name",
      "phoneOrTelegram",
      "workEmail",
    ]);
  });
});
