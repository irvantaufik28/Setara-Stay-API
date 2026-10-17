import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { guests } from "../../../db/schema/guests.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import {
  bookingTotal,
  grossPaid,
  refunded,
  remainingBalance,
} from "../services/outstanding-balance.sql.js";

type Query = {
  search?: string;
  source?: "website" | "walk_in" | "phone" | "ota";
  page?: number;
  limit?: number;
};

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    search: { type: "string", maxLength: 255 },
    source: { type: "string", enum: ["website", "walk_in", "phone", "ota"] },
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
} as const;

export const paymentOutstandingRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Query }>(
    "/outstanding",
    { preHandler: app.requirePermission("payments.view"), schema: { querystring: querySchema } },
    async (request) => {
      const { search, source, page = 1, limit = 20 } = request.query;
      const term = search?.trim();
      const filter = and(
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
      );
      const matchingBalances = app.db
        .select({ remainingBalance: remainingBalance.as("remaining_balance") })
        .from(reservations)
        .innerJoin(guests, eq(reservations.guestId, guests.id))
        .where(filter)
        .as("matching_balances");
      const [items, [summary]] = await Promise.all([
        app.db
          .select({
            id: reservations.id,
            bookingCode: reservations.bookingCode,
            source: reservations.source,
            checkInDate: reservations.checkInDate,
            checkOutDate: reservations.checkOutDate,
            checkedOutAt: reservations.checkedOutAt,
            paymentStatus: reservations.paymentStatus,
            checkoutOutstandingReason: reservations.checkoutOutstandingReason,
            guest: { fullName: guests.fullName, phone: guests.phone },
            bookingTotal,
            grossPaid,
            refundedAmount: refunded,
            remainingBalance,
          })
          .from(reservations)
          .innerJoin(guests, eq(reservations.guestId, guests.id))
          .where(filter)
          .orderBy(desc(reservations.checkedOutAt), desc(reservations.id))
          .limit(limit)
          .offset((page - 1) * limit),
        app.db
          .select({
            total: sql<number>`count(*)::int`.mapWith(Number),
            totalOutstanding:
              sql<number>`coalesce(sum(${matchingBalances.remainingBalance}), 0)::bigint`.mapWith(
                Number,
              ),
          })
          .from(matchingBalances),
      ]);
      return { items, summary, page, limit, total: summary.total };
    },
  );
};
