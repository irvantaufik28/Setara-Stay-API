import type { FastifyPluginAsync } from "fastify";
import { getRolePermissions } from "../../auth/services/auth.service.js";
import {
  aiChatBodySchema,
  aiConversationParamsSchema,
  aiExportBodySchema,
  aiHistoryQuerySchema,
  aiMessagesQuerySchema,
  type AiChatBody,
  type AiExportBody,
} from "../schemas/ai-chat.schema.js";
import {
  AiConversationNotFoundError,
  getAiConversation,
  getAiConversationPage,
  listAiConversations,
  saveAiExchange,
} from "../services/ai-history.service.js";
import {
  AiPermissionError,
  AiUpstreamError,
  answerChatQuestion,
  resolveExportRequest,
} from "../services/ai-chat.service.js";
import { ExportError, exportCsv } from "../services/ai-export.service.js";
import { createOpenRouterRuntime } from "../services/openrouter.service.js";

export const aiChatRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { offset?: number; limit?: number } }>(
    "/conversations",
    { preHandler: app.authenticate, schema: { querystring: aiHistoryQuerySchema } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return listAiConversations(
        app.db,
        request.authUser!.id,
        request.query.offset ?? 0,
        request.query.limit ?? 50,
      );
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { before?: number; limit?: number };
  }>(
    "/conversations/:id",
    {
      preHandler: app.authenticate,
      schema: { params: aiConversationParamsSchema, querystring: aiMessagesQuerySchema },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const page = await getAiConversationPage(
        app.db,
        request.authUser!.id,
        request.params.id,
        request.query.before,
        request.query.limit ?? 50,
      );
      return (
        page ??
        reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Conversation not found" },
        })
      );
    },
  );

  app.post<{ Body: AiChatBody }>(
    "/chat",
    {
      preHandler: app.authenticate,
      schema: { body: aiChatBodySchema },
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const config = app.authConfig.openRouter;
      if (!config) {
        return reply.code(503).send({
          error: { code: "AI_NOT_CONFIGURED", message: "AI assistant is not configured" },
        });
      }

      if (
        request.body.conversationId &&
        !(await getAiConversation(app.db, request.authUser!.id, request.body.conversationId))
      ) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: "Conversation not found" },
        });
      }

      try {
        const runtime = createOpenRouterRuntime(config);
        const permissions = new Set(await getRolePermissions(app, request.authUser!.roleId));
        const answer = await answerChatQuestion(
          runtime,
          app,
          request.headers.authorization ?? "",
          request.body.message,
          permissions,
        );
        const stored = await saveAiExchange(
          app.db,
          request.authUser!.id,
          request.body.conversationId,
          request.body.message,
          answer,
        );
        return { ...answer, ...stored };
      } catch (error) {
        if (error instanceof AiConversationNotFoundError) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Conversation not found" },
          });
        }
        if (error instanceof AiPermissionError) {
          return reply.code(403).send({
            error: { code: "FORBIDDEN", message: "Permission denied" },
          });
        }
        if (error instanceof AiUpstreamError) {
          request.log.warn({ attempts: error.attempts }, "AI model attempts failed");
          return reply.code(503).send({
            error: { code: "AI_UNAVAILABLE", message: "AI assistant is temporarily unavailable" },
            ...(app.authConfig.nodeEnv === "production" ? {} : { diagnostics: error.attempts }),
          });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: AiExportBody }>(
    "/export",
    {
      preHandler: app.authenticate,
      schema: { body: aiExportBodySchema },
      config: { rateLimit: { max: 2, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const config = app.authConfig.openRouter;
      if (!config) {
        return reply.code(503).send({
          error: { code: "AI_NOT_CONFIGURED", message: "AI assistant is not configured" },
        });
      }
      try {
        const runtime = createOpenRouterRuntime(config);
        const { request: exportRequest } = await resolveExportRequest(
          runtime,
          request.body.message,
        );
        const { csv, count } = await exportCsv(
          app,
          request.headers.authorization ?? "",
          exportRequest,
        );
        const filename = `${exportRequest.dataset}-${new Date().toISOString().slice(0, 10)}.csv`;
        return reply
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .header("X-Export-Row-Count", String(count))
          .type("text/csv; charset=utf-8")
          .send(csv);
      } catch (error) {
        if (error instanceof ExportError) {
          return reply.code(error.statusCode).send({
            error: {
              code: error.code,
              message:
                error.statusCode === 413 ? "Export exceeds the supported size" : "Export failed",
            },
          });
        }
        if (error instanceof AiUpstreamError) {
          request.log.warn({ attempts: error.attempts }, "AI export model attempts failed");
          return reply.code(503).send({
            error: { code: "AI_UNAVAILABLE", message: "AI assistant is temporarily unavailable" },
            ...(app.authConfig.nodeEnv === "production" ? {} : { diagnostics: error.attempts }),
          });
        }
        throw error;
      }
    },
  );
};
