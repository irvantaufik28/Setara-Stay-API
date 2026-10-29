import { and, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { masterItems } from "../../../db/schema/master_items.schema.js";
import { guests } from "../../../db/schema/guests.schema.js";
import { reservationDeposits } from "../../../db/schema/reservation_deposits.schema.js";
import { reservationRooms } from "../../../db/schema/reservation_rooms.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import { roomStatusEvents } from "../../../db/schema/room_status_events.schema.js";
import { readActiveMaintenanceBlocks } from "../../rooms/services/room-maintenance.service.js";
import { uuidSchema } from "../../master/master.shared.js";
import { recordReservationEvent } from "../services/reservation-events.service.js";
import { readReservationFinancials } from "../services/reservation-financials.service.js";
import { getCheckInWarning } from "../reservation-status.js";
import { bookingDateJakarta } from "../services/reservations-campaigns.service.js";
import {
  addEarlyCheckInCharge,
  EarlyCheckInError,
  getEarlyCheckInContext,
  type EarlyCheckInInput,
} from "../services/reservation-early-check-in.service.js";

type CheckInParams = { id: string };
type CheckInBody = {
  guestNik?: string;
  acknowledgeOutstanding?: boolean;
  rooms?: { reservationRoomId: string; roomUnitId: string }[];
  deposit?: { amount: number; methodId: string; notes?: string };
  earlyCheckIn?: EarlyCheckInInput;
};

const paramsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: uuidSchema },
} as const;

const bodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    guestNik: { type: "string", maxLength: 32 },
    acknowledgeOutstanding: { type: "boolean" },
    rooms: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["reservationRoomId", "roomUnitId"],
        properties: { reservationRoomId: uuidSchema, roomUnitId: uuidSchema },
      },
    },
    deposit: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "methodId"],
      properties: {
        amount: { type: "integer", minimum: 1 },
        methodId: uuidSchema,
        notes: { type: "string", maxLength: 1000 },
      },
    },
    earlyCheckIn: {
      type: "object",
      additionalProperties: false,
      required: ["acknowledged", "chargeAmount", "paymentTiming"],
      properties: {
        acknowledged: { type: "boolean" },
        chargeAmount: { type: "integer", minimum: 0, maximum: 9007199254740991 },
        paymentTiming: { type: "string", enum: ["now", "later"] },
        paymentMethodId: uuidSchema,
      },
    },
  },
} as const;

class CheckInInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export const reservationCheckInRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { checkInDate: string } }>(
    "/check-in-context",
    {
      preHandler: app.requirePermission("reservations.check_in"),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["checkInDate"],
          properties: { checkInDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
        },
      },
    },
    async (request) => getEarlyCheckInContext(app.db, request.query.checkInDate),
  );

  app.post<{ Params: CheckInParams; Body: CheckInBody }>(
    "/:id/check-in",
    {
      preHandler: app.requirePermission("reservations.check_in"),
      schema: { params: paramsSchema, body: bodySchema },
    },
    async (request, reply) => {
      try {
        const result = await app.db.transaction(async (tx) => {
          const [reservation] = await tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, request.params.id))
            .for("update")
            .limit(1);
          if (!reservation) {
            throw new CheckInInputError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
          }

          const warning = getCheckInWarning(
            reservation.reservationStatus,
            reservation.paymentStatus,
          );
          if (warning === "not_allowed") {
            throw new CheckInInputError(
              "CHECK_IN_NOT_ALLOWED",
              "Reservation must be confirmed with Unpaid, Partial, or Paid payment status",
            );
          }
          if (reservation.checkInDate > bookingDateJakarta()) {
            throw new CheckInInputError(
              "CHECK_IN_DATE_NOT_TODAY",
              "Check-in is only available on or after the check-in date",
            );
          }
          const earlyContext = await getEarlyCheckInContext(tx, reservation.checkInDate);
          const early = request.body?.earlyCheckIn;
          if (earlyContext.required && early?.acknowledged !== true) {
            throw new CheckInInputError(
              "EARLY_CHECK_IN_CONFIRMATION_REQUIRED",
              "Confirm early check-in before the standard check-in time",
            );
          }
          if (
            earlyContext.required &&
            early &&
            early.paymentTiming === "now" &&
            early.chargeAmount > 0 &&
            !early.paymentMethodId
          ) {
            throw new CheckInInputError(
              "INVALID_EARLY_CHECK_IN",
              "Early check-in details or payment method are invalid",
              400,
            );
          }
          if (warning !== "none" && !earlyContext.allowOutstandingCheckIn) {
            throw new CheckInInputError(
              "OUTSTANDING_CHECK_IN_DISABLED",
              "Check-in requires full payment because outstanding check-in is disabled",
            );
          }
          if (warning !== "none" && request.body?.acknowledgeOutstanding !== true) {
            throw new CheckInInputError(
              "OUTSTANDING_CONFIRMATION_REQUIRED",
              "Confirm the outstanding balance before check-in",
            );
          }

          const bookedRooms = await tx
            .select()
            .from(reservationRooms)
            .where(eq(reservationRooms.reservationId, reservation.id))
            .orderBy(reservationRooms.id);
          if (!bookedRooms.length) {
            throw new CheckInInputError("ROOM_ASSIGNMENT_REQUIRED", "Reservation has no rooms");
          }

          const requested = request.body?.rooms ?? [];
          const assignments = new Map(
            requested.map((room) => [room.reservationRoomId, room.roomUnitId]),
          );
          if (assignments.size !== requested.length) {
            throw new CheckInInputError(
              "DUPLICATE_ROOM_ASSIGNMENT",
              "A reservation room was assigned twice",
              400,
            );
          }
          const bookedRoomIds = new Set(bookedRooms.map((room) => room.id));
          if (requested.some((room) => !bookedRoomIds.has(room.reservationRoomId))) {
            throw new CheckInInputError(
              "INVALID_RESERVATION_ROOM",
              "Room does not belong to this reservation",
              400,
            );
          }

          const finalAssignments = bookedRooms.map((room) => {
            const selected = assignments.get(room.id);
            if (room.roomUnitId && selected && selected !== room.roomUnitId) {
              throw new CheckInInputError(
                "ROOM_CHANGE_NOT_ALLOWED",
                "Use Change Room to replace a previously assigned room",
              );
            }
            const roomUnitId = room.roomUnitId ?? selected;
            if (!roomUnitId) {
              throw new CheckInInputError(
                "ROOM_ASSIGNMENT_REQUIRED",
                "Assign a room number to every reservation room before check-in",
              );
            }
            return { room, roomUnitId };
          });
          const unitIds = finalAssignments.map((assignment) => assignment.roomUnitId);
          if (new Set(unitIds).size !== unitIds.length) {
            throw new CheckInInputError(
              "DUPLICATE_ROOM_UNIT",
              "A room number can only be assigned once",
              400,
            );
          }

          const units = await tx
            .select()
            .from(roomUnits)
            .where(inArray(roomUnits.id, [...unitIds].sort()))
            .orderBy(roomUnits.id)
            .for("update");
          const unitsById = new Map(units.map((unit) => [unit.id, unit]));
          const maintenanceBlocks = await readActiveMaintenanceBlocks(
            tx,
            reservation.checkInDate,
            reservation.checkOutDate,
            [...new Set(bookedRooms.map((room) => room.roomTypeId))],
          );
          const blockedUnitIds = new Set(maintenanceBlocks.map((block) => block.roomUnitId));
          for (const { room, roomUnitId } of finalAssignments) {
            const unit = unitsById.get(roomUnitId);
            if (
              !unit ||
              unit.roomTypeId !== room.roomTypeId ||
              !unit.isActive ||
              blockedUnitIds.has(roomUnitId) ||
              unit.operationalStatus !== "available"
            ) {
              throw new CheckInInputError(
                "ROOM_UNIT_UNAVAILABLE",
                `Room unit ${roomUnitId} is not available for check-in`,
              );
            }
          }

          const overlapping = await tx
            .select({ roomUnitId: reservationRooms.roomUnitId })
            .from(reservationRooms)
            .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
            .where(
              and(
                inArray(reservationRooms.roomUnitId, unitIds),
                ne(reservations.id, reservation.id),
                inArray(reservations.reservationStatus, ["pending", "confirmed", "checked_in"]),
                lt(reservations.checkInDate, reservation.checkOutDate),
                gt(reservations.checkOutDate, reservation.checkInDate),
              ),
            );
          if (overlapping.length) {
            throw new CheckInInputError(
              "ROOM_UNIT_UNAVAILABLE",
              "A room number is assigned to another reservation for this stay",
            );
          }

          const { remainingBalance: originalBalance } = await readReservationFinancials(
            tx,
            reservation.id,
          );
          const projectedOutstanding =
            originalBalance +
            (earlyContext.required && early?.paymentTiming === "later" ? early.chargeAmount : 0);
          if (projectedOutstanding > 0 && !earlyContext.allowOutstandingCheckIn) {
            throw new CheckInInputError(
              "OUTSTANDING_CHECK_IN_DISABLED",
              "Check-in requires full payment because outstanding check-in is disabled",
            );
          }
          if (originalBalance > 0 && request.body?.acknowledgeOutstanding !== true) {
            throw new CheckInInputError(
              "OUTSTANDING_CONFIRMATION_REQUIRED",
              "Confirm the outstanding balance before check-in",
            );
          }

          if (request.body?.deposit) {
            const [method] = await tx
              .select({ id: masterItems.id })
              .from(masterItems)
              .where(
                and(
                  eq(masterItems.id, request.body.deposit.methodId),
                  eq(masterItems.category, "payment_methods"),
                  eq(masterItems.isActive, true),
                ),
              )
              .limit(1);
            if (!method) {
              throw new CheckInInputError(
                "INVALID_DEPOSIT_METHOD",
                "Select an active deposit payment method",
                400,
              );
            }
          }

          for (const { room, roomUnitId } of finalAssignments) {
            if (room.roomUnitId) continue;
            await tx
              .update(reservationRooms)
              .set({
                roomUnitId,
                bedConfigurationSnapshot: unitsById.get(roomUnitId)!.bedConfiguration,
                updatedAt: new Date(),
              })
              .where(eq(reservationRooms.id, room.id));
          }
          await tx
            .update(roomUnits)
            .set({ operationalStatus: "occupied", updatedAt: new Date() })
            .where(inArray(roomUnits.id, unitIds));
          if (unitIds.length)
            await tx
              .insert(roomStatusEvents)
              .values(
                unitIds.map((roomUnitId) => ({
                  roomUnitId,
                  statusBefore: "available",
                  statusAfter: "occupied",
                  actorUserId: request.authUser!.id,
                  source: "checkin",
                })),
              );

          const checkedInAt = new Date();
          const guestNik = request.body?.guestNik?.trim();
          if (guestNik) {
            await tx
              .update(guests)
              .set({ nik: guestNik, updatedAt: checkedInAt })
              .where(eq(guests.id, reservation.guestId));
          }
          const earlyCharge =
            earlyContext.required && early
              ? await addEarlyCheckInCharge(tx, {
                  reservationId: reservation.id,
                  checkInDate: reservation.checkInDate,
                  actorUserId: request.authUser!.id,
                  earlyCheckIn: early,
                })
              : null;
          const financials = await readReservationFinancials(tx, reservation.id);
          const remainingBalance = financials.remainingBalance;
          const paymentStatus =
            financials.netPaidAmount >= financials.bookingTotal
              ? "paid"
              : financials.netPaidAmount > 0
                ? "partial"
                : "unpaid";
          const [heldDeposit] = request.body?.deposit
            ? await tx
                .insert(reservationDeposits)
                .values({
                  reservationId: reservation.id,
                  methodId: request.body.deposit.methodId,
                  amountHeld: request.body.deposit.amount,
                  notes: request.body.deposit.notes?.trim() || null,
                })
                .returning({ id: reservationDeposits.id })
            : [];
          if (earlyCharge?.chargeId) {
            await recordReservationEvent(tx, {
              reservationId: reservation.id,
              eventType: "reservation.early_check_in_charged",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: checkedInAt,
              reservationStatusBefore: reservation.reservationStatus,
              reservationStatusAfter: reservation.reservationStatus,
              paymentStatusBefore: reservation.paymentStatus,
              paymentStatusAfter: paymentStatus,
              referenceId: earlyCharge.chargeId,
              details: { amount: early!.chargeAmount, paymentTiming: early!.paymentTiming },
            });
          }
          if (earlyCharge?.paymentId) {
            await recordReservationEvent(tx, {
              reservationId: reservation.id,
              eventType: "payment.recorded",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: checkedInAt,
              reservationStatusBefore: reservation.reservationStatus,
              reservationStatusAfter: reservation.reservationStatus,
              paymentStatusBefore: reservation.paymentStatus,
              paymentStatusAfter: paymentStatus,
              referenceId: earlyCharge.paymentId,
              details: {
                amount: early!.chargeAmount,
                methodId: early!.paymentMethodId,
                source: "early_check_in",
              },
            });
          }
          await tx
            .update(reservations)
            .set({
              reservationStatus: "checked_in",
              paymentStatus,
              checkedInAt,
              version: sql`${reservations.version} + 1`,
              updatedAt: checkedInAt,
            })
            .where(eq(reservations.id, reservation.id));
          if (heldDeposit) {
            await recordReservationEvent(tx, {
              reservationId: reservation.id,
              eventType: "deposit.held",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: checkedInAt,
              reservationStatusBefore: reservation.reservationStatus,
              reservationStatusAfter: reservation.reservationStatus,
              paymentStatusBefore: reservation.paymentStatus,
              paymentStatusAfter: reservation.paymentStatus,
              referenceId: heldDeposit.id,
              details: {
                amount: request.body!.deposit!.amount,
                methodId: request.body!.deposit!.methodId,
              },
            });
          }
          await recordReservationEvent(tx, {
            reservationId: reservation.id,
            eventType: "guest.checked_in",
            actorType: "user",
            actorUserId: request.authUser!.id,
            occurredAt: checkedInAt,
            reservationStatusBefore: reservation.reservationStatus,
            reservationStatusAfter: "checked_in",
            paymentStatusBefore: reservation.paymentStatus,
            paymentStatusAfter: paymentStatus,
            details: {
              rooms: finalAssignments.map(({ room, roomUnitId }) => ({
                reservationRoomId: room.id,
                roomUnitId,
                roomNumber: unitsById.get(roomUnitId)!.roomNumber,
              })),
              remainingBalance,
              outstandingAcknowledged: originalBalance > 0,
              depositId: heldDeposit?.id ?? null,
              earlyCheckIn: earlyContext.required
                ? {
                    standardCheckInTime: earlyContext.standardCheckInTime,
                    serverTime: earlyContext.serverTime,
                    chargeAmount: early?.chargeAmount ?? 0,
                    paymentTiming: early?.paymentTiming ?? "later",
                    chargeId: earlyCharge?.chargeId ?? null,
                    paymentId: earlyCharge?.paymentId ?? null,
                  }
                : null,
            },
          });

          return {
            reservationId: reservation.id,
            bookingCode: reservation.bookingCode,
            reservationStatus: "checked_in" as const,
            paymentStatus,
            checkedInAt,
            remainingBalance,
            rooms: finalAssignments.map(({ room, roomUnitId }) => ({
              reservationRoomId: room.id,
              roomUnitId,
              roomNumber: unitsById.get(roomUnitId)!.roomNumber,
            })),
          };
        });
        return result;
      } catch (error) {
        if (error instanceof EarlyCheckInError) {
          return reply.code(400).send({ error: { code: error.code, message: error.message } });
        }
        if (error instanceof CheckInInputError) {
          return reply.code(error.statusCode).send({
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    },
  );
};
