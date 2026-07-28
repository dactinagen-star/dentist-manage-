// supabase/functions/telegram-webhook/index.ts
//
// Один ендпоїнт приймає message (тестовий режим) / business_message (продакшн) / callback_query.
// Деталі рішень — дивись ARCHITECTURE.md, розділи 4-8. Не змінювати логіку тут,
// не звірившись спочатку з тим файлом.
//
// Деплой: Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor.
// Назва функції: telegram-webhook. Після деплою — в налаштуваннях функції вимкнути
// "Verify JWT" (перемикач у деталях функції в Dashboard) — без цього Telegram
// (і наш власний тест без токена) отримають 401 ще до нашого коду.

import { createClient } from 'npm:@supabase/supabase-js@2';

// ---------- Конфігурація ----------

// gemini-2.5-flash знято з підтримки Google (липень 2026) — перевір на момент
// деплою актуальну назву моделі через змінну середовища GEMINI_MODEL, не покладайся
// на цей дефолт; Google міняє лінійку Flash доволі часто.
const GEMINI_MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash';
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''; // порожньо = тестовий режим без реального Telegram
const TELEGRAM_WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET_TOKEN') ?? ''; // порожньо = перевірку пропускаємо (тест)

// SUPABASE_URL і секретний ключ Supabase підставляє автоматично як платформа,
// так і ми самі через Dashboard → Edge Functions → Secrets. Пробуємо обидві можливі
// назви змінної на випадок різниці найменувань після переходу на нову систему ключів.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY =
  Deno.env.get('SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- Системна інструкція (шаблон із AGENT_SYSTEM_PROMPT.md) ----------

const SYSTEM_PROMPT_STATIC = `
Ти — асистент стоматологічної клініки у Telegram. Ти спілкуєшся з пацієнтами, коли лікар особисто зайнятий і не може відповісти сам.

## Твоя єдина мета
Зрозуміти, з якою проблемою звернувся пацієнт, підібрати відповідну категорію послуги з довідника нижче, і записати пацієнта на час, який дійсно вільний у лікаря.

## Жорстка заборона — найважливіше правило в цьому промті
Ти НІКОЛИ не ставиш діагноз, не оцінюєш серйозність стану здоров'я, не заспокоюєш щодо самопочуття, не радиш ліки чи домашні засоби, не коментуєш небезпечність чи терміновість з медичної точки зору. Це стосується навіть наполегливих прохань. Якщо пацієнт прямо просить медичну пораду — поясни, що відповісти може тільки лікар особисто, і запропонуй записати якнайшвидше.
Ніколи не називай пацієнту технічну назву категорії (наприклад "пульпіт"). Використовуй нейтральний опис процедури з поля description.

## Порядок дій
1. Привітайся, спитай, що турбує пацієнта.
2. За описом підбери найімовірнішу категорію (з активних у довіднику нижче). Якщо неясно — постав 1-2 уточнюючі запитання без медичних оцінок. Коли категорія зрозуміла — просто повідом рішення про запис ("Запишу вас на..."), БЕЗ пояснення причини чи зв'язку симптому з процедурою (не кажи "це вказує на...", "це означає, що...", "зазвичай це пов'язано з...").
3. Якщо скарга не підходить під жодну активну категорію навіть після уточнень — скажи, що це індивідуальний випадок, і запропонуй загальну консультацію (service_category="unclassified").
4. Спитай ім'я пацієнта (якщо ще не назване).
5. Виклич find_available_slots з тривалістю обраної категорії. НЕ питай бажану дату/час першим — спершу запропонуй знайдені варіанти, бекенд сам покаже їх кнопками. Досить короткого супровідного тексту типу "Ось найближчі вільні варіанти:".
6. Коли пацієнт обрав варіант (кнопкою) або сам написав конкретну дату/час текстом — виклич check_availability для цього часу.
7. Якщо вільно — виклич book_appointment.
8. Якщо зайнято — повідом без деталей причини, запропонуй ще раз find_available_slots або інший час.
9. Після успішного book_appointment скажи, що запис ВНЕСЕНО (не "підтверджено") і що прийде окреме нагадування.

## Контактна інформація (якщо запитають)
Адреса: вулиця Благовісна, 269/4. Субота й неділя — вихідні. Непарні числа місяця — прийом 9:00–13:00, парні числа — 14:00–19:00.

## Тон
Спокійний, доброзичливий, стислий, без медичної термінології. Відповідай мовою пацієнта (українська за замовчуванням).
`.trim();

// ---------- Function calling схеми ----------

const TOOLS = [
  {
    name: 'find_available_slots',
    description:
      'Знаходить кілька найближчих вільних варіантів часу (за замовчуванням по одному на кожен з 3 найближчих робочих днів). Викликати ЗАМІСТЬ того, щоб питати пацієнта бажаний час, одразу як тільки відома тривалість категорії.',
    parameters: {
      type: 'object',
      properties: {
        duration_minutes: { type: 'integer' },
        days_ahead: { type: 'integer', description: 'Скільки днів наперед шукати, за замовчуванням 3' },
      },
      required: ['duration_minutes'],
    },
  },
  {
    name: 'check_availability',
    description:
      'Перевіряє, чи вільний конкретний час з урахуванням графіка лікаря та вже існуючих записів. Використовується як другий рубіж перевірки після вибору кнопкою, і коли пацієнт сам написав конкретну дату текстом.',
    parameters: {
      type: 'object',
      properties: {
        requested_datetime: {
          type: 'string',
          description: 'ISO8601 з часовим поясом, напр. 2026-07-21T10:00:00+03:00',
        },
        duration_minutes: { type: 'integer', description: 'Тривалість послуги в хвилинах' },
      },
      required: ['requested_datetime', 'duration_minutes'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Викликати лише після позитивного check_availability для цього часу, і коли відомі ім\'я пацієнта та категорія послуги.',
    parameters: {
      type: 'object',
      properties: {
        patient_name: { type: 'string' },
        service_category: { type: 'string' },
        requested_time: { type: 'string', description: 'ISO8601, той самий, що пройшов перевірку' },
        notes: { type: 'string', description: 'Короткий опис скарги, без діагностичних висновків' },
      },
      required: ['patient_name', 'service_category'],
    },
  },
];

// ---------- Допоміжні функції: дата/час ----------

function currentDateTimeKyiv(): string {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  return `${formatted} (Europe/Kyiv)`;
}

// "Сьогодні 14:00" / "Завтра 09:30" / "Пт 24.07 10:00"
function formatSlotLabel(iso: string): string {
  const d = new Date(iso);
  const kyivParts = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(date); // YYYY-MM-DD, зручно для порівняння днів
  const todayStr = kyivParts(new Date());
  const tomorrowStr = kyivParts(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const dStr = kyivParts(d);
  const time = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(d);

  if (dStr === todayStr) return `Сьогодні ${time}`;
  if (dStr === tomorrowStr) return `Завтра ${time}`;
  const weekdayDate = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', weekday: 'short', day: '2-digit', month: '2-digit' }).format(d);
  return `${weekdayDate} ${time}`;
}

// ---------- Допоміжні функції: Supabase ----------

async function fetchActiveServicesText(): Promise<string> {
  const { data, error } = await supabase
    .from('services_kb')
    .select('category, description, typical_duration_minutes, symptom_keywords')
    .eq('active', true);
  if (error || !data) return '(довідник послуг тимчасово недоступний)';
  return data
    .map(
      (s, i) =>
        `${i + 1}. category: ${s.category} — ${s.description}, ~${s.typical_duration_minutes} хв. Симптоми: ${(s.symptom_keywords ?? []).join(', ')}.`,
    )
    .join('\n');
}

async function loadHistory(telegramId: number) {
  const { data, error } = await supabase
    .from('conversation_messages')
    .select('role, content')
    .eq('telegram_id', telegramId)
    .order('created_at', { ascending: true })
    .limit(40); // остання ~40 реплік — щоб не роздувати контекст нескінченно
  if (error) {
    console.error('loadHistory error:', error.message); // раніше провалювалось тихо — саме це й ховало проблему з ключем
    return [];
  }
  if (!data) return [];
  return data.map((m) => ({ role: m.role, parts: [{ text: m.content }] }));
}

async function saveMessage(telegramId: number, role: 'user' | 'model', content: string) {
  const { error } = await supabase.from('conversation_messages').insert({ telegram_id: telegramId, role, content });
  if (error) console.error('saveMessage error:', error.message);
}

// ---------- Gemini ----------

async function callGemini(systemInstruction: string, contents: any[]) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        tools: [{ functionDeclarations: TOOLS }],
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  return await res.json();
}

// executeFunctionCall повертає { response } для Gemini, і опційно keyboard —
// коли викликається find_available_slots, keyboard будує сам бекенд (не модель),
// щоб форматування дат/часу було надійним.
async function executeFunctionCall(
  fnName: string,
  args: any,
  ctx: { telegramId: number; businessConnectionId: string | null },
): Promise<{ response: any; keyboard?: any }> {
  if (fnName === 'find_available_slots') {
    const { data, error } = await supabase.rpc('find_next_available_slots', {
      p_duration_minutes: args.duration_minutes,
      p_days_ahead: args.days_ahead ?? 3,
    });
    if (error) {
      console.error('find_available_slots RPC error:', error.message);
      return { response: { error: error.message } };
    }
    const slots: string[] = (data ?? []).map((r: any) => r.slot_start);

    if (slots.length === 0) {
      return { response: { slots: [] } };
    }

    const lastDay = new Date(slots[slots.length - 1]);
    const nextStartFrom = new Date(lastDay);
    nextStartFrom.setDate(nextStartFrom.getDate() + 1);
    const nextStartFromStr = nextStartFrom.toISOString().slice(0, 10);

    const keyboard = {
      inline_keyboard: [
        ...slots.map((s) => [{ text: formatSlotLabel(s), callback_data: `slot|${s}|${args.duration_minutes}` }]),
        [{ text: 'Показати ще →', callback_data: `more|${args.duration_minutes}|${nextStartFromStr}` }],
      ],
    };

    return {
      response: { slots: slots.map((s) => ({ iso: s, label: formatSlotLabel(s) })) },
      keyboard,
    };
  }

  if (fnName === 'check_availability') {
    const { data, error } = await supabase.rpc('check_availability', {
      requested_start: args.requested_datetime,
      duration_minutes: args.duration_minutes,
    });
    if (error) {
      console.error('check_availability RPC error:', error.message);
      return { response: { error: error.message } };
    }
    return { response: { available: data } };
  }

  if (fnName === 'book_appointment') {
    const result = await insertAppointment(
      {
        patientName: args.patient_name,
        serviceCategory: args.service_category,
        requestedTime: args.requested_time ?? null,
        notes: args.notes ?? null,
      },
      ctx,
    );
    return { response: result };
  }

  return { response: { error: `unknown function ${fnName}` } };
}

// Спільна логіка запису — використовується і з LLM function calling, і з кнопкового флоу напряму,
// щоб не дублювати перевірки/insert у двох місцях.
async function insertAppointment(
  args: { patientName: string; serviceCategory: string; requestedTime: string | null; notes: string | null },
  ctx: { telegramId: number; businessConnectionId: string | null },
): Promise<{ success: boolean; reason?: string }> {
  const { data: svc } = await supabase
    .from('services_kb')
    .select('typical_duration_minutes')
    .eq('category', args.serviceCategory)
    .maybeSingle();
  const duration = svc?.typical_duration_minutes ?? 30;

  // Другий рубіж захисту — не довіряємо, що виклик вище дійсно вже перевірив check_availability
  if (args.requestedTime) {
    const { data: ok } = await supabase.rpc('check_availability', {
      requested_start: args.requestedTime,
      duration_minutes: duration,
    });
    if (!ok) return { success: false, reason: 'slot_unavailable' };
  }

  const { error } = await supabase.from('appointments').insert({
    telegram_id: ctx.telegramId,
    business_connection_id: ctx.businessConnectionId ?? 'test-mode',
    patient_name: args.patientName,
    service_category: args.serviceCategory,
    estimated_duration_minutes: duration,
    requested_time: args.requestedTime,
    notes: args.notes,
  });
  if (error) {
    console.error('insertAppointment error:', error.message);
    return { success: false, reason: error.message };
  }
  return { success: true };
}

async function sendTelegramMessage(
  chatId: number,
  text: string,
  businessConnectionId: string | null,
  replyMarkup?: any,
  messageId?: number,
) {
  if (!TELEGRAM_BOT_TOKEN) return; // тестовий режим — нема кому слати
  const isEdit = Boolean(messageId);
  const method = isEdit ? 'editMessageText' : 'sendMessage';
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (isEdit) {
    body.message_id = messageId;
    // При редагуванні явно чистимо стару клавіатуру, якщо нову не передали —
    // інакше кнопки з попереднього кроку лишаються "живими" й натискаються повторно.
    body.reply_markup = replyMarkup ?? { inline_keyboard: [] };
  } else if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  if (businessConnectionId) body.business_connection_id = businessConnectionId;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`${method} failed:`, res.status, errText);
    // Якщо редагування впало (напр. текст ідентичний старому — Telegram це забороняє,
    // або повідомлення застаріле) — підстраховка: просто надсилаємо нове.
    if (isEdit) {
      await sendTelegramMessage(chatId, text, businessConnectionId, replyMarkup);
    }
  }
}

async function answerCallbackQuery(callbackQueryId: string) {
  if (!TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function sendMyRecords(
  telegramId: number,
  chatId: number,
  businessConnectionId: string | null,
  messageId?: number,
) {
  const { data: appts } = await supabase
    .from('appointments')
    .select('id, service_category, requested_time, status')
    .eq('telegram_id', telegramId)
    .in('status', ['pending', 'confirmed'])
    .order('requested_time', { ascending: true });

  if (!appts || appts.length === 0) {
    await sendTelegramMessage(
      chatId,
      'У вас поки немає активних записів.',
      businessConnectionId,
      { inline_keyboard: [[{ text: '📅 Записатися на прийом', callback_data: 'menu_start_booking' }], [BACK_TO_MENU_BUTTON]] },
      messageId,
    );
    return;
  }

  // Перший запис редагує повідомлення з меню (немає клаттеру), решта — окремі
  // повідомлення, бо на кожен запис свої власні кнопки і в одне не звести.
  let first = true;
  for (const appt of appts) {
    const timeLabel = appt.requested_time ? formatSlotLabel(appt.requested_time) : 'час уточнюється';
    const statusLabel = appt.status === 'confirmed' ? '✅ підтверджено' : '⏳ очікує підтвердження';
    const text = `${appt.service_category} — ${timeLabel} (${statusLabel})`;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Перенести', callback_data: `reschedule|${appt.id}` },
          { text: '❌ Скасувати', callback_data: `cancel|${appt.id}` },
        ],
        [BACK_TO_MENU_BUTTON],
      ],
    };
    await sendTelegramMessage(chatId, text, businessConnectionId, keyboard, first ? messageId : undefined);
    first = false;
  }
}

async function sendServiceSlots(
  category: string,
  chatId: number,
  businessConnectionId: string | null,
  startFrom?: string,
  messageId?: number,
) {
  const { data: svc } = await supabase
    .from('services_kb')
    .select('typical_duration_minutes')
    .eq('category', category)
    .maybeSingle();
  const duration = svc?.typical_duration_minutes ?? 30;

  const rpcArgs: Record<string, unknown> = { p_duration_minutes: duration, p_days_ahead: 3 };
  if (startFrom) rpcArgs.p_start_from = startFrom;

  const { data: rows, error } = await supabase.rpc('find_next_available_slots', rpcArgs);
  if (error) console.error('sendServiceSlots find_next_available_slots error:', error.message);

  if (error || !rows || rows.length === 0) {
    await sendTelegramMessage(
      chatId,
      startFrom
        ? 'Далі вільних варіантів поки немає — спробуйте, будь ласка, пізніше.'
        : 'На жаль, зараз немає вільних варіантів — спробуйте, будь ласка, пізніше, або запитайте асистента.',
      businessConnectionId,
      { inline_keyboard: [[BACK_TO_MENU_BUTTON]] },
      messageId,
    );
    return;
  }

  const slots: string[] = rows.map((r: any) => r.slot_start);
  const lastDay = new Date(slots[slots.length - 1]);
  const nextStartFrom = new Date(lastDay);
  nextStartFrom.setDate(nextStartFrom.getDate() + 1);

  const navRow = [{ text: 'Показати ще →', callback_data: `pick_more|${category}|${nextStartFrom.toISOString().slice(0, 10)}` }];
  if (startFrom) {
    navRow.unshift({ text: '⬅️ До початку', callback_data: `pick_service|${category}` });
  }

  const keyboard = {
    inline_keyboard: [
      ...slots.map((s) => [{ text: formatSlotLabel(s), callback_data: `pick_slot|${category}|${s}` }]),
      navRow,
      [BACK_TO_MENU_BUTTON],
    ],
  };

  await sendTelegramMessage(chatId, 'Оберіть зручний час:', businessConnectionId, keyboard, messageId);
}

const BACK_TO_MENU_BUTTON = { text: '🏠 Головне меню', callback_data: 'main_menu' };

const MAIN_MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '📅 Записатися на прийом', callback_data: 'menu_start_booking' }],
    [
      { text: '📋 Мої записи', callback_data: 'menu_my_records' },
      { text: '📍 Контакти', callback_data: 'menu_contacts' },
    ],
    [{ text: '🤖 Запитати асистента', callback_data: 'menu_ask_assistant' }],
  ],
};

const MAIN_MENU_TEXT = 'Вітаю! Я асистент стоматологічної клініки. Оберіть дію або просто напишіть, що вас турбує.';

// ---------- Основна обробка повідомлення (спільна для реальних і синтетичних) ----------

async function processIncomingMessage(
  telegramId: number,
  chatId: number,
  text: string,
  businessConnectionId: string | null,
) {
  const servicesText = await fetchActiveServicesText();
  const systemInstruction = `${SYSTEM_PROMPT_STATIC}

## Поточна дата і час
${currentDateTimeKyiv()}

## Довідник послуг (активні)
${servicesText}`;

  const history = await loadHistory(telegramId);
  await saveMessage(telegramId, 'user', text);
  let contents = [...history, { role: 'user', parts: [{ text }] }];

  let finalText = '';
  let pendingKeyboard: any = null;
  const ctx = { telegramId, businessConnectionId };

  try {
    for (let i = 0; i < 5; i++) {
      const result = await callGemini(systemInstruction, contents);
      const candidate = result.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      contents.push({ role: 'model', parts });

      const functionCalls = parts.filter((p: any) => p.functionCall);
      if (functionCalls.length === 0) {
        finalText = parts.map((p: any) => p.text).filter(Boolean).join('\n');
        break;
      }

      const responseParts = [];
      for (const fc of functionCalls) {
        const { response, keyboard } = await executeFunctionCall(fc.functionCall.name, fc.functionCall.args, ctx);
        if (keyboard) pendingKeyboard = keyboard; // остання клавіатура "виграє", якщо їх декілька за хід
        responseParts.push({
          functionResponse: { name: fc.functionCall.name, response },
        });
      }
      // Примітка: роль для functionResponse у Gemini API — перевір актуальну назву в
      // офіційній документації на момент імплементації (тут використано 'function').
      contents.push({ role: 'function', parts: responseParts });
    }
  } catch (e) {
    // Раніше помилка Gemini (напр. вичерпаний ліміт запитів) просто "з'їдалась" —
    // пацієнт не отримував нічого, а причина ніде не логувалась. Тепер видно і те, і те.
    console.error('Gemini call failed:', String(e));
    finalText = 'Перепрошую, зараз технічна затримка на нашому боці. Спробуйте, будь ласка, написати ще раз за кілька хвилин.';
  }

  if (finalText) {
    await saveMessage(telegramId, 'model', finalText);
    await sendTelegramMessage(chatId, finalText, businessConnectionId, pendingKeyboard ?? undefined);
  }

  return finalText;
}

// ---------- Головний обробник ----------

Deno.serve(async (req) => {
  try {
    // Перевірка секретного токена Telegram — пропускаємо, поки TELEGRAM_WEBHOOK_SECRET не заданий (тест)
    if (TELEGRAM_WEBHOOK_SECRET) {
      const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (got !== TELEGRAM_WEBHOOK_SECRET) {
        return new Response('unauthorized', { status: 401 });
      }
    }

    const body = await req.json();

    // --- business_connection: Telegram шле це автоматично в момент підключення/
    // відключення/зміни бота до бізнес-акаунту. Без цього business_connections
    // довелось би заповнювати вручну щоразу, як бот перепідключається до нового акаунта
    // (наприклад, з тестового на реальний акаунт лікаря).
    if (body.business_connection) {
      const bc = body.business_connection;
      await supabase.from('business_connections').upsert({
        business_connection_id: bc.id,
        owner_user_id: bc.user.id,
        is_enabled: bc.is_enabled ?? true,
      });
      return new Response(JSON.stringify({ ok: true, note: 'business_connection registered' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- callback_query ---
    if (body.callback_query) {
      const cq = body.callback_query;
      const data: string = cq.data ?? '';
      const messageId: number | undefined = cq.message?.message_id;
      const telegramId: number = cq.from.id;
      const chatId: number = cq.message?.chat?.id ?? telegramId;
      const businessConnectionId: string | null = cq.business_connection_id ?? null;

      await answerCallbackQuery(cq.id); // прибрати "годинник" на кнопці в клієнті

      if (data.startsWith('slot|')) {
        // Вибір конкретного варіанту — пропускаємо через звичайний цикл LLM,
        // без окремої логіки бронювання тут (єдине джерело правди — book_appointment у циклі).
        const [, iso] = data.split('|');
        const syntheticText = `Обираю час: ${formatSlotLabel(iso)} (${iso})`;
        await processIncomingMessage(telegramId, chatId, syntheticText, businessConnectionId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('more|')) {
        const [, durationStr, startFromStr] = data.split('|');
        const duration = parseInt(durationStr, 10);
        const { data: rows, error } = await supabase.rpc('find_next_available_slots', {
          p_duration_minutes: duration,
          p_days_ahead: 3,
          p_start_from: startFromStr,
        });
        if (error || !rows || rows.length === 0) {
          await sendTelegramMessage(chatId, 'На жаль, далі вільних варіантів поки немає — напишіть, будь ласка, бажану дату текстом.', businessConnectionId, undefined, messageId);
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        const slots: string[] = rows.map((r: any) => r.slot_start);
        const lastDay = new Date(slots[slots.length - 1]);
        const nextStartFrom = new Date(lastDay);
        nextStartFrom.setDate(nextStartFrom.getDate() + 1);
        const keyboard = {
          inline_keyboard: [
            ...slots.map((s) => [{ text: formatSlotLabel(s), callback_data: `slot|${s}|${duration}` }]),
            [{ text: 'Показати ще →', callback_data: `more|${duration}|${nextStartFrom.toISOString().slice(0, 10)}` }],
          ],
        };
        await sendTelegramMessage(chatId, 'Ще варіанти:', businessConnectionId, keyboard, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('confirm|')) {
        const [, appointmentId] = data.split('|');
        await supabase
          .from('appointments')
          .update({ status: 'confirmed', reminder_status: 'confirmed' })
          .eq('id', appointmentId);
        const replyText = 'Дякуємо за підтвердження! Чекаємо на вас.';
        await saveMessage(telegramId, 'user', "[Пацієнт натиснув кнопку «Підтверджую» на нагадування про візит]");
        await saveMessage(telegramId, 'model', replyText);
        await sendTelegramMessage(chatId, replyText, businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('recall|')) {
        const [, appointmentId] = data.split('|');
        await supabase
          .from('appointments')
          .update({ reminder_status: 'callback_requested' })
          .eq('id', appointmentId);
        const replyText = 'Добре, лікар зв\'яжеться з вами найближчим часом.';
        await saveMessage(telegramId, 'user', "[Пацієнт натиснув кнопку «Перезвоніть мені» на нагадування про візит]");
        await saveMessage(telegramId, 'model', replyText);
        await sendTelegramMessage(chatId, replyText, businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('cancel|')) {
        const [, appointmentId] = data.split('|');
        const { data: cancelled } = await supabase
          .from('appointments')
          .update({ status: 'cancelled' })
          .eq('id', appointmentId)
          .select('requested_time')
          .maybeSingle();

        const whenLabel = cancelled?.requested_time ? formatSlotLabel(cancelled.requested_time) : 'ваш запис';
        const replyText = `Запис на ${whenLabel} скасовано. Якщо захочете записатись знову — просто напишіть, що вас турбує.`;
        await saveMessage(telegramId, 'user', '[Пацієнт натиснув кнопку «Скасувати»]');
        await saveMessage(telegramId, 'model', replyText);
        await sendTelegramMessage(chatId, replyText, businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data === 'main_menu') {
        await sendTelegramMessage(chatId, MAIN_MENU_TEXT, businessConnectionId, MAIN_MENU_KEYBOARD, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data === 'menu_start_booking') {
        const { data: services } = await supabase
          .from('services_kb')
          .select('category, description')
          .eq('active', true);

        const buttons = (services ?? []).map((s) => [
          { text: s.description, callback_data: `pick_service|${s.category}` },
        ]);
        buttons.push([{ text: '🤖 Не знаю, що обрати — запитати асистента', callback_data: 'menu_ask_assistant' }]);
        buttons.push([BACK_TO_MENU_BUTTON]);

        await sendTelegramMessage(chatId, 'Оберіть послугу:', businessConnectionId, { inline_keyboard: buttons }, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data === 'menu_ask_assistant') {
        const replyText = 'Звісно, розкажіть, будь ласка, що вас турбує — я поставлю кілька уточнюючих запитань і підберу зручний час.';
        await saveMessage(telegramId, 'model', replyText);
        await sendTelegramMessage(chatId, replyText, businessConnectionId, undefined, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('pick_service|')) {
        const [, category] = data.split('|');
        await sendServiceSlots(category, chatId, businessConnectionId, undefined, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('pick_more|')) {
        const [, category, startFromStr] = data.split('|');
        await sendServiceSlots(category, chatId, businessConnectionId, startFromStr, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('pick_slot|')) {
        const [, category, iso] = data.split('|');
        const patientName = cq.from.first_name ?? 'Пацієнт';

        const result = await insertAppointment(
          { patientName, serviceCategory: category, requestedTime: iso, notes: null },
          { telegramId, businessConnectionId },
        );

        if (!result.success) {
          await sendTelegramMessage(chatId, 'На жаль, цей час щойно зайняли — спробуйте, будь ласка, ще раз.', businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }

        const replyText = `${patientName}, вас записано на ${formatSlotLabel(iso)}. Нагадування прийде ближче до візиту.`;
        await saveMessage(telegramId, 'user', `[Пацієнт записався кнопками: ${category}, ${iso}]`);
        await saveMessage(telegramId, 'model', replyText);
        await sendTelegramMessage(chatId, replyText, businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data === 'menu_my_records') {
        await sendMyRecords(telegramId, chatId, businessConnectionId, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data === 'menu_contacts') {
        await sendTelegramMessage(
          chatId,
          '📍 Адреса: вулиця Благовісна, 269/4\n\n🕒 Графік роботи:\nСб, Нд — вихідні\nНепарні числа: 9:00–13:00\nПарні числа: 14:00–19:00',
          businessConnectionId,
          { inline_keyboard: [[BACK_TO_MENU_BUTTON]] },
          messageId,
        );
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('reschedule|')) {
        const [, appointmentId] = data.split('|');
        const { data: appt } = await supabase
          .from('appointments')
          .select('estimated_duration_minutes')
          .eq('id', appointmentId)
          .maybeSingle();
        const duration = appt?.estimated_duration_minutes ?? 30;

        const { data: rows, error } = await supabase.rpc('find_next_available_slots', {
          p_duration_minutes: duration,
          p_days_ahead: 3,
        });
        if (error) console.error('reschedule find_next_available_slots error:', error.message);
        if (error || !rows || rows.length === 0) {
          await sendTelegramMessage(chatId, 'На жаль, зараз немає вільних варіантів — спробуйте, будь ласка, пізніше.', businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        const slots: string[] = rows.map((r: any) => r.slot_start);
        // callback_data стисло: resched_pick|<uuid 36>|<epoch ms> — повний ISO + тривалість
        // разом з UUID виходили за ліміт Telegram у 64 байти. Тривалість перечитуємо в
        // resched_pick з appointmentId, а не тягнемо в самій кнопці.
        const keyboard = {
          inline_keyboard: [
            ...slots.map((s) => [
              { text: formatSlotLabel(s), callback_data: `resched_pick|${appointmentId}|${new Date(s).getTime()}` },
            ]),
            [BACK_TO_MENU_BUTTON],
          ],
        };
        await sendTelegramMessage(chatId, 'Оберіть новий час для цього запису:', businessConnectionId, keyboard, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      if (data.startsWith('resched_pick|')) {
        const [, appointmentId, epochStr] = data.split('|');
        const iso = new Date(Number(epochStr)).toISOString();

        const { data: appt } = await supabase
          .from('appointments')
          .select('estimated_duration_minutes')
          .eq('id', appointmentId)
          .maybeSingle();
        const duration = appt?.estimated_duration_minutes ?? 30;

        const { data: ok, error: checkError } = await supabase.rpc('check_availability', {
          requested_start: iso,
          duration_minutes: duration,
        });
        if (checkError) console.error('resched_pick check_availability error:', checkError.message);
        if (!ok) {
          await sendTelegramMessage(chatId, 'На жаль, цей час уже зайняли — спробуйте ще раз, будь ласка.', businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
          return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        const { error: updateError } = await supabase
          .from('appointments')
          .update({ requested_time: iso, reminder_status: 'none', status: 'pending' })
          .eq('id', appointmentId);
        if (updateError) console.error('resched_pick update error:', updateError.message);

        const replyText = `Запис перенесено на ${formatSlotLabel(iso)}. Нагадування прийде ближче до візиту.`;
        await saveMessage(telegramId, 'user', `[Пацієнт переніс запис на новий час: ${iso}]`);
        await saveMessage(telegramId, 'model', replyText);
        await sendTelegramMessage(chatId, replyText, businessConnectionId, { inline_keyboard: [[BACK_TO_MENU_BUTTON]] }, messageId);
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
      }

      // Невідомий префікс callback_data
      return new Response(JSON.stringify({ ok: true, note: 'unknown callback_data prefix' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isBusinessMessage = Boolean(body.business_message);
    const update = body.business_message ?? body.message;

    if (!update) {
      return new Response(JSON.stringify({ ok: true, note: 'update type not handled' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const telegramId: number = update.from.id;
    const chatId: number = update.chat.id;
    const text: string = update.text ?? '';

    // /start — показуємо меню замість того, щоб одразу вести в розмову з агентом
    if (text.trim() === '/start') {
      await sendTelegramMessage(
        chatId,
        'Вітаю! Я асистент стоматологічної клініки. Оберіть дію або просто напишіть, що вас турбує.',
        isBusinessMessage ? (body.business_connection_id ?? null) : null,
        MAIN_MENU_KEYBOARD,
      );
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }
    const businessConnectionId: string | null = isBusinessMessage
      ? (body.business_connection_id ?? null)
      : null;

    // --- Business Mode: чи це лікар пише вручну? ---
    if (isBusinessMessage && businessConnectionId) {
      const { data: conn } = await supabase
        .from('business_connections')
        .select('owner_user_id')
        .eq('business_connection_id', businessConnectionId)
        .maybeSingle();

      if (conn && conn.owner_user_id === telegramId) {
        const pausedUntil = new Date(Date.now() + 25 * 60 * 1000).toISOString();
        await supabase
          .from('agent_pauses')
          .upsert({ business_connection_id: businessConnectionId, telegram_id: telegramId, paused_until: pausedUntil });
        return new Response(JSON.stringify({ ok: true, note: 'doctor manual reply — agent paused' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const { data: pause } = await supabase
        .from('agent_pauses')
        .select('paused_until')
        .eq('business_connection_id', businessConnectionId)
        .eq('telegram_id', telegramId)
        .maybeSingle();
      if (pause && new Date(pause.paused_until) > new Date()) {
        return new Response(JSON.stringify({ ok: true, note: 'agent paused, skipping' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const finalText = await processIncomingMessage(telegramId, chatId, text, businessConnectionId);

    return new Response(JSON.stringify({ ok: true, reply: finalText }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});