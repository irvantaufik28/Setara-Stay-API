import { index, uuid, varchar } from "drizzle-orm/pg-core";
import { auditTimestamps, idColumn } from "./columns.js";
import { users } from "./users.schema.js";
import { appSchema } from "./app-schema.js";

export const aiChatConversations = appSchema.table(
  "ai_chat_conversations",
  {
    id: idColumn(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 160 }).notNull(),
    ...auditTimestamps(),
  },
  (table) => [index("ai_chat_conversations_user_updated_idx").on(table.userId, table.updatedAt)],
);
