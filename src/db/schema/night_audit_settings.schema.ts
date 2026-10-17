import { sql } from "drizzle-orm";
import { check, date, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import { appSchema } from "./app-schema.js";
import { users } from "./users.schema.js";

export const nightAuditSettings = appSchema.table(
  "night_audit_settings",
  {
    id: integer("id").primaryKey().default(1),
    startDate: date("start_date").notNull(),
    initializedByUserId: uuid("initialized_by_user_id")
      .notNull()
      .references(() => users.id),
    initializedAt: timestamp("initialized_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("night_audit_settings_singleton_check", sql`id = 1`)],
);
