import { and, desc, eq } from "drizzle-orm";
import { aiChatConversations } from "../../../db/schema/ai_chat_conversations.schema.js";
import { aiChatMessages } from "../../../db/schema/ai_chat_messages.schema.js";
import type { Database } from "../../../plugins/database.js";

const bookingCodePattern = /\bGH-[A-Z0-9-]+\b/i;

export function needsConversationContext(message: string): boolean {
  const question = message.trim();
  if (question.length > 140 || bookingCodePattern.test(question)) return false;
  if (/(?:\bapa itu\b|\bitu apa\b|\bmaksud(?:nya)? apa\b)/i.test(question)) return false;
  return /(?:\b(?:tadi|tersebut|sebelumnya|yang sama|siapa aja|siapa saja|rincikan|rinciannya)\b|\b(?:booking|reservasi|laporan|pembayaran|tamu)\s+(?:id|itu|nya)\b|\b(?:detail|nomor|kode)\s+(?:booking|reservasi)\b)/i.test(
    question,
  );
}

export function withConversationContext(message: string, previousQuestions: readonly string[]) {
  if (!needsConversationContext(message) || previousQuestions.length === 0) return message;
  const context = previousQuestions
    .slice(-2)
    .map((question) => question.replace(/\s+/g, " ").trim().slice(0, 180))
    .filter(Boolean);
  if (!context.length) return message;
  return [
    "Pertanyaan sebelumnya (hanya untuk memahami rujukan, bukan sumber fakta terkini):",
    ...context.map((question) => `- ${question}`),
    `Pertanyaan saat ini: ${message}`,
  ].join("\n");
}

export async function getRecentAiUserQuestions(
  db: Database,
  userId: string,
  conversationId: string,
): Promise<string[]> {
  const rows = await db
    .select({ content: aiChatMessages.content })
    .from(aiChatMessages)
    .innerJoin(aiChatConversations, eq(aiChatMessages.conversationId, aiChatConversations.id))
    .where(
      and(
        eq(aiChatConversations.id, conversationId),
        eq(aiChatConversations.userId, userId),
        eq(aiChatMessages.role, "user"),
      ),
    )
    .orderBy(desc(aiChatMessages.sequence))
    .limit(2);
  return rows.reverse().map((row) => row.content);
}
