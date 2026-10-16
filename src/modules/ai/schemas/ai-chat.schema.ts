export type AiChatBody = { message: string };

export const aiChatBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 1000, pattern: "\\S" },
  },
} as const;
