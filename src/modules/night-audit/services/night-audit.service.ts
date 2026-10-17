import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../plugins/database.js";

type Queryable = Pick<Database, "execute">;

export type AuditIssue = { code: string; label: string; count: number };
export type AuditPreview = {
  businessDate: string;
  nextBusinessDate: string;
  lastClosedDate: string | null;
  closeAllowedAt: string;
  closeWindowOpen: boolean;
  blockers: AuditIssue[];
  warnings: AuditIssue[];
  summary: {
    arrivals: number;
    departures: number;
    inHouse: number;
    soldRoomNights: number;
    roomRevenue: number;
    paymentsReceived: number;
    refundsPaid: number;
  };
  previewToken: string;
};

export function jakartaDate(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function closeAllowedAt(businessDate: string): string {
  return `${nextDate(businessDate)}T06:00:00+07:00`;
}

export function closeWindowOpen(businessDate: string, now = new Date()): boolean {
  return now.getTime() >= new Date(closeAllowedAt(businessDate)).getTime();
}

export async function getAuditState(db: Queryable) {
  const result = await db.execute(sql<{
    start_date: string | null;
    first_closed_date: string | null;
    last_closed_date: string | null;
    closed_count: number;
  }>`
    select
      (select start_date from greenhero.night_audit_settings where id = 1) as start_date,
      min(business_date) as first_closed_date,
      max(business_date) as last_closed_date,
      count(*)::int as closed_count
    from greenhero.night_audits
  `);
  const row = result.rows[0] as {
    start_date: string | null;
    first_closed_date: string | null;
    last_closed_date: string | null;
    closed_count: number;
  };
  const startDate = row.start_date;
  const firstClosedDate = row.first_closed_date;
  const lastClosedDate = row.last_closed_date;
  const closedCount = Number(row.closed_count);
  const expectedCount =
    firstClosedDate && lastClosedDate
      ? Math.round(
          (Date.parse(`${lastClosedDate}T00:00:00Z`) - Date.parse(`${firstClosedDate}T00:00:00Z`)) /
            86_400_000,
        ) + 1
      : 0;
  const historyHasGaps = closedCount > 0 && closedCount !== expectedCount;
  const recoveryReason = historyHasGaps
    ? "date_gap"
    : closedCount > 0 && startDate && firstClosedDate !== startDate
      ? "start_date_mismatch"
      : closedCount > 0 && !startDate
        ? "missing_setup"
        : null;
  const recoveryRequired = recoveryReason !== null;
  const businessDate = lastClosedDate ? nextDate(lastClosedDate) : startDate;
  return {
    initialized: startDate !== null,
    startDate,
    firstClosedDate,
    closedCount,
    businessDate,
    lastClosedDate,
    recoveryRequired,
    recoveryReason,
    closeAllowedAt: businessDate ? closeAllowedAt(businessDate) : null,
    closeWindowOpen: businessDate ? closeWindowOpen(businessDate) : false,
  };
}

export async function buildAuditPreview(
  db: Queryable,
  businessDate: string,
  lastClosedDate: string | null,
): Promise<AuditPreview> {
  const result = await db.execute(sql<{
    arrivals: number;
    departures: number;
    in_house: number;
    unresolved_arrivals: number;
    unresolved_departures: number;
    pending_payments: number;
    pending_refunds: number;
    sold_room_nights: number;
    room_revenue: number;
    payments_received: number;
    refunds_paid: number;
  }>`
    select
      (select count(*)::int from greenhero.reservations r where r.check_in_date = ${businessDate}::date and r.reservation_status in ('confirmed', 'checked_in', 'checked_out')) as arrivals,
      (select count(*)::int from greenhero.reservations r where r.check_out_date = ${businessDate}::date and r.reservation_status in ('checked_in', 'checked_out')) as departures,
      (select count(*)::int from greenhero.reservations r where r.reservation_status = 'checked_in' and r.check_in_date <= ${businessDate}::date and r.check_out_date > ${businessDate}::date) as in_house,
      (select count(*)::int from greenhero.reservations r where r.check_in_date <= ${businessDate}::date and r.reservation_status = 'confirmed') as unresolved_arrivals,
      (select count(*)::int from greenhero.reservations r where r.check_out_date <= ${businessDate}::date and r.reservation_status = 'checked_in') as unresolved_departures,
      (select count(*)::int from greenhero.payments p where p.status = 'pending') as pending_payments,
      (select count(*)::int from greenhero.payment_refunds f where f.status = 'pending') as pending_refunds,
      (select count(*)::int from greenhero.reservation_room_nights n join greenhero.reservation_rooms rr on rr.id = n.reservation_room_id join greenhero.reservations r on r.id = rr.reservation_id where n.stay_date = ${businessDate}::date and r.reservation_status in ('checked_in', 'checked_out')) as sold_room_nights,
      (select coalesce(sum(n.final_price), 0)::bigint from greenhero.reservation_room_nights n join greenhero.reservation_rooms rr on rr.id = n.reservation_room_id join greenhero.reservations r on r.id = rr.reservation_id where n.stay_date = ${businessDate}::date and r.reservation_status in ('checked_in', 'checked_out')) as room_revenue,
      (select coalesce(sum(p.amount), 0)::bigint from greenhero.payments p where p.status in ('succeeded', 'partially_refunded', 'refunded') and (p.paid_at at time zone 'Asia/Jakarta')::date = ${businessDate}::date) as payments_received,
      (select coalesce(sum(f.amount), 0)::bigint from greenhero.payment_refunds f where f.status = 'succeeded' and (f.processed_at at time zone 'Asia/Jakarta')::date = ${businessDate}::date) as refunds_paid
  `);
  const row = result.rows[0] as Record<string, unknown>;
  const count = (value: unknown) => Number(value ?? 0);
  const summary = {
    arrivals: count(row.arrivals),
    departures: count(row.departures),
    inHouse: count(row.in_house),
    soldRoomNights: count(row.sold_room_nights),
    roomRevenue: count(row.room_revenue),
    paymentsReceived: count(row.payments_received),
    refundsPaid: count(row.refunds_paid),
  };
  const blockers: AuditIssue[] = [
    {
      code: "UNRESOLVED_ARRIVALS",
      label: "Arrival belum check-in atau no-show",
      count: count(row.unresolved_arrivals),
    },
    {
      code: "UNRESOLVED_DEPARTURES",
      label: "Departure belum check-out",
      count: count(row.unresolved_departures),
    },
  ].filter((issue) => issue.count > 0);
  const warnings: AuditIssue[] = [
    {
      code: "PENDING_PAYMENTS",
      label: "Pembayaran masih pending",
      count: count(row.pending_payments),
    },
    { code: "PENDING_REFUNDS", label: "Refund masih pending", count: count(row.pending_refunds) },
  ].filter((issue) => issue.count > 0);
  const previewToken = createHash("sha256")
    .update(JSON.stringify({ businessDate, blockers, warnings, summary }))
    .digest("hex");
  return {
    businessDate,
    nextBusinessDate: nextDate(businessDate),
    lastClosedDate,
    closeAllowedAt: closeAllowedAt(businessDate),
    closeWindowOpen: closeWindowOpen(businessDate),
    blockers,
    warnings,
    summary,
    previewToken,
  };
}
