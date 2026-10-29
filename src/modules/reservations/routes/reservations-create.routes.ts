import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { cancellationPolicies } from "../../../db/schema/cancellation_policies.schema.js";
import { cancellationPolicyRoomTypes } from "../../../db/schema/cancellation_policy_room_types.schema.js";
import { cancellationRules } from "../../../db/schema/cancellation_rules.schema.js";
import { capacityPatterns } from "../../../db/schema/capacity_patterns.schema.js";
import { experienceVariants } from "../../../db/schema/experience_variants.schema.js";
import { experiences } from "../../../db/schema/experiences.schema.js";
import { guests } from "../../../db/schema/guests.schema.js";
import { masterItems } from "../../../db/schema/master_items.schema.js";
import { payments } from "../../../db/schema/payments.schema.js";
import { permissions } from "../../../db/schema/permissions.schema.js";
import { reservationCharges } from "../../../db/schema/reservation_charges.schema.js";
import { reservationDeposits } from "../../../db/schema/reservation_deposits.schema.js";
import { reservationExperiences } from "../../../db/schema/reservation_experiences.schema.js";
import { reservationRoomExtraBeds } from "../../../db/schema/reservation_room_extra_beds.schema.js";
import { reservationRoomNights } from "../../../db/schema/reservation_room_nights.schema.js";
import { reservationRooms } from "../../../db/schema/reservation_rooms.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import { rolePermissions } from "../../../db/schema/role_permissions.schema.js";
import { roomInventoryDaily } from "../../../db/schema/room_inventory_daily.schema.js";
import { roomTypeCapacityPatterns } from "../../../db/schema/room_type_capacity_patterns.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import { roomStatusEvents } from "../../../db/schema/room_status_events.schema.js";
import { readActiveMaintenanceBlocks } from "../../rooms/services/room-maintenance.service.js";
import { recordReservationEvent } from "../services/reservation-events.service.js";
import {
  addEarlyCheckInCharge,
  EarlyCheckInError,
  getEarlyCheckInContext,
} from "../services/reservation-early-check-in.service.js";
import { requestHash } from "../reservation-idempotency.js";
import {
  calculateReservationTotal,
  ReservationTotalError,
} from "../services/reservation-total.service.js";
import { databaseErrorCode, uuidSchema } from "../../master/master.shared.js";
import { readRoomAvailability, stayDates } from "../services/reservations-availability.service.js";
import {
  bookingDateJakarta,
  InvalidPromoCodeError,
  priceRoomNights,
} from "../services/reservations-campaigns.service.js";
import {
  availabilityQuerySchema,
  createReservationBodySchema,
  reservationQuoteBodySchema,
  type CreateReservationBody,
  type ReservationQuoteBody,
} from "../schemas/reservations-create.schema.js";

type AvailabilityQuery = {
  checkInDate: string;
  checkOutDate: string;
  roomTypeId?: string;
  adults?: number;
  children?: number;
};

class ReservationInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });
const nullable = (value: string | null | undefined) => value?.trim() || null;

function guestAllocationError(input: {
  rooms: { adults: number; children: number }[];
  totalAdults?: number;
  totalChildren?: number;
}) {
  if ((input.totalAdults === undefined) !== (input.totalChildren === undefined)) {
    return errorBody("INVALID_GUEST_COUNT", "Provide both totalAdults and totalChildren");
  }
  if (input.totalAdults === undefined) return null;
  const adults = input.rooms.reduce((sum, room) => sum + room.adults, 0);
  const children = input.rooms.reduce((sum, room) => sum + room.children, 0);
  return adults === input.totalAdults && children === input.totalChildren
    ? null
    : errorBody(
        "GUEST_ALLOCATION_MISMATCH",
        `Room allocation has ${adults} adult(s) and ${children} child(ren); expected ${input.totalAdults} adult(s) and ${input.totalChildren} child(ren)`,
      );
}

export const reservationCreateRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: AvailabilityQuery }>(
    "/availability",
    {
      preHandler: app.requirePermission("reservations.create"),
      schema: { querystring: availabilityQuerySchema },
    },
    async (request, reply) => {
      const { checkInDate, checkOutDate, roomTypeId, adults, children } = request.query;
      if ((adults === undefined) !== (children === undefined)) {
        return reply
          .code(400)
          .send(errorBody("INVALID_GUEST_COUNT", "Provide both adults and children"));
      }
      const dates = stayDates(checkInDate, checkOutDate);
      if (!dates) {
        return reply
          .code(400)
          .send(errorBody("INVALID_STAY_DATES", "Use valid dates for a stay of 1 to 366 nights"));
      }
      const items = await readRoomAvailability(
        app.db,
        checkInDate,
        checkOutDate,
        dates,
        roomTypeId ? [roomTypeId] : undefined,
        adults === undefined || children === undefined ? undefined : { adults, children },
      );
      return {
        checkInDate,
        checkOutDate,
        adults: adults ?? null,
        children: children ?? null,
        nights: dates.length,
        items,
      };
    },
  );

  app.post<{ Body: ReservationQuoteBody }>(
    "/quote",
    {
      preHandler: app.requirePermission("reservations.create"),
      schema: { body: reservationQuoteBodySchema },
    },
    async (request, reply) => {
      const {
        source,
        checkInDate,
        checkOutDate,
        promoCode,
        rooms,
        experiences: selectedExperiences = [],
      } = request.body;
      const dates = stayDates(checkInDate, checkOutDate);
      if (!dates) {
        return reply
          .code(400)
          .send(errorBody("INVALID_STAY_DATES", "Use valid dates for a stay of 1 to 366 nights"));
      }
      const roomCount = rooms.length;
      if (source === "ota" && (promoCode || rooms.some((room) => !room.otaRatePerNight))) {
        return reply
          .code(400)
          .send(
            errorBody(
              "INVALID_OTA_QUOTE",
              "OTA quote requires a voucher rate for every room and cannot use a promo code",
            ),
          );
      }
      if (source !== "ota" && rooms.some((room) => room.otaRatePerNight !== undefined)) {
        return reply
          .code(400)
          .send(
            errorBody(
              "INVALID_SOURCE_FIELDS",
              "Voucher rates are only available for OTA reservations",
            ),
          );
      }
      if (rooms.every((room) => room.adults === 0 && room.children === 0)) {
        return reply.code(400).send(errorBody("INVALID_ROOMS", "At least one guest is required"));
      }
      const quoteAllocationError = guestAllocationError(request.body);
      if (quoteAllocationError) return reply.code(400).send(quoteAllocationError);
      const requested = new Map<string, number>();
      for (const room of rooms) {
        requested.set(room.roomTypeId, (requested.get(room.roomTypeId) ?? 0) + 1);
      }
      const options = await readRoomAvailability(app.db, checkInDate, checkOutDate, dates, [
        ...requested.keys(),
      ]);
      const byType = new Map(options.map((option) => [option.roomType.id, option]));
      for (const [roomTypeId, quantity] of requested) {
        const option = byType.get(roomTypeId);
        if (
          !option ||
          (source !== "ota" && (!option.bookable || option.availableRooms < quantity))
        ) {
          return reply
            .code(409)
            .send(errorBody("ROOM_UNAVAILABLE", `Room type ${roomTypeId} is unavailable`));
        }
      }
      const selectedUnitIds = rooms
        .map((room) => room.roomUnitId)
        .filter((id): id is string => Boolean(id));
      if (new Set(selectedUnitIds).size !== selectedUnitIds.length) {
        return reply
          .code(400)
          .send(errorBody("DUPLICATE_ROOM", "A room number can only be assigned once"));
      }
      for (const room of rooms) {
        if (
          room.roomUnitId &&
          !byType
            .get(room.roomTypeId)!
            .assignableRoomUnits.some((unit) => unit.id === room.roomUnitId)
        ) {
          return reply
            .code(409)
            .send(errorBody("ROOM_UNIT_UNAVAILABLE", "Assigned room is unavailable for this stay"));
        }
      }
      const capacities = await app.db
        .select({
          roomTypeId: roomTypeCapacityPatterns.roomTypeId,
          adults: capacityPatterns.adults,
          children: capacityPatterns.children,
          extraBeds: roomTypeCapacityPatterns.extraBeds,
        })
        .from(roomTypeCapacityPatterns)
        .innerJoin(
          capacityPatterns,
          eq(roomTypeCapacityPatterns.capacityPatternId, capacityPatterns.id),
        )
        .where(
          and(
            inArray(roomTypeCapacityPatterns.roomTypeId, [...requested.keys()]),
            eq(capacityPatterns.isActive, true),
          ),
        );
      for (const [roomIndex, room] of rooms.entries()) {
        if (
          !capacities.some(
            (capacity) =>
              capacity.roomTypeId === room.roomTypeId &&
              capacity.adults === room.adults &&
              capacity.children === room.children &&
              capacity.extraBeds <= (room.extraBeds ?? 0),
          )
        ) {
          return reply
            .code(400)
            .send(
              errorBody(
                "INVALID_CAPACITY",
                `Room ${roomIndex + 1}: guest count or extra beds are not allowed for this room type`,
              ),
            );
        }
      }
      try {
        const price = await priceRoomNights(app.db, {
          source,
          promoCode,
          bookingDate: bookingDateJakarta(),
          nights: dates.length,
          roomCount,
          rows: rooms.flatMap((room, roomIndex) =>
            (source === "ota"
              ? dates.map((stayDate) => ({ stayDate, basePrice: room.otaRatePerNight! }))
              : byType.get(room.roomTypeId)!.nightlyRates.map((night) => ({
                  stayDate: night.stayDate,
                  basePrice: night.basePrice!,
                }))
            ).map((night) => ({
              roomIndex,
              roomTypeId: room.roomTypeId,
              stayDate: night.stayDate,
              basePrice: night.basePrice,
            })),
          ),
        });
        const selectedVariants = selectedExperiences.length
          ? await app.db
              .select({ variant: experienceVariants, experience: experiences })
              .from(experienceVariants)
              .innerJoin(experiences, eq(experienceVariants.experienceId, experiences.id))
              .where(
                inArray(
                  experienceVariants.id,
                  selectedExperiences.map((item) => item.variantId),
                ),
              )
          : [];
        for (const item of selectedExperiences) {
          if (
            item.serviceDate &&
            (item.serviceDate < checkInDate ||
              item.serviceDate >= checkOutDate ||
              !stayDates(item.serviceDate, checkOutDate))
          ) {
            return reply
              .code(400)
              .send(errorBody("INVALID_SERVICE_DATE", "Experience date must fall within the stay"));
          }
        }
        const totals = calculateReservationTotal({
          rooms,
          roomRates: new Map(options.map((option) => [option.roomType.id, option.roomType])),
          roomNights: price.rows,
          nights: dates.length,
          experiences: selectedExperiences,
          experienceRates: new Map(
            selectedVariants
              .filter((row) => row.experience.isActive)
              .map((row) => [
                row.variant.id,
                {
                  name: `${row.experience.name} · ${row.variant.subName}`,
                  unitPrice: row.variant.price,
                },
              ]),
          ),
        });
        const paidAmount =
          source === "ota" ? totals.bookingTotal : (request.body.paymentAmount ?? 0);
        if (paidAmount > totals.bookingTotal) {
          return reply
            .code(400)
            .send(errorBody("INVALID_PAYMENT", "Payment exceeds the booking total"));
        }
        return {
          checkInDate,
          checkOutDate,
          nights: dates.length,
          roomCount,
          ...price,
          charges: totals,
          bookingTotal: totals.bookingTotal,
          paidAmount,
          paymentStatus:
            paidAmount === totals.bookingTotal ? "paid" : paidAmount > 0 ? "partial" : "unpaid",
          remainingBalance: totals.bookingTotal - paidAmount,
          depositAmount: request.body.depositAmount ?? 0,
          totalCollected: paidAmount + (request.body.depositAmount ?? 0),
        };
      } catch (error) {
        if (error instanceof InvalidPromoCodeError) {
          return reply.code(400).send(errorBody("INVALID_PROMO_CODE", error.message));
        }
        if (error instanceof ReservationTotalError) {
          return reply.code(400).send(errorBody(error.code, error.message));
        }
        throw error;
      }
    },
  );

  app.post<{ Body: CreateReservationBody }>(
    "/",
    {
      preHandler: app.requirePermission("reservations.create"),
      schema: { body: createReservationBodySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const idempotencyKey = body.idempotencyKey.trim();
      if (idempotencyKey.length < 8) {
        return reply
          .code(400)
          .send(errorBody("INVALID_IDEMPOTENCY_KEY", "Use at least 8 characters"));
      }
      const idempotencyRequestHash = requestHash(body);
      const dates = stayDates(body.checkInDate, body.checkOutDate);
      if (!dates) {
        return reply
          .code(400)
          .send(errorBody("INVALID_STAY_DATES", "Use valid dates for a stay of 1 to 366 nights"));
      }
      if (Boolean(body.guestId) === Boolean(body.guest)) {
        return reply
          .code(400)
          .send(errorBody("INVALID_GUEST", "Provide either guestId or a new guest"));
      }
      if (body.guest && !body.guest.fullName.trim()) {
        return reply.code(400).send(errorBody("INVALID_GUEST", "Guest name is required"));
      }
      if (body.checkIn && (!body.confirm || body.source === "ota")) {
        return reply
          .code(400)
          .send(
            errorBody(
              "INVALID_CHECK_IN",
              "Direct check-in requires a confirmed Walk-in or Phone reservation",
            ),
          );
      }
      if (body.checkIn && body.checkInDate !== bookingDateJakarta()) {
        return reply
          .code(400)
          .send(
            errorBody(
              "CHECK_IN_DATE_NOT_TODAY",
              "Direct check-in is only available on the check-in date",
            ),
          );
      }
      if (body.source === "walk_in" && body.cancellationPolicyId) {
        return reply
          .code(400)
          .send(
            errorBody("INVALID_POLICY", "Walk-in reservations do not use cancellation policies"),
          );
      }
      if (
        body.source !== "phone" &&
        body.rooms.some((room) => room.cancellationPolicyId !== undefined)
      ) {
        return reply
          .code(400)
          .send(
            errorBody(
              "INVALID_POLICY",
              "Room cancellation policies are only available for Phone reservations",
            ),
          );
      }
      if (body.source === "ota") {
        if (!body.otaChannelId || !body.externalReference?.trim()) {
          return reply
            .code(400)
            .send(errorBody("INVALID_OTA_BOOKING", "OTA channel and reference are required"));
        }
        if (!body.confirm || body.rooms.some((room) => !room.otaRatePerNight)) {
          return reply
            .code(400)
            .send(
              errorBody(
                "INVALID_OTA_BOOKING",
                "Confirmed OTA bookings require a voucher rate for every room",
              ),
            );
        }
        if (body.promoCode || body.cancellationPolicyId || body.payment || body.deposit) {
          return reply
            .code(400)
            .send(
              errorBody(
                "INVALID_OTA_BOOKING",
                "OTA voucher payment and policy are managed by the OTA channel",
              ),
            );
        }
      } else if (
        body.otaChannelId ||
        body.externalReference ||
        body.rooms.some((room) => room.otaRatePerNight !== undefined)
      ) {
        return reply
          .code(400)
          .send(
            errorBody(
              "INVALID_SOURCE_FIELDS",
              "OTA fields are only available for OTA reservations",
            ),
          );
      }
      if (body.rooms.every((room) => room.adults === 0 && room.children === 0)) {
        return reply.code(400).send(errorBody("INVALID_ROOMS", "At least one guest is required"));
      }
      const createAllocationError = guestAllocationError(body);
      if (createAllocationError) return reply.code(400).send(createAllocationError);
      const assignedUnitIds = body.rooms
        .map((room) => room.roomUnitId)
        .filter((id): id is string => Boolean(id));
      if (new Set(assignedUnitIds).size !== assignedUnitIds.length) {
        return reply
          .code(400)
          .send(errorBody("DUPLICATE_ROOM", "A room number can only be assigned once"));
      }
      if (body.checkIn && assignedUnitIds.length !== body.rooms.length) {
        return reply
          .code(400)
          .send(
            errorBody(
              "ROOM_ASSIGNMENT_REQUIRED",
              "Assign a room number to every room before check-in",
            ),
          );
      }

      const requestedCounts = new Map<string, number>();
      for (const room of body.rooms) {
        requestedCounts.set(room.roomTypeId, (requestedCounts.get(room.roomTypeId) ?? 0) + 1);
      }
      const roomTypeIds = [...requestedCounts.keys()].sort();
      const bookingDate = bookingDateJakarta();

      try {
        const outcome = await app.db.transaction(async (tx) => {
          if (body.checkIn) {
            const [checkInPermission] = await tx
              .select({ id: permissions.id })
              .from(rolePermissions)
              .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
              .where(
                and(
                  eq(rolePermissions.roleId, request.authUser!.roleId),
                  eq(permissions.code, "reservations.check_in"),
                ),
              )
              .limit(1);
            if (!checkInPermission) {
              throw new ReservationInputError(
                "CHECK_IN_FORBIDDEN",
                "Permission to check in a guest is required",
                403,
              );
            }
          }
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`reservation-create:${idempotencyKey}`}))`,
          );
          const [existing] = await tx
            .select({
              idempotencyRequestHash: reservations.idempotencyRequestHash,
              createResponseSnapshot: reservations.createResponseSnapshot,
            })
            .from(reservations)
            .where(eq(reservations.idempotencyKey, idempotencyKey))
            .limit(1);
          if (existing) {
            if (existing.idempotencyRequestHash !== idempotencyRequestHash) {
              throw new ReservationInputError(
                "IDEMPOTENCY_KEY_REUSED",
                "Idempotency key was already used with a different request",
                409,
              );
            }
            return { reservation: existing.createResponseSnapshot, replayed: true };
          }
          // Serialize bookings for each room type before reading occupied inventory.
          for (const roomTypeId of roomTypeIds) {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${roomTypeId}))`);
          }
          const inventoryRows = await tx
            .select()
            .from(roomInventoryDaily)
            .where(
              and(
                inArray(roomInventoryDaily.roomTypeId, roomTypeIds),
                gte(roomInventoryDaily.stayDate, dates[0]),
                lte(roomInventoryDaily.stayDate, dates[dates.length - 1]),
              ),
            )
            .for("update");
          const inventoryByKey = new Map(
            inventoryRows.map((row) => [`${row.roomTypeId}:${row.stayDate}`, row]),
          );
          const availability = await readRoomAvailability(
            tx,
            body.checkInDate,
            body.checkOutDate,
            dates,
            roomTypeIds,
          );
          const availabilityByType = new Map(availability.map((item) => [item.roomType.id, item]));
          for (const [roomTypeId, quantity] of requestedCounts) {
            const option = availabilityByType.get(roomTypeId);
            if (
              !option ||
              (body.source !== "ota" && (!option.bookable || option.availableRooms < quantity))
            ) {
              throw new ReservationInputError(
                "ROOM_UNAVAILABLE",
                `Room type ${roomTypeId} is unavailable for the requested stay`,
                409,
              );
            }
          }

          const assignedUnits = assignedUnitIds.length
            ? await tx
                .select({
                  id: roomUnits.id,
                  roomTypeId: roomUnits.roomTypeId,
                  roomNumber: roomUnits.roomNumber,
                  bedConfiguration: roomUnits.bedConfiguration,
                  isActive: roomUnits.isActive,
                  operationalStatus: roomUnits.operationalStatus,
                })
                .from(roomUnits)
                .where(inArray(roomUnits.id, assignedUnitIds))
                .for("update")
            : [];
          const assignedById = new Map(assignedUnits.map((unit) => [unit.id, unit]));
          const maintenanceBlocks = assignedUnitIds.length
            ? await readActiveMaintenanceBlocks(
                tx,
                body.checkInDate,
                body.checkOutDate,
                roomTypeIds,
              )
            : [];
          const blockedUnitIds = new Set(maintenanceBlocks.map((block) => block.roomUnitId));
          for (const room of body.rooms) {
            if (!room.roomUnitId) continue;
            const unit = assignedById.get(room.roomUnitId);
            if (
              !unit ||
              unit.roomTypeId !== room.roomTypeId ||
              !unit.isActive ||
              blockedUnitIds.has(unit.id) ||
              ["maintenance", "out_of_service"].includes(unit.operationalStatus) ||
              ((body.checkIn || body.checkInDate <= bookingDate) &&
                unit.operationalStatus !== "available")
            ) {
              throw new ReservationInputError(
                "ROOM_UNIT_UNAVAILABLE",
                `Assigned room ${room.roomUnitId} is unavailable for this room type`,
                409,
              );
            }
          }
          if (assignedUnitIds.length) {
            const overlapping = await tx
              .select({ roomUnitId: reservationRooms.roomUnitId })
              .from(reservationRooms)
              .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
              .where(
                and(
                  inArray(reservationRooms.roomUnitId, assignedUnitIds),
                  inArray(reservations.reservationStatus, ["pending", "confirmed", "checked_in"]),
                  sql`${reservations.checkInDate} < ${body.checkOutDate}`,
                  sql`${reservations.checkOutDate} > ${body.checkInDate}`,
                ),
              );
            if (overlapping.length) {
              throw new ReservationInputError(
                "ROOM_UNIT_UNAVAILABLE",
                "An assigned room is already reserved for the requested stay",
                409,
              );
            }
          }

          const capacities = await tx
            .select({
              roomTypeId: roomTypeCapacityPatterns.roomTypeId,
              adults: capacityPatterns.adults,
              children: capacityPatterns.children,
              extraBeds: roomTypeCapacityPatterns.extraBeds,
            })
            .from(roomTypeCapacityPatterns)
            .innerJoin(
              capacityPatterns,
              eq(roomTypeCapacityPatterns.capacityPatternId, capacityPatterns.id),
            )
            .where(
              and(
                inArray(roomTypeCapacityPatterns.roomTypeId, roomTypeIds),
                eq(capacityPatterns.isActive, true),
              ),
            );
          for (const [roomIndex, room] of body.rooms.entries()) {
            const option = availabilityByType.get(room.roomTypeId)!;
            const extraBeds = room.extraBeds ?? 0;
            if (
              (extraBeds > 0 && !option.roomType.extraBedEnabled) ||
              extraBeds > option.roomType.maxExtraBeds
            ) {
              throw new ReservationInputError(
                "INVALID_EXTRA_BEDS",
                `Room ${roomIndex + 1}: extra bed is not allowed for this room type`,
              );
            }
            if (
              !capacities.some(
                (capacity) =>
                  capacity.roomTypeId === room.roomTypeId &&
                  capacity.adults === room.adults &&
                  capacity.children === room.children &&
                  capacity.extraBeds <= extraBeds,
              )
            ) {
              throw new ReservationInputError(
                "INVALID_CAPACITY",
                `Room ${roomIndex + 1}: guest count or extra beds are not allowed for this room type`,
              );
            }
          }

          const priced = await priceRoomNights(tx, {
            source: body.source,
            promoCode: body.promoCode,
            bookingDate,
            nights: dates.length,
            roomCount: body.rooms.length,
            rows: body.rooms.flatMap((room, roomIndex) =>
              dates.map((stayDate) => ({
                roomIndex,
                roomTypeId: room.roomTypeId,
                stayDate,
                basePrice:
                  body.source === "ota"
                    ? room.otaRatePerNight!
                    : inventoryByKey.get(`${room.roomTypeId}:${stayDate}`)!.basePrice,
              })),
            ),
          });

          let otaPaymentMethodId: string | null = null;
          let otaProvider: string | null = null;
          if (body.source === "ota") {
            const [otaChannel] = await tx
              .select({ id: masterItems.id, code: masterItems.code })
              .from(masterItems)
              .where(
                and(
                  eq(masterItems.id, body.otaChannelId!),
                  eq(masterItems.category, "ota_channels"),
                  eq(masterItems.isActive, true),
                ),
              )
              .limit(1);
            if (!otaChannel) {
              throw new ReservationInputError(
                "INVALID_OTA_CHANNEL",
                "OTA channel not found or inactive",
              );
            }
            const [gatewayMethod] = await tx
              .select({ id: masterItems.id })
              .from(masterItems)
              .where(
                and(
                  eq(masterItems.category, "payment_methods"),
                  eq(masterItems.code, "payment_gateway"),
                  eq(masterItems.isActive, true),
                ),
              )
              .limit(1);
            if (!gatewayMethod) {
              throw new ReservationInputError(
                "INVALID_PAYMENT_METHOD",
                "Active Payment Gateway method is required for OTA settlement",
              );
            }
            otaPaymentMethodId = gatewayMethod.id;
            otaProvider = `ota:${otaChannel.code}`;
          }

          const methodIds = [body.payment?.methodId, body.deposit?.methodId].filter(
            (id): id is string => Boolean(id),
          );
          if (methodIds.length) {
            const methods = await tx
              .select({ id: masterItems.id })
              .from(masterItems)
              .where(
                and(
                  inArray(masterItems.id, methodIds),
                  eq(masterItems.category, "payment_methods"),
                  eq(masterItems.isActive, true),
                ),
              );
            if (new Set(methods.map((method) => method.id)).size !== new Set(methodIds).size) {
              throw new ReservationInputError(
                "INVALID_PAYMENT_METHOD",
                "Payment method not found or inactive",
              );
            }
          }

          const selectedVariants = body.experiences?.length
            ? await tx
                .select({ variant: experienceVariants, experience: experiences })
                .from(experienceVariants)
                .innerJoin(experiences, eq(experienceVariants.experienceId, experiences.id))
                .where(
                  inArray(
                    experienceVariants.id,
                    body.experiences.map((item) => item.variantId),
                  ),
                )
            : [];
          const variantById = new Map(selectedVariants.map((row) => [row.variant.id, row]));
          for (const item of body.experiences ?? []) {
            const row = variantById.get(item.variantId);
            if (!row || !row.experience.isActive) {
              throw new ReservationInputError(
                "INVALID_EXPERIENCE",
                "Experience variant not found or inactive",
              );
            }
            if (
              item.serviceDate &&
              (!stayDates(item.serviceDate, body.checkOutDate) ||
                item.serviceDate < body.checkInDate ||
                item.serviceDate >= body.checkOutDate)
            ) {
              throw new ReservationInputError(
                "INVALID_SERVICE_DATE",
                "Experience date must fall within the stay",
              );
            }
          }

          let cancellationPolicyId: string | null = null;
          let cancellationPolicySnapshot: unknown = null;
          let roomPolicySnapshots:
            | {
                roomIndex: number;
                roomTypeId: string;
                policyId: string | null;
                snapshot: unknown;
              }[]
            | null = null;
          if (body.source === "phone") {
            if (body.rooms.some((room) => room.cancellationPolicyId !== undefined)) {
              if (body.cancellationPolicyId) {
                throw new ReservationInputError(
                  "INVALID_POLICY",
                  "Choose cancellation policies per room or per reservation",
                );
              }
              const roomPolicies = [];
              for (const [roomIndex, room] of body.rooms.entries()) {
                if (!room.cancellationPolicyId) {
                  roomPolicies.push({
                    roomIndex,
                    roomTypeId: room.roomTypeId,
                    policyId: null,
                    snapshot: {
                      name: "100% cancellation charge",
                      type: "non_refundable",
                      chargeType: "percentage",
                      chargeValue: 100,
                    },
                  });
                  continue;
                }
                const [policy] = await tx
                  .select()
                  .from(cancellationPolicies)
                  .where(
                    and(
                      eq(cancellationPolicies.id, room.cancellationPolicyId),
                      eq(cancellationPolicies.isActive, true),
                      eq(cancellationPolicies.appliesPhone, true),
                    ),
                  )
                  .limit(1);
                if (
                  !policy ||
                  (policy.stayStart && policy.stayStart > body.checkInDate) ||
                  (policy.stayEnd && policy.stayEnd < dates[dates.length - 1])
                ) {
                  throw new ReservationInputError(
                    "INVALID_POLICY",
                    `Cancellation policy is unavailable for room ${roomIndex + 1}`,
                  );
                }
                const [rules, applicableRooms] = await Promise.all([
                  tx
                    .select()
                    .from(cancellationRules)
                    .where(eq(cancellationRules.policyId, policy.id)),
                  tx
                    .select({ roomTypeId: cancellationPolicyRoomTypes.roomTypeId })
                    .from(cancellationPolicyRoomTypes)
                    .where(eq(cancellationPolicyRoomTypes.policyId, policy.id)),
                ]);
                if (!applicableRooms.some((item) => item.roomTypeId === room.roomTypeId)) {
                  throw new ReservationInputError(
                    "INVALID_POLICY",
                    `Cancellation policy does not apply to room ${roomIndex + 1}`,
                  );
                }
                roomPolicies.push({
                  roomIndex,
                  roomTypeId: room.roomTypeId,
                  policyId: policy.id,
                  snapshot: { policy, rules },
                });
              }
              cancellationPolicySnapshot = { type: "per_room", rooms: roomPolicies };
              roomPolicySnapshots = roomPolicies;
            } else {
              const selectedPolicyId =
                body.cancellationPolicyId === null
                  ? null
                  : (body.cancellationPolicyId ??
                    priced.appliedCampaigns.find((campaign) => campaign.cancellationPolicyId)
                      ?.cancellationPolicyId);
              if (selectedPolicyId) {
                const [policy] = await tx
                  .select()
                  .from(cancellationPolicies)
                  .where(
                    and(
                      eq(cancellationPolicies.id, selectedPolicyId),
                      eq(cancellationPolicies.isActive, true),
                      eq(cancellationPolicies.appliesPhone, true),
                    ),
                  )
                  .limit(1);
                if (
                  !policy ||
                  (policy.stayStart && policy.stayStart > body.checkInDate) ||
                  (policy.stayEnd && policy.stayEnd < dates[dates.length - 1])
                ) {
                  throw new ReservationInputError(
                    "INVALID_POLICY",
                    "Phone cancellation policy is unavailable for this stay",
                  );
                }
                const [rules, applicableRooms] = await Promise.all([
                  tx
                    .select()
                    .from(cancellationRules)
                    .where(eq(cancellationRules.policyId, policy.id)),
                  tx
                    .select({ roomTypeId: cancellationPolicyRoomTypes.roomTypeId })
                    .from(cancellationPolicyRoomTypes)
                    .where(eq(cancellationPolicyRoomTypes.policyId, policy.id)),
                ]);
                if (
                  roomTypeIds.some(
                    (id) => !applicableRooms.some((applicable) => applicable.roomTypeId === id),
                  )
                ) {
                  throw new ReservationInputError(
                    "INVALID_POLICY",
                    "Cancellation policy does not apply to all selected rooms",
                  );
                }
                cancellationPolicyId = policy.id;
                cancellationPolicySnapshot = { policy, rules };
              } else {
                cancellationPolicySnapshot = {
                  name: "100% cancellation charge",
                  type: "non_refundable",
                  chargeType: "percentage",
                  chargeValue: 100,
                };
              }
            }
          }

          const totals = calculateReservationTotal({
            rooms: body.rooms,
            roomRates: new Map(availability.map((option) => [option.roomType.id, option.roomType])),
            roomNights: priced.rows,
            nights: dates.length,
            experiences: body.experiences ?? [],
            experienceRates: new Map(
              selectedVariants.map((row) => [
                row.variant.id,
                {
                  name: `${row.experience.name} · ${row.variant.subName}`,
                  unitPrice: row.variant.price,
                },
              ]),
            ),
          });
          const bookingTotal = totals.bookingTotal;
          const earlyContext = body.checkIn
            ? await getEarlyCheckInContext(tx, body.checkInDate)
            : null;
          if (earlyContext?.required && body.earlyCheckIn?.acknowledged !== true) {
            throw new ReservationInputError(
              "EARLY_CHECK_IN_CONFIRMATION_REQUIRED",
              "Confirm early check-in before the standard check-in time",
              409,
            );
          }
          if (
            earlyContext?.required &&
            body.earlyCheckIn &&
            body.earlyCheckIn.paymentTiming === "now" &&
            body.earlyCheckIn.chargeAmount > 0 &&
            !body.earlyCheckIn.paymentMethodId
          ) {
            throw new ReservationInputError(
              "INVALID_EARLY_CHECK_IN",
              "Early check-in details or payment method are invalid",
            );
          }
          if (body.payment && body.payment.amount > bookingTotal) {
            throw new ReservationInputError("INVALID_PAYMENT", "Payment exceeds the booking total");
          }
          const paidAmount = body.source === "ota" ? bookingTotal : (body.payment?.amount ?? 0);
          const remainingBalance = bookingTotal - paidAmount;
          const projectedCheckInOutstanding =
            remainingBalance +
            (earlyContext?.required && body.earlyCheckIn?.paymentTiming === "later"
              ? body.earlyCheckIn.chargeAmount
              : 0);
          if (
            body.checkIn &&
            projectedCheckInOutstanding > 0 &&
            !earlyContext?.allowOutstandingCheckIn
          ) {
            throw new ReservationInputError(
              "OUTSTANDING_CHECK_IN_DISABLED",
              "Check-in requires full payment because outstanding check-in is disabled",
              409,
            );
          }
          if (body.checkIn && remainingBalance > 0 && body.acknowledgeOutstanding !== true) {
            throw new ReservationInputError(
              "OUTSTANDING_CONFIRMATION_REQUIRED",
              "Confirm the outstanding balance before check-in",
              409,
            );
          }

          let guestId = body.guestId;
          if (guestId) {
            const [existing] = await tx
              .select({ id: guests.id })
              .from(guests)
              .where(eq(guests.id, guestId))
              .limit(1);
            if (!existing) throw new ReservationInputError("GUEST_NOT_FOUND", "Guest not found");
          } else {
            const [created] = await tx
              .insert(guests)
              .values({
                fullName: body.guest!.fullName.trim(),
                nik: nullable(body.guest!.nik),
                phone: nullable(body.guest!.phone),
                email: nullable(body.guest!.email),
              })
              .returning({ id: guests.id });
            guestId = created.id;
          }

          const id = randomUUID();
          const bookingCode = `GH-${id.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
          const paymentStatus =
            paidAmount === bookingTotal ? "paid" : paidAmount > 0 ? "partial" : "unpaid";
          const reservationStatus = body.checkIn
            ? "checked_in"
            : body.confirm
              ? "confirmed"
              : "pending";
          const checkedInAt = body.checkIn ? new Date() : null;
          await tx.insert(reservations).values({
            id,
            bookingCode,
            idempotencyKey,
            idempotencyRequestHash,
            guestId,
            source: body.source,
            otaChannelId: body.source === "ota" ? body.otaChannelId : null,
            externalReference: body.source === "ota" ? body.externalReference!.trim() : null,
            checkInDate: body.checkInDate,
            checkOutDate: body.checkOutDate,
            adults: body.rooms.reduce((sum, room) => sum + room.adults, 0),
            children: body.rooms.reduce((sum, room) => sum + room.children, 0),
            reservationStatus,
            paymentStatus,
            promoCodeSnapshot: priced.promoCodeSnapshot,
            cancellationPolicyId,
            cancellationPolicySnapshot,
            specialRequests: nullable(body.specialRequests),
            internalNotes: nullable(body.internalNotes),
            confirmedAt: body.confirm ? new Date() : null,
            checkedInAt,
            createdByUserId: request.authUser!.id,
          });

          const createdRoomAssignments: {
            reservationRoomId: string;
            roomUnitId: string;
            roomNumber: string;
          }[] = [];
          const createdRoomIds: string[] = [];
          for (const [roomIndex, room] of body.rooms.entries()) {
            const option = availabilityByType.get(room.roomTypeId)!;
            const roomNights = priced.rows.filter((night) => night.roomIndex === roomIndex);
            const roomTotal = roomNights.reduce((sum, night) => sum + night.finalPrice, 0);
            const [createdRoom] = await tx
              .insert(reservationRooms)
              .values({
                reservationId: id,
                roomTypeId: room.roomTypeId,
                roomUnitId: room.roomUnitId ?? null,
                roomTypeNameSnapshot: option.roomType.name,
                adults: room.adults,
                children: room.children,
                bedConfigurationSnapshot: room.roomUnitId
                  ? assignedById.get(room.roomUnitId)!.bedConfiguration
                  : null,
              })
              .returning({ id: reservationRooms.id });
            createdRoomIds.push(createdRoom.id);
            if (room.roomUnitId) {
              createdRoomAssignments.push({
                reservationRoomId: createdRoom.id,
                roomUnitId: room.roomUnitId,
                roomNumber: assignedById.get(room.roomUnitId)!.roomNumber,
              });
            }
            await tx.insert(reservationRoomNights).values(
              roomNights.map((night) => ({
                reservationRoomId: createdRoom.id,
                stayDate: night.stayDate,
                basePrice: night.basePrice,
                discountAmount: night.discountAmount,
                finalPrice: night.finalPrice,
                campaignSnapshot: night.campaignSnapshot,
              })),
            );
            await tx.insert(reservationCharges).values({
              reservationId: id,
              reservationRoomId: createdRoom.id,
              kind: "room",
              description: `${option.roomType.name} · ${dates.length} night(s)`,
              quantity: "1",
              unitAmount: roomTotal,
              amount: roomTotal,
              createdByUserId: request.authUser!.id,
            });
            if (room.extraBeds) {
              const amount = room.extraBeds * option.roomType.extraBedPricePerNight * dates.length;
              await tx.insert(reservationRoomExtraBeds).values({
                reservationRoomId: createdRoom.id,
                quantity: room.extraBeds,
                dateFrom: body.checkInDate,
                dateTo: body.checkOutDate,
                unitPricePerNight: option.roomType.extraBedPricePerNight,
              });
              await tx.insert(reservationCharges).values({
                reservationId: id,
                reservationRoomId: createdRoom.id,
                kind: "extra_bed",
                description: `${room.extraBeds} extra bed(s) · ${option.roomType.name}`,
                quantity: String(room.extraBeds * dates.length),
                unitAmount: option.roomType.extraBedPricePerNight,
                amount,
                createdByUserId: request.authUser!.id,
              });
            }
            for (const [label, quantity, unitAmount] of [
              ["Adult breakfast", room.adultBreakfasts ?? 0, option.roomType.adultBreakfastPrice],
              ["Child breakfast", room.childBreakfasts ?? 0, option.roomType.childBreakfastPrice],
            ] as const) {
              if (!quantity) continue;
              await tx.insert(reservationCharges).values({
                reservationId: id,
                reservationRoomId: createdRoom.id,
                kind: "breakfast",
                description: `${label} · ${option.roomType.name}`,
                quantity: String(quantity * dates.length),
                unitAmount,
                amount: quantity * unitAmount * dates.length,
                createdByUserId: request.authUser!.id,
              });
            }
          }
          if (roomPolicySnapshots) {
            await tx
              .update(reservations)
              .set({
                cancellationPolicySnapshot: {
                  type: "per_room",
                  rooms: roomPolicySnapshots.map((entry) => ({
                    ...entry,
                    reservationRoomId: createdRoomIds[entry.roomIndex],
                  })),
                },
              })
              .where(eq(reservations.id, id));
          }

          for (const item of body.experiences ?? []) {
            const selected = variantById.get(item.variantId)!;
            const name = `${selected.experience.name} · ${selected.variant.subName}`;
            await tx.insert(reservationExperiences).values({
              reservationId: id,
              experienceId: selected.experience.id,
              nameSnapshot: name.slice(0, 160),
              descriptionSnapshot: selected.variant.description,
              quantity: item.quantity,
              unitPrice: selected.variant.price,
              serviceDate: item.serviceDate ?? null,
            });
            await tx.insert(reservationCharges).values({
              reservationId: id,
              kind: "experience",
              sourceId: selected.variant.id,
              description: name,
              quantity: String(item.quantity),
              unitAmount: selected.variant.price,
              amount: selected.variant.price * item.quantity,
              serviceDate: item.serviceDate ?? null,
              createdByUserId: request.authUser!.id,
            });
          }
          const [initialPayment] =
            body.payment || (body.source === "ota" && otaPaymentMethodId)
              ? await tx
                  .insert(payments)
                  .values({
                    reservationId: id,
                    methodId: body.payment?.methodId ?? otaPaymentMethodId!,
                    amount: body.payment?.amount ?? bookingTotal,
                    provider: otaProvider,
                    providerReference:
                      body.source === "ota" ? body.externalReference!.trim() : null,
                    status: "succeeded",
                    paidAt: new Date(),
                    notes: body.source === "ota" ? "Prepaid by OTA" : nullable(body.payment?.notes),
                    recordedByUserId: request.authUser!.id,
                  })
                  .returning({ id: payments.id })
              : [];
          const [initialDeposit] = body.deposit
            ? await tx
                .insert(reservationDeposits)
                .values({
                  reservationId: id,
                  methodId: body.deposit.methodId,
                  amountHeld: body.deposit.amount,
                  notes: nullable(body.deposit.notes),
                })
                .returning({ id: reservationDeposits.id })
            : [];

          const earlyCharge =
            earlyContext?.required && body.earlyCheckIn
              ? await addEarlyCheckInCharge(tx, {
                  reservationId: id,
                  checkInDate: body.checkInDate,
                  actorUserId: request.authUser!.id,
                  earlyCheckIn: body.earlyCheckIn,
                })
              : null;
          const finalBookingTotal =
            bookingTotal + (earlyContext?.required ? (body.earlyCheckIn?.chargeAmount ?? 0) : 0);
          const finalPaidAmount =
            paidAmount + (earlyCharge?.paymentId ? body.earlyCheckIn!.chargeAmount : 0);
          const finalRemainingBalance = finalBookingTotal - finalPaidAmount;
          const finalPaymentStatus =
            finalPaidAmount >= finalBookingTotal
              ? "paid"
              : finalPaidAmount > 0
                ? "partial"
                : "unpaid";
          if (finalPaymentStatus !== paymentStatus) {
            await tx
              .update(reservations)
              .set({ paymentStatus: finalPaymentStatus })
              .where(eq(reservations.id, id));
          }

          const eventBaseTime = new Date();
          let eventOffset = 0;
          const nextEventTime = () => new Date(eventBaseTime.getTime() + eventOffset++);
          await recordReservationEvent(tx, {
            reservationId: id,
            eventType: "reservation.created",
            actorType: "user",
            actorUserId: request.authUser!.id,
            occurredAt: nextEventTime(),
            reservationStatusAfter: "pending",
            paymentStatusAfter: "unpaid",
            details: {
              bookingCode,
              source: body.source,
              bookingTotal,
              roomCount: body.rooms.length,
            },
          });
          if (initialPayment) {
            await recordReservationEvent(tx, {
              reservationId: id,
              eventType: "payment.recorded",
              actorType: body.source === "ota" ? "gateway" : "user",
              actorUserId: body.source === "ota" ? null : request.authUser!.id,
              occurredAt: nextEventTime(),
              reservationStatusBefore: "pending",
              reservationStatusAfter: "pending",
              paymentStatusBefore: "unpaid",
              paymentStatusAfter: paymentStatus,
              referenceId: initialPayment.id,
              details: {
                amount: paidAmount,
                source: body.source,
                methodId: body.payment?.methodId ?? otaPaymentMethodId,
              },
            });
          }
          if (initialDeposit) {
            await recordReservationEvent(tx, {
              reservationId: id,
              eventType: "deposit.held",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: nextEventTime(),
              reservationStatusBefore: "pending",
              reservationStatusAfter: "pending",
              paymentStatusBefore: paymentStatus,
              paymentStatusAfter: paymentStatus,
              referenceId: initialDeposit.id,
              details: { amount: body.deposit!.amount, methodId: body.deposit!.methodId },
            });
          }
          if (earlyCharge?.chargeId) {
            await recordReservationEvent(tx, {
              reservationId: id,
              eventType: "reservation.early_check_in_charged",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: nextEventTime(),
              reservationStatusBefore: "pending",
              reservationStatusAfter: "pending",
              paymentStatusBefore: paymentStatus,
              paymentStatusAfter: finalPaymentStatus,
              referenceId: earlyCharge.chargeId,
              details: {
                amount: body.earlyCheckIn!.chargeAmount,
                paymentTiming: body.earlyCheckIn!.paymentTiming,
              },
            });
          }
          if (earlyCharge?.paymentId) {
            await recordReservationEvent(tx, {
              reservationId: id,
              eventType: "payment.recorded",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: nextEventTime(),
              reservationStatusBefore: "pending",
              reservationStatusAfter: "pending",
              paymentStatusBefore: paymentStatus,
              paymentStatusAfter: finalPaymentStatus,
              referenceId: earlyCharge.paymentId,
              details: {
                amount: body.earlyCheckIn!.chargeAmount,
                methodId: body.earlyCheckIn!.paymentMethodId,
                source: "early_check_in",
              },
            });
          }
          if (body.confirm) {
            await recordReservationEvent(tx, {
              reservationId: id,
              eventType: "reservation.confirmed",
              actorType: body.source === "ota" ? "system" : "user",
              actorUserId: body.source === "ota" ? null : request.authUser!.id,
              occurredAt: nextEventTime(),
              reservationStatusBefore: "pending",
              reservationStatusAfter: "confirmed",
              paymentStatusBefore: paymentStatus,
              paymentStatusAfter: finalPaymentStatus,
              details: { bookingCode, source: body.source, automatic: body.source === "ota" },
            });
          }
          if (body.checkIn) {
            await tx
              .update(roomUnits)
              .set({ operationalStatus: "occupied", updatedAt: checkedInAt! })
              .where(inArray(roomUnits.id, assignedUnitIds));
            if (assignedUnitIds.length)
              await tx
                .insert(roomStatusEvents)
                .values(
                  assignedUnitIds.map((roomUnitId) => ({
                    roomUnitId,
                    statusBefore: "available",
                    statusAfter: "occupied",
                    actorUserId: request.authUser!.id,
                    source: "checkin",
                  })),
                );
            await recordReservationEvent(tx, {
              reservationId: id,
              eventType: "guest.checked_in",
              actorType: "user",
              actorUserId: request.authUser!.id,
              occurredAt: nextEventTime(),
              reservationStatusBefore: "confirmed",
              reservationStatusAfter: "checked_in",
              paymentStatusBefore: paymentStatus,
              paymentStatusAfter: finalPaymentStatus,
              details: {
                rooms: createdRoomAssignments,
                remainingBalance: finalRemainingBalance,
                outstandingAcknowledged: remainingBalance > 0,
                earlyCheckIn: earlyContext?.required
                  ? {
                      standardCheckInTime: earlyContext.standardCheckInTime,
                      serverTime: earlyContext.serverTime,
                      chargeAmount: body.earlyCheckIn?.chargeAmount ?? 0,
                      paymentTiming: body.earlyCheckIn?.paymentTiming ?? "later",
                      chargeId: earlyCharge?.chargeId ?? null,
                      paymentId: earlyCharge?.paymentId ?? null,
                    }
                  : null,
              },
            });
          }
          const result = {
            id,
            bookingCode,
            reservationStatus,
            paymentStatus: finalPaymentStatus,
            checkedInAt,
            bookingTotal: finalBookingTotal,
            discountTotal: priced.discountTotal,
            appliedCampaigns: priced.appliedCampaigns,
            rooms: body.rooms.map((room) => ({
              roomTypeId: room.roomTypeId,
              roomUnitId: room.roomUnitId ?? null,
              roomNumber: room.roomUnitId ? assignedById.get(room.roomUnitId)!.roomNumber : null,
              adults: room.adults,
              children: room.children,
              extraBeds: room.extraBeds ?? 0,
              adultBreakfasts: room.adultBreakfasts ?? 0,
              childBreakfasts: room.childBreakfasts ?? 0,
              otaRatePerNight: body.source === "ota" ? room.otaRatePerNight : null,
            })),
            experiences: (body.experiences ?? []).map((item) => ({
              variantId: item.variantId,
              quantity: item.quantity,
              serviceDate: item.serviceDate ?? null,
              unitPrice: variantById.get(item.variantId)!.variant.price,
            })),
            paidAmount: finalPaidAmount,
            remainingBalance: finalRemainingBalance,
            payment: body.payment
              ? { methodId: body.payment.methodId, amount: body.payment.amount }
              : body.source === "ota"
                ? { methodId: otaPaymentMethodId, amount: bookingTotal, provider: otaProvider }
                : null,
            otaChannelId: body.source === "ota" ? body.otaChannelId : null,
            externalReference: body.source === "ota" ? body.externalReference!.trim() : null,
            settlement: body.source === "ota" ? "prepaid_by_ota" : null,
            deposit: body.deposit
              ? { methodId: body.deposit.methodId, amountHeld: body.deposit.amount }
              : null,
          };
          await tx
            .update(reservations)
            .set({ createResponseSnapshot: result })
            .where(eq(reservations.id, id));
          return { reservation: result, replayed: false };
        });
        return reply.code(outcome.replayed ? 200 : 201).send(outcome);
      } catch (error) {
        if (error instanceof EarlyCheckInError) {
          return reply.code(400).send(errorBody(error.code, error.message));
        }
        if (error instanceof InvalidPromoCodeError) {
          return reply.code(400).send(errorBody("INVALID_PROMO_CODE", error.message));
        }
        if (error instanceof ReservationInputError) {
          return reply.code(error.statusCode).send(errorBody(error.code, error.message));
        }
        if (error instanceof ReservationTotalError) {
          return reply.code(400).send(errorBody(error.code, error.message));
        }
        if (databaseErrorCode(error) === "23503") {
          return reply
            .code(400)
            .send(errorBody("INVALID_REFERENCE", "A referenced item is unavailable"));
        }
        if (databaseErrorCode(error) === "23505") {
          return reply
            .code(409)
            .send(errorBody("DUPLICATE_RESERVATION", "Reservation conflicts with existing data"));
        }
        throw error;
      }
    },
  );
};
