import "server-only";

import { randomUUID } from "crypto";
import type { Lead, NotificationJob, NotificationJobStatus, PublicLead, Slot } from "@/lib/lead-types";
import { buildConversationSummary } from "@/lib/resume-context";
import { createNotificationJob, finishNotificationJob, startNotificationJobAttempt } from "./notification-job";
import { StoreUnavailableError } from "@/lib/store-errors";
import {
  getLeadById,
  getLeadBySession,
  getNotificationJob as getPersistedNotificationJob,
  getOfferedSlots,
  getToolCall as getPersistedToolCall,
  insertLead,
  isSupabaseConfigured,
  persistNotificationJob,
  saveOfferedSlots,
  saveToolCall as persistToolCall,
  takeDueNotificationLeadIds,
  updateLeadById,
  updateLeadFields,
} from "@/lib/supabase-repository";

type ToolCallRecord = { result: unknown; createdAt: string };

type MemoryStore = {
  leads: Map<string, Lead>;
  toolCalls: Map<string, ToolCallRecord>;
  slots: Map<string, Slot[]>;
  notificationJobs: Map<string, NotificationJob>;
  queues: Map<string, Promise<unknown>>;
};

const globalStore = globalThis as typeof globalThis & {
  botaminLeadStore?: MemoryStore;
};

function memory(): MemoryStore {
  if (!globalStore.botaminLeadStore) {
    globalStore.botaminLeadStore = {
      leads: new Map(),
      toolCalls: new Map(),
      slots: new Map(),
      notificationJobs: new Map(),
      queues: new Map(),
    };
  }
  return globalStore.botaminLeadStore;
}

function emptyLead(): Lead {
  const now = new Date().toISOString();
  return {
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
}

function storeMode(): "supabase" | "memory" {
  if (isSupabaseConfigured()) return "supabase";
  if (process.env.NODE_ENV === "production") throw new StoreUnavailableError();
  return "memory";
}

export function usesDurableStore() {
  return storeMode() === "supabase";
}

export function isolateServerlessInstanceForTests() {
  globalStore.botaminLeadStore = undefined;
}

export async function withLeadLock<T>(leadId: string, task: () => Promise<T>): Promise<T> {
  const queues = memory().queues;
  const previous = queues.get(leadId) ?? Promise.resolve();
  let release: (value: unknown) => void = () => undefined;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  queues.set(leadId, previous.then(() => gate, () => gate));
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release(null);
  }
}

export async function createLead() {
  const lead = emptyLead();
  if (usesDurableStore()) await insertLead(lead);
  else memory().leads.set(lead.id, lead);
  return lead;
}

export async function getLead(leadId: string, sessionSecret: string) {
  if (usesDurableStore()) return getLeadBySession(leadId, sessionSecret);
  const lead = memory().leads.get(leadId);
  return lead?.sessionSecret === sessionSecret ? lead : null;
}

function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

export async function updateLead(leadId: string, sessionSecret: string, update: Partial<Lead>) {
  const current = await getLead(leadId, sessionSecret);
  if (!current) return null;
  const stages = update.stages
    ? Array.from(new Set([...(current.stages || []), ...update.stages]))
    : current.stages;
  const defined = definedFields(update);
  const merged = { ...current, ...defined, stages, updatedAt: new Date().toISOString() };
  const patch: Partial<Lead> = { ...defined, stages: update.stages ? stages : undefined };
  if (update.conversationSummary === undefined) {
    patch.conversationSummary = buildConversationSummary(merged);
  }
  if (usesDurableStore()) {
    const persisted = await updateLeadFields(leadId, sessionSecret, patch);
    if (!persisted) throw new StoreUnavailableError();
    return persisted;
  }
  const next = { ...merged, conversationSummary: patch.conversationSummary ?? merged.conversationSummary };
  memory().leads.set(leadId, next);
  return next;
}

export async function saveSlots(leadId: string, sessionSecret: string, slots: Slot[]) {
  if (usesDurableStore()) return saveOfferedSlots(leadId, sessionSecret, slots);
  memory().slots.set(leadId, slots);
  return slots;
}

export async function getSlots(leadId: string, sessionSecret: string) {
  if (usesDurableStore()) return getOfferedSlots(leadId, sessionSecret);
  return memory().slots.get(leadId) ?? [];
}

export async function getToolCall(leadId: string, callId: string) {
  if (usesDurableStore()) return getPersistedToolCall(leadId, callId);
  return memory().toolCalls.get(`${leadId}:${callId}`)?.result ?? null;
}

export async function saveToolCall(leadId: string, callId: string, result: unknown) {
  if (usesDurableStore()) return persistToolCall(leadId, callId, result as never);
  const existing = memory().toolCalls.get(`${leadId}:${callId}`);
  if (existing) return existing.result;
  memory().toolCalls.set(`${leadId}:${callId}`, { result, createdAt: new Date().toISOString() });
  return result;
}

export async function enqueueNotification(leadId: string) {
  if (usesDurableStore()) {
    const existing = await getPersistedNotificationJob(leadId);
    if (existing?.status === "sent" || existing?.status === "not_configured") return existing;
    const job = existing ?? createNotificationJob(leadId);
    await persistNotificationJob(job);
    return job;
  }
  const existing = memory().notificationJobs.get(leadId);
  if (existing?.status === "sent" || existing?.status === "not_configured") return existing;
  const job = existing ?? createNotificationJob(leadId);
  memory().notificationJobs.set(leadId, job);
  return job;
}

export async function startNotificationAttempt(leadId: string) {
  const job = await enqueueNotification(leadId);
  const next = startNotificationJobAttempt(job);
  if (usesDurableStore()) await persistNotificationJob(next);
  else memory().notificationJobs.set(leadId, next);
  return next;
}

export async function finishNotification(
  leadId: string,
  status: NotificationJobStatus,
  details: Pick<NotificationJob, "lastError" | "messageId">,
) {
  const job = await enqueueNotification(leadId);
  const next = finishNotificationJob(job, status, details);
  if (usesDurableStore()) await persistNotificationJob(next);
  else memory().notificationJobs.set(leadId, next);
  return next;
}

export async function takeNotifications(limit = 10) {
  if (usesDurableStore()) return takeDueNotificationLeadIds(limit);
  const now = Date.now();
  return Array.from(memory().notificationJobs.values())
    .filter((job) => job.status === "pending" || (job.status === "failed" && (!job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now)))
    .slice(0, limit)
    .map((job) => job.leadId);
}

export async function completeNotification(leadId: string) {
  const job = usesDurableStore()
    ? await getPersistedNotificationJob(leadId)
    : memory().notificationJobs.get(leadId) ?? null;
  if (!job) return;
  const next = { ...job, nextAttemptAt: null, updatedAt: new Date().toISOString() };
  if (usesDurableStore()) await persistNotificationJob(next);
  else memory().notificationJobs.set(leadId, next);
}

export async function getLeadForNotification(leadId: string) {
  if (usesDurableStore()) return getLeadById(leadId);
  return memory().leads.get(leadId) ?? null;
}

export async function updateTrustedLead(leadId: string, update: Partial<Lead>) {
  if (usesDurableStore()) return updateLeadById(leadId, update);
  const lead = memory().leads.get(leadId);
  if (!lead) return null;
  const next = { ...lead, ...update, updatedAt: new Date().toISOString() };
  memory().leads.set(leadId, next);
  return next;
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
