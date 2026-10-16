import type { FastifyInstance } from "fastify";
import { categorySlugs } from "../../master/master.shared.js";

export const exportDatasets = [
  "reservations",
  "reservations_report",
  "revenue_report",
  "guests",
  "payments",
  "transactions",
  "refunds",
  "outstanding",
  "room_types",
  "room_numbers",
  "maintenance_blocks",
  "prices_stocks",
  "cancellation_policies",
  "campaigns",
  "experiences",
  "users",
  "roles",
  "master_items",
  "capacity_patterns",
  "reservation_settings",
] as const;

export type ExportDataset = (typeof exportDatasets)[number];
export type ExportRequest = { dataset: ExportDataset; filters: Record<string, string | boolean> };

const maxRows = 10000;
const maxCsvBytes = 20_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed: Record<ExportDataset, readonly string[]> = {
  reservations: [
    "search",
    "source",
    "reservationStatus",
    "paymentStatus",
    "stayDate",
    "stayDateFrom",
    "stayDateTo",
    "sort",
  ],
  reservations_report: [
    "search",
    "dateBy",
    "from",
    "to",
    "reservationStatus",
    "source",
    "roomType",
    "otaChannelId",
    "sort",
  ],
  revenue_report: [
    "dateBy",
    "from",
    "to",
    "source",
    "paymentStatus",
    "reservationStatus",
    "methodId",
    "roomType",
  ],
  guests: ["search", "status"],
  payments: ["search", "reservationStatus", "paymentStatus", "source", "methodId", "from", "to"],
  transactions: ["search", "source", "status", "methodId", "from", "to"],
  refunds: ["search", "source"],
  outstanding: ["search", "source"],
  room_types: ["search", "isActive"],
  room_numbers: ["search", "roomTypeId", "floorId", "operationalStatus", "occupancy", "isActive"],
  maintenance_blocks: ["startDate", "endDate", "roomTypeId", "roomUnitId", "includeCancelled"],
  prices_stocks: ["roomTypeId", "startDate", "endDate"],
  cancellation_policies: ["search", "source", "isActive", "roomTypeId"],
  campaigns: ["search", "roomTypeId", "channel", "isActive"],
  experiences: ["search", "categoryId", "isActive"],
  users: ["search"],
  roles: ["search"],
  master_items: ["category"],
  capacity_patterns: [],
  reservation_settings: [],
};

const paths: Record<Exclude<ExportDataset, "master_items">, string> = {
  reservations: "/reservations",
  reservations_report: "/reports/reservations",
  revenue_report: "/reports/revenue",
  guests: "/guests",
  payments: "/payments",
  transactions: "/payments/transactions",
  refunds: "/payments/refunds",
  outstanding: "/payments/outstanding",
  room_types: "/room-types",
  room_numbers: "/room-numbers",
  maintenance_blocks: "/room-maintenance-blocks",
  prices_stocks: "/prices-stocks",
  cancellation_policies: "/cancellation-policies",
  campaigns: "/campaigns",
  experiences: "/experiences",
  users: "/users",
  roles: "/roles",
  capacity_patterns: "/master/capacity-patterns",
  reservation_settings: "/settings/reservations",
};

const unpaged = new Set<ExportDataset>([
  "revenue_report",
  "maintenance_blocks",
  "users",
  "roles",
  "master_items",
  "capacity_patterns",
  "reservation_settings",
]);
const dateKeys = new Set([
  "from",
  "to",
  "startDate",
  "endDate",
  "stayDate",
  "stayDateFrom",
  "stayDateTo",
]);
const uuidKeys = new Set([
  "roomTypeId",
  "roomUnitId",
  "floorId",
  "categoryId",
  "methodId",
  "roomType",
  "otaChannelId",
]);
const booleanKeys = new Set(["isActive", "includeCancelled"]);
const enums: Record<string, readonly string[]> = {
  source: ["website", "phone", "walk_in", "ota"],
  reservationStatus: [
    "pending",
    "confirmed",
    "checked_in",
    "checked_out",
    "no_show",
    "cancelled",
    "expired",
  ],
  paymentStatus: ["unpaid", "partial", "paid", "failed", "expired", "refunded"],
  status: [
    "active",
    "blacklisted",
    "pending",
    "succeeded",
    "failed",
    "expired",
    "refunded",
    "partially_refunded",
  ],
  channel: ["website", "front_desk"],
  operationalStatus: ["available", "occupied", "cleaning", "maintenance", "out_of_service"],
  occupancy: ["available", "occupied"],
  dateBy: ["payment", "booking", "check_in", "check_out"],
  sort: ["newest", "booking_code_asc", "booking_code_desc"],
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseExportRequest(value: unknown): ExportRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid export request");
  }
  const input = value as Record<string, unknown>;
  const dataset = input.dataset as ExportDataset;
  if (
    !exportDatasets.includes(dataset) ||
    Object.keys(input).some((key) => key !== "dataset" && key !== "filters")
  ) {
    throw new Error("Invalid export request");
  }
  const filters = input.filters === undefined ? {} : input.filters;
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) {
    throw new Error("Invalid export request");
  }
  const values = filters as Record<string, unknown>;
  for (const [key, entry] of Object.entries(values)) {
    if (!allowed[dataset].includes(key)) throw new Error("Invalid export request");
    if (booleanKeys.has(key)) {
      if (typeof entry !== "boolean") throw new Error("Invalid export request");
    } else if (typeof entry !== "string" || entry.length > 255 || !entry.length) {
      throw new Error("Invalid export request");
    } else if (dateKeys.has(key) && !validDate(entry)) {
      throw new Error("Invalid export request");
    } else if (uuidKeys.has(key) && !uuid.test(entry)) {
      throw new Error("Invalid export request");
    } else if (
      key === "category" &&
      !categorySlugs.includes(entry as (typeof categorySlugs)[number])
    ) {
      throw new Error("Invalid export request");
    } else if (enums[key] && !enums[key].includes(entry)) {
      throw new Error("Invalid export request");
    }
  }
  if (
    (dataset === "master_items" && !values.category) ||
    (["prices_stocks", "maintenance_blocks"].includes(dataset) &&
      (!values.startDate || !values.endDate)) ||
    (dataset === "prices_stocks" && !values.roomTypeId) ||
    (typeof values.from === "string" && typeof values.to === "string" && values.from > values.to) ||
    (typeof values.startDate === "string" &&
      typeof values.endDate === "string" &&
      values.startDate > values.endDate) ||
    (typeof values.stayDateFrom === "string" &&
      typeof values.stayDateTo === "string" &&
      values.stayDateFrom > values.stayDateTo) ||
    (dataset === "revenue_report" &&
      values.dateBy !== undefined &&
      !["payment", "booking", "check_in"].includes(values.dateBy as string)) ||
    (dataset === "reservations_report" &&
      values.dateBy !== undefined &&
      !["booking", "check_in", "check_out"].includes(values.dateBy as string)) ||
    (dataset === "cancellation_policies" &&
      values.source !== undefined &&
      !["website", "phone"].includes(values.source as string))
  ) {
    throw new Error("Invalid export request");
  }
  if (typeof values.startDate === "string" && typeof values.endDate === "string") {
    const days =
      (Date.parse(`${values.endDate}T00:00:00Z`) - Date.parse(`${values.startDate}T00:00:00Z`)) /
      86400000;
    if (dataset === "maintenance_blocks" ? days < 1 || days > 366 : days < 0 || days > 365) {
      throw new Error("Invalid export request");
    }
  }
  return {
    dataset,
    filters: {
      ...(dataset === "revenue_report" ? { dateBy: "payment" } : {}),
      ...(values as ExportRequest["filters"]),
    },
  };
}

export class ExportError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function itemsFromResponse(
  dataset: ExportDataset,
  body: Record<string, unknown>,
): Record<string, unknown>[] {
  if (Array.isArray(body.items)) return body.items as Record<string, unknown>[];
  if (dataset === "reservation_settings") return [body];
  throw new ExportError(502, "EXPORT_RESPONSE_INVALID");
}

async function readPage(
  app: FastifyInstance,
  authorization: string,
  request: ExportRequest,
  page: number,
): Promise<{ items: Record<string, unknown>[]; total: number | null }> {
  const path =
    request.dataset === "master_items"
      ? `/master/${request.filters.category}`
      : paths[request.dataset];
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.filters)) {
    if (key !== "category" && !(request.dataset === "users" || request.dataset === "roles")) {
      query.set(key, String(value));
    }
  }
  if (!unpaged.has(request.dataset)) {
    query.set("page", String(page));
    query.set("limit", request.dataset === "prices_stocks" ? "30" : "100");
  }
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/admin${path}${query.size ? `?${query}` : ""}`,
    headers: { authorization },
  });
  if (response.statusCode === 401 || response.statusCode === 403)
    throw new ExportError(403, "FORBIDDEN");
  if (response.statusCode === 400 || response.statusCode === 404)
    throw new ExportError(400, "INVALID_EXPORT_FILTERS");
  if (response.statusCode !== 200) throw new ExportError(502, "EXPORT_READ_FAILED");
  const body = response.json() as Record<string, unknown>;
  let items = itemsFromResponse(request.dataset, body);
  if ((request.dataset === "users" || request.dataset === "roles") && request.filters.search) {
    const search = String(request.filters.search).toLowerCase();
    items = items.filter((item) =>
      Object.values(item).some(
        (value) => typeof value === "string" && value.toLowerCase().includes(search),
      ),
    );
  }
  const total = typeof body.total === "number" ? body.total : null;
  return { items, total };
}

function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  const safe = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "\uFEFF";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvCell(row[column])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export async function exportCsv(
  app: FastifyInstance,
  authorization: string,
  request: ExportRequest,
): Promise<{ csv: string; count: number }> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 101; page += 1) {
    const result = await readPage(app, authorization, request, page);
    if (result.total !== null && result.total > maxRows)
      throw new ExportError(413, "EXPORT_TOO_LARGE");
    rows.push(...result.items);
    if (rows.length > maxRows) throw new ExportError(413, "EXPORT_TOO_LARGE");
    if (
      unpaged.has(request.dataset) ||
      result.items.length < (request.dataset === "prices_stocks" ? 30 : 100)
    )
      break;
    if (page === 101) throw new ExportError(413, "EXPORT_TOO_LARGE");
  }
  const csv = rowsToCsv(rows);
  if (Buffer.byteLength(csv, "utf8") > maxCsvBytes) throw new ExportError(413, "EXPORT_TOO_LARGE");
  return { csv, count: rows.length };
}
