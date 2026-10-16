import type { Database } from "../../../plugins/database.js";
import {
  getRevenueReport,
  type RevenueReportDateBy,
  type RevenueReportSource,
} from "../../reports/services/revenue-report.service.js";

export type RevenueSummaryArgs = {
  dateBy: RevenueReportDateBy;
  from: string;
  to: string;
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseRevenueSummaryArgs(value: unknown): RevenueSummaryArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid revenue summary arguments");
  }
  const input = value as Record<string, unknown>;
  const { dateBy, from, to } = input;
  if (
    Object.keys(input).some((key) => !["dateBy", "from", "to"].includes(key)) ||
    !["payment", "booking", "check_in"].includes(dateBy as string) ||
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 > 366
  ) {
    throw new Error("Invalid revenue summary arguments");
  }
  return { dateBy: dateBy as RevenueReportDateBy, from, to };
}

export async function getRevenueSummary(db: Database, args: RevenueSummaryArgs) {
  const report = await getRevenueReport(db, args);
  return {
    ...args,
    currency: "IDR" as const,
    revenue: args.dateBy === "payment" ? report.totals.netCollected : report.totals.net,
    revenueBasis: args.dateBy === "payment" ? "paid_minus_refunded" : "reservation_net",
    reservations: report.totals.reservations,
  };
}

type RevenueReportSection = "totals" | "by_source" | "by_method" | "items" | "all";
type RevenueReportPaymentStatus = "unpaid" | "partial" | "paid" | "failed" | "expired" | "refunded";
type RevenueReportReservationStatus =
  "pending" | "confirmed" | "checked_in" | "checked_out" | "no_show" | "cancelled" | "expired";

export type AiRevenueReportArgs = {
  dateBy: RevenueReportDateBy;
  from?: string;
  to?: string;
  section: RevenueReportSection;
  source?: RevenueReportSource;
  paymentStatus?: RevenueReportPaymentStatus;
  reservationStatus?: RevenueReportReservationStatus;
  methodId?: string;
  roomType?: string;
  offset: number;
  limit: number;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAiRevenueReportArgs(value: unknown): AiRevenueReportArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid revenue report arguments");
  }
  const input = value as Record<string, unknown>;
  const allowed = [
    "dateBy",
    "from",
    "to",
    "section",
    "source",
    "paymentStatus",
    "reservationStatus",
    "methodId",
    "roomType",
    "offset",
    "limit",
  ];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    !["payment", "booking", "check_in"].includes(input.dateBy as string) ||
    (input.from !== undefined && !validDate(input.from)) ||
    (input.to !== undefined && !validDate(input.to)) ||
    (typeof input.from === "string" && typeof input.to === "string" && input.from > input.to) ||
    !["totals", "by_source", "by_method", "items", "all"].includes(input.section as string) ||
    (input.source !== undefined &&
      !["website", "phone", "walk_in", "ota"].includes(input.source as string)) ||
    (input.paymentStatus !== undefined &&
      !["unpaid", "partial", "paid", "failed", "expired", "refunded"].includes(
        input.paymentStatus as string,
      )) ||
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
    (input.methodId !== undefined &&
      (typeof input.methodId !== "string" || !uuidPattern.test(input.methodId))) ||
    (input.roomType !== undefined &&
      (typeof input.roomType !== "string" || !uuidPattern.test(input.roomType))) ||
    (input.offset !== undefined &&
      (!Number.isInteger(input.offset) ||
        (input.offset as number) < 0 ||
        (input.offset as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 50))
  ) {
    throw new Error("Invalid revenue report arguments");
  }
  return {
    dateBy: input.dateBy as RevenueReportDateBy,
    from: input.from as string | undefined,
    to: input.to as string | undefined,
    section: input.section as RevenueReportSection,
    source: input.source as RevenueReportSource | undefined,
    paymentStatus: input.paymentStatus as RevenueReportPaymentStatus | undefined,
    reservationStatus: input.reservationStatus as RevenueReportReservationStatus | undefined,
    methodId: input.methodId as string | undefined,
    roomType: input.roomType as string | undefined,
    offset: (input.offset as number | undefined) ?? 0,
    limit: (input.limit as number | undefined) ?? 20,
  };
}

export async function getAiRevenueReport(db: Database, args: AiRevenueReportArgs) {
  const report = await getRevenueReport(db, {
    dateBy: args.dateBy,
    from: args.from,
    to: args.to,
    source: args.source,
    paymentStatus: args.paymentStatus,
    reservationStatus: args.reservationStatus,
    methodId: args.methodId,
    roomType: args.roomType,
  });
  const basis = args.dateBy === "payment" ? "paid_minus_refunded" : "reservation_net";
  const revenue = args.dateBy === "payment" ? report.totals.netCollected : report.totals.net;
  const common = {
    dateBy: args.dateBy,
    from: args.from ?? null,
    to: args.to ?? null,
    source: args.source ?? null,
    paymentStatus: args.paymentStatus ?? null,
    reservationStatus: args.reservationStatus ?? null,
    methodId: args.methodId ?? null,
    roomType: args.roomType ?? null,
    currency: "IDR" as const,
    revenue,
    revenueBasis: basis,
  };
  switch (args.section) {
    case "totals":
      return { ...common, totals: report.totals };
    case "by_source":
      return { ...common, bySource: report.bySource };
    case "by_method":
      return { ...common, byMethod: report.byMethod };
    case "items":
      return {
        ...common,
        totalItems: report.items.length,
        offset: args.offset,
        limit: args.limit,
        items: report.items.slice(args.offset, args.offset + args.limit),
      };
    case "all":
      return {
        ...common,
        totals: report.totals,
        bySource: report.bySource,
        byMethod: report.byMethod,
        totalItems: report.items.length,
        offset: args.offset,
        limit: args.limit,
        items: report.items.slice(args.offset, args.offset + args.limit),
      };
  }
}
