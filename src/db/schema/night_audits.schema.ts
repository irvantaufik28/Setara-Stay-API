import { date, jsonb, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { idColumn } from "./columns.js";
import { appSchema } from "./app-schema.js";
import { users } from "./users.schema.js";

export const nightAudits = appSchema.table(
  "night_audits",
  {
    id: idColumn(),
    businessDate: date("business_date").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    closedByUserId: uuid("closed_by_user_id")
      .notNull()
      .references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("night_audits_business_date_uq").on(table.businessDate)],
);
