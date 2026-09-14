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
  | "reconnecting"
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
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  response?: {
    id?: string;
    status?: string;
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
  reconnecting: "Переподключаемся, диалог сохранён…",
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
  const [bookingReviewVisible, setBookingReviewVisible] = useState(false);
  const [meetingUrlCopied, setMeetingUrlCopied] = useState(false);
  const [bookingModalVisible, setBookingModalVisible] = useState(false);

  const sessionRef = useRef(session);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const handledCallsRef = useRef(new Set<string>());
  const activeResponseIdRef = useRef<string | null>(null);
  const responseRequestedRef = useRef(false);
  const startingRef = useRef(false);
  const bookingBusyRef = useRef(false);
  const activeAssistantBubbleRef = useRef<{ id: string; responseId: string | null } | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const manuallyEndedRef = useRef(false);
  const reconnectRef = useRef<() => void>(() => undefined);

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

  const appendAssistantDelta = useCallback((delta: string, responseId: string | null) => {
    const safe = maskSensitiveText(delta);
    if (!safe) return;
    const activeBubble = activeAssistantBubbleRef.current;
    if (activeBubble && activeBubble.responseId === responseId) {
      setTranscript((current) =>
        current.map((line) =>
          line.id === activeBubble.id ? { ...line, text: `${line.text}${safe}` } : line,
        ),
      );
      return;
    }
    const id = crypto.randomUUID();
    activeAssistantBubbleRef.current = { id, responseId };
    setTranscript((current) => [...current, { id, role: "assistant", text: safe }]);
  }, []);

  const finalizeAssistantBubble = useCallback((responseId?: string) => {
    if (!responseId || activeAssistantBubbleRef.current?.responseId === responseId) {
      activeAssistantBubbleRef.current = null;
    }
  }, []);

  const sendEvent = useCallback((event: object) => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") {
      channel.send(JSON.stringify(event));
    }
  }, []);

  const requestResponse = useCallback((instructions?: string) => {
    if (activeResponseIdRef.current || responseRequestedRef.current) return false;
    responseRequestedRef.current = true;
    sendEvent(
      instructions
        ? { type: "response.create", response: { instructions } }
        : { type: "response.create" },
    );
    return true;
  }, [sendEvent]);

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
      if (!name || !callId || handledCallsRef.current.has(callId)) return null;
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
      return name;
    },
    [runTool, sendEvent],
  );

  const handleEvent = useCallback(
    async (event: RealtimeEvent) => {
      switch (event.type) {
        case "input_audio_buffer.speech_started":
          setStatus("listening");
          if (activeResponseIdRef.current) {
            sendEvent({ type: "response.cancel" });
          }
          break;
        case "response.created":
          activeResponseIdRef.current = event.response?.id ?? "pending";
          responseRequestedRef.current = false;
          setError((current) =>
            current === "Ответ ещё формируется. Продолжаем разговор." ? null : current,
          );
          setStatus("speaking");
          break;
        case "response.done": {
          const responseId = event.response?.id;
          activeResponseIdRef.current = null;
          responseRequestedRef.current = false;
          finalizeAssistantBubble(responseId);
          setStatus("listening");
          const calledTools = await Promise.all(
            (event.response?.output ?? [])
            ?.filter((item) => item.type === "function_call")
            .map((item) =>
              handleFunctionCall(
                item.name,
                item.call_id,
                item.arguments,
              ),
            ),
          );
          if (calledTools.some(Boolean)) {
            const slotsWereReturned = calledTools.includes("get_available_slots");
            requestResponse(
              slotsWereReturned
                ? "Коротко переспроси, какой из полученных слотов выбирает клиент. Не выбирай слот за него."
                : undefined,
            );
          }
          break;
        }
        case "response.cancelled":
        case "response.failed":
          activeResponseIdRef.current = null;
          responseRequestedRef.current = false;
          finalizeAssistantBubble(event.response?.id);
          setStatus("listening");
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript) {
            appendTranscript("user", event.transcript);
            void runTool(
              "save_conversation_context",
              { lastUserMessage: event.transcript },
              crypto.randomUUID(),
            );
          }
          break;
        case "response.output_audio_transcript.delta":
          if (event.delta) appendAssistantDelta(event.delta, activeResponseIdRef.current);
          break;
        case "response.output_audio_transcript.done":
          if (!activeAssistantBubbleRef.current && event.transcript) {
            appendAssistantDelta(event.transcript, activeResponseIdRef.current);
          }
          break;
        case "error":
          if ((event.error?.message || "").includes("active response")) {
            setError("Ответ ещё формируется. Продолжаем разговор.");
          } else {
            setError(event.error?.message || "Ошибка Realtime API.");
            setStatus("error");
          }
          break;
      }
    },
    [appendAssistantDelta, appendTranscript, finalizeAssistantBubble, handleFunctionCall, requestResponse, runTool, sendEvent],
  );

  const closeTransport = useCallback(() => {
    channelRef.current?.close();
    peerRef.current?.close();
    if (audioRef.current) audioRef.current.srcObject = null;
    channelRef.current = null;
    peerRef.current = null;
  }, []);

  const cleanupConnection = useCallback(() => {
    closeTransport();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, [closeTransport]);

  useEffect(() => () => {
    manuallyEndedRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    cleanupConnection();
  }, [cleanupConnection]);

  const startConversation = async (resume = false) => {
    if (startingRef.current) return;
    startingRef.current = true;
    if (resume) closeTransport();
    else cleanupConnection();
    if (!resume) handledCallsRef.current.clear();
    activeResponseIdRef.current = null;
    responseRequestedRef.current = false;
    activeAssistantBubbleRef.current = null;
    if (!resume) {
      manuallyEndedRef.current = false;
      reconnectAttemptsRef.current = 0;
      setError(null);
      setTranscript([]);
      setLead(null);
      setSlots([]);
      setBookingReviewVisible(false);
      setMeetingUrlCopied(false);
      updateSession(createInitialSessionState());
    }
    setStatus(resume ? "reconnecting" : "connecting");

    try {
      const media = streamRef.current?.active
        ? streamRef.current
        : await navigator.mediaDevices.getUserMedia({
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
        resumed?: boolean;
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
      const reconnectOnFailure = () => {
        if (!manuallyEndedRef.current) reconnectRef.current();
      };
      peer.onconnectionstatechange = () => {
        if (["failed", "disconnected"].includes(peer.connectionState)) {
          reconnectOnFailure();
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (["failed", "disconnected", "closed"].includes(peer.iceConnectionState)) {
          reconnectOnFailure();
        }
      };

      const channel = peer.createDataChannel("oai-events");
      channelRef.current = channel;
      channel.onmessage = (message) => {
        try {
          void handleEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          setError("Получено некорректное событие Realtime API.");
        }
      };
      channel.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setError(null);
        requestResponse(tokenData.resumed
          ? "Продолжи диалог по переданному сервером контексту с единственного следующего логичного шага. Не здоровайся заново."
          : "Поздоровайся сейчас дословно фразой из первого шага и задай только вопрос о деятельности компании.");
      };
      channel.onclose = reconnectOnFailure;
      channel.onerror = reconnectOnFailure;

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
      if (resume) closeTransport();
      else cleanupConnection();
      const denied =
        caught instanceof DOMException &&
        ["NotAllowedError", "PermissionDeniedError"].includes(caught.name);
      const message =
        denied
          ? "Доступ к микрофону запрещён. Разрешите его в настройках браузера и попробуйте снова."
          : caught instanceof Error
            ? caught.message
            : "Не удалось подключиться к голосовому агенту.";
      if (resume) {
        setError("Не удалось переподключиться. Диалог сохранён.");
        reconnectRef.current();
      } else {
        setError(message);
        setStatus("error");
      }
    } finally {
      startingRef.current = false;
    }
  };

  useEffect(() => {
    reconnectRef.current = () => {
      if (manuallyEndedRef.current || !lead || !navigator.onLine) {
        if (!manuallyEndedRef.current && lead) {
          setStatus("reconnecting");
          setError("Нет сети. Диалог сохранён — продолжим, когда соединение вернётся.");
        }
        return;
      }
      if (startingRef.current || reconnectTimerRef.current !== null) return;
      const delays = [1000, 2000, 4000];
      const attempt = reconnectAttemptsRef.current;
      if (attempt >= delays.length) {
        setStatus("error");
        setError("Не удалось восстановить соединение. Диалог сохранён — попробуйте подключиться ещё раз.");
        return;
      }
      reconnectAttemptsRef.current += 1;
      setStatus("reconnecting");
      setError(null);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void startConversation(true);
      }, delays[attempt]);
    };
  });

  useEffect(() => {
    const onOnline = () => {
      reconnectAttemptsRef.current = 0;
      reconnectRef.current();
    };
    const onOffline = () => {
      if (!manuallyEndedRef.current && lead) {
        setStatus("reconnecting");
        setError("Нет сети. Диалог сохранён — продолжим, когда соединение вернётся.");
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [lead]);

  const endConversation = () => {
    manuallyEndedRef.current = true;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    cleanupConnection();
    setStatus("ended");
  };

  const resetConversation = () => {
    manuallyEndedRef.current = true;
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    cleanupConnection();
    handledCallsRef.current.clear();
    activeResponseIdRef.current = null;
    responseRequestedRef.current = false;
    updateSession(createInitialSessionState());
    setTranscript([]);
    setLead(null);
    setSlots([]);
    setBookingReviewVisible(false);
    setMeetingUrlCopied(false);
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

  const active = ["connecting", "reconnecting", "listening", "speaking"].includes(status);
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
    if (bookingBusyRef.current) return;
    bookingBusyRef.current = true;
    setBookingBusy(true);
    try {
      const result = await requestTool("confirm_booking", { consent: true });
      if (result?.success && result.booking?.status === "confirmed") {
        setBookingModalVisible(true);
      }
    } finally {
      bookingBusyRef.current = false;
      setBookingBusy(false);
    }
  };

  const copyMeetingUrl = async () => {
    if (!lead?.meetingUrl) return;
    try {
      await navigator.clipboard.writeText(lead.meetingUrl);
      setMeetingUrlCopied(true);
    } catch {
      setError("Не удалось скопировать ссылку. Вы можете открыть её в новой вкладке.");
    }
  };

  const meetingLabel = lead?.meetingUrl?.includes("meet.google.com")
    ? "Google Meet"
    : "Ссылка на встречу";

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
                <button onClick={() => void startConversation()} className="nexus-button">
                  <span>◉</span> Начать разговор
                </button>
              )}
              {active && (
                <button onClick={endConversation} className="nexus-button nexus-button--stop">
                  <span>■</span> Завершить разговор
                </button>
              )}
              {(status === "ended" || status === "error") && (
                <>
                  {status === "error" && lead && (
                    <button onClick={() => {
                      reconnectAttemptsRef.current = 0;
                      reconnectRef.current();
                    }} className="nexus-button">
                      <span>↻</span> Повторить подключение
                    </button>
                  )}
                  <button onClick={resetConversation} className="nexus-button">
                    <span>↻</span> Начать заново
                  </button>
                </>
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
            {lead.selectedSlot && lead.bookingStatus !== "confirmed" && (
              <div className="review-card">
                <div>
                  <span>ПРОВЕРЬТЕ ДАННЫЕ</span>
                  <p>{lead.name ?? "Имя не указано"} · {lead.selectedSlot.label} МСК</p>
                  <dl className="review-details">
                    <div><dt>Время</dt><dd>{lead.selectedSlot.label} · МСК</dd></div>
                    <div><dt>Контакт</dt><dd>{lead.phone ?? lead.telegram ?? "не указан"}</dd></div>
                    <div><dt>Почта</dt><dd>{lead.workEmail ?? "не указана"}</dd></div>
                  </dl>
                  {bookingReviewVisible && (
                    <small className="review-confirmation">
                      Подтверждаю запись на консультацию Botamin. Ссылка на встречу будет предоставлена календарём после подтверждения.
                    </small>
                  )}
                </div>
                <div className="review-actions">
                  {bookingReviewVisible ? (
                    <>
                      <button className="nexus-button" disabled={bookingBusy} onClick={() => void confirmBooking()}>
                        {bookingBusy ? "Создаём запись…" : "Подтвердить запись"}
                      </button>
                      <button className="text-action" disabled={bookingBusy} onClick={() => setBookingReviewVisible(false)}>Изменить данные</button>
                    </>
                  ) : (
                    <button className="nexus-button" onClick={() => setBookingReviewVisible(true)}>Проверить запись</button>
                  )}
                </div>
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
                  <div>Календарное приглашение: <strong>создано</strong></div>
                  <div>Уведомление менеджеру: <strong>{lead.notificationStatus === "sent" ? "доставлено" : lead.notificationStatus === "failed" ? "ожидает повторной отправки" : lead.notificationStatus === "not_configured" ? "не настроено" : "отправляется"}</strong></div>
                  {lead.meetingUrl && (
                    <div className="meeting-link-actions">
                      {meetingLabel}: <a href={lead.meetingUrl} target="_blank" rel="noreferrer">{lead.meetingUrl}</a>
                      <a className="text-action" href={lead.meetingUrl} target="_blank" rel="noreferrer">
                        {meetingLabel === "Google Meet" ? "Открыть Google Meet" : "Открыть видеовстречу"}
                      </a>
                      <button className="text-action" onClick={() => void copyMeetingUrl()}>
                        {meetingUrlCopied ? "Скопировано" : "Копировать ссылку"}
                      </button>
                    </div>
                  )}
              </div>
            </section>
          )}
        {bookingModalVisible && lead?.bookingStatus === "confirmed" && lead.selectedSlot && (
          <div className="booking-modal-backdrop" role="presentation">
            <section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-modal-title">
              <div className="booking-sigil" aria-hidden>✓</div>
              <p className="panel-header">КОНСУЛЬТАЦИЯ BOTAMIN</p>
              <h2 id="booking-modal-title">Встреча подтверждена</h2>
              <p>{lead.selectedSlot.label} · МСК</p>
              <p>{lead.meetingUrl ? "Приглашение отправлено на вашу почту." : "Встреча создана, но ссылка на видеовстречу пока не получена. Проверьте приглашение на почте."}</p>
              {lead.meetingUrl && (
                <>
                  <label className="meeting-url-field">
                    {meetingLabel}
                    <input readOnly value={lead.meetingUrl} aria-label="Ссылка на видеовстречу" />
                  </label>
                  <div className="modal-actions">
                    <a className="nexus-button" href={lead.meetingUrl} target="_blank" rel="noreferrer">
                      {meetingLabel === "Google Meet" ? "Открыть Google Meet" : "Открыть видеовстречу"}
                    </a>
                    <button className="text-action" onClick={() => void copyMeetingUrl()}>
                      {meetingUrlCopied ? "Скопировано" : "Скопировать ссылку"}
                    </button>
                  </div>
                </>
              )}
              <button className="text-action" onClick={() => setBookingModalVisible(false)}>Готово</button>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
