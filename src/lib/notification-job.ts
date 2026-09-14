import type { NotificationJob, NotificationJobStatus } from "./lead-types";

export function createNotificationJob(leadId: string, now = new Date()): NotificationJob {
  const timestamp = now.toISOString();
  return {
    leadId,
    status: "pending",
    attempts: 0,
    lastError: null,
    messageId: null,
    nextAttemptAt: timestamp,
    updatedAt: timestamp,
  };
}

export function startNotificationJobAttempt(job: NotificationJob, now = new Date()): NotificationJob {
  return {
    ...job,
    status: "pending",
    attempts: job.attempts + 1,
    lastError: null,
    updatedAt: now.toISOString(),
  };
}

export function finishNotificationJob(
  job: NotificationJob,
  status: NotificationJobStatus,
  details: Pick<NotificationJob, "lastError" | "messageId">,
  now = new Date(),
): NotificationJob {
  return {
    ...job,
    status,
    ...details,
    nextAttemptAt: status === "failed" ? new Date(now.getTime() + 5 * 60_000).toISOString() : null,
    updatedAt: now.toISOString(),
  };
}
