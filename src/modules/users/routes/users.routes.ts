import type { FastifyPluginAsync } from "fastify";
import { databaseErrorCode } from "../../master/master.shared.js";
import { requireOwner } from "../owner-only.js";
import {
  createUser,
  getUser,
  listActiveRoles,
  listUsers,
  setUserStatus,
} from "../services/users.service.js";
import {
  createUserSchema,
  userIdParamsSchema,
  userStatusSchema,
  type CreateUserBody,
  type UserStatusBody,
} from "../schemas/users.schema.js";

type IdParams = { id: string };

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: [app.requirePermission("master.view"), requireOwner] }, async () => ({
    items: await listUsers(app),
  }));

  app.get(
    "/roles",
    { preHandler: [app.requirePermission("master.view"), requireOwner] },
    async () => ({ items: await listActiveRoles(app) }),
  );

  app.get<{ Params: IdParams }>(
    "/:id",
    {
      preHandler: [app.requirePermission("master.view"), requireOwner],
      schema: { params: userIdParamsSchema },
    },
    async (request, reply) => {
      const user = await getUser(app, request.params.id);
      return user ? { user } : reply.code(404).send(errorBody("NOT_FOUND", "User not found"));
    },
  );

  app.post<{ Body: CreateUserBody }>(
    "/",
    {
      preHandler: [app.requirePermission("master.create"), requireOwner],
      schema: { body: createUserSchema },
    },
    async (request, reply) => {
      const role = (await listActiveRoles(app)).find((item) => item.id === request.body.roleId);
      if (!role) {
        return reply.code(400).send(errorBody("INVALID_ROLE", "Role is not active"));
      }
      try {
        return reply.code(201).send({ user: await createUser(app, request.body) });
      } catch (error) {
        if (databaseErrorCode(error) === "23505") {
          return reply
            .code(409)
            .send(errorBody("DUPLICATE_USER", "Email or username already exists"));
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: IdParams; Body: UserStatusBody }>(
    "/:id/status",
    {
      preHandler: [app.requirePermission("master.edit"), requireOwner],
      schema: { params: userIdParamsSchema, body: userStatusSchema },
    },
    async (request, reply) => {
      if (!request.body.isActive && request.params.id === request.authUser!.id) {
        return reply
          .code(409)
          .send(errorBody("CANNOT_DISABLE_SELF", "Cannot disable your own account"));
      }
      const existing = await getUser(app, request.params.id);
      if (!existing) return reply.code(404).send(errorBody("NOT_FOUND", "User not found"));
      const user = await setUserStatus(app, existing.id, request.body.isActive);
      return { user };
    },
  );
};
