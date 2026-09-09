"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createInitialSessionState,
  maskSensitiveText,
  type SessionState,
} from "@/lib/business";
import type { PublicLead, Slot, ToolResult } from "@/lib/lead-types";

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

export default function VoiceConsultant() {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [session, setSession] = useState<SessionState>(
    createInitialSessionState,
  );
  const [lead, setLead] = useState<PublicLead | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [bookingBusy, setBookingBusy] = useState(false);

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

  const runTool = useCallback(async (name: string, args: Record<string, unknown>, callId?: string): Promise<ToolResult> => {
    const response = await fetch("/api/lead/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: name, args, callId }),
    });
    const result = (await response.json()) as ToolResult;
    if (result.lead) setLead(result.lead);
    if (result.slots) setSlots(result.slots);
    if (name === "save_contact" || name === "save_work_email") {
      setTranscript((lines) => lines.map((line) => line.role === "user" ? { ...line, text: maskSensitiveText(line.text) } : line));
    }
    return result;
  }, []);

  const handleFunctionCall = useCallback(
    async (name?: string, callId?: string, rawArguments?: string) => {
      if (!name || !callId || handledCallsRef.current.has(callId)) return;
      handledCallsRef.current.add(callId);

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(rawArguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = await runTool(name, args, callId);
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
    setLead(null);
    setSlots([]);
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

      const tokenResponse = await fetch("/api/voice-session", {
        method: "POST",
      });
      const tokenData = (await tokenResponse.json()) as {
        value?: string;
        error?: string;
        lead?: PublicLead;
      };
      if (!tokenResponse.ok || !tokenData.value) {
        throw new Error(tokenData.error || "Не удалось получить временный ключ.");
      }
      setLead(tokenData.lead ?? null);

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
    setLead(null);
    setSlots([]);
    setError(null);
    setStatus("idle");
  };

  const progress = useMemo(
    () => [
      { label: "Компания", done: Boolean(lead?.companyActivity) },
      { label: "Слот", done: Boolean(lead?.selectedSlot) },
      {
        label: "Контакты",
        done: Boolean(lead?.name && (lead.phone || lead.telegram) && lead.workEmail),
      },
      { label: "Встреча", done: lead?.bookingStatus === "confirmed" },
      { label: "Квалификация", done: Boolean(lead?.leadsPerMonth && lead.salesManagersCount) },
    ],
    [lead],
  );

  const active = ["connecting", "listening", "speaking"].includes(status);
  const requestTool = async (tool: string, args: Record<string, unknown>) => {
    try {
      const result = await runTool(tool, args, crypto.randomUUID());
      if (!result.success) setError(result.message);
      return result;
    } catch {
      setError("Сервис временно недоступен. Попробуйте ещё раз.");
      return null;
    }
  };

  const confirmBooking = async () => {
    setBookingBusy(true);
    const result = await requestTool("confirm_booking", { consent: true });
    setBookingBusy(false);
    if (!result?.success) return;
  };

  return (
    <main className="voxaura-page">
      <div className="aurora aurora--one" aria-hidden />
      <div className="aurora aurora--two" aria-hidden />
      <div className="voxaura-shell">
        <header className="voxaura-header">
          <a href="#" className="voxaura-brand" aria-label="Botamin">
            <span className="brand-glyph" aria-hidden>◌</span>
            Botamin<span className="brand-cursor">°</span>
          </a>
          <div className="system-status">
            <span aria-hidden className="status-led" />
            Консультант онлайн
          </div>
        </header>

        <div className="voxaura-grid">
          <section className="hero-terminal">
            <p className="terminal-kicker">BOTAMIN · VOICE INTELLIGENCE</p>
            <h1>
              Говорите
              <span>свободно.</span>
            </h1>
            <p className="terminal-copy">
              Голосовой консультант поможет понять вашу задачу и подберёт
              время для короткого разговора с экспертом.
            </p>

            <div className={`nexus-orb nexus-orb--${status}`} aria-hidden>
              <span className="orb-frame orb-frame--one" />
              <span className="orb-frame orb-frame--two" />
              <span className="orb-core">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>

            <p className="voice-status" aria-live="polite">
              <span>{status === "speaking" ? "ГОВОРИТ" : "ГОТОВ"}</span>
              {statusLabels[status]}
            </p>

            {error && (
              <div className="nexus-error" role="alert">
                <strong>Не удалось подключиться</strong>
                <p>{error}</p>
              </div>
            )}

            <div className="nexus-controls">
              {!active && status !== "ended" && (
                <button onClick={startConversation} className="nexus-button">
                  <span>◉</span> Начать разговор
                </button>
              )}
              {active && (
                <button onClick={endConversation} className="nexus-button nexus-button--stop">
                  <span>■</span> Завершить разговор
                </button>
              )}
              {(status === "ended" || status === "error") && (
                <button onClick={resetConversation} className="nexus-button">
                  <span>↻</span> Начать заново
                </button>
              )}
              <small>Доступ к микрофону запрашивается только после нажатия кнопки</small>
            </div>
          </section>

          <section className="nexus-panel transcript-panel">
            <div className="panel-header">
              <span>В РЕАЛЬНОМ ВРЕМЕНИ</span>
              <span className="panel-chip">КОНТАКТЫ СКРЫТЫ</span>
            </div>
            <h2>Диалог</h2>
            <div className="transcript-stream" aria-live="polite">
              {transcript.length === 0 ? (
                <div className="terminal-empty">
                  <span>ОЖИДАНИЕ СЕАНСА</span>
                  <p>Здесь появятся реплики консультанта и ваши ответы.</p>
                </div>
              ) : (
                transcript.map((line) => (
                  <div
                    key={line.id}
                    className={`terminal-message terminal-message--${line.role}`}
                  >
                    <span>{line.role === "assistant" ? "BOTAMIN" : "ВЫ"}</span>
                    <p>{line.text}</p>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        {lead && (
          <section className="nexus-panel manager-panel">
            <div className="panel-header"><span>ЗАПИСЬ НА КОНСУЛЬТАЦИЮ</span><span>{lead.bookingStatus}</span></div>
            <div className="manager-grid">
              <div>
                <h2>Свободное время</h2>
                <div className="slot-list">
                  {slots.length === 0 ? (
                    <button className="slot-button" onClick={() => void requestTool("get_available_slots", {})}>Показать свободные слоты</button>
                  ) : slots.map((slot) => (
                    <button key={slot.id} className={`slot-button ${lead.selectedSlot?.id === slot.id ? "is-selected" : ""}`} onClick={() => void requestTool("select_slot", { slot })}>
                      {slot.label} · МСК
                    </button>
                  ))}
                  <button className="text-action" onClick={() => void requestTool("get_available_slots", {})}>Другие варианты</button>
                </div>
              </div>
              <div>
                <h2>Контакты</h2>
                <div className="contact-form">
                  <input aria-label="Имя" placeholder="Имя" defaultValue={lead.name ?? ""} onBlur={(event) => void requestTool("save_name", { name: event.currentTarget.value })} />
                  <input aria-label="Телефон или Telegram" placeholder="Телефон или @telegram" defaultValue={lead.phone ?? lead.telegram ?? ""} onBlur={(event) => { const value = event.currentTarget.value; void requestTool("save_contact", { type: value.trim().startsWith("@") ? "telegram" : "phone", value }); }} />
                  <input aria-label="Рабочая почта" placeholder="Рабочая почта" type="email" defaultValue={lead.workEmail ?? ""} onBlur={(event) => void requestTool("save_work_email", { email: event.currentTarget.value })} />
                </div>
              </div>
            </div>
            {lead.selectedSlot && (
              <div className="review-card">
                <div><span>ПРОВЕРЬТЕ ДАННЫЕ</span><p>{lead.name ?? "Имя не указано"} · {lead.selectedSlot.label} МСК</p><small>Нажимая «Записаться», вы соглашаетесь передать контакты и запрос менеджеру Botamin для организации встречи.</small></div>
                <button className="nexus-button" disabled={bookingBusy} onClick={() => void confirmBooking()}>{bookingBusy ? "Создаём запись…" : "Записаться"}</button>
              </div>
            )}
          </section>
        )}

        <section className="nexus-panel nexus-progress">
          <div className="panel-header">
            <span>ПРОГРЕСС ВСТРЕЧИ</span>
            <span>{progress.filter((step) => step.done).length}/5</span>
          </div>
          <div className="progress-steps">
            {progress.map((step, index) => (
              <div key={step.label} className={`mission-step ${step.done ? "is-complete" : ""}`}>
                <span>{step.done ? "✓" : String(index + 1).padStart(2, "0")}</span>
                <p>{step.label}</p>
              </div>
            ))}
          </div>
        </section>

        {lead?.bookingStatus === "confirmed" && lead.selectedSlot && (
            <section className="nexus-panel booking-panel">
              <div className="booking-sigil" aria-hidden>✓</div>
              <div>
                <p className="panel-header">ВСТРЕЧА ПОДТВЕРЖДЕНА</p>
                <h2>{lead.selectedSlot.label}</h2>
                <p className="booking-subtitle">20 минут · время московское</p>
              </div>
              <div className="booking-contacts">
                  <div>
                    Контакт: <strong>{lead.phone ?? lead.telegram ?? "не указан"}</strong>
                  </div>
                  <div>
                    Почта: <strong>{lead.workEmail ?? "не указана"}</strong>
                  </div>
                  {lead.meetingUrl && <div>Ссылка: <a href={lead.meetingUrl} target="_blank" rel="noreferrer">Открыть встречу</a></div>}
              </div>
            </section>
          )}
      </div>
    </main>
  );
}
