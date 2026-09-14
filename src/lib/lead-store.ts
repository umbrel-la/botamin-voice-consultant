import "server-only";

import { randomUUID } from "crypto";
import type { Lead, NotificationJob, NotificationJobStatus, PublicLead } from "@/lib/lead-types";
import type { Slot } from "@/lib/lead-types";
import { buildConversationSummary } from "@/lib/resume-context";
import { createNotificationJob, finishNotificationJob, startNotificationJobAttempt } from "./notification-job";

type ToolCallRecord = { result: unknown; createdAt: string };

type MemoryStore = {
  leads: Map<string, Lead>;
  toolCalls: Map<string, ToolCallRecord>;
  slots: Map<string, Slot[]>;
  notificationJobs: Map<string, NotificationJob>;
};

const globalStore = globalThis as typeof globalThis & {
  botaminLeadStore?: MemoryStore;
};

function store(): MemoryStore {
  if (!globalStore.botaminLeadStore) {
    globalStore.botaminLeadStore = { leads: new Map(), toolCalls: new Map(), slots: new Map(), notificationJobs: new Map() };
  }
  return globalStore.botaminLeadStore;
}

export function saveSlots(leadId: string, slots: Slot[]) { store().slots.set(leadId, slots); }
export function getSlots(leadId: string) { return store().slots.get(leadId) ?? []; }
export function enqueueNotification(leadId: string) {
  const existing = store().notificationJobs.get(leadId);
  if (existing?.status === "sent" || existing?.status === "not_configured") return existing;
  const job: NotificationJob = existing ?? createNotificationJob(leadId);
  store().notificationJobs.set(leadId, job);
  return job;
}
export function getNotificationJob(leadId: string) { return store().notificationJobs.get(leadId) ?? null; }
export function startNotificationAttempt(leadId: string) {
  const job = enqueueNotification(leadId);
  const next = startNotificationJobAttempt(job);
  store().notificationJobs.set(leadId, next);
  return next;
}
export function finishNotification(leadId: string, status: NotificationJobStatus, details: Pick<NotificationJob, "lastError" | "messageId">) {
  const job = enqueueNotification(leadId);
  const next = finishNotificationJob(job, status, details);
  store().notificationJobs.set(leadId, next);
  return next;
}
export function takeNotifications(limit = 10) {
  const now = Date.now();
  return Array.from(store().notificationJobs.values())
    .filter((job) => job.status === "pending" || (job.status === "failed" && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now)))
    .slice(0, limit)
    .map((job) => job.leadId);
}
export function completeNotification(leadId: string) {
  const job = store().notificationJobs.get(leadId);
  if (job) store().notificationJobs.set(leadId, { ...job, nextAttemptAt: null, updatedAt: new Date().toISOString() });
}
export function getLeadForNotification(leadId: string) { return store().leads.get(leadId) ?? null; }

export function createLead() {
  const now = new Date().toISOString();
  const lead: Lead = {
    id: randomUUID(),
    sessionSecret: randomUUID(),
    name: null,
    companyActivity: null,
    currentProcess: null,
    need: null,
    desiredResult: null,
    summaryConfirmed: null,
    phone: null,
    telegram: null,
    workEmail: null,
    leadsPerMonth: null,
    salesManagersCount: null,
    selectedSlot: null,
    bookingStatus: "none",
    bookingId: null,
    meetingUrl: null,
    notificationStatus: "not_configured",
    lastUserMessage: null,
    conversationSummary: "Диалог начат, данные о компании ещё не получены.",
    createdAt: now,
    updatedAt: now,
    stages: ["conversation_started"],
  };
  store().leads.set(lead.id, lead);
  return lead;
}

export function getLead(leadId: string, sessionSecret: string) {
  const lead = store().leads.get(leadId);
  return lead?.sessionSecret === sessionSecret ? lead : null;
}

export function updateLead(
  leadId: string,
  sessionSecret: string,
  update: Partial<Lead>,
) {
  const lead = getLead(leadId, sessionSecret);
  if (!lead) return null;
  const stages = Array.from(new Set([...(lead.stages || []), ...(update.stages || [])]));
  const nextWithoutSummary = {
    ...lead,
    ...update,
    stages,
    updatedAt: new Date().toISOString(),
  };
  const next = {
    ...nextWithoutSummary,
    conversationSummary: update.conversationSummary ?? buildConversationSummary(nextWithoutSummary),
  };
  store().leads.set(leadId, next);
  return next;
}

export function getToolCall(callKey: string) {
  return store().toolCalls.get(callKey)?.result;
}

export function saveToolCall(callKey: string, result: unknown) {
  store().toolCalls.set(callKey, { result, createdAt: new Date().toISOString() });
}

export function toPublicLead(lead: Lead): PublicLead {
  return {
    id: lead.id,
    name: lead.name,
    companyActivity: lead.companyActivity,
    currentProcess: lead.currentProcess,
    need: lead.need,
    desiredResult: lead.desiredResult,
    summaryConfirmed: lead.summaryConfirmed,
    phone: lead.phone,
    telegram: lead.telegram,
    workEmail: lead.workEmail,
    leadsPerMonth: lead.leadsPerMonth,
    salesManagersCount: lead.salesManagersCount,
    selectedSlot: lead.selectedSlot,
    bookingStatus: lead.bookingStatus,
    bookingId: lead.bookingId,
    meetingUrl: lead.meetingUrl,
    notificationStatus: lead.notificationStatus,
    lastUserMessage: lead.lastUserMessage,
    conversationSummary: lead.conversationSummary,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    stages: lead.stages,
  };
}
