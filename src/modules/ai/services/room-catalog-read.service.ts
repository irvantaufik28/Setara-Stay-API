import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { roomTypes } from "../../../db/schema/room_types.schema.js";

export type RoomCatalogView =
  | "room_types"
  | "room_type_detail"
  | "room_numbers"
  | "room_number_detail"
  | "maintenance_blocks"
  | "prices_stocks"
  | "prices_stocks_all";

export type RoomCatalogArgs = {
  view: RoomCatalogView;
  id?: string;
  search?: string;
  isActive?: boolean;
  roomTypeId?: string;
  roomTypeName?: string;
  floorId?: string;
  operationalStatus?: string;
  occupancy?: string;
  roomUnitId?: string;
  includeCancelled?: boolean;
  date?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
};

const views: RoomCatalogView[] = [
  "room_types",
  "room_type_detail",
  "room_numbers",
  "room_number_detail",
  "maintenance_blocks",
  "prices_stocks",
  "prices_stocks_all",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed: Record<RoomCatalogView, readonly (keyof RoomCatalogArgs)[]> = {
  room_types: ["search", "isActive", "page", "limit"],
  room_type_detail: ["id"],
  room_numbers: [
    "search",
    "roomTypeId",
    "floorId",
    "operationalStatus",
    "occupancy",
    "isActive",
    "page",
    "limit",
  ],
  room_number_detail: ["id"],
  maintenance_blocks: ["startDate", "endDate", "roomTypeId", "roomUnitId", "includeCancelled"],
  prices_stocks: ["roomTypeId", "roomTypeName", "date", "startDate", "endDate", "page", "limit"],
  prices_stocks_all: ["date"],
};

export function roomCatalogPermission(view: RoomCatalogView): string {
  if (view === "room_types" || view === "room_type_detail") return "rooms.view_types";
  if (view === "prices_stocks" || view === "prices_stocks_all") return "prices_stocks.view";
  return "rooms.view_numbers";
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function jakartaDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function parseRoomCatalogArgs(value: unknown): RoomCatalogArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid room catalog arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as RoomCatalogView;
  if (!views.includes(view)) throw new Error("Invalid room catalog arguments");
  const stockView = view === "prices_stocks" || view === "prices_stocks_all";
  const rangeView = view === "maintenance_blocks" || view === "prices_stocks";
  const stockDate =
    stockView && !input.date && !input.startDate && !input.endDate ? jakartaDate() : input.date;
  const start = view === "prices_stocks" && stockDate !== undefined ? stockDate : input.startDate;
  const end = view === "prices_stocks" && stockDate !== undefined ? stockDate : input.endDate;
  const rangeDays =
    validDate(start) && validDate(end)
      ? (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000
      : -1;
  if (
    Object.keys(input).some(
      (key) => key !== "view" && !allowed[view].includes(key as keyof RoomCatalogArgs),
    ) ||
    (input.id !== undefined && (typeof input.id !== "string" || !uuid.test(input.id))) ||
    ((view === "room_type_detail" || view === "room_number_detail") && !input.id) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.length > 160)) ||
    (input.isActive !== undefined && typeof input.isActive !== "boolean") ||
    (input.includeCancelled !== undefined && typeof input.includeCancelled !== "boolean") ||
    (input.date !== undefined && !validDate(input.date)) ||
    [input.roomTypeId, input.floorId, input.roomUnitId].some(
      (id) => id !== undefined && (typeof id !== "string" || !uuid.test(id)),
    ) ||
    (input.roomTypeName !== undefined &&
      (typeof input.roomTypeName !== "string" ||
        !input.roomTypeName.trim() ||
        input.roomTypeName.length > 160)) ||
    (input.operationalStatus !== undefined &&
      !["available", "occupied", "cleaning", "maintenance", "out_of_service"].includes(
        input.operationalStatus as string,
      )) ||
    (input.occupancy !== undefined &&
      !["available", "occupied"].includes(input.occupancy as string)) ||
    (rangeView &&
      (view === "maintenance_blocks"
        ? rangeDays < 1 || rangeDays > 366
        : rangeDays < 0 || rangeDays > 365)) ||
    (view === "prices_stocks" && !input.roomTypeId && !input.roomTypeName) ||
    (view === "prices_stocks_all" && !validDate(stockDate)) ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > (view === "prices_stocks" ? 30 : 100)))
  ) {
    throw new Error("Invalid room catalog arguments");
  }
  return {
    ...input,
    date: view === "prices_stocks_all" ? (stockDate as string) : undefined,
    startDate: start as string | undefined,
    endDate: end as string | undefined,
  } as RoomCatalogArgs;
}

export class RoomCatalogReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Room catalog read failed");
  }
}

function normalizeRoomTypeName(name: string): string {
  return name
    .trim()
    .replace(/^kamar\s+/i, "")
    .replace(/\bstandart\b/gi, "standard")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function resolveRoomTypeId(
  app: FastifyInstance,
  name: string,
): Promise<{ id?: string; matches?: string[] }> {
  const search = normalizeRoomTypeName(name);
  const rows = await app.db
    .select({ id: roomTypes.id, name: roomTypes.name })
    .from(roomTypes)
    .orderBy(asc(roomTypes.name));
  const exact = rows.filter((item) => normalizeRoomTypeName(item.name) === search);
  const matches = exact.length
    ? exact
    : rows.filter((item) => normalizeRoomTypeName(item.name).includes(search));
  if (matches.length === 1) return { id: matches[0].id };
  return { matches: matches.map((item) => item.name) };
}

async function readAllRoomStocks(
  app: FastifyInstance,
  authorization: string,
  date: string,
): Promise<unknown> {
  const types = await app.db
    .select({ id: roomTypes.id, name: roomTypes.name })
    .from(roomTypes)
    .where(eq(roomTypes.isActive, true))
    .orderBy(asc(roomTypes.name));
  const items: {
    roomTypeId: string;
    roomTypeName: string;
    sellableStock: number | null;
    bookedRooms: number;
    availableRooms: number | null;
    stopSell: boolean | null;
    isConfigured: boolean;
  }[] = [];
  for (let offset = 0; offset < types.length; offset += 5) {
    const batch = await Promise.all(
      types.slice(offset, offset + 5).map(async (type) => {
        const result = (await readRoomCatalog(app, authorization, {
          view: "prices_stocks",
          roomTypeId: type.id,
          startDate: date,
          endDate: date,
        })) as {
          items: {
            sellableStock: number | null;
            bookedRooms: number;
            availableRooms: number | null;
            stopSell: boolean | null;
            isConfigured: boolean;
          }[];
        };
        const stock = result.items[0];
        if (!stock) throw new RoomCatalogReadError(502);
        return {
          roomTypeId: type.id,
          roomTypeName: type.name,
          sellableStock: stock.sellableStock,
          bookedRooms: stock.bookedRooms,
          availableRooms: stock.availableRooms,
          stopSell: stock.stopSell,
          isConfigured: stock.isConfigured,
        };
      }),
    );
    items.push(...batch);
  }
  const fullyConfigured = items.every((item) => item.isConfigured);
  return {
    date,
    activeRoomTypes: types.length,
    availableRooms: fullyConfigured
      ? items.reduce((total, item) => total + (item.availableRooms ?? 0), 0)
      : null,
    items,
  };
}

export async function readRoomCatalog(
  app: FastifyInstance,
  authorization: string,
  args: RoomCatalogArgs,
): Promise<unknown> {
  if (args.view === "prices_stocks_all") {
    return readAllRoomStocks(app, authorization, args.date!);
  }
  if (args.view === "prices_stocks" && args.roomTypeId && args.roomTypeName) {
    args = { ...args, roomTypeName: undefined };
  }
  if (args.view === "prices_stocks" && args.roomTypeName) {
    const resolved = await resolveRoomTypeId(app, args.roomTypeName);
    if (!resolved.id) {
      return {
        view: args.view,
        roomTypeName: args.roomTypeName,
        found: false,
        matches: resolved.matches,
      };
    }
    args = { ...args, roomTypeId: resolved.id, roomTypeName: undefined };
  }
  const path: Record<RoomCatalogView, string> = {
    room_types: "/room-types",
    room_type_detail: `/room-types/${args.id}`,
    room_numbers: "/room-numbers",
    room_number_detail: `/room-numbers/${args.id}`,
    maintenance_blocks: "/room-maintenance-blocks",
    prices_stocks: "/prices-stocks",
    prices_stocks_all: "/prices-stocks",
  };
  const query = new URLSearchParams();
  for (const key of allowed[args.view]) {
    if (key === "id") continue;
    const value = args[key];
    if (value !== undefined) query.set(key, String(value));
  }
  if (["room_types", "room_numbers", "prices_stocks"].includes(args.view) && !query.has("limit")) {
    query.set("limit", args.view === "prices_stocks" ? "30" : "20");
  }
  const url = `/api/v1/admin${path[args.view]}${query.size ? `?${query}` : ""}`;
  const response = await app.inject({ method: "GET", url, headers: { authorization } });
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new RoomCatalogReadError(response.statusCode);
  }
  if (response.statusCode === 404) return { found: false, view: args.view, id: args.id };
  if (response.statusCode === 400) throw new Error("Invalid room catalog arguments");
  if (response.statusCode !== 200) throw new RoomCatalogReadError(response.statusCode);
  return response.json();
}
