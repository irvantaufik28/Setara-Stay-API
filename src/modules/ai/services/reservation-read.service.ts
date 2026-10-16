import type { FastifyInstance } from "fastify";

export type ReservationView =
  "list" | "detail" | "history" | "arrivals_today" | "in_house" | "departures_today" | "room_rack";

export type ReservationReadArgs = {
  view: ReservationView;
  id?: string;
  search?: string;
  source?: "website" | "phone" | "walk_in" | "ota";
  reservationStatus?: string;
  paymentStatus?: string;
  roomAssignment?: "unassigned";
  operationalStatus?: string;
  stayDate?: string;
  stayDateFrom?: string;
  stayDateTo?: string;
  sort?: "newest" | "booking_code_asc" | "booking_code_desc";
  page?: number;
  limit?: number;
  startDate?: string;
  days?: number;
  roomTypeId?: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const views: ReservationView[] = [
  "list",
  "detail",
  "history",
  "arrivals_today",
  "in_house",
  "departures_today",
  "room_rack",
];

const viewPermissions: Record<ReservationView, string> = {
  list: "reservations.view",
  detail: "reservations.view",
  history: "reservations.view",
  arrivals_today: "reservations.view_arrivals_today",
  in_house: "reservations.view_in_house",
  departures_today: "reservations.view_departures_today",
  room_rack: "reservations.view",
};

const allowedByView: Record<ReservationView, readonly (keyof ReservationReadArgs)[]> = {
  list: [
    "search",
    "source",
    "reservationStatus",
    "paymentStatus",
    "roomAssignment",
    "stayDate",
    "stayDateFrom",
    "stayDateTo",
    "sort",
    "page",
    "limit",
  ],
  detail: ["id"],
  history: ["id", "page", "limit"],
  arrivals_today: ["search", "source", "page", "limit"],
  in_house: ["search", "operationalStatus", "paymentStatus", "page", "limit"],
  departures_today: ["search", "operationalStatus", "paymentStatus", "page", "limit"],
  room_rack: ["startDate", "days", "roomTypeId"],
};

export function reservationViewPermission(view: ReservationView): string {
  return viewPermissions[view];
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseReservationReadArgs(value: unknown): ReservationReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid reservation read arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as ReservationView;
  if (
    !views.includes(view) ||
    Object.keys(input).some(
      (key) => key !== "view" && !allowedByView[view].includes(key as keyof ReservationReadArgs),
    ) ||
    (input.id !== undefined && (typeof input.id !== "string" || !uuidPattern.test(input.id))) ||
    (["detail", "history"].includes(input.view as string) && !input.id) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.trim().length > 255)) ||
    (input.source !== undefined &&
      !["website", "phone", "walk_in", "ota"].includes(input.source as string)) ||
    (input.reservationStatus !== undefined &&
      ![
        "pending",
        "confirmed",
        "checked_in",
        "checked_out",
        "no_show",
        "cancelled",
        "expired",
      ].includes(input.reservationStatus as string)) ||
    (input.paymentStatus !== undefined &&
      !["unpaid", "partial", "paid", "failed", "expired", "refunded"].includes(
        input.paymentStatus as string,
      )) ||
    (input.roomAssignment !== undefined && input.roomAssignment !== "unassigned") ||
    (input.operationalStatus !== undefined &&
      !["in_house", "due_out", "overdue", "checked_out"].includes(
        input.operationalStatus as string,
      )) ||
    (view === "in_house" && input.operationalStatus === "checked_out") ||
    (["in_house", "departures_today"].includes(view) &&
      input.paymentStatus !== undefined &&
      !["unpaid", "partial", "paid"].includes(input.paymentStatus as string)) ||
    (input.stayDate !== undefined && !validDate(input.stayDate)) ||
    (input.stayDateFrom !== undefined && !validDate(input.stayDateFrom)) ||
    (input.stayDateTo !== undefined && !validDate(input.stayDateTo)) ||
    (typeof input.stayDateFrom === "string" &&
      typeof input.stayDateTo === "string" &&
      input.stayDateFrom > input.stayDateTo) ||
    (input.sort !== undefined &&
      !["newest", "booking_code_asc", "booking_code_desc"].includes(input.sort as string)) ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 50)) ||
    (input.startDate !== undefined && !validDate(input.startDate)) ||
    (input.view === "room_rack" && !input.startDate) ||
    (input.days !== undefined &&
      (!Number.isInteger(input.days) ||
        (input.days as number) < 1 ||
        (input.days as number) > 31)) ||
    (input.roomTypeId !== undefined &&
      (typeof input.roomTypeId !== "string" || !uuidPattern.test(input.roomTypeId)))
  ) {
    throw new Error("Invalid reservation read arguments");
  }
  return {
    view: input.view as ReservationView,
    id: input.id as string | undefined,
    search: typeof input.search === "string" ? input.search.trim() || undefined : undefined,
    source: input.source as ReservationReadArgs["source"],
    reservationStatus: input.reservationStatus as string | undefined,
    paymentStatus: input.paymentStatus as string | undefined,
    roomAssignment: input.roomAssignment as "unassigned" | undefined,
    operationalStatus: input.operationalStatus as string | undefined,
    stayDate: input.stayDate as string | undefined,
    stayDateFrom: input.stayDateFrom as string | undefined,
    stayDateTo: input.stayDateTo as string | undefined,
    sort: input.sort as ReservationReadArgs["sort"],
    page: input.page as number | undefined,
    limit: input.limit as number | undefined,
    startDate: input.startDate as string | undefined,
    days: input.days as number | undefined,
    roomTypeId: input.roomTypeId as string | undefined,
  };
}

export class ReservationReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Reservation read failed");
  }
}

export async function readReservationView(
  app: FastifyInstance,
  authorization: string,
  args: ReservationReadArgs,
): Promise<unknown> {
  const base = "/api/v1/admin/reservations";
  const path = {
    list: "",
    detail: `/${args.id}`,
    history: `/${args.id}/history`,
    arrivals_today: "/arrivals-today",
    in_house: "/in-house",
    departures_today: "/departures-today",
    room_rack: "/room-rack",
  }[args.view];
  const query = new URLSearchParams();
  for (const key of allowedByView[args.view]) {
    if (key === "id") continue;
    const value = args[key];
    if (value !== undefined) query.set(key, String(value));
  }
  if (args.view === "room_rack" && args.startDate === undefined) {
    throw new Error("Invalid reservation read arguments");
  }
  if (args.view !== "room_rack" && args.view !== "detail") {
    if (!query.has("limit")) query.set("limit", "20");
  }
  const url = `${base}${path}${query.size ? `?${query}` : ""}`;
  const response = await app.inject({ method: "GET", url, headers: { authorization } });
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new ReservationReadError(response.statusCode);
  }
  if (response.statusCode === 404) return { found: false, view: args.view, id: args.id };
  if (response.statusCode === 400) throw new Error("Invalid reservation read arguments");
  if (response.statusCode !== 200) throw new ReservationReadError(response.statusCode);
  return response.json();
}
