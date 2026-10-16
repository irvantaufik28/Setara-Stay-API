import type { FastifyInstance } from "fastify";

export type AdminUserReadArgs = {
  view:
    | "my_profile"
    | "users"
    | "user_detail"
    | "active_roles"
    | "roles"
    | "role_detail"
    | "permissions";
  id?: string;
  search?: string;
  page?: number;
  limit?: number;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const views: AdminUserReadArgs["view"][] = [
  "my_profile",
  "users",
  "user_detail",
  "active_roles",
  "roles",
  "role_detail",
  "permissions",
];

export function parseAdminUserReadArgs(value: unknown): AdminUserReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid admin user read arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as AdminUserReadArgs["view"];
  const list = ["users", "active_roles", "roles", "permissions"].includes(view);
  const detail = view === "user_detail" || view === "role_detail";
  if (
    !views.includes(view) ||
    Object.keys(input).some(
      (key) =>
        key !== "view" &&
        !(detail ? ["id"] : list ? ["search", "page", "limit"] : []).includes(key),
    ) ||
    (detail && !input.id) ||
    (input.id !== undefined && (typeof input.id !== "string" || !uuid.test(input.id))) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.length > 160)) ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 100))
  ) {
    throw new Error("Invalid admin user read arguments");
  }
  return input as AdminUserReadArgs;
}

export class AdminUserReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Admin user read failed");
  }
}

export async function readAdminUserView(
  app: FastifyInstance,
  authorization: string,
  args: AdminUserReadArgs,
): Promise<unknown> {
  const paths: Record<AdminUserReadArgs["view"], string> = {
    my_profile: "/profile",
    users: "/users",
    user_detail: `/users/${args.id}`,
    active_roles: "/users/roles",
    roles: "/roles",
    role_detail: `/roles/${args.id}`,
    permissions: "/roles/permissions",
  };
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/admin${paths[args.view]}`,
    headers: { authorization },
  });
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new AdminUserReadError(response.statusCode);
  }
  if (response.statusCode === 404) return { found: false, view: args.view, id: args.id };
  if (response.statusCode !== 200) throw new AdminUserReadError(response.statusCode);
  const body = response.json() as Record<string, unknown>;
  if (!Array.isArray(body.items)) return body;
  const search = args.search?.trim().toLowerCase();
  const filtered = search
    ? body.items.filter((item) => {
        if (typeof item !== "object" || item === null) return false;
        return Object.values(item).some(
          (value) => typeof value === "string" && value.toLowerCase().includes(search),
        );
      })
    : body.items;
  const page = args.page ?? 1;
  const limit = args.limit ?? 20;
  return {
    items: filtered.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: filtered.length,
  };
}
