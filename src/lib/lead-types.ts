export type ContactType = "phone" | "telegram";
export type FunnelStage =
  | "conversation_started"
  | "contacts_collected"
  | "booking_attempted"
  | "booking_confirmed";
export type BookingStatus =
  | "none"
  | "selected"
  | "pending_consent"
  | "booking"
  | "confirmed"
  | "conflict"
  | "failed";

export type Slot = {
  id: string;
  startAtUtc: string;
  endAtUtc: string;
  label: string;
  date: string;
  time: string;
  timeZone: "Europe/Moscow";
  durationMinutes: number;
};

export type Lead = {
  id: string;
  sessionSecret: string;
  name: string | null;
  companyActivity: string | null;
  currentProcess: string | null;
  need: string | null;
  desiredResult: string | null;
  summaryConfirmed: boolean | null;
  phone: string | null;
  telegram: string | null;
  workEmail: string | null;
  leadsPerMonth: string | null;
  salesManagersCount: string | null;
  selectedSlot: Slot | null;
  bookingStatus: BookingStatus;
  bookingId: string | null;
  meetingUrl: string | null;
  notificationStatus: "pending" | "sent" | "failed" | "not_configured";
  createdAt: string;
  updatedAt: string;
  stages: FunnelStage[];
};

export type ToolResult = {
  success: boolean;
  message: string;
  lead?: PublicLead;
  slots?: Slot[];
  missing?: string[];
  booking?: {
    status: BookingStatus;
    slot: Slot | null;
    meetingUrl: string | null;
  };
};

export type PublicLead = Omit<Lead, "sessionSecret">;
