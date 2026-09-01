"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  confirmBooking,
  createInitialSessionState,
  getAvailableSlots,
  maskSensitiveText,
  saveCompanyActivity,
  saveContact,
  saveQualification,
  saveWorkEmail,
  selectSlot,
  type ContactType,
  type SessionState,
  type ToolResult,
} from "@/lib/business";

type CallStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "ended"
  | "error";

type TranscriptLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type RealtimeEvent = {
  type: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  response?: {
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
  error?: { message?: string };
};

const statusLabels: Record<CallStatus, string> = {
  idle: "Готовы начать",
  connecting: "Подключаемся",
  listening: "Слушаю",
  speaking: "Агент отвечает",
  ended: "Разговор завершён",
  error: "Ошибка",
};

function maskContact(type: ContactType, value: string) {
  if (type === "telegram") return `${value.slice(0, 2)}***`;
  const digits = value.replace(/\D/g, "");
  return `+* (***) ***-**-${digits.slice(-2)}`;
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

export default function VoiceConsultant() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [session, setSession] = useState<SessionState>(
    createInitialSessionState,
  );

  const sessionRef = useRef(session);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const handledCallsRef = useRef(new Set<string>());

  const updateSession = useCallback((next: SessionState) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const appendTranscript = useCallback(
    (role: TranscriptLine["role"], text: string) => {
      const safe = maskSensitiveText(text.trim());
      if (!safe) return;
      setTranscript((current) => [
        ...current,
        { id: crypto.randomUUID(), role, text: safe },
      ]);
    },
    [],
  );

  const sendEvent = useCallback((event: object) => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify(event));
    }
  }, []);

  const runTool = useCallback(
    (name: string, args: Record<string, unknown>): ToolResult => {
      const state = sessionRef.current;
      let result: [SessionState, ToolResult];

      switch (name) {
        case "save_company_activity":
          result = saveCompanyActivity(state, String(args.activity ?? ""));
          break;
        case "get_available_slots":
          result = getAvailableSlots(state);
          break;
        case "select_slot":
          result = selectSlot(state, String(args.slotId ?? ""));
          break;
        case "save_contact":
          result = saveContact(
            state,
            args.type as ContactType,
            String(args.value ?? ""),
          );
          break;
        case "save_work_email":
          result = saveWorkEmail(state, String(args.email ?? ""));
          break;
        case "confirm_booking":
          result = confirmBooking(state);
          break;
        case "save_qualification":
          result = saveQualification(
            state,
            String(args.leadsPerMonth ?? ""),
            String(args.salesManagersCount ?? ""),
          );
          break;
        default:
          return { success: false, message: `Неизвестный tool: ${name}` };
      }

      updateSession(result[0]);
      if (name === "save_contact" || name === "save_work_email") {
        setTranscript((lines) =>
          lines.map((line) =>
            line.role === "user"
              ? { ...line, text: maskSensitiveText(line.text) }
              : line,
          ),
        );
      }
      return result[1];
    },
    [updateSession],
  );

  const handleFunctionCall = useCallback(
    (name?: string, callId?: string, rawArguments?: string) => {
      if (!name || !callId || handledCallsRef.current.has(callId)) return;
      handledCallsRef.current.add(callId);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(rawArguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = runTool(name, args);
      sendEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(result),
        },
      });
      sendEvent({ type: "response.create" });
    },
    [runTool, sendEvent],
  );

  const handleEvent = useCallback(
    (event: RealtimeEvent) => {
      switch (event.type) {
        case "input_audio_buffer.speech_started":
          setStatus("listening");
          break;
        case "response.created":
          setStatus("speaking");
          break;
        case "response.done": {
          setStatus("listening");
          event.response?.output
            ?.filter((item) => item.type === "function_call")
            .forEach((item) =>
              handleFunctionCall(
                item.name,
                item.call_id,
                item.arguments,
              ),
            );
          break;
        }
        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript) appendTranscript("user", event.transcript);
          break;
        case "response.output_audio_transcript.done":
          if (event.transcript)
            appendTranscript("assistant", event.transcript);
          break;
        case "response.function_call_arguments.done": {
          handleFunctionCall(event.name, event.call_id, event.arguments);
          break;
        }
        case "error":
          setError(event.error?.message || "Ошибка Realtime API.");
          setStatus("error");
          break;
      }
    },
    [appendTranscript, handleFunctionCall],
  );

  const cleanupConnection = useCallback(() => {
    channelRef.current?.close();
    peerRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioRef.current) audioRef.current.srcObject = null;
    channelRef.current = null;
    peerRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => cleanupConnection, [cleanupConnection]);

  const startConversation = async () => {
    cleanupConnection();
    handledCallsRef.current.clear();
    setError(null);
    setTranscript([]);
    updateSession(createInitialSessionState());
    setStatus("connecting");

    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = media;

      const tokenResponse = await fetch("/api/realtime-token", {
        method: "POST",
      });
      const tokenData = (await tokenResponse.json()) as {
        value?: string;
        error?: string;
      };
      if (!tokenResponse.ok || !tokenData.value) {
        throw new Error(tokenData.error || "Не удалось получить временный ключ.");
      }

      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      media.getTracks().forEach((track) => peer.addTrack(track, media));

      const audio = new Audio();
      audio.autoplay = true;
      audioRef.current = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => undefined);
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          setError("Соединение с голосовым агентом потеряно.");
          setStatus("error");
        }
      };

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (message) => {
        try {
          handleEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          setError("Получено некорректное событие Realtime API.");
        }
      };
      channel.onopen = () => {
        setStatus("speaking");
        sendEvent({
          type: "response.create",
          response: {
            instructions:
              "Поздоровайся сейчас дословно фразой из первого шага и задай только вопрос о деятельности компании.",
          },
        });
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const sdpResponse = await fetch(
        "https://api.openai.com/v1/realtime/calls",
        {
          method: "POST",
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${tokenData.value}`,
            "Content-Type": "application/sdp",
          },
        },
      );
      if (!sdpResponse.ok) {
        throw new Error("OpenAI отклонил WebRTC-подключение.");
      }
      await peer.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });
    } catch (caught) {
      cleanupConnection();
      const denied =
        caught instanceof DOMException &&
        ["NotAllowedError", "PermissionDeniedError"].includes(caught.name);
      setError(
        denied
          ? "Доступ к микрофону запрещён. Разрешите его в настройках браузера и попробуйте снова."
          : caught instanceof Error
            ? caught.message
            : "Не удалось подключиться к голосовому агенту.",
      );
      setStatus("error");
    }
  };

  const endConversation = () => {
    cleanupConnection();
    setStatus("ended");
  };

  const resetConversation = () => {
    cleanupConnection();
    handledCallsRef.current.clear();
    updateSession(createInitialSessionState());
    setTranscript([]);
    setError(null);
    setStatus("idle");
  };

  const progress = useMemo(
    () => [
      { label: "Компания", done: Boolean(session.companyActivity) },
      { label: "Слот", done: Boolean(session.selectedSlot) },
      {
        label: "Контакты",
        done: Boolean(session.contact && session.workEmail),
      },
      { label: "Встреча", done: session.bookingConfirmed },
      { label: "Квалификация", done: Boolean(session.qualification) },
    ],
    [session],
  );

  const active = ["connecting", "listening", "speaking"].includes(status);

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <span className="eyebrow">AI voice agent · Москва</span>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-950 sm:text-6xl">
            Botamin Voice
            <span className="block text-emerald-600">Consultant</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            Голосовой консультант для первичной квалификации и записи на встречу
          </p>
        </header>

        <section className="mb-5 rounded-3xl border border-white/80 bg-white/75 p-4 shadow-sm backdrop-blur sm:p-5">
          <div className="grid grid-cols-5 gap-2">
            {progress.map((step, index) => (
              <div key={step.label} className="min-w-0">
                <div
                  className={`mb-2 h-1.5 rounded-full ${step.done ? "bg-emerald-500" : "bg-slate-200"}`}
                />
                <p
                  className={`truncate text-[10px] font-medium sm:text-xs ${step.done ? "text-emerald-700" : "text-slate-400"}`}
                >
                  {index + 1}. {step.label}
                </p>
              </div>
            ))}
          </div>
        </section>

        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-3xl bg-slate-950 p-6 text-white shadow-xl shadow-slate-900/10 sm:p-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Статус
                </p>
                <p className="mt-2 text-xl font-medium">
                  {statusLabels[status]}
                </p>
              </div>
              <div className={`voice-orb voice-orb--${status}`} aria-hidden />
            </div>

            <p className="mt-12 text-sm leading-6 text-slate-400">
              Разрешите доступ к микрофону. Агент говорит по-русски, предложит
              два слота и попросит контакты для подтверждения.
            </p>

            {error && (
              <div
                role="alert"
                className="mt-5 rounded-2xl border border-rose-400/20 bg-rose-400/10 p-4 text-sm leading-6 text-rose-100"
              >
                {error}
              </div>
            )}

            <div className="mt-6 flex flex-col gap-3">
              {!active && status !== "ended" && (
                <button
                  onClick={startConversation}
                  className="button button-primary"
                >
                  Начать разговор
                </button>
              )}
              {active && (
                <button
                  onClick={endConversation}
                  className="button button-danger"
                >
                  Завершить разговор
                </button>
              )}
              {(status === "ended" || status === "error") && (
                <button onClick={resetConversation} className="button button-dark">
                  Начать заново
                </button>
              )}
            </div>
          </section>

          <section className="flex min-h-[430px] flex-col rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                Расшифровка
              </h2>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                Контакты маскируются
              </span>
            </div>
            <div
              className="mt-5 flex max-h-[480px] flex-1 flex-col gap-3 overflow-y-auto pr-1"
              aria-live="polite"
            >
              {transcript.length === 0 ? (
                <div className="m-auto max-w-xs text-center text-sm leading-6 text-slate-400">
                  Здесь появятся реплики консультанта и ваши ответы.
                </div>
              ) : (
                transcript.map((line) => (
                  <div
                    key={line.id}
                    className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                      line.role === "assistant"
                        ? "self-start rounded-bl-md bg-slate-100 text-slate-700"
                        : "self-end rounded-br-md bg-emerald-600 text-white"
                    }`}
                  >
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider opacity-60">
                      {line.role === "assistant" ? "Botamin" : "Вы"}
                    </span>
                    {line.text}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {session.bookingConfirmed &&
          session.selectedSlot &&
          session.contact &&
          session.workEmail && (
            <section className="mt-5 rounded-3xl border border-emerald-200 bg-emerald-50 p-6 sm:p-8">
              <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
                <div>
                  <span className="inline-flex rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white">
                    Встреча подтверждена
                  </span>
                  <h2 className="mt-4 text-2xl font-semibold text-slate-950">
                    {session.selectedSlot.label}
                  </h2>
                  <p className="mt-2 text-sm text-slate-600">
                    20 минут · время московское
                  </p>
                </div>
                <div className="rounded-2xl bg-white/80 p-4 text-sm leading-7 text-slate-600">
                  <div>
                    {session.contact.type === "phone" ? "Телефон" : "Telegram"}:{" "}
                    <strong className="text-slate-900">
                      {maskContact(
                        session.contact.type,
                        session.contact.value,
                      )}
                    </strong>
                  </div>
                  <div>
                    Почта:{" "}
                    <strong className="text-slate-900">
                      {maskEmail(session.workEmail)}
                    </strong>
                  </div>
                </div>
              </div>
            </section>
          )}
      </div>
    </main>
  );
}
