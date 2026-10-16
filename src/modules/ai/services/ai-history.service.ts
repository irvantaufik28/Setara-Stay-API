import { and, desc, eq, lt } from "drizzle-orm";
import { aiChatConversations } from "../../../db/schema/ai_chat_conversations.schema.js";
import { aiChatMessages } from "../../../db/schema/ai_chat_messages.schema.js";
import type { Database } from "../../../plugins/database.js";

export type AiHistoryMessage = {
  id: string;
  role: string;
  content: string;
  modelUsed: string | null;
  dataSource: string | null;
  createdAt: Date;
};

export class AiConversationNotFoundError extends Error {}

const messageSelection = {
  id: aiChatMessages.id,
  role: aiChatMessages.role,
  content: aiChatMessages.content,
  modelUsed: aiChatMessages.modelUsed,
  dataSource: aiChatMessages.dataSource,
  createdAt: aiChatMessages.createdAt,
};

export async function listAiConversations(
  db: Database,
  userId: string,
  offset: number,
  limit: number,
) {
  const rows = await db
    .select({
      id: aiChatConversations.id,
      title: aiChatConversations.title,
      createdAt: aiChatConversations.createdAt,
      updatedAt: aiChatConversations.updatedAt,
    })
    .from(aiChatConversations)
    .where(eq(aiChatConversations.userId, userId))
    .orderBy(desc(aiChatConversations.updatedAt), desc(aiChatConversations.id))
    .limit(limit + 1)
    .offset(offset);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function getAiConversation(db: Database, userId: string, id: string) {
  const [conversation] = await db
    .select({
      id: aiChatConversations.id,
      title: aiChatConversations.title,
      createdAt: aiChatConversations.createdAt,
      updatedAt: aiChatConversations.updatedAt,
    })
    .from(aiChatConversations)
    .where(and(eq(aiChatConversations.id, id), eq(aiChatConversations.userId, userId)))
    .limit(1);
  return conversation ?? null;
}

export async function getAiConversationPage(
  db: Database,
  userId: string,
  id: string,
  before: number | undefined,
  limit: number,
) {
  const conversation = await getAiConversation(db, userId, id);
  if (!conversation) return null;
  const rows = await db
    .select({ ...messageSelection, sequence: aiChatMessages.sequence })
    .from(aiChatMessages)
    .where(
      before === undefined
        ? eq(aiChatMessages.conversationId, id)
        : and(eq(aiChatMessages.conversationId, id), lt(aiChatMessages.sequence, before)),
    )
    .orderBy(desc(aiChatMessages.sequence))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const nextBefore = pageRows.at(-1)?.sequence ?? null;
  return {
    conversation,
    messages: pageRows.reverse().map(({ sequence: _sequence, ...message }) => message),
    hasMore: rows.length > limit,
    nextBefore,
  };
}

export async function saveAiExchange(
  db: Database,
  userId: string,
  conversationId: string | undefined,
  question: string,
  answer: {
    answer: string;
    modelUsed: string;
    dataSource: string;
  },
): Promise<{
  conversationId: string;
  userMessage: AiHistoryMessage;
  assistantMessage: AiHistoryMessage;
}> {
  return db.transaction(async (tx) => {
    let id = conversationId;
    if (id) {
      const [updated] = await tx
        .update(aiChatConversations)
        .set({ updatedAt: new Date() })
        .where(and(eq(aiChatConversations.id, id), eq(aiChatConversations.userId, userId)))
        .returning({ id: aiChatConversations.id });
      if (!updated) throw new AiConversationNotFoundError();
    } else {
      const [created] = await tx
        .insert(aiChatConversations)
        .values({
          userId,
          title: question.replace(/\s+/g, " ").trim().slice(0, 160),
        })
        .returning({ id: aiChatConversations.id });
      id = created.id;
    }

    const savedMessages = await tx
      .insert(aiChatMessages)
      .values([
        { conversationId: id, role: "user", content: question },
        {
          conversationId: id,
          role: "assistant",
          content: answer.answer,
          modelUsed: answer.modelUsed,
          dataSource: answer.dataSource,
        },
      ])
      .returning(messageSelection);
    const userMessage = savedMessages.find((message) => message.role === "user");
    const assistantMessage = savedMessages.find((message) => message.role === "assistant");
    if (!userMessage || !assistantMessage) throw new Error("AI_MESSAGES_NOT_SAVED");
    return { conversationId: id, userMessage, assistantMessage };
  });
}
