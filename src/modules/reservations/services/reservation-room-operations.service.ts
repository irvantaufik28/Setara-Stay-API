import { and, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../../../plugins/database.js";
import { capacityPatterns } from "../../../db/schema/capacity_patterns.schema.js";
import { reservationCharges } from "../../../db/schema/reservation_charges.schema.js";
import { reservationRoomExtraBeds } from "../../../db/schema/reservation_room_extra_beds.schema.js";
import { reservationRoomNights } from "../../../db/schema/reservation_room_nights.schema.js";
import { reservationRooms } from "../../../db/schema/reservation_rooms.schema.js";
import { reservations } from "../../../db/schema/reservations.schema.js";
import { roomInventoryDaily } from "../../../db/schema/room_inventory_daily.schema.js";
import { roomTypeCapacityPatterns } from "../../../db/schema/room_type_capacity_patterns.schema.js";
import { roomTypes } from "../../../db/schema/room_types.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import { roomStatusEvents } from "../../../db/schema/room_status_events.schema.js";
import { readActiveMaintenanceBlocks } from "../../rooms/services/room-maintenance.service.js";
import { bookingDateJakarta, priceRoomNights } from "./reservations-campaigns.service.js";
import { stayDates } from "./reservations-availability.service.js";
import { readReservationFinancials } from "./reservation-financials.service.js";
import { recordReservationEvent } from "./reservation-events.service.js";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type QueryDatabase = Database | Transaction;

export class RoomOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

async function loadContext(db: QueryDatabase, reservationId: string, reservationRoomId: string) {
  const [reservation] = await db
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .limit(1);
  if (!reservation)
    throw new RoomOperationError("RESERVATION_NOT_FOUND", "Reservation not found", 404);
  if (reservation.reservationStatus !== "checked_in") {
    throw new RoomOperationError(
      "ROOM_OPERATION_NOT_ALLOWED",
      "Only checked-in reservations can change rooms or extra beds",
    );
  }
  const [room] = await db
    .select()
    .from(reservationRooms)
    .where(
      and(
        eq(reservationRooms.id, reservationRoomId),
        eq(reservationRooms.reservationId, reservationId),
      ),
    )
    .limit(1);
  if (!room || !room.roomUnitId)
    throw new RoomOperationError(
      "RESERVATION_ROOM_NOT_FOUND",
      "Assigned reservation room not found",
      404,
    );
  const effectiveDate = bookingDateJakarta();
  const remainingDates = stayDates(effectiveDate, reservation.checkOutDate);
  if (!remainingDates)
    throw new RoomOperationError(
      "NO_REMAINING_NIGHTS",
      "Extend the stay before changing room or extra bed",
    );
  return { reservation, room, effectiveDate, remainingDates };
}

function overlappingNights(from: string, to: string, effectiveDate: string, checkOutDate: string) {
  const start = from > effectiveDate ? from : effectiveDate;
  const end = to < checkOutDate ? to : checkOutDate;
  return stayDates(start, end)?.length ?? 0;
}

async function activeExtraBeds(
  db: QueryDatabase,
  reservationRoomId: string,
  effectiveDate: string,
  checkOutDate: string,
) {
  const rows = await db
    .select()
    .from(reservationRoomExtraBeds)
    .where(
      and(
        eq(reservationRoomExtraBeds.reservationRoomId, reservationRoomId),
        lt(reservationRoomExtraBeds.dateFrom, checkOutDate),
        gt(reservationRoomExtraBeds.dateTo, effectiveDate),
      ),
    );
  const oldRemainingAmount = rows.reduce(
    (sum, bed) =>
      sum +
      overlappingNights(bed.dateFrom, bed.dateTo, effectiveDate, checkOutDate) *
        bed.quantity *
        bed.unitPricePerNight,
    0,
  );
  const currentQuantity = rows
    .filter((bed) => bed.dateFrom <= effectiveDate && bed.dateTo > effectiveDate)
    .reduce((sum, bed) => sum + bed.quantity, 0);
  return { rows, oldRemainingAmount, currentQuantity };
}

async function replaceFutureExtraBeds(
  tx: Transaction,
  reservationRoomId: string,
  effectiveDate: string,
  checkOutDate: string,
  quantity: number,
  unitPricePerNight: number,
) {
  const existing = await activeExtraBeds(tx, reservationRoomId, effectiveDate, checkOutDate);
  for (const bed of existing.rows) {
    if (bed.dateFrom >= effectiveDate) {
      await tx.delete(reservationRoomExtraBeds).where(eq(reservationRoomExtraBeds.id, bed.id));
    } else {
      await tx
        .update(reservationRoomExtraBeds)
        .set({ dateTo: effectiveDate, updatedAt: new Date() })
        .where(eq(reservationRoomExtraBeds.id, bed.id));
    }
  }
  if (quantity > 0) {
    await tx
      .insert(reservationRoomExtraBeds)
      .values({
        reservationRoomId,
        dateFrom: effectiveDate,
        dateTo: checkOutDate,
        quantity,
        unitPricePerNight,
      });
  }
}

export async function quoteExtraBedChange(
  db: QueryDatabase,
  reservationId: string,
  roomId: string,
  quantity: number,
) {
  const { reservation, room, effectiveDate, remainingDates } = await loadContext(
    db,
    reservationId,
    roomId,
  );
  const [roomType] = await db
    .select()
    .from(roomTypes)
    .where(eq(roomTypes.id, room.roomTypeId))
    .limit(1);
  if (
    !roomType ||
    quantity < 0 ||
    !Number.isInteger(quantity) ||
    quantity > roomType.maxExtraBeds ||
    (quantity > 0 && !roomType.extraBedEnabled)
  ) {
    throw new RoomOperationError(
      "INVALID_EXTRA_BEDS",
      "Extra bed quantity is not allowed for this room type",
      400,
    );
  }
  const capacities = await db
    .select({ requiredExtraBeds: roomTypeCapacityPatterns.extraBeds })
    .from(roomTypeCapacityPatterns)
    .innerJoin(
      capacityPatterns,
      eq(roomTypeCapacityPatterns.capacityPatternId, capacityPatterns.id),
    )
    .where(
      and(
        eq(roomTypeCapacityPatterns.roomTypeId, room.roomTypeId),
        eq(capacityPatterns.adults, room.adults),
        eq(capacityPatterns.children, room.children),
        eq(capacityPatterns.isActive, true),
      ),
    );
  if (!capacities.some((item) => item.requiredExtraBeds <= quantity)) {
    throw new RoomOperationError(
      "CAPACITY_MISMATCH",
      "This guest combination requires more extra beds",
      400,
    );
  }
  const current = await activeExtraBeds(db, room.id, effectiveDate, reservation.checkOutDate);
  const newAmount = quantity * roomType.extraBedPricePerNight * remainingDates.length;
  return {
    reservationRoomId: room.id,
    roomNumber: room.roomUnitId,
    roomTypeName: roomType.name,
    effectiveDate,
    checkOutDate: reservation.checkOutDate,
    nights: remainingDates.length,
    previousQuantity: current.currentQuantity,
    quantity,
    unitPricePerNight: roomType.extraBedPricePerNight,
    maxExtraBeds: roomType.maxExtraBeds,
    previousRemainingAmount: current.oldRemainingAmount,
    newAmount,
    difference: newAmount - current.oldRemainingAmount,
    version: reservation.version,
  };
}

export async function saveExtraBedChange(
  tx: Transaction,
  input: {
    reservationId: string;
    roomId: string;
    quantity: number;
    expectedVersion: number;
    actorUserId: string;
  },
) {
  const [locked] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, input.reservationId))
    .for("update")
    .limit(1);
  if (!locked || locked.version !== input.expectedVersion)
    throw new RoomOperationError(
      "RESERVATION_CHANGED",
      "Reservation changed. Review the extra bed quote again",
    );
  const quote = await quoteExtraBedChange(tx, input.reservationId, input.roomId, input.quantity);
  if (quote.quantity === quote.previousQuantity && quote.difference === 0) {
    throw new RoomOperationError("NO_CHANGE", "Extra bed quantity is unchanged", 400);
  }
  await replaceFutureExtraBeds(
    tx,
    input.roomId,
    quote.effectiveDate,
    quote.checkOutDate,
    quote.quantity,
    quote.unitPricePerNight,
  );
  if (quote.difference !== 0) {
    await tx
      .insert(reservationCharges)
      .values({
        reservationId: input.reservationId,
        reservationRoomId: input.roomId,
        kind: "adjustment",
        description: `Extra bed change · ${quote.roomTypeName} · ${quote.effectiveDate} to ${quote.checkOutDate}`,
        quantity: "1",
        unitAmount: quote.difference,
        amount: quote.difference,
        createdByUserId: input.actorUserId,
      });
  }
  const financials = await readReservationFinancials(tx, input.reservationId);
  const paymentStatus =
    financials.remainingBalance === 0
      ? "paid"
      : financials.netPaidAmount > 0
        ? "partial"
        : "unpaid";
  await tx
    .update(reservations)
    .set({ paymentStatus, version: sql`${reservations.version} + 1`, updatedAt: new Date() })
    .where(eq(reservations.id, input.reservationId));
  await recordReservationEvent(tx, {
    reservationId: input.reservationId,
    eventType: "reservation.extra_bed_changed",
    actorType: "user",
    actorUserId: input.actorUserId,
    reservationStatusBefore: "checked_in",
    reservationStatusAfter: "checked_in",
    paymentStatusBefore: locked.paymentStatus,
    paymentStatusAfter: paymentStatus,
    details: {
      reservationRoomId: input.roomId,
      effectiveDate: quote.effectiveDate,
      previousQuantity: quote.previousQuantity,
      quantity: quote.quantity,
      difference: quote.difference,
    },
  });
  return { ...quote, paymentStatus, remainingBalance: financials.remainingBalance };
}

async function targetRoomAvailability(
  db: QueryDatabase,
  context: Awaited<ReturnType<typeof loadContext>>,
  targetRoomUnitId: string,
) {
  const { reservation, room, effectiveDate, remainingDates } = context;
  const [target] = await db
    .select({ unit: roomUnits, roomType: roomTypes })
    .from(roomUnits)
    .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
    .where(eq(roomUnits.id, targetRoomUnitId))
    .limit(1);
  if (
    !target ||
    !target.unit.isActive ||
    !target.roomType.isActive ||
    target.unit.operationalStatus !== "available"
  ) {
    throw new RoomOperationError("ROOM_UNIT_UNAVAILABLE", "Target room is not ready or inactive");
  }
  if (target.unit.id === room.roomUnitId)
    throw new RoomOperationError("NO_CHANGE", "Choose another room", 400);
  const maintenanceBlocks = await readActiveMaintenanceBlocks(
    db,
    effectiveDate,
    reservation.checkOutDate,
    [target.roomType.id],
  );
  if (maintenanceBlocks.some((block) => block.roomUnitId === targetRoomUnitId)) {
    throw new RoomOperationError(
      "ROOM_UNIT_UNAVAILABLE",
      "Target room has maintenance during this stay",
    );
  }
  const conflicting = await db
    .select({ id: reservationRooms.id })
    .from(reservationRooms)
    .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
    .where(
      and(
        eq(reservationRooms.roomUnitId, targetRoomUnitId),
        ne(reservations.id, reservation.id),
        inArray(reservations.reservationStatus, ["pending", "confirmed", "checked_in"]),
        lt(reservations.checkInDate, reservation.checkOutDate),
        gt(reservations.checkOutDate, effectiveDate),
      ),
    )
    .limit(1);
  if (conflicting.length)
    throw new RoomOperationError(
      "ROOM_UNIT_UNAVAILABLE",
      "Target room is assigned to another reservation during this stay",
    );

  const beds = await activeExtraBeds(db, room.id, effectiveDate, reservation.checkOutDate);
  if (
    beds.currentQuantity > target.roomType.maxExtraBeds ||
    (beds.currentQuantity > 0 && !target.roomType.extraBedEnabled)
  ) {
    throw new RoomOperationError(
      "EXTRA_BED_UNAVAILABLE",
      "Target room cannot accommodate the current extra beds",
    );
  }
  const capacities = await db
    .select({ extraBeds: roomTypeCapacityPatterns.extraBeds })
    .from(roomTypeCapacityPatterns)
    .innerJoin(
      capacityPatterns,
      eq(roomTypeCapacityPatterns.capacityPatternId, capacityPatterns.id),
    )
    .where(
      and(
        eq(roomTypeCapacityPatterns.roomTypeId, target.roomType.id),
        eq(capacityPatterns.adults, room.adults),
        eq(capacityPatterns.children, room.children),
        eq(capacityPatterns.isActive, true),
      ),
    );
  if (!capacities.some((item) => item.extraBeds <= beds.currentQuantity)) {
    throw new RoomOperationError(
      "CAPACITY_MISMATCH",
      "Target room does not fit this room's guests and extra beds",
    );
  }
  if (target.roomType.id !== room.roomTypeId) {
    const [inventory, booked, activeUnits] = await Promise.all([
      db
        .select()
        .from(roomInventoryDaily)
        .where(
          and(
            eq(roomInventoryDaily.roomTypeId, target.roomType.id),
            gte(roomInventoryDaily.stayDate, effectiveDate),
            lt(roomInventoryDaily.stayDate, reservation.checkOutDate),
          ),
        ),
      db
        .select({ checkInDate: reservations.checkInDate, checkOutDate: reservations.checkOutDate })
        .from(reservationRooms)
        .innerJoin(reservations, eq(reservationRooms.reservationId, reservations.id))
        .where(
          and(
            eq(reservationRooms.roomTypeId, target.roomType.id),
            ne(reservations.id, reservation.id),
            inArray(reservations.reservationStatus, ["pending", "confirmed", "checked_in"]),
            lt(reservations.checkInDate, reservation.checkOutDate),
            gt(reservations.checkOutDate, effectiveDate),
          ),
        ),
      db
        .select({ id: roomUnits.id })
        .from(roomUnits)
        .where(
          and(
            eq(roomUnits.roomTypeId, target.roomType.id),
            eq(roomUnits.isActive, true),
            sql`${roomUnits.operationalStatus} not in ('maintenance', 'out_of_service')`,
          ),
        ),
    ]);
    for (const date of remainingDates) {
      const daily = inventory.find((item) => item.stayDate === date);
      const occupied = booked.filter(
        (item) => item.checkInDate <= date && item.checkOutDate > date,
      ).length;
      const blockedUnitIds = new Set(
        maintenanceBlocks
          .filter((block) => block.startDate <= date && block.endDate > date)
          .map((block) => block.roomUnitId),
      );
      const physicalRooms = activeUnits.filter((unit) => !blockedUnitIds.has(unit.id)).length;
      if (!daily || daily.stopSell || Math.min(daily.sellableStock, physicalRooms) <= occupied) {
        throw new RoomOperationError(
          "ROOM_UNAVAILABLE",
          `Target room type has no sellable stock on ${date}`,
        );
      }
    }
  }
  return { target, beds };
}

export async function listChangeRoomOptions(
  db: QueryDatabase,
  reservationId: string,
  roomId: string,
) {
  const context = await loadContext(db, reservationId, roomId);
  const candidates = await db
    .select({
      id: roomUnits.id,
      roomNumber: roomUnits.roomNumber,
      roomTypeId: roomTypes.id,
      roomTypeName: roomTypes.name,
    })
    .from(roomUnits)
    .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
    .where(
      and(
        eq(roomUnits.isActive, true),
        eq(roomUnits.operationalStatus, "available"),
        eq(roomTypes.isActive, true),
        ne(roomUnits.id, context.room.roomUnitId!),
      ),
    )
    .orderBy(roomTypes.name, roomUnits.roomNumber);
  const options = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await targetRoomAvailability(db, context, candidate.id);
        return { ...candidate, available: true, reason: null };
      } catch (error) {
        return {
          ...candidate,
          available: false,
          reason: error instanceof RoomOperationError ? error.message : "Unavailable",
        };
      }
    }),
  );
  return {
    currentRoomUnitId: context.room.roomUnitId,
    effectiveDate: context.effectiveDate,
    checkOutDate: context.reservation.checkOutDate,
    options,
  };
}

export async function quoteRoomChange(
  db: QueryDatabase,
  reservationId: string,
  roomId: string,
  targetRoomUnitId: string,
) {
  const context = await loadContext(db, reservationId, roomId);
  const { target, beds } = await targetRoomAvailability(db, context, targetRoomUnitId);
  const { reservation, room, effectiveDate, remainingDates } = context;
  const [oldUnit] = await db
    .select({ roomNumber: roomUnits.roomNumber })
    .from(roomUnits)
    .where(eq(roomUnits.id, room.roomUnitId!))
    .limit(1);
  const oldNights = await db
    .select()
    .from(reservationRoomNights)
    .where(
      and(
        eq(reservationRoomNights.reservationRoomId, room.id),
        gte(reservationRoomNights.stayDate, effectiveDate),
        lt(reservationRoomNights.stayDate, reservation.checkOutDate),
      ),
    );
  if (oldNights.length !== remainingDates.length)
    throw new RoomOperationError("ROOM_RATES_MISSING", "Current room rates are incomplete");
  const oldRoomAmount = oldNights.reduce((sum, night) => sum + night.finalPrice, 0);
  let newNights = oldNights.map((night) => ({
    stayDate: night.stayDate,
    basePrice: night.basePrice,
    discountAmount: night.discountAmount,
    finalPrice: night.finalPrice,
    campaignSnapshot: night.campaignSnapshot,
  }));
  if (target.roomType.id !== room.roomTypeId) {
    const inventory = await db
      .select()
      .from(roomInventoryDaily)
      .where(
        and(
          eq(roomInventoryDaily.roomTypeId, target.roomType.id),
          gte(roomInventoryDaily.stayDate, effectiveDate),
          lt(roomInventoryDaily.stayDate, reservation.checkOutDate),
        ),
      );
    const roomCount = (
      await db
        .select({ id: reservationRooms.id })
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, reservation.id))
    ).length;
    const totalNights =
      stayDates(reservation.checkInDate, reservation.checkOutDate)?.length ?? remainingDates.length;
    const priced = await priceRoomNights(db, {
      source: reservation.source as "website" | "phone" | "walk_in" | "ota",
      bookingDate: effectiveDate,
      nights: totalNights,
      roomCount,
      rows: remainingDates.map((stayDate) => ({
        roomIndex: 0,
        roomTypeId: target.roomType.id,
        stayDate,
        basePrice: inventory.find((item) => item.stayDate === stayDate)!.basePrice,
      })),
    });
    newNights = priced.rows.map((night) => ({
      stayDate: night.stayDate,
      basePrice: night.basePrice,
      discountAmount: night.discountAmount,
      finalPrice: night.finalPrice,
      campaignSnapshot: night.campaignSnapshot,
    }));
  }
  const newRoomAmount = newNights.reduce((sum, night) => sum + night.finalPrice, 0);
  const newExtraBedAmount =
    target.roomType.id === room.roomTypeId
      ? beds.oldRemainingAmount
      : beds.currentQuantity * target.roomType.extraBedPricePerNight * remainingDates.length;
  return {
    reservationRoomId: room.id,
    oldRoomUnitId: room.roomUnitId,
    oldRoomNumber: oldUnit?.roomNumber ?? null,
    oldRoomTypeName: room.roomTypeNameSnapshot,
    targetRoomUnitId,
    targetRoomNumber: target.unit.roomNumber,
    targetRoomTypeId: target.roomType.id,
    targetRoomTypeName: target.roomType.name,
    effectiveDate,
    checkOutDate: reservation.checkOutDate,
    nights: remainingDates.length,
    oldRoomAmount,
    newRoomAmount,
    roomDifference: newRoomAmount - oldRoomAmount,
    extraBedQuantity: beds.currentQuantity,
    oldExtraBedAmount: beds.oldRemainingAmount,
    newExtraBedAmount,
    extraBedDifference: newExtraBedAmount - beds.oldRemainingAmount,
    totalDifference: newRoomAmount - oldRoomAmount + newExtraBedAmount - beds.oldRemainingAmount,
    newNights,
    version: reservation.version,
  };
}

export async function saveRoomChange(
  tx: Transaction,
  input: {
    reservationId: string;
    roomId: string;
    targetRoomUnitId: string;
    expectedVersion: number;
    actorUserId: string;
  },
) {
  const [locked] = await tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, input.reservationId))
    .for("update")
    .limit(1);
  if (!locked || locked.version !== input.expectedVersion)
    throw new RoomOperationError(
      "RESERVATION_CHANGED",
      "Reservation changed. Review the room change quote again",
    );
  const [currentRoom] = await tx
    .select({ roomUnitId: reservationRooms.roomUnitId })
    .from(reservationRooms)
    .where(
      and(
        eq(reservationRooms.id, input.roomId),
        eq(reservationRooms.reservationId, input.reservationId),
      ),
    )
    .limit(1);
  const [targetRoom] = await tx
    .select({ roomTypeId: roomUnits.roomTypeId })
    .from(roomUnits)
    .where(eq(roomUnits.id, input.targetRoomUnitId))
    .limit(1);
  if (!currentRoom?.roomUnitId || !targetRoom)
    throw new RoomOperationError("ROOM_UNIT_UNAVAILABLE", "Current or target room is unavailable");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${targetRoom.roomTypeId}))`);
  await tx
    .select()
    .from(roomUnits)
    .where(inArray(roomUnits.id, [currentRoom.roomUnitId, input.targetRoomUnitId].sort()))
    .orderBy(roomUnits.id)
    .for("update");
  const quote = await quoteRoomChange(
    tx,
    input.reservationId,
    input.roomId,
    input.targetRoomUnitId,
  );
  await tx
    .update(reservationRooms)
    .set({
      roomUnitId: quote.targetRoomUnitId,
      roomTypeId: quote.targetRoomTypeId,
      roomTypeNameSnapshot: quote.targetRoomTypeName,
      updatedAt: new Date(),
    })
    .where(eq(reservationRooms.id, input.roomId));
  if (
    quote.targetRoomTypeId !==
    (
      await tx
        .select({ roomTypeId: roomUnits.roomTypeId })
        .from(roomUnits)
        .where(eq(roomUnits.id, quote.oldRoomUnitId!))
        .limit(1)
    )[0]?.roomTypeId
  ) {
    for (const night of quote.newNights) {
      await tx
        .update(reservationRoomNights)
        .set({
          basePrice: night.basePrice,
          discountAmount: night.discountAmount,
          finalPrice: night.finalPrice,
          campaignSnapshot: night.campaignSnapshot,
        })
        .where(
          and(
            eq(reservationRoomNights.reservationRoomId, input.roomId),
            eq(reservationRoomNights.stayDate, night.stayDate),
          ),
        );
    }
  }
  if (quote.extraBedQuantity > 0 && quote.extraBedDifference !== 0) {
    await replaceFutureExtraBeds(
      tx,
      input.roomId,
      quote.effectiveDate,
      quote.checkOutDate,
      quote.extraBedQuantity,
      quote.newExtraBedAmount / (quote.extraBedQuantity * quote.nights),
    );
  }
  if (quote.roomDifference !== 0) {
    await tx
      .insert(reservationCharges)
      .values({
        reservationId: input.reservationId,
        reservationRoomId: input.roomId,
        kind: "room_change",
        description: `Room change ${quote.oldRoomTypeName} ${quote.oldRoomNumber ?? ""} → ${quote.targetRoomTypeName} ${quote.targetRoomNumber}`,
        quantity: "1",
        unitAmount: quote.roomDifference,
        amount: quote.roomDifference,
        createdByUserId: input.actorUserId,
      });
  }
  if (quote.extraBedDifference !== 0) {
    await tx
      .insert(reservationCharges)
      .values({
        reservationId: input.reservationId,
        reservationRoomId: input.roomId,
        kind: "adjustment",
        description: `Extra bed rate adjustment · room change ${quote.effectiveDate} to ${quote.checkOutDate}`,
        quantity: "1",
        unitAmount: quote.extraBedDifference,
        amount: quote.extraBedDifference,
        createdByUserId: input.actorUserId,
      });
  }
  await tx
    .update(roomUnits)
    .set({ operationalStatus: "cleaning", updatedAt: new Date() })
    .where(eq(roomUnits.id, quote.oldRoomUnitId!));
  await tx
    .update(roomUnits)
    .set({ operationalStatus: "occupied", updatedAt: new Date() })
    .where(eq(roomUnits.id, quote.targetRoomUnitId));
  await tx.insert(roomStatusEvents).values([
    {
      roomUnitId: quote.oldRoomUnitId!,
      statusBefore: "occupied",
      statusAfter: "cleaning",
      actorUserId: input.actorUserId,
      source: "room_change",
    },
    {
      roomUnitId: quote.targetRoomUnitId,
      statusBefore: "available",
      statusAfter: "occupied",
      actorUserId: input.actorUserId,
      source: "room_change",
    },
  ]);
  const financials = await readReservationFinancials(tx, input.reservationId);
  const paymentStatus =
    financials.remainingBalance === 0
      ? "paid"
      : financials.netPaidAmount > 0
        ? "partial"
        : "unpaid";
  await tx
    .update(reservations)
    .set({ paymentStatus, version: sql`${reservations.version} + 1`, updatedAt: new Date() })
    .where(eq(reservations.id, input.reservationId));
  await recordReservationEvent(tx, {
    reservationId: input.reservationId,
    eventType: "reservation.room_changed",
    actorType: "user",
    actorUserId: input.actorUserId,
    reservationStatusBefore: "checked_in",
    reservationStatusAfter: "checked_in",
    paymentStatusBefore: locked.paymentStatus,
    paymentStatusAfter: paymentStatus,
    details: {
      reservationRoomId: input.roomId,
      oldRoomUnitId: quote.oldRoomUnitId,
      oldRoomNumber: quote.oldRoomNumber,
      targetRoomUnitId: quote.targetRoomUnitId,
      targetRoomNumber: quote.targetRoomNumber,
      oldRoomTypeName: quote.oldRoomTypeName,
      targetRoomTypeName: quote.targetRoomTypeName,
      effectiveDate: quote.effectiveDate,
      roomDifference: quote.roomDifference,
      extraBedDifference: quote.extraBedDifference,
      totalDifference: quote.totalDifference,
    },
  });
  return { ...quote, paymentStatus, remainingBalance: financials.remainingBalance };
}
