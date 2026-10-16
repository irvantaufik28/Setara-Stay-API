import { and, asc, count, desc, eq, gt, inArray, lt, lte, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { guests } from "../../../db/schema/guests.schema.js";
import { paymentRefunds } from "../../../db/schema/payment_refunds.schema.js";
import { payments } from "../../../db/schema/payments.schema.js";
import { reservationCharges } from "../../../db/schema/reservation_charges.schema.js";
import { reservationRooms } from "../../../db/schema/reservation_rooms.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import { roomInventoryDaily } from "../../../db/schema/room_inventory_daily.schema.js";
import { roomTypes } from "../../../db/schema/room_types.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import { getCheckOutClock } from "../../reservations/services/reservation-check-out-time.service.js";

const activeStatuses = ["pending", "confirmed", "checked_in"] as const;
const outstandingStatuses = ["unpaid", "partial"] as const;
type ActivityType = "Arrival" | "Departure" | "Payment" | "Overdue";

export async function getDashboard(app: FastifyInstance) {
  const clock = await getCheckOutClock(app.db);
  const today = clock.serverDate;
  const activityConditions = {
    Arrival: and(
      eq(reservations.checkInDate, today),
      eq(reservations.reservationStatus, "confirmed"),
    ),
    Departure: clock.afterCheckOutTime
      ? sql`false`
      : and(eq(reservations.checkOutDate, today), eq(reservations.reservationStatus, "checked_in")),
    Payment: and(
      inArray(reservations.reservationStatus, activeStatuses),
      inArray(reservations.paymentStatus, outstandingStatuses),
    ),
    Overdue: and(
      clock.afterCheckOutTime
        ? lte(reservations.checkOutDate, today)
        : lt(reservations.checkOutDate, today),
      eq(reservations.reservationStatus, "checked_in"),
    ),
  };
  const activityTypes: ActivityType[] = ["Overdue", "Departure", "Arrival", "Payment"];

  const [
    summaryRows,
    outstandingRows,
    activityGroups,
    recentRows,
    inventoryRows,
    bookedRows,
    operationalRows,
  ] = await Promise.all([
    app.db
      .select({
        arrivalsToday:
          sql<number>`count(*) filter (where ${reservations.checkInDate} = ${today} and ${reservations.reservationStatus} in ('confirmed', 'checked_in'))::int`.mapWith(
            Number,
          ),
        arrivalsPending:
          sql<number>`count(*) filter (where ${reservations.checkInDate} = ${today} and ${reservations.reservationStatus} = 'confirmed')::int`.mapWith(
            Number,
          ),
        departuresToday:
          sql<number>`count(*) filter (where ${reservations.checkOutDate} = ${today} and ${reservations.reservationStatus} in ('checked_in', 'checked_out'))::int`.mapWith(
            Number,
          ),
        departuresPending:
          sql<number>`count(*) filter (where ${reservations.checkOutDate} = ${today} and ${reservations.reservationStatus} = 'checked_in')::int`.mapWith(
            Number,
          ),
        inHouse:
          sql<number>`count(*) filter (where ${reservations.reservationStatus} = 'checked_in')::int`.mapWith(
            Number,
          ),
        pendingPayment:
          sql<number>`count(*) filter (where ${reservations.reservationStatus} in ('pending', 'confirmed', 'checked_in') and ${reservations.paymentStatus} in ('unpaid', 'partial'))::int`.mapWith(
            Number,
          ),
        overdue:
          sql<number>`count(*) filter (where (${reservations.checkOutDate} < ${today} or (${reservations.checkOutDate} = ${today} and ${clock.afterCheckOutTime})) and ${reservations.reservationStatus} = 'checked_in')::int`.mapWith(
            Number,
          ),
      })
      .from(reservations),
    app.db
      .select({ id: reservations.id })
      .from(reservations)
      .where(
        and(
          inArray(reservations.reservationStatus, activeStatuses),
          inArray(reservations.paymentStatus, outstandingStatuses),
        ),
      ),
    Promise.all(
      activityTypes.map((type) =>
        app.db
          .select({
            reservationId: reservations.id,
            bookingCode: reservations.bookingCode,
            guestName: guests.fullName,
            source: reservations.source,
            checkInDate: reservations.checkInDate,
            checkOutDate: reservations.checkOutDate,
            reservationStatus: reservations.reservationStatus,
            paymentStatus: reservations.paymentStatus,
          })
          .from(reservations)
          .innerJoin(guests, eq(reservations.guestId, guests.id))
          .where(activityConditions[type])
          .orderBy(asc(reservations.checkOutDate), desc(reservations.createdAt))
          .limit(6),
      ),
    ),
    app.db
      .select({
        reservationId: reservations.id,
        bookingCode: reservations.bookingCode,
        guestName: guests.fullName,
        source: reservations.source,
        checkInDate: reservations.checkInDate,
        checkOutDate: reservations.checkOutDate,
        reservationStatus: reservations.reservationStatus,
        paymentStatus: reservations.paymentStatus,
        createdAt: reservations.createdAt,
      })
      .from(reservations)
      .innerJoin(guests, eq(reservations.guestId, guests.id))
      .orderBy(desc(reservations.createdAt), desc(reservations.id))
      .limit(5),
    app.db
      .select({
        roomTypeId: roomTypes.id,
        roomTypeName: roomTypes.name,
        configuredStock: roomInventoryDaily.sellableStock,
        stopSell: roomInventoryDaily.stopSell,
      })
      .from(roomTypes)
      .leftJoin(
        roomInventoryDaily,
        and(
          eq(roomInventoryDaily.roomTypeId, roomTypes.id),
          eq(roomInventoryDaily.stayDate, today),
        ),
      )
      .where(eq(roomTypes.isActive, true))
      .orderBy(asc(roomTypes.name)),
    app.db
      .select({ roomTypeId: reservationRooms.roomTypeId, booked: count() })
      .from(reservationRooms)
      .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
      .where(
        and(
          lte(reservations.checkInDate, today),
          gt(reservations.checkOutDate, today),
          inArray(reservations.reservationStatus, activeStatuses),
        ),
      )
      .groupBy(reservationRooms.roomTypeId),
    app.db
      .select({ roomTypeId: roomUnits.roomTypeId, total: count() })
      .from(roomUnits)
      .where(
        and(
          eq(roomUnits.isActive, true),
          notInArray(roomUnits.operationalStatus, ["maintenance", "out_of_service"]),
        ),
      )
      .groupBy(roomUnits.roomTypeId),
  ]);

  const summary = summaryRows[0];
  const outstandingIds = outstandingRows.map((row) => row.id);
  const [chargeTotals, paymentTotals, refundTotals] = outstandingIds.length
    ? await Promise.all([
        app.db
          .select({
            reservationId: reservationCharges.reservationId,
            amount: sql<number>`sum(${reservationCharges.amount})::bigint`.mapWith(Number),
          })
          .from(reservationCharges)
          .where(inArray(reservationCharges.reservationId, outstandingIds))
          .groupBy(reservationCharges.reservationId),
        app.db
          .select({
            reservationId: payments.reservationId,
            amount: sql<number>`sum(${payments.amount})::bigint`.mapWith(Number),
          })
          .from(payments)
          .where(
            and(
              inArray(payments.reservationId, outstandingIds),
              inArray(payments.status, ["succeeded", "partially_refunded", "refunded"]),
            ),
          )
          .groupBy(payments.reservationId),
        app.db
          .select({
            reservationId: payments.reservationId,
            amount: sql<number>`sum(${paymentRefunds.amount})::bigint`.mapWith(Number),
          })
          .from(paymentRefunds)
          .innerJoin(payments, eq(paymentRefunds.paymentId, payments.id))
          .where(
            and(
              inArray(payments.reservationId, outstandingIds),
              eq(paymentRefunds.status, "succeeded"),
            ),
          )
          .groupBy(payments.reservationId),
      ])
    : [[], [], []];
  const chargesById = new Map(chargeTotals.map((row) => [row.reservationId, row.amount]));
  const paymentsById = new Map(paymentTotals.map((row) => [row.reservationId, row.amount]));
  const refundsById = new Map(refundTotals.map((row) => [row.reservationId, row.amount]));
  const outstandingAmount = outstandingIds.reduce(
    (sum, id) =>
      sum +
      Math.max(
        0,
        (chargesById.get(id) ?? 0) - (paymentsById.get(id) ?? 0) + (refundsById.get(id) ?? 0),
      ),
    0,
  );
  const candidates = activityTypes.map((type, index) =>
    activityGroups[index].map((row) => ({
      ...row,
      type,
      status: type === "Payment" ? row.paymentStatus : row.reservationStatus,
      url: `/reservations/${row.reservationId}`,
    })),
  );
  const activities = [] as (typeof candidates)[number];
  for (let position = 0; activities.length < 6 && position < 6; position++) {
    for (const group of candidates) {
      const item = group[position];
      if (item) activities.push(item);
      if (activities.length === 6) break;
    }
  }

  const visibleReservationIds = [
    ...new Set([...activities, ...recentRows].map((row) => row.reservationId)),
  ];
  const roomRows = visibleReservationIds.length
    ? await app.db
        .select({
          reservationId: reservationRooms.reservationId,
          roomTypeName: reservationRooms.roomTypeNameSnapshot,
        })
        .from(reservationRooms)
        .where(inArray(reservationRooms.reservationId, visibleReservationIds))
    : [];
  const roomNames = new Map<string, string[]>();
  for (const room of roomRows) {
    const names = roomNames.get(room.reservationId) ?? [];
    names.push(room.roomTypeName);
    roomNames.set(room.reservationId, names);
  }
  const bookedByType = new Map(bookedRows.map((row) => [row.roomTypeId, row.booked]));
  const operationalByType = new Map(operationalRows.map((row) => [row.roomTypeId, row.total]));

  return {
    date: today,
    summary: {
      ...summary,
      outstandingAmount,
    },
    todayActivity: {
      totalShown: activities.length,
      items: activities.map((item) => ({
        ...item,
        roomSummary: (roomNames.get(item.reservationId) ?? []).join(", "),
      })),
    },
    recentReservations: recentRows.map((row) => ({
      ...row,
      roomSummary: (roomNames.get(row.reservationId) ?? []).join(", "),
      url: `/reservations/${row.reservationId}`,
    })),
    todayAvailability: inventoryRows.map((row) => ({
      roomTypeId: row.roomTypeId,
      roomTypeName: row.roomTypeName,
      configuredStock: row.configuredStock,
      booked: bookedByType.get(row.roomTypeId) ?? 0,
      available:
        row.configuredStock === null
          ? null
          : row.stopSell
            ? 0
            : Math.max(
                0,
                Math.min(row.configuredStock, operationalByType.get(row.roomTypeId) ?? 0) -
                  (bookedByType.get(row.roomTypeId) ?? 0),
              ),
      stopSell: row.stopSell ?? false,
      isConfigured: row.configuredStock !== null,
    })),
  };
}
