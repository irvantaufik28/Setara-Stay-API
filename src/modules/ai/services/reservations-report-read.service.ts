import type { Database } from "../../../plugins/database.js";
import {
  getReservationsReport,
  type ReservationReportDateBy,
  type ReservationReportSort,
  type ReservationReportSource,
} from "../../reports/services/reservations-report.service.js";
import type { ReservationStatus } from "../../reservations/reservation-status.js";

type Section = "summary" | "financial" | "items" | "all";

export type AiReservationsReportArgs = {
  section: Section;
  search?: string;
  dateBy: ReservationReportDateBy;
  from?: string;
  to?: string;
  reservationStatus?: ReservationStatus;
  source?: ReservationReportSource;
  roomType?: string;
  otaChannelId?: string;
  sort: ReservationReportSort;
  page: number;
  limit: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseAiReservationsReportArgs(value: unknown): AiReservationsReportArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid reservations report arguments");
  }
  const input = value as Record<string, unknown>;
  const allowed = [
    "section",
    "search",
    "dateBy",
    "from",
    "to",
    "reservationStatus",
    "source",
    "roomType",
    "otaChannelId",
    "sort",
    "page",
    "limit",
  ];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !["summary", "financial", "items", "all"].includes(input.section as string) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.trim().length > 255)) ||
    (input.dateBy !== undefined &&
      !["booking", "check_in", "check_out"].includes(input.dateBy as string)) ||
    (input.from !== undefined && !validDate(input.from)) ||
    (input.to !== undefined && !validDate(input.to)) ||
    (typeof input.from === "string" && typeof input.to === "string" && input.from > input.to) ||
    (input.reservationStatus !== undefined &&
      ![
        "pending",
        "confirmed",
        "checked_in",
        "checked_out",
        "no_show",
        "cancelled",
        "expired",
      ].includes(input.reservationStatus as string)) ||
    (input.source !== undefined &&
      !["website", "phone", "walk_in", "ota"].includes(input.source as string)) ||
    (input.roomType !== undefined &&
      (typeof input.roomType !== "string" || !uuidPattern.test(input.roomType))) ||
    (input.otaChannelId !== undefined &&
      (typeof input.otaChannelId !== "string" || !uuidPattern.test(input.otaChannelId))) ||
    (input.sort !== undefined &&
      !["newest", "booking_code_asc", "booking_code_desc"].includes(input.sort as string)) ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 50))
  ) {
    throw new Error("Invalid reservations report arguments");
  }
  return {
    section: input.section as Section,
    search: typeof input.search === "string" ? input.search.trim() || undefined : undefined,
    dateBy: (input.dateBy as ReservationReportDateBy | undefined) ?? "booking",
    from: input.from as string | undefined,
    to: input.to as string | undefined,
    reservationStatus: input.reservationStatus as ReservationStatus | undefined,
    source: input.source as ReservationReportSource | undefined,
    roomType: input.roomType as string | undefined,
    otaChannelId: input.otaChannelId as string | undefined,
    sort: (input.sort as ReservationReportSort | undefined) ?? "newest",
    page: (input.page as number | undefined) ?? 1,
    limit: (input.limit as number | undefined) ?? 20,
  };
}

export async function getAiReservationsReport(db: Database, args: AiReservationsReportArgs) {
  const report = await getReservationsReport(
    db,
    {
      search: args.search,
      dateBy: args.dateBy,
      from: args.from,
      to: args.to,
      reservationStatus: args.reservationStatus,
      source: args.source,
      roomType: args.roomType,
      otaChannelId: args.otaChannelId,
      sort: args.sort,
    },
    { page: args.page, limit: args.limit },
  );
  const common = {
    dateBy: args.dateBy,
    from: args.from ?? null,
    to: args.to ?? null,
    search: args.search ?? null,
    source: args.source ?? null,
    reservationStatus: args.reservationStatus ?? null,
    total: report.total,
  };
  switch (args.section) {
    case "summary":
      return { ...common, summary: report.summary };
    case "financial":
      return { ...common, financial: report.financial, currency: "IDR" as const };
    case "items":
      return { ...common, page: report.page, limit: report.limit, items: report.items };
    case "all":
      return { ...common, ...report, currency: "IDR" as const };
  }
}
