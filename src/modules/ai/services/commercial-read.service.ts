import type { FastifyInstance } from "fastify";

export type CommercialView =
  | "cancellation_policies"
  | "cancellation_policy_detail"
  | "campaigns"
  | "campaign_detail"
  | "experiences"
  | "experience_detail";

export type CommercialReadArgs = {
  view: CommercialView;
  id?: string;
  search?: string;
  source?: "website" | "phone";
  roomTypeId?: string;
  channel?: "website" | "front_desk";
  categoryId?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
};

const views: CommercialView[] = [
  "cancellation_policies",
  "cancellation_policy_detail",
  "campaigns",
  "campaign_detail",
  "experiences",
  "experience_detail",
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed: Record<CommercialView, readonly (keyof CommercialReadArgs)[]> = {
  cancellation_policies: ["search", "source", "isActive", "roomTypeId", "page", "limit"],
  cancellation_policy_detail: ["id"],
  campaigns: ["search", "roomTypeId", "channel", "isActive", "page", "limit"],
  campaign_detail: ["id"],
  experiences: ["search", "categoryId", "isActive", "page", "limit"],
  experience_detail: ["id"],
};

export function commercialViewPermission(view: CommercialView): string {
  if (view.startsWith("cancellation_")) return "cancellation_policies.view";
  if (view.startsWith("campaign")) return "campaigns.view";
  return "experiences.view";
}

export function parseCommercialReadArgs(value: unknown): CommercialReadArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid commercial read arguments");
  }
  const input = value as Record<string, unknown>;
  const view = input.view as CommercialView;
  if (
    !views.includes(view) ||
    Object.keys(input).some(
      (key) => key !== "view" && !allowed[view].includes(key as keyof CommercialReadArgs),
    ) ||
    (input.id !== undefined && (typeof input.id !== "string" || !uuid.test(input.id))) ||
    (view.endsWith("_detail") && !input.id) ||
    (input.search !== undefined &&
      (typeof input.search !== "string" || input.search.length > 160)) ||
    (input.roomTypeId !== undefined &&
      (typeof input.roomTypeId !== "string" || !uuid.test(input.roomTypeId))) ||
    (input.categoryId !== undefined &&
      (typeof input.categoryId !== "string" || !uuid.test(input.categoryId))) ||
    (input.source !== undefined && !["website", "phone"].includes(input.source as string)) ||
    (input.channel !== undefined && !["website", "front_desk"].includes(input.channel as string)) ||
    (input.isActive !== undefined && typeof input.isActive !== "boolean") ||
    (input.page !== undefined &&
      (!Number.isInteger(input.page) ||
        (input.page as number) < 1 ||
        (input.page as number) > 100000)) ||
    (input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > 100))
  ) {
    throw new Error("Invalid commercial read arguments");
  }
  return input as CommercialReadArgs;
}

export class CommercialReadError extends Error {
  constructor(readonly statusCode: number) {
    super("Commercial read failed");
  }
}

export async function readCommercialView(
  app: FastifyInstance,
  authorization: string,
  args: CommercialReadArgs,
): Promise<unknown> {
  const paths: Record<CommercialView, string> = {
    cancellation_policies: "/cancellation-policies",
    cancellation_policy_detail: `/cancellation-policies/${args.id}`,
    campaigns: "/campaigns",
    campaign_detail: `/campaigns/${args.id}`,
    experiences: "/experiences",
    experience_detail: `/experiences/${args.id}`,
  };
  const query = new URLSearchParams();
  for (const key of allowed[args.view]) {
    if (key === "id") continue;
    const value = args[key];
    if (value !== undefined) query.set(key, String(value));
  }
  if (!args.view.endsWith("_detail") && !query.has("limit")) query.set("limit", "20");
  const url = `/api/v1/admin${paths[args.view]}${query.size ? `?${query}` : ""}`;
  const response = await app.inject({ method: "GET", url, headers: { authorization } });
  if (response.statusCode === 401 || response.statusCode === 403) {
    throw new CommercialReadError(response.statusCode);
  }
  if (response.statusCode === 404) return { found: false, view: args.view, id: args.id };
  if (response.statusCode === 400) throw new Error("Invalid commercial read arguments");
  if (response.statusCode !== 200) throw new CommercialReadError(response.statusCode);
  return response.json();
}
