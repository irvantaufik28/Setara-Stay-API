import type { FastifyInstance } from "fastify";

export type GuestReadArgs = {
  view: "list" | "detail" | "stay_history";
  id?: string;
  search?: string;
  status?: "active" | "blacklisted";
  page?: number;
  limit?: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed: Record<GuestReadArgs["view"], readonly (keyof GuestReadArgs)[]> = {
  list: ["search", "status", "page", "limit"],
  detail: ["id"],
  stay_history: ["id", "page", "limit"],
};

export function guestViewPermissions(view: GuestReadArgs["view"]): string[] {
  if (view === "detail") return ["guests.view", "guests.view_stay_history"];
  return [view === "list" ? "guests.view" : "guests.view_stay_history"];
}

export function parseGuestReadArgs(value: unknown): GuestReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid guest read arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as GuestReadArgs["view"];
  if (
    !["list", "detail", "stay_history"].includes(view) ||
    Object.keys(input).some(
      (key) => key !== "view" && !allowed[view].includes(key as keyof GuestReadArgs),
    ) ||
    (view !== "list" && !input.id) ||
    (input.id !== undefined && (typeof input.id !== "string" || !uuid.test(input.id))) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.length > 255)) ||
    (input.status !== undefined && !["active", "blacklisted"].includes(input.status as string)) ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 100))
  ) {
    throw new Error("Invalid guest read arguments");
  }
  return input as GuestReadArgs;
}

export class GuestReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Guest read failed");
  }
}

export async function readGuestView(
  app: FastifyInstance,
  authorization: string,
  args: GuestReadArgs,
): Promise<unknown> {
  const path = {
    list: "/guests",
    detail: `/guests/${args.id}`,
    stay_history: `/guests/${args.id}/reservations`,
  }[args.view];
  const query = new URLSearchParams();
  for (const key of allowed[args.view]) {
    if (key === "id") continue;
    const value = args[key];
    if (value !== undefined) query.set(key, String(value));
  }
  if (args.view !== "detail" && !query.has("limit")) query.set("limit", "20");
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/admin${path}${query.size ? `?${query}` : ""}`,
    headers: { authorization },
  });
  if (response.statusCode === 401 || response.statusCode === 403)
    throw new GuestReadError(response.statusCode);
  if (response.statusCode === 404) return { found: false, view: args.view, id: args.id };
  if (response.statusCode === 400) throw new Error("Invalid guest read arguments");
  if (response.statusCode !== 200) throw new GuestReadError(response.statusCode);
  return response.json();
}
