import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { guests } from "../../../db/schema/guests.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import type { Database } from "../../../plugins/database.js";
import { remainingBalance } from "../../payments/services/outstanding-balance.sql.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ArAgingQuery = {
  search?: string;
  source?: "website" | "walk_in" | "phone" | "ota";
  bucket?: "0_30" | "31_60" | "61_90" | "over_90";
  page?: number;
  limit?: number;
};

export async function buildArAgingReport(
  db: Transaction,
  asOfDate: string,
  capturedAt: string,
  query: ArAgingQuery,
) {
  const { search, source, bucket, page = 1, limit = 20 } = query;
  const term = search?.trim();
  const ageDays = sql<number>`greatest(0, ${asOfDate}::date - coalesce(
    (${reservations.checkedOutAt} at time zone 'Asia/Jakarta')::date,
    ${reservations.checkOutDate}
  ))`.mapWith(Number);
  const base = db
    .select({
      id: reservations.id,
      bookingCode: reservations.bookingCode,
      source: reservations.source,
      checkedOutAt: reservations.checkedOutAt,
      checkOutDate: reservations.checkOutDate,
      guestName: guests.fullName,
      balance: remainingBalance.as("balance"),
      ageDays: ageDays.as("age_days"),
    })
    .from(reservations)
    .innerJoin(guests, eq(reservations.guestId, guests.id))
    .where(
      and(
        eq(reservations.reservationStatus, "checked_out"),
        sql`${remainingBalance} > 0`,
        source ? eq(reservations.source, source) : undefined,
        term
          ? or(
              ilike(reservations.bookingCode, `%${term}%`),
              ilike(guests.fullName, `%${term}%`),
              ilike(guests.phone, `%${term}%`),
            )
          : undefined,
      ),
    )
    .as("aging_base");
  const bucketFilter =
    bucket === "0_30"
      ? sql`${base.ageDays} between 0 and 30`
      : bucket === "31_60"
        ? sql`${base.ageDays} between 31 and 60`
        : bucket === "61_90"
          ? sql`${base.ageDays} between 61 and 90`
          : bucket === "over_90"
            ? sql`${base.ageDays} > 90`
            : undefined;
  const [items, [summary], [pageTotal]] = await Promise.all([
    db
      .select()
      .from(base)
      .where(bucketFilter)
      .orderBy(desc(base.ageDays), desc(base.balance), desc(base.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({
        total: sql<number>`count(*)::int`.mapWith(Number),
        balance: sql<number>`coalesce(sum(${base.balance}), 0)::bigint`.mapWith(Number),
        bucket0To30:
          sql<number>`coalesce(sum(${base.balance}) filter (where ${base.ageDays} between 0 and 30), 0)::bigint`.mapWith(
            Number,
          ),
        bucket31To60:
          sql<number>`coalesce(sum(${base.balance}) filter (where ${base.ageDays} between 31 and 60), 0)::bigint`.mapWith(
            Number,
          ),
        bucket61To90:
          sql<number>`coalesce(sum(${base.balance}) filter (where ${base.ageDays} between 61 and 90), 0)::bigint`.mapWith(
            Number,
          ),
        bucketOver90:
          sql<number>`coalesce(sum(${base.balance}) filter (where ${base.ageDays} > 90), 0)::bigint`.mapWith(
            Number,
          ),
        count0To30:
          sql<number>`count(*) filter (where ${base.ageDays} between 0 and 30)::int`.mapWith(
            Number,
          ),
        count31To60:
          sql<number>`count(*) filter (where ${base.ageDays} between 31 and 60)::int`.mapWith(
            Number,
          ),
        count61To90:
          sql<number>`count(*) filter (where ${base.ageDays} between 61 and 90)::int`.mapWith(
            Number,
          ),
        countOver90: sql<number>`count(*) filter (where ${base.ageDays} > 90)::int`.mapWith(Number),
      })
      .from(base),
    db
      .select({ total: sql<number>`count(*)::int`.mapWith(Number) })
      .from(base)
      .where(bucketFilter),
  ]);
  return {
    asOfDate,
    capturedAt,
    basis: "checkout_date" as const,
    summary: {
      totalReservations: summary.total,
      totalBalance: summary.balance,
      buckets: [
        { key: "0_30", count: summary.count0To30, amount: summary.bucket0To30 },
        { key: "31_60", count: summary.count31To60, amount: summary.bucket31To60 },
        { key: "61_90", count: summary.count61To90, amount: summary.bucket61To90 },
        { key: "over_90", count: summary.countOver90, amount: summary.bucketOver90 },
      ],
    },
    items,
    page,
    limit,
    total: pageTotal.total,
  };
}
