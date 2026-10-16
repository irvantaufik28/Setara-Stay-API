import { and, asc, desc, eq, exists, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { guests } from "../../../db/schema/guests.schema.js";
import { masterItems } from "../../../db/schema/master_items.schema.js";
import { reservationCharges } from "../../../db/schema/reservation_charges.schema.js";
import { reservationRooms } from "../../../db/schema/reservation_rooms.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import { resolveReservationOperationalStatus } from "../reservations-operational-status.js";
import { getCheckOutClock } from "../services/reservation-check-out-time.service.js";

type ListQuery = {
  search?: string;
  source?: "website" | "phone" | "walk_in" | "ota";
  reservationStatus?:
    "pending" | "confirmed" | "checked_in" | "checked_out" | "no_show" | "cancelled" | "expired";
  paymentStatus?: "unpaid" | "partial" | "paid" | "failed" | "expired" | "refunded";
  roomAssignment?: "unassigned";
  stayDate?: string;
  stayDateFrom?: string;
  stayDateTo?: string;
  sort?: "newest" | "booking_code_asc" | "booking_code_desc";
  page?: number;
  limit?: number;
};

const listQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    search: { type: "string", maxLength: 255 },
    source: { type: "string", enum: ["website", "phone", "walk_in", "ota"] },
    reservationStatus: {
      type: "string",
      enum: [
        "pending",
        "confirmed",
        "checked_in",
        "checked_out",
        "no_show",
        "cancelled",
        "expired",
      ],
    },
    paymentStatus: {
      type: "string",
      enum: ["unpaid", "partial", "paid", "failed", "expired", "refunded"],
    },
    roomAssignment: { type: "string", enum: ["unassigned"] },
    stayDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    stayDateFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    stayDateTo: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    sort: {
      type: "string",
      enum: ["newest", "booking_code_asc", "booking_code_desc"],
      default: "newest",
    },
    page: { type: "integer", minimum: 1, default: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
} as const;

function validDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const reservationListRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ListQuery }>(
    "/",
    {
      preHandler: app.requirePermission("reservations.view"),
      schema: { querystring: listQuerySchema },
    },
    async (request, reply) => {
      const operationalClock = await getCheckOutClock(app.db);
      const today = operationalClock.serverDate;
      const {
        search,
        source,
        reservationStatus,
        paymentStatus,
        roomAssignment,
        stayDate,
        stayDateFrom,
        stayDateTo,
        sort = "newest",
        page = 1,
        limit = 20,
      } = request.query;
      if (stayDate && !validDate(stayDate)) {
        return reply
          .code(400)
          .send({ error: { code: "INVALID_STAY_DATE", message: "Stay date is invalid" } });
      }
      if (
        (stayDateFrom && !validDate(stayDateFrom)) ||
        (stayDateTo && !validDate(stayDateTo)) ||
        (stayDateFrom && stayDateTo && stayDateFrom > stayDateTo)
      ) {
        return reply.code(400).send({
          error: { code: "INVALID_STAY_DATE_RANGE", message: "Stay date range is invalid" },
        });
      }

      const term = search?.trim();
      const filter = and(
        term
          ? or(
              ilike(reservations.bookingCode, `%${term}%`),
              ilike(guests.fullName, `%${term}%`),
              ilike(guests.phone, `%${term}%`),
              ilike(reservations.externalReference, `%${term}%`),
            )
          : undefined,
        source ? eq(reservations.source, source) : undefined,
        reservationStatus ? eq(reservations.reservationStatus, reservationStatus) : undefined,
        paymentStatus ? eq(reservations.paymentStatus, paymentStatus) : undefined,
        roomAssignment === "unassigned"
          ? exists(
              app.db
                .select({ id: reservationRooms.id })
                .from(reservationRooms)
                .where(
                  and(
                    eq(reservationRooms.reservationId, reservations.id),
                    isNull(reservationRooms.roomUnitId),
                  ),
                ),
            )
          : undefined,
        stayDate
          ? and(lte(reservations.checkInDate, stayDate), gt(reservations.checkOutDate, stayDate))
          : undefined,
        stayDateFrom && stayDateTo
          ? and(
              lte(reservations.checkInDate, stayDateTo),
              gt(reservations.checkOutDate, stayDateFrom),
            )
          : undefined,
      );
      const ordering =
        sort === "booking_code_asc"
          ? [asc(reservations.bookingCode), desc(reservations.id)]
          : sort === "booking_code_desc"
            ? [desc(reservations.bookingCode), desc(reservations.id)]
            : [desc(reservations.createdAt), desc(reservations.id)];

      const [rows, [count]] = await Promise.all([
        app.db
          .select({
            id: reservations.id,
            bookingCode: reservations.bookingCode,
            source: reservations.source,
            externalReference: reservations.externalReference,
            checkInDate: reservations.checkInDate,
            checkOutDate: reservations.checkOutDate,
            nights: sql<number>`${reservations.checkOutDate} - ${reservations.checkInDate}`,
            adults: reservations.adults,
            children: reservations.children,
            reservationStatus: reservations.reservationStatus,
            paymentStatus: reservations.paymentStatus,
            createdAt: reservations.createdAt,
            updatedAt: reservations.updatedAt,
            guest: {
              id: guests.id,
              fullName: guests.fullName,
              phone: guests.phone,
              email: guests.email,
            },
            otaChannel: {
              id: masterItems.id,
              code: masterItems.code,
              name: masterItems.name,
            },
          })
          .from(reservations)
          .innerJoin(guests, eq(reservations.guestId, guests.id))
          .leftJoin(masterItems, eq(reservations.otaChannelId, masterItems.id))
          .where(filter)
          .orderBy(...ordering)
          .limit(limit)
          .offset((page - 1) * limit),
        app.db
          .select({ total: sql<number>`count(*)::int` })
          .from(reservations)
          .innerJoin(guests, eq(reservations.guestId, guests.id))
          .where(filter),
      ]);

      const ids = rows.map((row) => row.id);
      const [rooms, totals] = ids.length
        ? await Promise.all([
            app.db
              .select({
                id: reservationRooms.id,
                reservationId: reservationRooms.reservationId,
                roomTypeId: reservationRooms.roomTypeId,
                roomTypeName: reservationRooms.roomTypeNameSnapshot,
                roomUnitId: reservationRooms.roomUnitId,
                roomNumber: roomUnits.roomNumber,
              })
              .from(reservationRooms)
              .leftJoin(roomUnits, eq(reservationRooms.roomUnitId, roomUnits.id))
              .where(inArray(reservationRooms.reservationId, ids))
              .orderBy(asc(reservationRooms.createdAt), asc(reservationRooms.id)),
            app.db
              .select({
                reservationId: reservationCharges.reservationId,
                bookingTotal:
                  sql<number>`coalesce(sum(${reservationCharges.amount}), 0)::bigint`.mapWith(
                    Number,
                  ),
              })
              .from(reservationCharges)
              .where(inArray(reservationCharges.reservationId, ids))
              .groupBy(reservationCharges.reservationId),
          ])
        : [[], []];

      const roomsByReservation = new Map<string, typeof rooms>();
      for (const room of rooms) {
        const grouped = roomsByReservation.get(room.reservationId) ?? [];
        grouped.push(room);
        roomsByReservation.set(room.reservationId, grouped);
      }
      const totalsByReservation = new Map(
        totals.map((total) => [total.reservationId, total.bookingTotal]),
      );

      return {
        items: rows.map((row) => ({
          ...row,
          operationalStatus: resolveReservationOperationalStatus(
            row.reservationStatus,
            row.checkInDate,
            row.checkOutDate,
            operationalClock,
          ),
          rooms: roomsByReservation.get(row.id) ?? [],
          roomCount: roomsByReservation.get(row.id)?.length ?? 0,
          bookingTotal: totalsByReservation.get(row.id) ?? 0,
        })),
        page,
        limit,
        total: count.total,
      };
    },
  );
};
