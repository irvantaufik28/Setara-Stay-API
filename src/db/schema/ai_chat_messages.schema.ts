import { check, index, text, uuid, varchar, bigserial, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idColumn } from "./columns.js";
import { aiChatConversations } from "./ai_chat_conversations.schema.js";
import { appSchema } from "./app-schema.js";

export const aiChatMessages = appSchema.table(
  "ai_chat_messages",
  {
    id: idColumn(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiChatConversations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 12 }).notNull(),
    content: text("content").notNull(),
    modelUsed: varchar("model_used", { length: 160 }),
    dataSource: varchar("data_source", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_chat_messages_conversation_sequence_idx").on(table.conversationId, table.sequence),
    check("ai_chat_messages_role_check", sql`${table.role} in ('user', 'assistant')`),
  ],
);
