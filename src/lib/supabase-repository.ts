import "server-only";

import type { BookingStatus, FunnelStage, Lead, NotificationJob, NotificationJobStatus, Slot, ToolResult } from "@/lib/lead-types";
import { hashSessionSecret, sessionHashMatches } from "@/lib/session-secret";
import { StoreUnavailableError } from "@/lib/store-errors";

type LeadRow = {
  id: string;
  session_hash: string;
  name: string | null;
  company_activity: string | null;
  current_process: string | null;
  need: string | null;
  desired_result: string | null;
  summary_confirmed: boolean | null;
  phone: string | null;
  telegram: string | null;
  work_email: string | null;
  leads_per_month: string | null;
  sales_managers_count: string | null;
  selected_slot: Slot | null;
  booking_status: BookingStatus;
  cal_booking_id: string | null;
  meeting_url: string | null;
  notification_status: Lead["notificationStatus"];
  last_user_message: string | null;
  conversation_summary: string | null;
  stages: FunnelStage[] | null;
  offered_slots: Slot[] | null;
  created_at: string;
  updated_at: string;
};

const LEAD_COLUMNS: Record<string, keyof Lead> = {
  name: "name",
  company_activity: "companyActivity",
  current_process: "currentProcess",
  need: "need",
  desired_result: "desiredResult",
  summary_confirmed: "summaryConfirmed",
  phone: "phone",
  telegram: "telegram",
  work_email: "workEmail",
  leads_per_month: "leadsPerMonth",
  sales_managers_count: "salesManagersCount",
  selected_slot: "selectedSlot",
  booking_status: "bookingStatus",
  cal_booking_id: "bookingId",
  meeting_url: "meetingUrl",
  notification_status: "notificationStatus",
  last_user_message: "lastUserMessage",
  conversation_summary: "conversationSummary",
  stages: "stages",
};

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function headers(prefer?: string) {
  const client = config();
  if (!client) throw new StoreUnavailableError();
  return {
    apikey: client.key,
    Authorization: `Bearer ${client.key}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

function rest(path: string) {
  const client = config();
  if (!client) throw new StoreUnavailableError();
  return `${client.url}/rest/v1/${path}`;
}

export function isSupabaseConfigured() {
  return Boolean(config());
}

function rowToLead(row: LeadRow, sessionSecret = ""): Lead {
  return {
    id: row.id,
    sessionSecret,
    name: row.name,
    companyActivity: row.company_activity,
    currentProcess: row.current_process,
    need: row.need,
    desiredResult: row.desired_result,
    summaryConfirmed: row.summary_confirmed,
    phone: row.phone,
    telegram: row.telegram,
    workEmail: row.work_email,
    leadsPerMonth: row.leads_per_month,
    salesManagersCount: row.sales_managers_count,
    selectedSlot: row.selected_slot,
    bookingStatus: row.booking_status,
    bookingId: row.cal_booking_id,
    meetingUrl: row.meeting_url,
    notificationStatus: row.notification_status,
    lastUserMessage: row.last_user_message,
    conversationSummary: row.conversation_summary || "Диалог начат, данные о компании ещё не получены.",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stages: row.stages ?? ["conversation_started"],
  };
}

function patchBody(update: Partial<Lead>) {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [column, field] of Object.entries(LEAD_COLUMNS)) {
    if (!Object.prototype.hasOwnProperty.call(update, field)) continue;
    const value = update[field as keyof Lead];
    if (value === undefined) continue;
    body[column] = value;
  }
  return body;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => null)) as T;
}

async function restFetch(path: string, init: RequestInit = {}) {
  try {
    return await fetch(rest(path), { cache: "no-store", ...init });
  } catch {
    throw new StoreUnavailableError();
  }
}

async function getLeadRow(leadId: string): Promise<LeadRow | null> {
  const response = await restFetch(`leads?id=eq.${leadId}&select=*`, { headers: headers() });
  if (!response.ok) throw new StoreUnavailableError();
  const rows = await readJson<LeadRow[]>(response);
  if (!Array.isArray(rows)) throw new StoreUnavailableError();
  return rows[0] ?? null;
}

export async function insertLead(lead: Lead) {
  const response = await restFetch("leads", {
    method: "POST",
    headers: headers("return=minimal"),
    body: JSON.stringify({
      id: lead.id,
      session_hash: hashSessionSecret(lead.sessionSecret),
      name: lead.name,
      company_activity: lead.companyActivity,
      current_process: lead.currentProcess,
      need: lead.need,
      desired_result: lead.desiredResult,
      summary_confirmed: lead.summaryConfirmed,
      phone: lead.phone,
      telegram: lead.telegram,
      work_email: lead.workEmail,
      leads_per_month: lead.leadsPerMonth,
      sales_managers_count: lead.salesManagersCount,
      selected_slot: lead.selectedSlot,
      booking_status: lead.bookingStatus,
      cal_booking_id: lead.bookingId,
      meeting_url: lead.meetingUrl,
      notification_status: lead.notificationStatus,
      last_user_message: lead.lastUserMessage,
      conversation_summary: lead.conversationSummary,
      stages: lead.stages,
      offered_slots: [],
      created_at: lead.createdAt,
      updated_at: lead.updatedAt,
    }),
  });
  if (!response.ok) throw new StoreUnavailableError();
  return true;
}

export async function getLeadBySession(leadId: string, sessionSecret: string) {
  const row = await getLeadRow(leadId);
  if (!row || !sessionHashMatches(sessionSecret, row.session_hash)) return null;
  return rowToLead(row, sessionSecret);
}

export async function getLeadById(leadId: string) {
  const row = await getLeadRow(leadId);
  return row ? rowToLead(row) : null;
}

export async function updateLeadFields(leadId: string, sessionSecret: string, update: Partial<Lead>) {
  const current = await getLeadBySession(leadId, sessionSecret);
  if (!current) return null;
  const response = await restFetch(`leads?id=eq.${leadId}`, {
    method: "PATCH",
    headers: headers("return=minimal"),
    body: JSON.stringify(patchBody(update)),
  });
  if (!response.ok) throw new StoreUnavailableError();
  return getLeadBySession(leadId, sessionSecret);
}

export async function updateLeadById(leadId: string, update: Partial<Lead>) {
  const response = await restFetch(`leads?id=eq.${leadId}`, {
    method: "PATCH",
    headers: headers("return=minimal"),
    body: JSON.stringify(patchBody(update)),
  });
  if (!response.ok) throw new StoreUnavailableError();
  return getLeadById(leadId);
}

export async function saveOfferedSlots(leadId: string, sessionSecret: string, slots: Slot[]) {
  const current = await getLeadBySession(leadId, sessionSecret);
  if (!current) return null;
  const response = await restFetch(`leads?id=eq.${leadId}`, {
    method: "PATCH",
    headers: headers("return=minimal"),
    body: JSON.stringify({ offered_slots: slots, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new StoreUnavailableError();
  return slots;
}

export async function getOfferedSlots(leadId: string, sessionSecret: string) {
  const row = await getLeadRow(leadId);
  if (!row || !sessionHashMatches(sessionSecret, row.session_hash)) return [];
  return row.offered_slots ?? [];
}

export async function getToolCall(leadId: string, callId: string) {
  const response = await restFetch(
    `lead_tool_calls?lead_id=eq.${leadId}&call_id=eq.${encodeURIComponent(callId)}&select=result`,
    { headers: headers() },
  );
  if (!response.ok) throw new StoreUnavailableError();
  const rows = await readJson<Array<{ result: ToolResult }>>(response);
  return rows?.[0]?.result ?? null;
}

export async function saveToolCall(leadId: string, callId: string, result: ToolResult) {
  const response = await restFetch("lead_tool_calls", {
    method: "POST",
    headers: headers("return=representation"),
    body: JSON.stringify({ lead_id: leadId, call_id: callId, result }),
  });
  if (response.status === 409) return getToolCall(leadId, callId);
  if (!response.ok) throw new StoreUnavailableError();
  return result;
}

export async function persistNotificationJob(job: NotificationJob) {
  const response = await restFetch("notification_jobs?on_conflict=lead_id", {
    method: "POST",
    headers: headers("resolution=merge-duplicates,return=minimal"),
    body: JSON.stringify({
      lead_id: job.leadId,
      status: job.status,
      attempts: job.attempts,
      next_attempt_at: job.nextAttemptAt,
      telegram_message_id: job.messageId,
      last_error: job.lastError,
      updated_at: job.updatedAt,
    }),
  });
  if (!response.ok) throw new StoreUnavailableError();
  return true;
}

export async function getNotificationJob(leadId: string) {
  const response = await restFetch(`notification_jobs?lead_id=eq.${leadId}&select=*`, {
    headers: headers(),
  });
  if (!response.ok) throw new StoreUnavailableError();
  const rows = await readJson<Array<{
    lead_id: string;
    status: NotificationJobStatus;
    attempts: number;
    last_error: string | null;
    telegram_message_id: string | null;
    next_attempt_at: string | null;
    updated_at: string;
  }>>(response);
  const row = rows?.[0];
  if (!row) return null;
  return {
    leadId: row.lead_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    messageId: row.telegram_message_id,
    nextAttemptAt: row.next_attempt_at,
    updatedAt: row.updated_at,
  } satisfies NotificationJob;
}

export async function takeDueNotificationLeadIds(limit = 10) {
  const now = new Date().toISOString();
  const response = await restFetch(
    `notification_jobs?or=(status.eq.pending,status.eq.failed)&next_attempt_at=lte.${now}&order=next_attempt_at.asc&limit=${limit}&select=lead_id`,
    { headers: headers() },
  );
  if (!response.ok) throw new StoreUnavailableError();
  const rows = await readJson<Array<{ lead_id: string }>>(response);
  return (rows ?? []).map((row) => row.lead_id);
}
