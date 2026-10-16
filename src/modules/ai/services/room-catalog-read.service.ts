import type { FastifyInstance } from "fastify";

export type RoomCatalogView =
  | "room_types"
  | "room_type_detail"
  | "room_numbers"
  | "room_number_detail"
  | "maintenance_blocks"
  | "prices_stocks";

export type RoomCatalogArgs = {
  view: RoomCatalogView;
  id?: string;
  search?: string;
  isActive?: boolean;
  roomTypeId?: string;
  floorId?: string;
  operationalStatus?: string;
  occupancy?: string;
  roomUnitId?: string;
  includeCancelled?: boolean;
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
  prices_stocks: ["roomTypeId", "startDate", "endDate", "page", "limit"],
};

export function roomCatalogPermission(view: RoomCatalogView): string {
  if (view === "room_types" || view === "room_type_detail") return "rooms.view_types";
  if (view === "prices_stocks") return "prices_stocks.view";
  return "rooms.view_numbers";
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseRoomCatalogArgs(value: unknown): RoomCatalogArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid room catalog arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as RoomCatalogView;
  if (!views.includes(view)) throw new Error("Invalid room catalog arguments");
  const rangeView = view === "maintenance_blocks" || view === "prices_stocks";
  const start = input.startDate;
  const end = input.endDate;
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
    [input.roomTypeId, input.floorId, input.roomUnitId].some(
      (id) => id !== undefined && (typeof id !== "string" || !uuid.test(id)),
    ) ||
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
    (view === "prices_stocks" && !input.roomTypeId) ||
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
  return input as RoomCatalogArgs;
}

export class RoomCatalogReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Room catalog read failed");
  }
}

export async function readRoomCatalog(
  app: FastifyInstance,
  authorization: string,
  args: RoomCatalogArgs,
): Promise<unknown> {
  const path: Record<RoomCatalogView, string> = {
    room_types: "/room-types",
    room_type_detail: `/room-types/${args.id}`,
    room_numbers: "/room-numbers",
    room_number_detail: `/room-numbers/${args.id}`,
    maintenance_blocks: "/room-maintenance-blocks",
    prices_stocks: "/prices-stocks",
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
