import { and, asc, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { masterItems } from "../../../db/schema/master_items.schema.js";
import { roomTypes } from "../../../db/schema/room_types.schema.js";
import { roomUnits } from "../../../db/schema/room_units.schema.js";
import { roomStatusEvents } from "../../../db/schema/room_status_events.schema.js";
import { roomMaintenanceBlocks } from "../../../db/schema/room_maintenance_blocks.schema.js";
import { users } from "../../../db/schema/users.schema.js";
import { databaseErrorCode, uuidSchema } from "../../master/master.shared.js";
import {
  roomNumberBodySchema,
  roomNumberParamsSchema,
  roomOperationalStatuses,
  type RoomNumberBody,
  type RoomOperationalStatus,
} from "../schemas/room-numbers.schema.js";

type IdParams = { id: string };
type ListQuery = {
  search?: string;
  roomTypeId?: string;
  floorId?: string;
  operationalStatus?: RoomOperationalStatus;
  occupancy?: "available" | "occupied";
  isActive?: boolean;
  page?: number;
  limit?: number;
};

const errorBody = (code: string, message: string) => ({ error: { code, message } });

function roomNumberValues(body: RoomNumberBody) {
  return {
    roomNumber: body.roomNumber.trim(),
    roomTypeId: body.roomTypeId,
    floorId: body.floorId ?? null,
    bedConfiguration: body.bedConfiguration?.trim() || null,
    operationalStatus: body.operationalStatus,
    isActive: body.isActive,
  };
}

export const roomNumberRoutes: FastifyPluginAsync = async (app) => {
  async function validateReferences(body: RoomNumberBody): Promise<string | null> {
    const [roomType] = await app.db
      .select({ id: roomTypes.id })
      .from(roomTypes)
      .where(and(eq(roomTypes.id, body.roomTypeId), eq(roomTypes.isActive, true)))
      .limit(1);
    if (!roomType) return "Room type not found or inactive";

    if (body.floorId) {
      const [floor] = await app.db
        .select({ id: masterItems.id })
        .from(masterItems)
        .where(
          and(
            eq(masterItems.id, body.floorId),
            eq(masterItems.category, "floors"),
            eq(masterItems.isActive, true),
          ),
        )
        .limit(1);
      if (!floor) return "Floor not found, inactive, or in the wrong master category";
    }
    return null;
  }

  const roomFields = {
    id: roomUnits.id,
    roomNumber: roomUnits.roomNumber,
    roomTypeId: roomUnits.roomTypeId,
    roomTypeCode: roomTypes.code,
    roomTypeName: roomTypes.name,
    floorId: roomUnits.floorId,
    floorName: masterItems.name,
    bedConfiguration: roomUnits.bedConfiguration,
    operationalStatus: roomUnits.operationalStatus,
    isActive: roomUnits.isActive,
    createdAt: roomUnits.createdAt,
    updatedAt: roomUnits.updatedAt,
  };

  function roomQuery() {
    return app.db
      .select(roomFields)
      .from(roomUnits)
      .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
      .leftJoin(masterItems, eq(roomUnits.floorId, masterItems.id));
  }

  app.get(
    "/status-history",
    { preHandler: app.requirePermission("rooms.view_numbers") },
    async () => {
      const items = await app.db
        .select({
          id: roomStatusEvents.id,
          roomUnitId: roomStatusEvents.roomUnitId,
          roomNumber: roomUnits.roomNumber,
          statusBefore: roomStatusEvents.statusBefore,
          statusAfter: roomStatusEvents.statusAfter,
          source: roomStatusEvents.source,
          occurredAt: roomStatusEvents.occurredAt,
          actorUserId: roomStatusEvents.actorUserId,
          actorName: users.name,
        })
        .from(roomStatusEvents)
        .innerJoin(roomUnits, eq(roomStatusEvents.roomUnitId, roomUnits.id))
        .innerJoin(users, eq(roomStatusEvents.actorUserId, users.id))
        .orderBy(desc(roomStatusEvents.occurredAt))
        .limit(30);
      return { items };
    },
  );

  app.get<{ Querystring: ListQuery }>(
    "/",
    {
      preHandler: app.requirePermission("rooms.view_numbers"),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            search: { type: "string", maxLength: 160 },
            roomTypeId: uuidSchema,
            floorId: uuidSchema,
            operationalStatus: { type: "string", enum: roomOperationalStatuses },
            occupancy: { type: "string", enum: ["available", "occupied"] },
            isActive: { type: "boolean" },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) => {
      const {
        search,
        roomTypeId,
        floorId,
        operationalStatus,
        occupancy,
        isActive,
        page = 1,
        limit = 20,
      } = request.query;
      const term = search?.trim();
      const filter = and(
        roomTypeId ? eq(roomUnits.roomTypeId, roomTypeId) : undefined,
        floorId ? eq(roomUnits.floorId, floorId) : undefined,
        operationalStatus ? eq(roomUnits.operationalStatus, operationalStatus) : undefined,
        occupancy === "occupied"
          ? eq(roomUnits.operationalStatus, "occupied")
          : occupancy === "available"
            ? and(eq(roomUnits.operationalStatus, "available"), eq(roomUnits.isActive, true))
            : undefined,
        isActive === undefined ? undefined : eq(roomUnits.isActive, isActive),
        term
          ? or(ilike(roomUnits.roomNumber, `%${term}%`), ilike(roomTypes.name, `%${term}%`))
          : undefined,
      );
      const [items, [count]] = await Promise.all([
        roomQuery()
          .where(filter)
          .orderBy(asc(roomUnits.roomNumber))
          .limit(limit)
          .offset((page - 1) * limit),
        app.db
          .select({ total: sql<number>`count(*)::int` })
          .from(roomUnits)
          .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
          .where(filter),
      ]);
      return { items, page, limit, total: count.total };
    },
  );

  app.get<{ Params: IdParams }>(
    "/:id",
    {
      preHandler: app.requirePermission("rooms.view_numbers"),
      schema: { params: roomNumberParamsSchema },
    },
    async (request, reply) => {
      const [roomNumber] = await roomQuery().where(eq(roomUnits.id, request.params.id)).limit(1);
      if (!roomNumber) return reply.code(404).send(errorBody("NOT_FOUND", "Room number not found"));
      return { roomNumber };
    },
  );

  app.get<{ Params: IdParams }>(
    "/:id/status-history",
    {
      preHandler: app.requirePermission("rooms.view_numbers"),
      schema: { params: roomNumberParamsSchema },
    },
    async (request, reply) => {
      const [room] = await app.db
        .select({ id: roomUnits.id })
        .from(roomUnits)
        .where(eq(roomUnits.id, request.params.id))
        .limit(1);
      if (!room) return reply.code(404).send(errorBody("NOT_FOUND", "Room number not found"));
      const items = await app.db
        .select({
          id: roomStatusEvents.id,
          statusBefore: roomStatusEvents.statusBefore,
          statusAfter: roomStatusEvents.statusAfter,
          source: roomStatusEvents.source,
          occurredAt: roomStatusEvents.occurredAt,
          actorUserId: roomStatusEvents.actorUserId,
          actorName: users.name,
        })
        .from(roomStatusEvents)
        .innerJoin(users, eq(roomStatusEvents.actorUserId, users.id))
        .where(eq(roomStatusEvents.roomUnitId, request.params.id))
        .orderBy(desc(roomStatusEvents.occurredAt))
        .limit(100);
      return { items };
    },
  );

  app.post<{ Body: RoomNumberBody }>(
    "/",
    {
      preHandler: app.requirePermission("rooms.create_number"),
      schema: { body: roomNumberBodySchema },
    },
    async (request, reply) => {
      if (!request.body.roomNumber.trim()) {
        return reply.code(400).send(errorBody("INVALID_ROOM_NUMBER", "Room number is required"));
      }
      const referenceError = await validateReferences(request.body);
      if (referenceError)
        return reply.code(400).send(errorBody("INVALID_REFERENCE", referenceError));
      try {
        const [created] = await app.db
          .insert(roomUnits)
          .values(roomNumberValues(request.body))
          .returning({ id: roomUnits.id });
        const [roomNumber] = await roomQuery().where(eq(roomUnits.id, created.id)).limit(1);
        return reply.code(201).send({ roomNumber });
      } catch (error) {
        if (databaseErrorCode(error) === "23505")
          return reply
            .code(409)
            .send(errorBody("DUPLICATE_ROOM_NUMBER", "Room number already exists"));
        if (databaseErrorCode(error) === "23503")
          return reply
            .code(400)
            .send(errorBody("INVALID_REFERENCE", "Room type or floor is unavailable"));
        throw error;
      }
    },
  );

  app.put<{ Params: IdParams; Body: RoomNumberBody }>(
    "/:id",
    {
      preHandler: app.requirePermission("rooms.edit_number"),
      schema: { params: roomNumberParamsSchema, body: roomNumberBodySchema },
    },
    async (request, reply) => {
      if (!request.body.roomNumber.trim()) {
        return reply.code(400).send(errorBody("INVALID_ROOM_NUMBER", "Room number is required"));
      }
      const referenceError = await validateReferences(request.body);
      if (referenceError)
        return reply.code(400).send(errorBody("INVALID_REFERENCE", referenceError));
      try {
        return await app.db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(roomUnits)
            .where(eq(roomUnits.id, request.params.id))
            .for("update")
            .limit(1);
          if (!current)
            return reply.code(404).send(errorBody("NOT_FOUND", "Room number not found"));
          if (current.operationalStatus === "occupied")
            return reply
              .code(409)
              .send(errorBody("ROOM_OCCUPIED", "Room is occupied; edit after checkout"));
          if (current.operationalStatus !== request.body.operationalStatus) {
            if (
              request.body.operationalStatus === "available" &&
              current.operationalStatus !== "cleaning"
            )
              return reply
                .code(409)
                .send(
                  errorBody(
                    "INVALID_STATUS_TRANSITION",
                    "Only a cleaning room can be marked available",
                  ),
                );
            if (request.body.operationalStatus === "available" && !request.body.isActive)
              return reply
                .code(409)
                .send(errorBody("ROOM_INACTIVE", "Inactive room cannot be marked available"));
            if (request.body.operationalStatus === "available") {
              const [block] = await tx
                .select({ id: roomMaintenanceBlocks.id })
                .from(roomMaintenanceBlocks)
                .where(
                  and(
                    eq(roomMaintenanceBlocks.roomUnitId, current.id),
                    sql`${roomMaintenanceBlocks.cancelledAt} is null`,
                    sql`${roomMaintenanceBlocks.startDate} <= current_date`,
                    sql`${roomMaintenanceBlocks.endDate} > current_date`,
                  ),
                )
                .limit(1);
              if (block)
                return reply
                  .code(409)
                  .send(errorBody("ROOM_MAINTENANCE", "Room has active maintenance"));
            }
          }
          await tx
            .update(roomUnits)
            .set({ ...roomNumberValues(request.body), updatedAt: new Date() })
            .where(eq(roomUnits.id, current.id));
          if (current.operationalStatus !== request.body.operationalStatus)
            await tx.insert(roomStatusEvents).values({
              roomUnitId: current.id,
              statusBefore: current.operationalStatus,
              statusAfter: request.body.operationalStatus,
              actorUserId: request.authUser!.id,
              source: "room_numbers",
            });
          const [roomNumber] = await tx
            .select(roomFields)
            .from(roomUnits)
            .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
            .leftJoin(masterItems, eq(roomUnits.floorId, masterItems.id))
            .where(eq(roomUnits.id, current.id))
            .limit(1);
          return { roomNumber };
        });
      } catch (error) {
        if (databaseErrorCode(error) === "23505")
          return reply
            .code(409)
            .send(errorBody("DUPLICATE_ROOM_NUMBER", "Room number already exists"));
        if (databaseErrorCode(error) === "23503")
          return reply
            .code(400)
            .send(errorBody("INVALID_REFERENCE", "Room type or floor is unavailable"));
        throw error;
      }
    },
  );

  app.patch<{
    Params: IdParams;
    Body: {
      operationalStatus: RoomOperationalStatus;
      source?: "housekeeping" | "room_rack" | "room_numbers";
    };
  }>(
    "/:id/operational-status",
    {
      preHandler: app.requirePermission("rooms.change_operational_status"),
      schema: {
        params: roomNumberParamsSchema,
        body: {
          type: "object",
          required: ["operationalStatus"],
          additionalProperties: false,
          properties: {
            operationalStatus: { type: "string", enum: roomOperationalStatuses },
            source: { type: "string", enum: ["housekeeping", "room_rack", "room_numbers"] },
          },
        },
      },
    },
    async (request, reply) => {
      return app.db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(roomUnits)
          .where(eq(roomUnits.id, request.params.id))
          .for("update")
          .limit(1);
        if (!current) return reply.code(404).send(errorBody("NOT_FOUND", "Room number not found"));
        if (current.operationalStatus === "occupied")
          return reply
            .code(409)
            .send(errorBody("ROOM_OCCUPIED", "Room is occupied; edit after checkout"));
        if (current.operationalStatus === request.body.operationalStatus)
          return reply
            .code(409)
            .send(errorBody("STATUS_UNCHANGED", "Room already has this status"));
        if (
          request.authUser!.roleName === "Staff" &&
          (current.operationalStatus !== "cleaning" ||
            request.body.operationalStatus !== "available")
        )
          return reply
            .code(403)
            .send(errorBody("FORBIDDEN", "Staff can only mark cleaning rooms available"));
        if (request.body.operationalStatus === "available") {
          if (!current.isActive)
            return reply
              .code(409)
              .send(errorBody("ROOM_INACTIVE", "Inactive room cannot be marked available"));
          if (current.operationalStatus !== "cleaning")
            return reply
              .code(409)
              .send(
                errorBody(
                  "INVALID_STATUS_TRANSITION",
                  "Only a cleaning room can be marked available",
                ),
              );
          const [block] = await tx
            .select({ id: roomMaintenanceBlocks.id })
            .from(roomMaintenanceBlocks)
            .where(
              and(
                eq(roomMaintenanceBlocks.roomUnitId, current.id),
                sql`${roomMaintenanceBlocks.cancelledAt} is null`,
                sql`${roomMaintenanceBlocks.startDate} <= current_date`,
                sql`${roomMaintenanceBlocks.endDate} > current_date`,
              ),
            )
            .limit(1);
          if (block)
            return reply
              .code(409)
              .send(errorBody("ROOM_MAINTENANCE", "Room has active maintenance"));
        }
        await tx
          .update(roomUnits)
          .set({ operationalStatus: request.body.operationalStatus, updatedAt: new Date() })
          .where(eq(roomUnits.id, current.id));
        await tx.insert(roomStatusEvents).values({
          roomUnitId: current.id,
          statusBefore: current.operationalStatus,
          statusAfter: request.body.operationalStatus,
          actorUserId: request.authUser!.id,
          source: request.body.source ?? "room_numbers",
        });
        const [roomNumber] = await tx
          .select(roomFields)
          .from(roomUnits)
          .innerJoin(roomTypes, eq(roomUnits.roomTypeId, roomTypes.id))
          .leftJoin(masterItems, eq(roomUnits.floorId, masterItems.id))
          .where(eq(roomUnits.id, current.id))
          .limit(1);
        return { roomNumber };
      });
    },
  );

  app.delete<{ Params: IdParams }>(
    "/:id",
    {
      preHandler: app.requirePermission("rooms.edit_number"),
      schema: { params: roomNumberParamsSchema },
    },
    async (request, reply) => {
      try {
        const [deleted] = await app.db
          .delete(roomUnits)
          .where(
            and(eq(roomUnits.id, request.params.id), ne(roomUnits.operationalStatus, "occupied")),
          )
          .returning({ id: roomUnits.id });
        if (!deleted) {
          const [existing] = await app.db
            .select({ id: roomUnits.id })
            .from(roomUnits)
            .where(eq(roomUnits.id, request.params.id))
            .limit(1);
          return existing
            ? reply
                .code(409)
                .send(errorBody("ROOM_OCCUPIED", "Room is occupied; delete after checkout"))
            : reply.code(404).send(errorBody("NOT_FOUND", "Room number not found"));
        }
        return reply.code(204).send();
      } catch (error) {
        if (databaseErrorCode(error) === "23503")
          return reply
            .code(409)
            .send(
              errorBody(
                "ROOM_IN_USE",
                "Room has reservation or change history; deactivate it instead",
              ),
            );
        throw error;
      }
    },
  );
};
