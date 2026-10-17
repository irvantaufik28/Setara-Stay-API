import type { FastifyPluginAsync } from "fastify";
import { authRoutes } from "../../modules/auth/index.js";
import { aiChatRoutes } from "../../modules/ai/index.js";
import { profileRoutes } from "../../modules/profile/index.js";
import { dashboardRoutes } from "../../modules/dashboard/index.js";
import { nightAuditRoutes } from "../../modules/night-audit/index.js";
import { masterRoutes } from "../../modules/master/index.js";
import {
  roomTypeRoutes,
  roomNumberRoutes,
  roomMaintenanceRoutes,
} from "../../modules/rooms/index.js";
import { pricesStocksRoutes } from "../../modules/prices-stocks/index.js";
import { cancellationPolicyRoutes } from "../../modules/cancellation-policies/index.js";
import { campaignRoutes } from "../../modules/campaigns/index.js";
import { experienceRoutes } from "../../modules/experiences/index.js";
import { guestRoutes } from "../../modules/guests/index.js";
import { hotelInfoAdminRoutes } from "../../modules/hotel-info/index.js";
import { featuredRoomsAdminRoutes } from "../../modules/featured-rooms/index.js";
import { galleryAdminRoutes } from "../../modules/gallery/index.js";
import { reservationSettingsRoutes } from "../../modules/settings/index.js";
import {
  reservationsReportRoutes,
  revenueReportRoutes,
  roomPerformanceReportRoutes,
} from "../../modules/reports/index.js";
import { uploadRoutes } from "../../modules/uploads/index.js";
import { roleRoutes, userRoutes } from "../../modules/users/index.js";
import {
  paymentListRoutes,
  paymentTransactionRoutes,
  paymentRefundListRoutes,
  paymentOutstandingRoutes,
} from "../../modules/payments/index.js";
import {
  reservationListRoutes,
  reservationRoomRackRoutes,
  reservationAssignRoomRoutes,
  reservationArrivalsTodayRoutes,
  reservationDeparturesTodayRoutes,
  reservationInHouseRoutes,
  reservationCreateRoutes,
  reservationDetailRoutes,
  reservationHistoryRoutes,
  reservationPaymentRoutes,
  reservationConfirmRoutes,
  reservationCheckInRoutes,
  reservationCheckOutRoutes,
  reservationExtendStayRoutes,
  reservationRoomOperationRoutes,
  reservationExperienceBillRoutes,
  reservationCancelRoutes,
  reservationNoShowRoutes,
  reservationCancellationSettlementRoutes,
  reservationRefundRoutes,
  reservationRefundProcessingRoutes,
} from "../../modules/reservations/index.js";

export const adminRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(aiChatRoutes, { prefix: "/ai" });
  await app.register(profileRoutes, { prefix: "/profile" });
  await app.register(dashboardRoutes, { prefix: "/dashboard" });
  await app.register(nightAuditRoutes, { prefix: "/night-audit" });
  await app.register(masterRoutes, { prefix: "/master" });
  await app.register(roomTypeRoutes, { prefix: "/room-types" });
  await app.register(roomNumberRoutes, { prefix: "/room-numbers" });
  await app.register(roomMaintenanceRoutes, { prefix: "/room-maintenance-blocks" });
  await app.register(pricesStocksRoutes, { prefix: "/prices-stocks" });
  await app.register(cancellationPolicyRoutes, { prefix: "/cancellation-policies" });
  await app.register(campaignRoutes, { prefix: "/campaigns" });
  await app.register(experienceRoutes, { prefix: "/experiences" });
  await app.register(guestRoutes, { prefix: "/guests" });
  await app.register(hotelInfoAdminRoutes, { prefix: "/hotel-info" });
  await app.register(featuredRoomsAdminRoutes, { prefix: "/featured-rooms" });
  await app.register(galleryAdminRoutes, { prefix: "/gallery" });
  await app.register(reservationSettingsRoutes, { prefix: "/settings" });
  await app.register(reservationsReportRoutes, { prefix: "/reports" });
  await app.register(revenueReportRoutes, { prefix: "/reports" });
  await app.register(roomPerformanceReportRoutes, { prefix: "/reports" });
  await app.register(uploadRoutes, { prefix: "/uploads" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(roleRoutes, { prefix: "/roles" });
  await app.register(paymentListRoutes, { prefix: "/payments" });
  await app.register(paymentTransactionRoutes, { prefix: "/payments" });
  await app.register(paymentRefundListRoutes, { prefix: "/payments" });
  await app.register(paymentOutstandingRoutes, { prefix: "/payments" });
  await app.register(reservationListRoutes, { prefix: "/reservations" });
  await app.register(reservationRoomRackRoutes, { prefix: "/reservations" });
  await app.register(reservationAssignRoomRoutes, { prefix: "/reservations" });
  await app.register(reservationArrivalsTodayRoutes, { prefix: "/reservations" });
  await app.register(reservationDeparturesTodayRoutes, { prefix: "/reservations" });
  await app.register(reservationInHouseRoutes, { prefix: "/reservations" });
  await app.register(reservationCreateRoutes, { prefix: "/reservations" });
  await app.register(reservationDetailRoutes, { prefix: "/reservations" });
  await app.register(reservationHistoryRoutes, { prefix: "/reservations" });
  await app.register(reservationPaymentRoutes, { prefix: "/reservations" });
  await app.register(reservationConfirmRoutes, { prefix: "/reservations" });
  await app.register(reservationCheckInRoutes, { prefix: "/reservations" });
  await app.register(reservationCheckOutRoutes, { prefix: "/reservations" });
  await app.register(reservationExtendStayRoutes, { prefix: "/reservations" });
  await app.register(reservationRoomOperationRoutes, { prefix: "/reservations" });
  await app.register(reservationExperienceBillRoutes, { prefix: "/reservations" });
  await app.register(reservationCancelRoutes, { prefix: "/reservations" });
  await app.register(reservationNoShowRoutes, { prefix: "/reservations" });
  await app.register(reservationCancellationSettlementRoutes, { prefix: "/reservations" });
  await app.register(reservationRefundRoutes, { prefix: "/reservations" });
  await app.register(reservationRefundProcessingRoutes, { prefix: "/reservations" });
};
