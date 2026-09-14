import "server-only";

import type { Lead, NotificationJob } from "@/lib/lead-types";

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

export async function persistLead(lead: Lead) {
  const client = config();
  if (!client) return false;
  const response = await fetch(`${client.url}/rest/v1/leads?id=eq.${lead.id}`, {
    method: "PATCH",
    headers: {
      apikey: client.key,
      Authorization: `Bearer ${client.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
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
      updated_at: lead.updatedAt,
    }),
  });
  return response.ok;
}

export async function insertLead(lead: Lead) {
  const client = config();
  if (!client) return false;
  const response = await fetch(`${client.url}/rest/v1/leads`, {
    method: "POST",
    headers: {
      apikey: client.key,
      Authorization: `Bearer ${client.key}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      id: lead.id,
      session_hash: lead.sessionSecret,
      booking_status: lead.bookingStatus,
      notification_status: lead.notificationStatus,
      created_at: lead.createdAt,
      updated_at: lead.updatedAt,
    }),
  });
  return response.ok;
}

export async function persistNotificationJob(job: NotificationJob) {
  const client = config();
  if (!client) return false;
  const response = await fetch(`${client.url}/rest/v1/notification_jobs?on_conflict=lead_id`, {
    method: "POST",
    headers: {
      apikey: client.key,
      Authorization: `Bearer ${client.key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
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
  return response.ok;
}
