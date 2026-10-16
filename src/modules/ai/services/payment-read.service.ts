import type { FastifyInstance } from "fastify";

export type PaymentReadArgs = {
  view: "list" | "transactions" | "refunds" | "outstanding";
  search?: string;
  source?: "website" | "walk_in" | "phone" | "ota";
  reservationStatus?: string;
  paymentStatus?: string;
  status?: string;
  methodId?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed: Record<PaymentReadArgs["view"], readonly (keyof PaymentReadArgs)[]> = {
  list: [
    "search",
    "source",
    "reservationStatus",
    "paymentStatus",
    "methodId",
    "from",
    "to",
    "page",
    "limit",
  ],
  transactions: ["search", "source", "status", "methodId", "from", "to", "page", "limit"],
  refunds: ["search", "source", "page", "limit"],
  outstanding: ["search", "source", "page", "limit"],
};

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parsePaymentReadArgs(value: unknown): PaymentReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid payment read arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as PaymentReadArgs["view"];
  if (
    !["list", "transactions", "refunds", "outstanding"].includes(view) ||
    Object.keys(input).some(
      (key) => key !== "view" && !allowed[view].includes(key as keyof PaymentReadArgs),
    ) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.length > 255)) ||
    (input.source !== undefined &&
      !["website", "walk_in", "phone", "ota"].includes(input.source as string)) ||
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
      !["unpaid", "partial", "paid", "failed", "refunded", "expired"].includes(
        input.paymentStatus as string,
      )) ||
    (input.status !== undefined &&
      !["pending", "succeeded", "failed", "expired", "refunded", "partially_refunded"].includes(
        input.status as string,
      )) ||
    (input.methodId !== undefined &&
      (typeof input.methodId !== "string" || !uuid.test(input.methodId))) ||
    (input.from !== undefined && !validDate(input.from)) ||
    (input.to !== undefined && !validDate(input.to)) ||
    (typeof input.from === "string" && typeof input.to === "string" && input.from > input.to) ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 100))
  ) {
    throw new Error("Invalid payment read arguments");
  }
  return input as PaymentReadArgs;
}

export class PaymentReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Payment read failed");
  }
}

export async function readPaymentView(
  app: FastifyInstance,
  authorization: string,
  args: PaymentReadArgs,
): Promise<unknown> {
  const path = {
    list: "/payments",
    transactions: "/payments/transactions",
    refunds: "/payments/refunds",
    outstanding: "/payments/outstanding",
  }[args.view];
  const query = new URLSearchParams();
  for (const key of allowed[args.view]) {
    const value = args[key];
    if (value !== undefined) query.set(key, String(value));
  }
  if (!query.has("limit")) query.set("limit", "20");
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/admin${path}?${query}`,
    headers: { authorization },
  });
  if (response.statusCode === 401 || response.statusCode === 403)
    throw new PaymentReadError(response.statusCode);
  if (response.statusCode === 400) throw new Error("Invalid payment read arguments");
  if (response.statusCode !== 200) throw new PaymentReadError(response.statusCode);
  return response.json();
}
