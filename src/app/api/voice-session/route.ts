import { NextResponse } from "next/server";
import { REALTIME_TOOLS, REALTIME_VOICE, SYSTEM_PROMPT } from "@/lib/agent-config";
import { createLead, getLead, toPublicLead } from "@/lib/lead-store";
import { insertLead } from "@/lib/supabase-repository";
import { buildRealtimeResumeInstructions } from "@/lib/resume-context";

export const runtime = "nodejs";

function readLeadSession(request: Request) {
  const cookie = request.headers.get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("botamin_lead="))
    ?.slice("botamin_lead=".length);
  if (!cookie) return null;
  const separator = cookie.indexOf(".");
  if (separator < 1) return null;
  return getLead(cookie.slice(0, separator), cookie.slice(separator + 1));
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Голосовой сервис не настроен." }, { status: 503 });

  try {
    const resumedLead = readLeadSession(request);
    const lead = resumedLead ?? createLead();
    if (!resumedLead && !(await insertLead(lead)) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: "Хранилище заявок временно недоступно." }, { status: 503 });
    }
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": `botamin-${lead.id}`,
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 60 },
        session: {
          type: "realtime",
          model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2.1",
          output_modalities: ["audio"],
          instructions: resumedLead ? buildRealtimeResumeInstructions(SYSTEM_PROMPT, lead) : SYSTEM_PROMPT,
          audio: {
            input: { transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true } },
            output: { voice: REALTIME_VOICE },
          },
          tools: REALTIME_TOOLS,
          tool_choice: "auto",
        },
      }),
      cache: "no-store",
    });
    const payload = (await response.json()) as { value?: string };
    if (!response.ok || !payload.value) {
      const message = response.status === 401 || response.status === 403
        ? "OpenAI API key не авторизован для Realtime API."
        : "Не удалось создать голосовую сессию.";
      return NextResponse.json({ error: message }, { status: response.status === 401 || response.status === 403 ? 503 : 502 });
    }

    const result = NextResponse.json({ value: payload.value, lead: toPublicLead(lead), resumed: Boolean(resumedLead) }, { headers: { "Cache-Control": "no-store" } });
    result.cookies.set("botamin_lead", `${lead.id}.${lead.sessionSecret}`, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60,
    });
    return result;
  } catch {
    return NextResponse.json({ error: "Не удалось связаться с голосовым сервисом." }, { status: 502 });
  }
}
