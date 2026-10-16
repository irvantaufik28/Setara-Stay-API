import type { FastifyPluginAsync } from "fastify";
import { getDashboard } from "../services/dashboard.service.js";

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requirePermission("dashboard.view") }, () => getDashboard(app));
};
