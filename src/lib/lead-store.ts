import "server-only";

import { randomUUID } from "crypto";
import type { Lead, PublicLead } from "@/lib/lead-types";
import type { Slot } from "@/lib/lead-types";

type ToolCallRecord = { result: unknown; createdAt: string };

type MemoryStore = {
  leads: Map<string, Lead>;
  toolCalls: Map<string, ToolCallRecord>;
  slots: Map<string, Slot[]>;
  notificationQueue: Set<string>;
};

const globalStore = globalThis as typeof globalThis & {
  botaminLeadStore?: MemoryStore;
};

function store(): MemoryStore {
  if (!globalStore.botaminLeadStore) {
    globalStore.botaminLeadStore = { leads: new Map(), toolCalls: new Map(), slots: new Map(), notificationQueue: new Set() };
  }
  return globalStore.botaminLeadStore;
}

export function saveSlots(leadId: string, slots: Slot[]) { store().slots.set(leadId, slots); }
export function getSlots(leadId: string) { return store().slots.get(leadId) ?? []; }
export function enqueueNotification(leadId: string) { store().notificationQueue.add(leadId); }
export function takeNotifications(limit = 10) { return Array.from(store().notificationQueue).slice(0, limit); }
export function completeNotification(leadId: string) { store().notificationQueue.delete(leadId); }
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
  const next = {
    ...lead,
    ...update,
    stages,
    updatedAt: new Date().toISOString(),
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
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    stages: lead.stages,
  };
}
