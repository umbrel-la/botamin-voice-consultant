import { NextResponse } from "next/server";
import {
  REALTIME_TOOLS,
  REALTIME_VOICE,
  SYSTEM_PROMPT,
} from "@/lib/agent-config";

export const runtime = "nodejs";

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1";

  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY не настроен на сервере." },
      { status: 500 },
    );
  }

  try {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": "botamin-mvp-anonymous",
        },
        body: JSON.stringify({
          expires_after: { anchor: "created_at", seconds: 60 },
          session: {
            type: "realtime",
            model,
            output_modalities: ["audio"],
            instructions: SYSTEM_PROMPT,
            audio: {
              input: {
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "semantic_vad",
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { voice: REALTIME_VOICE },
            },
            tools: REALTIME_TOOLS,
            tool_choice: "auto",
          },
        }),
        cache: "no-store",
      },
    );

    const payload = (await response.json()) as {
      value?: string;
      error?: { message?: string };
    };

    if (!response.ok || !payload.value) {
      return NextResponse.json(
        {
          error:
            payload.error?.message ||
            "OpenAI не вернул временный ключ Realtime.",
        },
        { status: response.status || 502 },
      );
    }

    // Возвращаем только краткоживущий secret, без конфигурации и server API key.
    return NextResponse.json(
      { value: payload.value },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Не удалось создать Realtime-сессию." },
      { status: 502 },
    );
  }
}
