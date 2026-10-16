export type AiChatBody = { message: string; conversationId?: string };
export type AiExportBody = { message: string; conversationId?: string };

export const aiChatBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
    conversationId: { type: "string", format: "uuid" },
  },
} as const;

export const aiExportBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
    conversationId: { type: "string", format: "uuid" },
  },
} as const;

export const aiConversationParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export const aiHistoryQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
  },
} as const;

export const aiMessagesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    before: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
  },
} as const;
