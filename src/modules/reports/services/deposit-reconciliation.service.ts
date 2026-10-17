import { sql } from "drizzle-orm";
import type { Database } from "../../../plugins/database.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DepositQuery = {
  search?: string;
  view?: "open" | "all";
  reservationStatus?: "all" | "checked_out";
  ledgerStatus?: "all" | "matched" | "review";
  page?: number;
  limit?: number;
};

const base = sql`
  from greenhero.reservation_deposits d
  join greenhero.reservations r on r.id = d.reservation_id
  join greenhero.guests g on g.id = r.guest_id
  left join greenhero.master_items m on m.id = d.method_id
  left join (
    select e.reference_id,
      count(*) filter (where e.event_type = 'deposit.held')::int as held_event_count,
      coalesce(sum(case when e.event_type = 'deposit.held' and jsonb_typeof(e.details->'amount') = 'number'
        then (e.details->>'amount')::bigint else 0 end), 0)::bigint as held,
      coalesce(sum(case when e.event_type in ('deposit.deferred', 'deposit.settled')
        and jsonb_typeof(e.details->'refundAmount') = 'number'
        then (e.details->>'refundAmount')::bigint else 0 end), 0)::bigint as refunded,
      coalesce(sum(case when e.event_type in ('deposit.deferred', 'deposit.settled')
        and jsonb_typeof(e.details->'deductionAmount') = 'number'
        then (e.details->>'deductionAmount')::bigint else 0 end), 0)::bigint as deducted
    from greenhero.reservation_events e
    where e.event_type in ('deposit.held', 'deposit.deferred', 'deposit.settled')
    group by e.reference_id
  ) ledger on ledger.reference_id = d.id
`;

export async function buildDepositReconciliation(
  db: Transaction,
  capturedAt: string,
  query: DepositQuery,
) {
  const {
    search,
    view = "open",
    reservationStatus = "all",
    ledgerStatus = "all",
    page = 1,
    limit = 20,
  } = query;
  const term = search?.trim();
  const searchFilter = term
    ? sql`and (r.booking_code ilike ${`%${term}%`} or g.full_name ilike ${`%${term}%`})`
    : sql``;
  const openFilter =
    view === "open" ? sql`and d.amount_held > d.amount_refunded + d.amount_deducted` : sql``;
  const reservationStatusFilter =
    reservationStatus === "checked_out" ? sql`and r.reservation_status = 'checked_out'` : sql``;
  const needsReview = sql`(coalesce(ledger.held_event_count, 0) = 0
    or d.amount_held <> coalesce(ledger.held, 0)
    or d.amount_refunded <> coalesce(ledger.refunded, 0)
    or d.amount_deducted <> coalesce(ledger.deducted, 0))`;
  const ledgerFilter =
    ledgerStatus === "review"
      ? sql`and ${needsReview}`
      : ledgerStatus === "matched"
        ? sql`and not ${needsReview}`
        : sql``;
  const [summaryResult, itemResult, countResult] = await Promise.all([
    db.execute(sql`select
      count(*)::int as deposits,
      coalesce(sum(d.amount_held), 0)::bigint as held,
      coalesce(sum(d.amount_refunded), 0)::bigint as refunded,
      coalesce(sum(d.amount_deducted), 0)::bigint as deducted,
      coalesce(sum(d.amount_held - d.amount_refunded - d.amount_deducted), 0)::bigint as balance,
      count(*) filter (where ${needsReview})::int as unmatched
      ${base} where true ${searchFilter}`),
    db.execute(sql`select d.id, d.reservation_id, r.booking_code, r.reservation_status,
      g.full_name as guest_name, m.name as method_name, d.status,
      d.amount_held, d.amount_refunded, d.amount_deducted,
      (d.amount_held - d.amount_refunded - d.amount_deducted)::bigint as balance,
      ledger.held_event_count, ledger.held as ledger_held, ledger.refunded as ledger_refunded,
      ledger.deducted as ledger_deducted, d.updated_at
      ${base} where true ${searchFilter} ${openFilter} ${reservationStatusFilter} ${ledgerFilter}
      order by (d.amount_held - d.amount_refunded - d.amount_deducted) desc, d.id
      limit ${limit} offset ${(page - 1) * limit}`),
    db.execute(sql`select count(*)::int as total
      ${base} where true ${searchFilter} ${openFilter} ${reservationStatusFilter} ${ledgerFilter}`),
  ]);
  const summary = summaryResult.rows[0] as Record<string, unknown>;
  return {
    capturedAt,
    historicalAsOfSupported: false,
    summary: {
      deposits: Number(summary.deposits),
      held: Number(summary.held),
      refunded: Number(summary.refunded),
      deducted: Number(summary.deducted),
      balance: Number(summary.balance),
      unmatched: Number(summary.unmatched),
    },
    items: itemResult.rows.map((row) => ({
      id: String(row.id),
      reservationId: String(row.reservation_id),
      bookingCode: String(row.booking_code),
      reservationStatus: String(row.reservation_status),
      guestName: String(row.guest_name),
      methodName: row.method_name === null ? null : String(row.method_name),
      status: String(row.status),
      held: Number(row.amount_held),
      refunded: Number(row.amount_refunded),
      deducted: Number(row.amount_deducted),
      balance: Number(row.balance),
      ledgerMatched:
        Number(row.held_event_count ?? 0) > 0 &&
        Number(row.amount_held) === Number(row.ledger_held) &&
        Number(row.amount_refunded) === Number(row.ledger_refunded) &&
        Number(row.amount_deducted) === Number(row.ledger_deducted),
      updatedAt: new Date(row.updated_at as string | Date).toISOString(),
    })),
    page,
    limit,
    total: Number(countResult.rows[0]?.total ?? 0),
  };
}

export async function listDepositMovements(
  db: Transaction,
  capturedAt: string,
  query: Pick<DepositQuery, "search" | "page" | "limit">,
) {
  const { search, page = 1, limit = 20 } = query;
  const term = search?.trim();
  const filter = term
    ? sql`and (r.booking_code ilike ${`%${term}%`} or g.full_name ilike ${`%${term}%`})`
    : sql``;
  const from = sql`from greenhero.reservation_events e
    join greenhero.reservation_deposits d on d.id = e.reference_id
    join greenhero.reservations r on r.id = d.reservation_id
    join greenhero.guests g on g.id = r.guest_id
    where e.event_type in ('deposit.held', 'deposit.deferred', 'deposit.settled') ${filter}`;
  const [rows, total] = await Promise.all([
    db.execute(sql`select e.id, e.event_type, e.occurred_at, e.details,
      d.id as deposit_id, r.id as reservation_id, r.booking_code, g.full_name as guest_name
      ${from} order by e.occurred_at desc, e.sequence desc
      limit ${limit} offset ${(page - 1) * limit}`),
    db.execute(sql`select count(*)::int as total ${from}`),
  ]);
  return {
    capturedAt,
    items: rows.rows.map((row) => {
      const details = (row.details ?? {}) as Record<string, unknown>;
      const amount = (key: string) =>
        typeof details[key] === "number" ? (details[key] as number) : 0;
      return {
        id: String(row.id),
        depositId: String(row.deposit_id),
        reservationId: String(row.reservation_id),
        bookingCode: String(row.booking_code),
        guestName: String(row.guest_name),
        eventType: String(row.event_type),
        occurredAt: new Date(row.occurred_at as string | Date).toISOString(),
        held: amount("amount"),
        refunded: amount("refundAmount"),
        deducted: amount("deductionAmount"),
        damageAmount: amount("damageAmount"),
        deductionPurpose:
          details.deductionPurpose === "balance" || details.deductionPurpose === "damage"
            ? details.deductionPurpose
            : null,
        source: details.source === "post_checkout" ? "post_checkout" : null,
        reason: typeof details.reason === "string" ? details.reason : null,
        reference: typeof details.refundReference === "string" ? details.refundReference : null,
      };
    }),
    page,
    limit,
    total: Number(total.rows[0]?.total ?? 0),
  };
}
