import { index, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { appSchema } from "./app-schema.js";
import { idColumn } from "./columns.js";
import { roomUnits } from "./room_units.schema.js";
import { users } from "./users.schema.js";

export const roomStatusEvents = appSchema.table(
  "room_status_events",
  {
    id: idColumn(),
    roomUnitId: uuid("room_unit_id")
      .notNull()
      .references(() => roomUnits.id),
    statusBefore: varchar("status_before", { length: 30 }).notNull(),
    statusAfter: varchar("status_after", { length: 30 }).notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    source: varchar("source", { length: 30 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("room_status_events_unit_time_idx").on(table.roomUnitId, table.occurredAt)],
);
