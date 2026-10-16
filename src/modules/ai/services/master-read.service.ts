import type { FastifyInstance } from "fastify";
import { categorySlugs, type MasterCategorySlug } from "../../master/master.shared.js";

export type MasterReadArgs =
  | { view: "items"; category: MasterCategorySlug }
  | { view: "capacity_patterns" }
  | { view: "reservation_settings" };

export function parseMasterReadArgs(value: unknown): MasterReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid master read arguments");
  }
  const input = value as Record<string, unknown>;
  if (
    input.view === "items" &&
    Object.keys(input).every((key) => key === "view" || key === "category") &&
    categorySlugs.includes(input.category as MasterCategorySlug)
  ) {
    return { view: "items", category: input.category as MasterCategorySlug };
  }
  if (
    (input.view === "capacity_patterns" || input.view === "reservation_settings") &&
    Object.keys(input).length === 1
  ) {
    return { view: input.view };
  }
  throw new Error("Invalid master read arguments");
}

export class MasterReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Master read failed");
  }
}

export async function readMasterData(
  app: FastifyInstance,
  authorization: string,
  args: MasterReadArgs,
): Promise<unknown> {
  const path = {
    items: `/master/${"category" in args ? args.category : ""}`,
    capacity_patterns: "/master/capacity-patterns",
    reservation_settings: "/settings/reservations",
  }[args.view];
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/admin${path}`,
    headers: { authorization },
  });
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new MasterReadError(response.statusCode);
  }
  if (response.statusCode !== 200) throw new MasterReadError(response.statusCode);
  return response.json();
}
