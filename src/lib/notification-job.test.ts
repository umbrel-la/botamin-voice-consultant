import { describe, expect, it } from "vitest";
import {
  createNotificationJob,
  finishNotificationJob,
  startNotificationJobAttempt,
} from "./notification-job";

describe("notification jobs", () => {
  it("tracks immediate delivery attempts and retryable failures", () => {
    const now = new Date("2026-09-11T12:00:00.000Z");
    const started = startNotificationJobAttempt(createNotificationJob("lead-1", now), now);
    const failed = finishNotificationJob(
      started,
      "failed",
      { lastError: "Telegram notification failed", messageId: null },
      now,
    );

    expect(failed).toMatchObject({
      leadId: "lead-1",
      status: "failed",
      attempts: 1,
      lastError: "Telegram notification failed",
    });
    expect(failed.nextAttemptAt).toBe("2026-09-11T12:05:00.000Z");
  });
});
