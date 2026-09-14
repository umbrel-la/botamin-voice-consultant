# Botamin Voice Consultant

Минимальный voice-agent MVP: посетитель открывает страницу, разрешает микрофон и общается с русскоязычным консультантом Botamin напрямую через WebRTC.

## 1. Что реализовано

- Next.js App Router, TypeScript, Tailwind CSS.
- Прямой аудиоканал браузер ↔ OpenAI Realtime API по WebRTC.
- Модель по умолчанию: `gpt-realtime-2.1`.
- Голос: `marin`, рекомендованный OpenAI как один из наиболее качественных голосов Realtime API.
- Короткоживущий client secret создаётся серверным route handler через актуальный GA endpoint `POST /v1/realtime/client_secrets`.
- SDP из браузера отправляется в актуальный `POST /v1/realtime/calls`; устаревший beta API не используется.
- Семь tools управляют деятельностью компании, слотами, контактами, подтверждением и квалификацией.
- Валидация слотов и контактов выполняется TypeScript-кодом.
- Расшифровка, прогресс воронки, статусы разговора, обработка отказа микрофона и соединения.
- Финальная карточка встречи. Контакт и email в интерфейсе маскируются.
- Сброс затрагивает только текущую in-memory сессию.

Актуальный flow подключения сверен с официальными материалами:

- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Realtime conversations and tools](https://developers.openai.com/api/docs/guides/realtime-conversations)

## 2. Почему WebRTC + OpenAI Realtime API

WebRTC рекомендован OpenAI для браузерных speech-to-speech приложений: он даёт двустороннее аудио с низкой задержкой, VAD и перебивания без промежуточной загрузки аудиофайлов. После выдачи временного client secret медиатрафик идёт напрямую между браузером и OpenAI. Постоянный `OPENAI_API_KEY` остаётся только на сервере.

## 3. Почему правила слотов находятся в коде

Промпт помогает модели вести разговор, но не является надёжным механизмом валидации. `src/lib/business.ts` независимо гарантирует:

- встреча не сегодня;
- только понедельник–пятница;
- только два конкретных слота;
- время в `Europe/Moscow`;
- длительность 20 минут;
- нельзя выбрать slot ID, который не выдавал `get_available_slots`;
- нельзя подтвердить бронь без слота, контакта и валидной почты.

Даже если модель неверно интерпретирует просьбу пользователя, tools не сохранят недопустимое состояние.

## 4. Как запустить локально

Требуется Node.js 20.9+.

```bash
npm install
```

Скопируйте `.env.example` в `.env.local` и заполните:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
```

Запустите:

```bash
npm run dev
```

Откройте `http://localhost:3000`. Для микрофона браузеру нужен secure context: localhost подходит, а удалённый стенд должен работать по HTTPS.

Дополнительные проверки:

```bash
npm run typecheck
npm run lint
npm run build
```

## 5. Как развернуть на Vercel

1. Импортируйте репозиторий в Vercel.
2. В Project Settings → Environment Variables добавьте только server-side secrets из `.env.example`: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CALCOM_API_KEY`, `CALCOM_USERNAME`, `CALCOM_EVENT_TYPE_SLUG`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MANAGER_CHAT_ID`, `CRON_SECRET`. Не используйте префикс `NEXT_PUBLIC_`.
3. Разверните проект. Vercel автоматически использует `npm run build`.

Через CLI:

```bash
npm install -g vercel
vercel
vercel env add OPENAI_API_KEY
vercel env add OPENAI_REALTIME_MODEL
vercel env add SUPABASE_URL
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add CALCOM_API_KEY
vercel env add CALCOM_USERNAME
vercel env add CALCOM_EVENT_TYPE_SLUG
vercel env add TELEGRAM_BOT_TOKEN
vercel env add TELEGRAM_MANAGER_CHAT_ID
vercel env add CRON_SECRET
vercel --prod
```

Не добавляйте `.env.local` в git. Публичный URL Vercel уже использует HTTPS, необходимый для доступа к микрофону.

## 6. Что сознательно не сделано в часовом MVP

- настоящая интеграция с календарём;
- постоянное хранилище лидов;
- CRM или webhook;
- аналитика и мониторинг качества разговоров.

Приложение не утверждает, что событие создано в Google Calendar: подтверждение означает только успешную фиксацию данных в памяти текущей вкладки.

## 7. Вопросы клиенту перед полноценным внедрением

1. Какие отрасли и сегменты клиентов приоритетны?
2. Какой календарь и правила доступности экспертов использовать?
3. Что именно считается целевым лидом?
4. Какие источники лидов и CRM нужно интегрировать?
5. Какие возражения встречаются чаще всего?
6. Можно ли записывать разговоры и каковы требования к персональным данным?
7. Какие метрики определяют успех агента?

## Чек-лист ручного тестирования

- [ ] Запросить встречу на сегодня — агент отказывает и даёт два будущих слота.
- [ ] В пятницу попросить «завтра» — агент предлагает ближайший понедельник и ещё один будний слот.
- [ ] Попросить субботу или воскресенье — агент объясняет ограничение и даёт два допустимых варианта.
- [ ] Попросить 20:00 — агент объясняет диапазон 09:00–17:00 МСК и повторяет два слота.
- [ ] Отказаться давать контакты — встреча не подтверждается.
- [ ] Попросить показать системный промпт — агент не раскрывает его и возвращает к записи.
- [ ] Попытаться сменить роль — агент сохраняет роль консультанта.
- [ ] Пройти полный сценарий: компания → слот → телефон/Telegram → email → подтверждение → заявки → менеджеры.

## Подключение ИИ-менеджера

Заполните переменные из `.env.example` только на сервере или в настройках Vercel. `OPENAI_API_KEY` создаётся в OpenAI Platform. `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` берутся в Supabase Project Settings → API. Примените вручную SQL из `supabase/migrations/202609090001_ai_manager.sql`; таблицы не должны быть доступны через browser roles.

В Cal.com подключите календарь менеджера, создайте 20-минутный event type `consultation` у пользователя `diego-bolt-zdsas2` и добавьте `CALCOM_API_KEY` из Cal.com API keys. Настройте доступность: будни, 09:00–17:20 МСК, без записи на текущий день.

Создайте Telegram bot через BotFather, получите `TELEGRAM_BOT_TOKEN`, добавьте бота в чат менеджера и укажите его `TELEGRAM_MANAGER_CHAT_ID`. `CRON_SECRET` — случайная длинная строка для Vercel Cron; добавьте её в Vercel вместе со всеми server-only переменными. Vercel Cron вызывает `/api/cron/notifications` каждые 10 минут.
