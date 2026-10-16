import type { FastifyPluginAsync } from "fastify";
import { getRolePermissions } from "../../auth/services/auth.service.js";
import { aiChatBodySchema, type AiChatBody } from "../schemas/ai-chat.schema.js";
import {
  AiPermissionError,
  AiUpstreamError,
  answerChatQuestion,
  resolveExportRequest,
} from "../services/ai-chat.service.js";
import { ExportError, exportCsv } from "../services/ai-export.service.js";
import { createOpenRouterRuntime } from "../services/openrouter.service.js";

export const aiChatRoutes: FastifyPluginAsync = async (app) => {
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

      try {
        const runtime = createOpenRouterRuntime(config);
        const permissions = new Set(await getRolePermissions(app, request.authUser!.roleId));
        return await answerChatQuestion(
          runtime,
          app,
          request.headers.authorization ?? "",
          request.body.message,
          permissions,
        );
      } catch (error) {
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

  app.post<{ Body: AiChatBody }>(
    "/export",
    {
      preHandler: app.authenticate,
      schema: { body: aiChatBodySchema },
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
