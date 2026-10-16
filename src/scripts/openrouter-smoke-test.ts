import { loadConfig } from "../config/env.js";
import { createOpenRouterRuntime } from "../modules/ai/services/openrouter.service.js";

function readStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return null;
}

function serializeError(error: unknown) {
  if (!(error instanceof Error)) {
    return {
      raw: error,
    };
  }

  const errorObject = error as Error & {
    statusCode?: number;
    status?: number;
    code?: string;
    cause?: unknown;
    response?: unknown;
    body?: unknown;
    data?: unknown;
  };

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,

    statusCode: errorObject.statusCode,
    status: errorObject.status,
    code: errorObject.code,

    cause: errorObject.cause,
    response: errorObject.response,
    body: errorObject.body,
    data: errorObject.data,

    // penting untuk melihat property enumerable dari SDK error
    raw: Object.fromEntries(
      Object.entries(errorObject).map(([key, value]) => [
        key,
        value instanceof Error
          ? {
              name: value.name,
              message: value.message,
              stack: value.stack,
            }
          : value,
      ]),
    ),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.openRouter) {
    throw new Error(
      "OPENROUTER_API_KEY dan OPENROUTER_MODELS belum dikonfigurasi",
    );
  }

  const runtime = createOpenRouterRuntime(config.openRouter);
  const startedAt = Date.now();

  try {
    const result = await runtime.client.chat.send({
      chatRequest: {
        models: [...runtime.models],
        messages: [
          {
            role: "user",
            content: "Reply with exactly OK and nothing else.",
          },
        ],
        temperature: 0,
        maxCompletionTokens: 16,
        stream: false,
      },
    });

    if (!("choices" in result)) {
      throw new Error("Unexpected streaming response");
    }

    const choice = result.choices[0];
    const content = choice?.message.content;
    const response = typeof content === "string" ? content.trim() : "";

    if (!choice || !response) {
      throw new Error("OpenRouter returned no text completion");
    }

    console.info(
      JSON.stringify(
        {
          ok: true,
          modelUsed: result.model,
          finishReason: choice.finishReason,
          response,
          durationMs: Date.now() - startedAt,
          promptTokens: result.usage?.promptTokens,
          completionTokens: result.usage?.completionTokens,
        },
        null,
        2,
      ),
    );
  } catch (error: unknown) {
    const statusCode = readStatusCode(error);

    console.error(
      JSON.stringify(
        {
          ok: false,
          statusCode,
          durationMs: Date.now() - startedAt,
          error: serializeError(error),
        },
        null,
        2,
      ),
    );

    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        fatal: true,
        error: serializeError(error),
      },
      null,
      2,
    ),
  );

  process.exitCode = 1;
});