import { and, asc, count, eq, ilike, or } from "drizzle-orm";
import { masterItems } from "../../../db/schema/master_items.schema.js";
import { roomTypes } from "../../../db/schema/room_types.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import type { Database } from "../../../plugins/database.js";
import {
  roomOperationalStatuses,
  type RoomOperationalStatus,
} from "../../rooms/schemas/room-numbers.schema.js";

type RoomStatusArgs = {
  search?: string;
  operationalStatus?: RoomOperationalStatus;
  isActive?: boolean;
};

export function parseRoomStatusArgs(value: unknown): RoomStatusArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid room status arguments");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["search", "operationalStatus", "isActive"].includes(key)) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.trim().length > 80)) ||
    (input.operationalStatus !== undefined &&
      !roomOperationalStatuses.includes(input.operationalStatus as RoomOperationalStatus)) ||
    (input.isActive !== undefined && typeof input.isActive !== "boolean")
  ) {
    throw new Error("Invalid room status arguments");
  }
  return {
    search: typeof input.search === "string" ? input.search.trim() || undefined : undefined,
    operationalStatus: input.operationalStatus as RoomOperationalStatus | undefined,
    isActive: input.isActive as boolean | undefined,
  };
}

export async function getRoomStatus(db: Database, args: RoomStatusArgs) {
  const searchPattern = args.search?.replace(/[\\%_]/g, "\\$&");
  const filter = and(
    eq(roomUnits.isActive, args.isActive ?? true),
    searchPattern
      ? or(
          ilike(roomUnits.roomNumber, `%${searchPattern}%`),
          ilike(roomTypes.name, `%${searchPattern}%`),
        )
      : undefined,
    args.operationalStatus ? eq(roomUnits.operationalStatus, args.operationalStatus) : undefined,
  );
  const [items, totals] = await Promise.all([
    db
      .select({
        roomNumber: roomUnits.roomNumber,
        roomType: roomTypes.name,
        floor: masterItems.name,
        operationalStatus: roomUnits.operationalStatus,
        isActive: roomUnits.isActive,
      })
      .from(roomUnits)
      .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
      .leftJoin(masterItems, eq(roomUnits.floorId, masterItems.id))
      .where(filter)
      .orderBy(asc(roomUnits.roomNumber))
      .limit(100),
    db
      .select({ operationalStatus: roomUnits.operationalStatus, total: count() })
      .from(roomUnits)
      .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
      .where(filter)
      .groupBy(roomUnits.operationalStatus),
  ]);
  const total = totals.reduce((sum, row) => sum + row.total, 0);
  return {
    ...args,
    total,
    byStatus: Object.fromEntries(totals.map((row) => [row.operationalStatus, row.total])),
    items,
    itemsTruncated: total > items.length,
    asOf: new Date().toISOString(),
  };
}
