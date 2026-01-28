// @ts-nocheck
import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { games, createGame, updateGame, deleteGame, profile, friends, users, createUser, updateUser, deleteUser, feedbacks, subscriptionPlans, characters, createCharacter, updateCharacter, deleteCharacter } from './db.js';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fetch as undiciFetch, ProxyAgent, FormData, File } from 'undici';
import pdfParse from 'pdf-parse';
import fs from 'fs';
import path from 'path';
import type { User } from './types';
import { getPrisma } from './prisma.js';
import type { Game } from './types';
import multer from 'multer';
import { toFile } from 'openai/uploads';
import crypto from 'crypto';

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

app.use(cors());
app.use(express.json());
process.on('unhandledRejection', (err) => {
  try { console.error('[unhandledRejection]', err); } catch {}
});
process.on('uncaughtException', (err) => {
  try { console.error('[uncaughtException]', err); } catch {}
});

function normalizeProxyUrl(raw: string): string {
  const strip = (s: string) => s.trim().replace(/^['"]+|['"]+$/g, '');
  const s = strip(raw);
  if (!s) return '';
  if (/^[a-zA-Z]+:\/\//.test(s)) return s;
  const parts = s.split(':');
  if (parts.length >= 4) {
    const [host, port, user, ...passParts] = parts;
    const pass = passParts.join(':');
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${s}`;
  return s;
}

function parseProxyList(listEnvRaw: string, singleRaw: string): string[] {
  const strip = (s: string) => s.trim().replace(/^['"]+|['"]+$/g, '');
  const listEnv = strip(listEnvRaw);
  const single = strip(singleRaw);
  const parts = [listEnv, single].filter(Boolean).join(',');
  return parts
    .split(',')
    .map((s) => normalizeProxyUrl(strip(s)))
    .filter(Boolean);
}

function parseProxies(): string[] {
  const listEnvRaw = process.env.OPENAI_PROXIES || '';
  const singleRaw = process.env.OPENAI_PROXY || process.env.HTTPS_PROXY || '';
  return parseProxyList(listEnvRaw, singleRaw);
}

function parseGeminiProxies(): string[] {
  const listEnvRaw = process.env.GEMINI_PROXIES || process.env.GOOGLE_PROXIES || '';
  const singleRaw = process.env.GEMINI_PROXY || process.env.GOOGLE_PROXY || process.env.HTTPS_PROXY || '';
  return parseProxyList(listEnvRaw, singleRaw);
}

function createProxiedFetchForGemini(proxies: string[], timeoutMs: number) {
  return (async (input: RequestInfo, init?: RequestInit) => {
    const controllers: Array<AbortController> = [];
    const attempts = proxies.length ? proxies : ['__direct__'];
    let lastErr: unknown = null;
    for (const p of attempts) {
      try {
        const controller = new AbortController();
        controllers.push(controller);
        const timer = setTimeout(() => controller.abort(), Math.max(120000, timeoutMs));
        const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
        const res = await undiciFetch(input as any, { 
          ...(init as any), 
          dispatcher, 
          signal: controller.signal,
          headers: {
            ...(init?.headers as any),
            'Content-Type': 'application/json'
          }
        });
        clearTimeout(timer);
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('All Gemini proxy attempts failed');
  }) as unknown as typeof fetch;
}

function createProxiedFetchForOpenAI(proxies: string[], timeoutMs: number) {
  return (async (input: RequestInfo, init?: RequestInit) => {
    const controllers: Array<AbortController> = [];
    const attempts = proxies.length ? proxies : ['__direct__'];
    let lastErr: unknown = null;
    for (const p of attempts) {
      try {
        const controller = new AbortController();
        controllers.push(controller);
        const timer = setTimeout(() => controller.abort(), Math.max(60000, timeoutMs));
        const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
        const res = await undiciFetch(input as any, { ...(init as any), dispatcher, signal: controller.signal });
        clearTimeout(timer);
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('All OpenAI proxy attempts failed');
  }) as unknown as typeof fetch;
}

function createOpenAIClient(apiKey: string) {
  const proxies = parseProxies();
  const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 15000);
  if (proxies.length) {
    const proxiedFetch = createProxiedFetchForOpenAI(proxies, timeoutMs);
    return new OpenAI({ apiKey, fetch: proxiedFetch });
  }
  return new OpenAI({ apiKey });
}

const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/server/uploads';
const PDF_DIR = path.join(UPLOAD_DIR, 'pdfs'); // Директория для хранения PDF файлов
try { 
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(PDF_DIR, { recursive: true });
} catch {}

// Для обычных загрузок используем memoryStorage
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { 
    fileSize: 100 * 1024 * 1024, // 100MB per file (достаточно для больших PDF)
    files: 10 // max 10 files
  } 
});

// Для PDF файлов используем diskStorage
const uploadPdf = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, PDF_DIR);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      const ext = path.extname(file.originalname || '');
      cb(null, `pdf-${uniqueSuffix}${ext}`);
    }
  }),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB
    files: 10
  }
});

app.use('/uploads', express.static(UPLOAD_DIR));

// Прегенерация удалена - используем только streaming TTS

// Функция для нормализации текста для сравнения по смыслу
// Убирает лишние пробелы, приводит к нижнему регистру, нормализует знаки препинания
function normalizeTextForComparison(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ') // Множественные пробелы в один
    .replace(/[.,!?;:]/g, '') // Убираем знаки препинания
    .replace(/["«»„"]/g, '"') // Нормализуем кавычки
    .replace(/[-—]/g, '-') // Нормализуем дефисы
    .trim();
}

// Функция для поиска похожих прегенерированных файлов по смыслу
// Проверяет не только точное совпадение, но и нормализованные варианты
// Функция для проверки наличия прегенерованных материалов для scenarioGameId
// Прегенерация удалена - используем только streaming TTS

// Парсит варианты выбора из текста (формат: "1. Вариант 1\n2. Вариант 2" или "- Вариант 1\n- Вариант 2")
function parseChoiceOptions(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  
  const choices: string[] = [];
  const lines = text.split('\n');
  
  for (const line of lines) {
    // Ищем нумерованные варианты: "1. Вариант", "2. Вариант"
    const numberedMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numberedMatch) {
      choices.push(numberedMatch[1].trim());
      continue;
    }
    
    // Ищем варианты с дефисом: "- Вариант", "— Вариант"
    const dashMatch = line.match(/^\s*[-—]\s+(.+)$/);
    if (dashMatch) {
      choices.push(dashMatch[1].trim());
      continue;
    }
  }
  
  return choices.filter(Boolean);
}

// -------------------- AI Prompts (runtime editable) --------------------
type AiPrompts = {
  system: string;
};
const AI_PROMPTS_FILE = path.resolve(process.cwd(), 'scripts', 'ai_prompts.json');
const DEFAULT_SYSTEM_PROMPT =
  'Ты — опытный мастер (DM) настольной ролевой игры Dungeons & Dragons 5-й редакции. ' +
  'Твоя задача — вести игроков через ЕДИНЫЙ БЕСШОВНЫЙ МИР. ' +
  'ОСОБЕННОСТИ ТВОЕЙ РАБОТЫ: ' +
  '1. МИР: Не воспринимай локации как изолированные комнаты. Это части одного большого мира. Переходы между ними должны быть плавными и описываться как движение персонажа. ' +
  '2. ПЕРСОНАЖИ: КРИТИЧЕСКИ ВАЖНО - Используй ТОЛЬКО данные об игровых персонажах из базы данных! В контексте указаны имена, классы, расы, характеристики, способности и оружие персонажей. НЕ придумывай новых персонажей, оружие, классы или расы. Используй ТОЛЬКО то, что указано в контексте. КРИТИЧЕСКИ ВАЖНО: Всегда используй ПОЛНОЕ имя персонажа целиком (все слова, не только первое!). Если имя "Сара Конор Младшая" - используй все три слова, а не только "Сара". НИКОГДА не сокращай имена персонажей до первого слова. Подбирай оружие и экипировку согласно классу и расе персонажа из базы данных. Если персонаж - маг, используй его магические способности из abilities. Если воин - его оружие и боевые навыки из abilities. ' +
  '3. ПРАВИЛА: Строго соблюдай правила D&D 5e. Используй характеристики персонажей (STR, DEX, CON, INT, WIS, CHA), классы и навыки. ' +
  'КРИТИЧЕСКИ ВАЖНО: ИГРАЙ СТРОГО ПО СЦЕНАРИЮ! ' +
  'СЦЕНАРИЙ - это ОСНОВНОЙ ИСТОЧНИК информации. Правила мира и правила процесса - это только ВСПОМОГАТЕЛЬНЫЙ контекст для понимания механик. ' +
  'Если в сценарии указано что-то конкретное - используй ЭТО, а не общие правила D&D. ' +
  'Например, если в сценарии написано "В этой локации находится алтарь с рунами" - используй ЭТО, а не общее описание алтарей из правил. ' +
  'Правила нужны только для понимания механик (броски кубиков, характеристики, бой), но сюжет и локации бери ИЗ СЦЕНАРИЯ. ' +
  '3. ПРОВЕРКИ: Для любых действий, исход которых не очевиден, запрашивай проверки характеристик (d20 + модификатор). Модификатор = (характеристика-10)/2. ' +
  '4. СПАСБРОСКИ: При опасностях запрашивай спасброски (STR/DEX/CON/INT/WIS/CHA) и учитывай их результат. ' +
  '5. ПРЕИМУЩЕСТВО/ПОМЕХА: Если условия дают преимущество или помеху, явно указывай это при броске d20. ' +
  '6. БОЙ: В случае конфликта инициируй бросок инициативы, рассчитывай попадания (бросок атаки против AC цели) и урон (согласно оружию/заклинанию). Учитывай крит на нат.20. ' +
  '7. ПАМЯТЬ: Ты работаешь с расширенным контекстом Gemini — помни всё состояние мира, инвентарь, HP и предысторию персонажей. ' +
  'ВАЖНО: Когда описываешь изменения HP, урон или лечение, используй явные формулировки: "Персонаж теряет X HP", "Персонаж восстанавливает X HP", "Урон: X HP". ' +
  'Система автоматически отслеживает и обновляет состояние персонажей на основе твоих описаний. ' +
  'СОСТОЯНИЯ: Состояния (отравление, паралич, оглушение и т.д.) имеют реальные эффекты: отравление причиняет урон каждый ход, паралич блокирует действия, оглушение дает помеху на проверки. ' +
  'Используй состояния осознанно и описывай их применение. Для снятия состояний используй: "Персонаж излечен от отравления", "Лечение снимает паралич", "Отдых восстанавливает силы". ' +
  '8. СТИЛЬ: Пиши атмосферно, кинематографично и живо, но КРАТКО. Описывай звуки, запахи и ощущения сжато, без избыточных деталей. ' +
  '9. ОГРАНИЧЕНИЯ: Не создавай новые ключевые локации, если их нет в сценарии, но можешь описывать путь между ними. ' +
  '10. ФОРМАТ И ДЛИНА: КРИТИЧЕСКИ ВАЖНО — отвечай КРАТКО! Максимум 3 коротких абзаца (по 3-4 строки каждый, всего не более 10-12 строк текста). Избегай длинных описаний, повторов и избыточных деталей. Будь лаконичен и конкретен. В конце выводи доступные действия.\n' +
  '11. ВАРИАНТЫ ВЫБОРА: НЕ обязательно включать реальные выходы из локации в КАЖДЫЙ ответ - можешь предлагать диалоговые/ситуативные варианты (например, "Спросить о чем-то", "Осмотреть детальнее", "Попробовать что-то сделать"). НО важно, чтобы ветка диалога периодически (раз в 5-10 сцен) вела к реальному выходу из локации - включай реальные выходы естественным образом, когда это логично по сюжету. Если включаешь реальные выходы - они должны быть ПЕРВЫМИ в списке. Форматируй варианты ТОЛЬКО нумерованным списком (1. Вариант, 2. Вариант), БЕЗ звездочек.\n' +
  '12. ПРОВЕРКИ: Если ситуация требует броска кубиков, добавь в самый конец сообщения скрытый тег формата: [[ROLL: skill_or_attack_or_save, DC: 15]]. Это вызовет окно броска у игрока (для атаки DC=AC).\n' +
  '13. ГРУППА: В игре всегда 5 персонажей. Если живых игроков меньше, ты сам управляешь остальными персонажами как союзными NPC, делая за них ходы, броски и принимая решения в бою.';
let aiPrompts: AiPrompts = { system: DEFAULT_SYSTEM_PROMPT };
try {
  if (fs.existsSync(AI_PROMPTS_FILE)) {
    const raw = fs.readFileSync(AI_PROMPTS_FILE, 'utf8');
    const json = JSON.parse(raw);
    if (json && typeof json.system === 'string' && json.system.trim()) {
      aiPrompts.system = json.system;
    }
  }
} catch {}
function getSysPrompt(): string {
  return aiPrompts.system || DEFAULT_SYSTEM_PROMPT;
}

/**
 * Форматирует варианты выбора: преобразует звездочки в нумерованный список
 * Пример: "* Вариант 1\n* Вариант 2" → "1. Вариант 1\n2. Вариант 2"
 */
function formatChoiceOptions(text: string): string {
  if (!text || typeof text !== 'string') return text;
  
  // Ищем блоки с вариантами выбора (строки, начинающиеся с * или •)
  // Паттерн: начало строки или новая строка, опциональные пробелы, звездочка или bullet, пробел, текст до конца строки
  const lines = text.split('\n');
  const formattedLines: string[] = [];
  let inChoiceBlock = false;
  let choiceNumber = 1;
  let choiceBlockStart = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Проверяем, является ли строка вариантом выбора (начинается с * или •)
    const choiceMatch = line.match(/^(\s*)[*•]\s+(.+)$/);
    
    if (choiceMatch) {
      // Начало блока вариантов
      if (!inChoiceBlock) {
        inChoiceBlock = true;
        choiceNumber = 1;
        choiceBlockStart = formattedLines.length;
      }
      // Добавляем нумерованный вариант
      const indent = choiceMatch[1]; // Сохраняем отступ
      const choiceText = choiceMatch[2].trim();
      formattedLines.push(`${indent}${choiceNumber}. ${choiceText}`);
      choiceNumber++;
    } else {
      // Если была серия вариантов и теперь пустая строка или другой текст - завершаем блок
      if (inChoiceBlock) {
        inChoiceBlock = false;
        choiceNumber = 1;
      }
      formattedLines.push(line);
    }
  }
  
  return formattedLines.join('\n');
}

/**
 * Универсальная функция для добавления реальных выходов из локации в варианты выбора
 * Добавляет реальные выходы только если прошло 5-10 сцен без реальных выходов
 */
async function ensureRealExitsInChoices(
  prisma: ReturnType<typeof getPrisma>,
  text: string,
  locationId: string | undefined | null,
  gameId: string | undefined,
  session: any | null = null // Передаем сессию для отслеживания счетчика
): Promise<{ text: string; shouldUpdateSession: boolean; sessionState: any; scenesWithoutRealExit?: number; realExitThreshold?: number; shouldSuggestRealExits?: boolean }> {
  const result = { text, shouldUpdateSession: false, sessionState: null as any, scenesWithoutRealExit: undefined as number | undefined, realExitThreshold: undefined as number | undefined, shouldSuggestRealExits: false as boolean };
  
  if (!locationId || !gameId) return result;
  
  try {
    // Получаем реальные выходы (BUTTON с targetLocationId, не GAMEOVER)
    const allExits = await prisma.locationExit.findMany({ where: { locationId } });
    const realExits = allExits.filter((e: any) => e.type === 'BUTTON' && e.targetLocationId && !e.isGameOver);
    
    if (realExits.length === 0) return result; // Нет реальных выходов - ничего не добавляем
    
    // Парсим варианты выбора из текста
    const choices = parseChoiceOptions(text);
    
    // Проверяем, есть ли реальные выходы в вариантах
    const realExitTexts = realExits.map(e => (e.buttonText || e.triggerText || '').toLowerCase().trim()).filter(Boolean);
    const hasRealExitInChoices = realExitTexts.some(exitText => 
      choices.some(choice => {
        const choiceLower = choice.toLowerCase();
        return choiceLower.includes(exitText) || exitText.includes(choiceLower) || 
               choiceLower === exitText || exitText === choiceLower;
      })
    );
    
    // Получаем или инициализируем счетчик сцен без реальных выходов
    let state = session?.state as any || {};
    if (!state.scenesWithoutRealExit) state.scenesWithoutRealExit = 0;
    
    // Рандомизируем порог один раз и сохраняем в state до перехода
    // Генерируем новый порог только если его еще нет в state
    if (!state.realExitThreshold) {
      state.realExitThreshold = Math.floor(Math.random() * 6) + 5; // 5-10 сцен
      result.shouldUpdateSession = true;
      result.sessionState = state;
      console.log(`[ensureRealExitsInChoices] 🎲 Generated new threshold: ${state.realExitThreshold} scenes`);
    }
    const threshold = state.realExitThreshold;
    
    // Увеличиваем счетчик сцен без реальных выходов
    state.scenesWithoutRealExit = (state.scenesWithoutRealExit || 0) + 1;
    result.shouldUpdateSession = true;
    result.sessionState = state;
    
    // Используем сохраненный порог из state
    const shouldAddRealExits = state.scenesWithoutRealExit >= threshold;
    
    // КРИТИЧЕСКИ ВАЖНО: Если реальные выходы уже есть в вариантах И мы НЕ достигли порога - удаляем их все
    // Оставляем только диалоговые/ситуативные варианты от ИИ
    // Реальные выходы добавляем принудительно только когда достигнут порог
    if (hasRealExitInChoices && !shouldAddRealExits) {
      // Удаляем все реальные выходы из вариантов, оставляем только диалоговые
      const filteredChoices = choices.filter(choice => {
        const choiceLower = choice.toLowerCase();
        const isRealExit = realExitTexts.some(exitText => 
          choiceLower.includes(exitText) || exitText.includes(choiceLower) || 
          choiceLower === exitText || exitText === choiceLower
        );
        return !isRealExit; // Оставляем только НЕ реальные выходы
      });
      
      if (filteredChoices.length > 0) {
        // Перестраиваем текст с новыми вариантами (без реальных выходов)
        const choiceMatch = text.match(/(\n\n\*\*.*[?]\s*\*\*\s*\n\n|\n\n)(\d+\.\s+[^\n]+(?:\n\d+\.\s+[^\n]+)*)/);
        if (choiceMatch) {
          const newChoiceLines = filteredChoices.map((choice, idx) => `${idx + 1}. ${choice}`).join('\n');
          text = text.replace(choiceMatch[2], newChoiceLines);
        } else {
          // Если не нашли место с вариантами - добавляем в конец
          const newChoiceLines = filteredChoices.map((choice, idx) => `${idx + 1}. ${choice}`).join('\n');
          if (text.match(/\*\*.*[?]\s*\*\*/i) || text.match(/Что вы делаете/i) || text.match(/Что делать/i)) {
            text = text.replace(/\*\*.*[?]\s*\*\*/gi, '').trim();
            text = text + '\n\n**Что вы делаете?**\n\n' + newChoiceLines;
          } else {
            text = text + '\n\n**Что вы делаете?**\n\n' + newChoiceLines;
          }
        }
        
        result.text = text;
      }
      
      console.log(`[ensureRealExitsInChoices] ⏳ Scenes without real exits: ${state.scenesWithoutRealExit}/${threshold} (removed real exits from choices, will add when threshold reached)`);
      return result;
    }
    
    // Сохраняем информацию о счетчике и пороге для передачи в промпт ИИ
    result.scenesWithoutRealExit = state.scenesWithoutRealExit;
    result.realExitThreshold = threshold;
    result.shouldSuggestRealExits = shouldAddRealExits; // Флаг для промпта
    
    if (shouldAddRealExits) {
      console.log(`[ensureRealExitsInChoices] ⚠️ Threshold reached: ${state.scenesWithoutRealExit}/${threshold} scenes - AI should suggest real exits more often`);
    } else {
      console.log(`[ensureRealExitsInChoices] ⏳ Scenes without real exits: ${state.scenesWithoutRealExit}/${threshold} (AI will suggest real exits more often when threshold reached)`);
    }
    
    result.text = text;
  } catch (e) {
    console.warn('[ensureRealExitsInChoices] Failed to add real exits:', e);
  }
  
  return result;
}
app.get('/api/admin/ai-prompts', async (_req, res) => {
  return res.json({ system: getSysPrompt() });
});
app.post('/api/admin/ai-prompts', async (req, res) => {
  try {
    const system = typeof req.body?.system === 'string' ? req.body.system.trim() : '';
    if (!system || system.length < 20) return res.status(400).json({ error: 'system_prompt_too_short' });
    aiPrompts.system = system;
    try {
      fs.mkdirSync(path.dirname(AI_PROMPTS_FILE), { recursive: true });
      fs.writeFileSync(AI_PROMPTS_FILE, JSON.stringify({ system }, null, 2), 'utf8');
    } catch {}
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'failed_to_save_prompts' });
  }
});
app.get('/', (_req, res) => {
  res.type('text/plain').send('MIRA API. Health: /api/health, Games: /api/games, Profile: /api/profile');
});

app.post('/api/debug/openai', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    if (!apiKey) return res.json({ ok: false, reason: 'no_api_key' });
    const client = createOpenAIClient(apiKey);
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const r = await client.chat.completions.create({
      model,
      temperature: 0.0,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Проверка соединения. Ответь коротко: ОК.' }],
    });
    const text = r.choices?.[0]?.message?.content?.trim() || '';
    return res.json({ ok: true, model, text });
  } catch (e: any) {
    return res.json({
      ok: false,
      error: (e && (e.stack || e.message)) || String(e),
      code: e?.code,
      status: e?.status,
      details: e,
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/games', async (_req, res) => {
  try {
    const prisma = getPrisma();
    const list = await prisma.game.findMany({
      where: { status: 'PUBLISHED' as any },
      select: { id: true, title: true, description: true, rating: true, tags: true, author: true, coverUrl: true }
    });
    res.json(list);
  } catch {
    res.json(games.map(({ rules, gallery, editions, ...short }) => short));
  }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const game = await prisma.game.findUnique({ where: { id: req.params.id }, include: { editions: true, locations: { orderBy: { order: 'asc' } }, characters: true } });
    if (!game) return res.status(404).json({ error: 'Not found' });
    res.json({ ...game, editions: game.editions });
  } catch {
    const game = games.find((g) => g.id === req.params.id);
    if (!game) return res.status(404).json({ error: 'Not found' });
    res.json(game);
  }
});

app.post('/api/games', async (req, res) => {
  try {
    const prisma = getPrisma();
    const created = await prisma.game.create({
      data: {
        title: req.body.title,
        description: req.body.description ?? '',
        rating: req.body.rating ?? 5,
        tags: req.body.tags ?? [],
        author: req.body.author ?? 'Автор',
        coverUrl: req.body.coverUrl ?? '',
        rules: req.body.rules ?? '',
        gallery: req.body.gallery ?? [],
        worldRules: req.body.worldRules,
        gameplayRules: req.body.gameplayRules,
        vkVideoUrl: req.body.vkVideoUrl,
        promoDescription: req.body.promoDescription,
        marketplaceLinks: req.body.marketplaceLinks ?? [],
        shelfCategory: req.body.shelfCategory,
        shelfPosition: req.body.shelfPosition,
        bannerStyle: req.body.bannerStyle,
        ageRating: req.body.ageRating,
        authorUserId: req.body.authorUserId,
        status: req.body.status || 'DRAFT',
        winCondition: req.body.winCondition,
        loseCondition: req.body.loseCondition,
        deathCondition: req.body.deathCondition,
        finalScreenUrl: req.body.finalScreenUrl,
      },
    });
    res.status(201).json(created);
  } catch {
    const created = createGame(req.body);
    res.status(201).json(created);
  }
});

app.patch('/api/games/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.game.update({ where: { id: req.params.id }, data: req.body });
    res.json(updated);
  } catch {
    const updated = updateGame(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  }
});

app.delete('/api/games/:id', async (req, res) => {
  const gameId = req.params.id;
  try {
    const prisma = getPrisma();
    
    // Устанавливаем флаг остановки для всех активных задач генерации этой игры
    generationStopFlags.set(gameId, true);
    console.log(`[GAME-DELETE] Stopping all generation tasks for game ${gameId}`);
    
    // Удаляем игру из БД
    await prisma.game.delete({ where: { id: gameId } });
    
    // Удаляем все прегенерированные файлы игры
    // Прегенерация удалена - нечего удалять
    
    // Флаг остановки оставляем установленным, чтобы активные генерации могли его проверить и остановиться
    // Он будет удален автоматически при следующем запуске генерации для этой игры (если она будет создана заново)
    
    res.status(204).end();
  } catch {
    const ok = deleteGame(gameId);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    
    // Устанавливаем флаг остановки
    generationStopFlags.set(gameId, true);
    
    // Прегенерация удалена - нечего удалять
    
    // Флаг остановки оставляем установленным, чтобы активные генерации могли его проверить и остановиться
    res.status(204).end();
  }
});

app.get('/api/admin/games', async (_req, res) => {
  try {
    const prisma = getPrisma();
    const list = await prisma.game.findMany({ select: { id: true, title: true, description: true, rating: true, tags: true, author: true, coverUrl: true, status: true, createdAt: true } });
    return res.json(list);
  } catch {
    return res.json(games.map(({ rules, gallery, editions, ...short }) => ({ ...short, status: 'PUBLISHED', createdAt: new Date().toISOString() })));
  }
});

app.get('/api/admin/games/:id/full', async (req, res) => {
  try {
    const prisma = getPrisma();
    const game = await prisma.game.findUnique({
      where: { id: req.params.id },
      include: {
        editions: true,
        locations: {
          orderBy: { order: 'asc' },
          include: { exits: true },
        },
        characters: true,
      },
    });
    if (!game) return res.status(404).json({ error: 'Not found' });
    return res.json(game);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_load', details: String(e) });
  }
});

app.patch('/api/admin/games/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.game.update({ where: { id: req.params.id }, data: req.body });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_update', details: String(e) });
  }
});

app.get('/api/games/:id/locations', async (req, res) => {
  try {
    const prisma = getPrisma();
    const list = await prisma.location.findMany({ where: { gameId: req.params.id }, orderBy: { order: 'asc' } });
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_list', details: String(e) });
  }
});
app.post('/api/games/:id/locations', async (req, res) => {
  try {
    const prisma = getPrisma();
    const maxOrder = await prisma.location.aggregate({ _max: { order: true }, where: { gameId: req.params.id } });
    const created = await prisma.location.create({
      data: {
        gameId: req.params.id,
        order: (maxOrder._max.order || 0) + 1,
        title: req.body.title || 'Новая локация',
        description: req.body.description,
        rulesPrompt: req.body.rulesPrompt,
        backgroundUrl: req.body.backgroundUrl,
        layout: req.body.layout,
        musicUrl: req.body.musicUrl,
      },
    });
    return res.status(201).json(created);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_create', details: String(e) });
  }
});
app.patch('/api/locations/:locId', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.location.update({ where: { id: req.params.locId }, data: req.body });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_update', details: String(e) });
  }
});
app.delete('/api/locations/:locId', async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.location.delete({ where: { id: req.params.locId } });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_delete', details: String(e) });
  }
});

app.get('/api/locations/:locId/exits', async (req, res) => {
  try {
    const prisma = getPrisma();
    const list = await prisma.locationExit.findMany({ where: { locationId: req.params.locId } });
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_list_exits', details: String(e) });
  }
});
app.get('/api/games/:id/exits', async (req, res) => {
  try {
    const prisma = getPrisma();
    // 1) Находим все локации игры
    const locs = await prisma.location.findMany({ where: { gameId: req.params.id }, select: { id: true } });
    const ids = locs.map((l) => l.id);
    // 2) Если нет локаций — пусто
    if (!ids.length) return res.json([]);
    // 3) Все выходы по этим локациям
    const list = await prisma.locationExit.findMany({
      where: { locationId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    });
    return res.json(list);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_list_game_exits', details: String(e) });
  }
});
app.post('/api/locations/:locId/exits', async (req, res) => {
  try {
    const prisma = getPrisma();
    const created = await prisma.locationExit.create({
      data: {
        locationId: req.params.locId,
        type: req.body?.type || 'BUTTON',
        buttonText: req.body?.buttonText || null,
        triggerText: req.body?.triggerText || null,
        targetLocationId: req.body?.targetLocationId || null,
        isGameOver: Boolean(req.body?.isGameOver),
      },
    });
    return res.status(201).json(created);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_create_exit', details: String(e) });
  }
});
app.patch('/api/exits/:exitId', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.locationExit.update({
      where: { id: req.params.exitId },
      data: {
        type: req.body?.type,
        buttonText: req.body?.buttonText,
        triggerText: req.body?.triggerText,
        targetLocationId: req.body?.targetLocationId,
        isGameOver: req.body?.isGameOver,
      },
    });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_update_exit', details: String(e) });
  }
});
app.delete('/api/exits/:exitId', async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.locationExit.delete({ where: { id: req.params.exitId } });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_delete_exit', details: String(e) });
  }
});

app.get('/api/games/:id/editions', async (req, res) => {
  try {
    const prisma = getPrisma();
    const items = await prisma.edition.findMany({ where: { gameId: req.params.id } });
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_list_editions' });
  }
});
app.post('/api/games/:id/editions', async (req, res) => {
  try {
    const prisma = getPrisma();
    const created = await prisma.edition.create({
      data: {
        gameId: req.params.id,
        name: req.body?.name || 'Издание',
        description: req.body?.description || '',
        price: Number(req.body?.price || 0),
        badge: req.body?.badge || null,
      },
    });
    return res.status(201).json(created);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_create_edition' });
  }
});
app.patch('/api/editions/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.edition.update({
      where: { id: req.params.id },
      data: {
        name: req.body?.name,
        description: req.body?.description,
        price: typeof req.body?.price === 'number' ? req.body.price : undefined,
        badge: req.body?.badge,
      },
    });
    return res.json(updated);
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_update_edition' });
  }
});
app.delete('/api/editions/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.edition.delete({ where: { id: req.params.id } });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_delete_edition' });
  }
});

app.post('/api/admin/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'file_required' });
    const kindRaw = typeof req.body?.kind === 'string' ? req.body.kind : '';
    let detected: 'image' | 'audio' | 'video' = 'image';
    if (req.file.mimetype.startsWith('audio/')) detected = 'audio';
    if (req.file.mimetype.startsWith('video/')) detected = 'video';
    const kind = (['image', 'audio', 'video'] as const).includes(kindRaw as any) ? (kindRaw as 'image' | 'audio' | 'video') : detected;
    const ext = (() => {
      const fromName = (req.file.originalname || '').split('.').pop() || '';
      const safe = fromName.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();
      if (safe) return '.' + safe;
      if (req.file.mimetype.startsWith('image/')) return '.png';
      if (req.file.mimetype === 'audio/mpeg') return '.mp3';
      if (req.file.mimetype === 'audio/ogg' || req.file.mimetype === 'audio/ogg; codecs=opus') return '.ogg';
      if (req.file.mimetype.startsWith('video/')) return '.mp4';
      return '';
    })();
    const fname = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const dir = path.join(UPLOAD_DIR, kind);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const full = path.join(dir, fname);
    fs.writeFileSync(full, Buffer.from(req.file.buffer));
    const urlPath = `/uploads/${kind}/${fname}`;
    return res.status(201).json({ url: urlPath, kind, size: req.file.size });
  } catch (e) {
    return res.status(500).json({ error: 'upload_failed', details: String(e) });
  }
});

// Улучшенный парсер карточек персонажей из PDF
// Поддерживает:
// 1. Формат Long Story Short (карточки персонажей) - формат: ИМЯ ПЕРСОНАЖА, КЛАСС И УРОВЕНЬ, характеристики
// 2. Формат "Приложение В. Статистика НИП" - структурированные блоки с характеристиками
// 3. Стандартные карточки D&D 5e
function parseCharacterCards(srcText: string): Array<any> {
  const chars: any[] = [];
  
  // ВАРИАНТ 1: Формат Long Story Short (карточки персонажей)
  // Ищем блоки с форматом: ИМЯ ПЕРСОНАЖА | КЛАСС И УРОВЕНЬ | РАСА | МИРОВОЗЗРЕНИЕ
  const lssPattern = /ИМЯ ПЕРСОНАЖА[\s\S]{0,200}?КЛАСС И УРОВЕНЬ[\s\S]{0,500}?РАСА[\s\S]{0,500}?Мудрость[\s\S]{0,300}?БАЗОВАЯ ХАРАКТЕРИСТИКА ЗАКЛИНАНИЙ[\s\S]{0,200}?(\d+)[\s\S]{0,500}?СЛОЖНОСТЬ СПАСБРОСКА[\s\S]{0,200}?(\d+)/gi;
  let lssMatch;
  const lssBlocks: Array<{ start: number; end: number; text: string }> = [];
  while ((lssMatch = lssPattern.exec(srcText)) !== null) {
    const start = Math.max(0, lssMatch.index - 500);
    const end = Math.min(srcText.length, lssMatch.index + lssMatch[0].length + 2000);
    lssBlocks.push({ start, end, text: srcText.slice(start, end) });
  }
  
  for (const block of lssBlocks) {
    const blockText = block.text;
    
    // Извлекаем имя персонажа
    const nameMatch = blockText.match(/ИМЯ ПЕРСОНАЖА\s*\n\s*\|[^\n]+\|\s*\n\s*\|[^\n]+\|\s*\n\s*([А-Яа-яЁёA-Za-z\s]{2,50})/i);
    if (!nameMatch) continue;
    const name = nameMatch[1]?.trim();
    if (!name || name.length < 2) continue;
    
    // Извлекаем класс и уровень
    const classLevelMatch = blockText.match(/КЛАСС И УРОВЕНЬ[\s\S]{0,200}?([А-Яа-яЁёA-Za-z\s]+)[\s\S]{0,100}?(?:Уровень|Level|Ур\.)[:\s]*(\d+)/i) || 
                          blockText.match(/([А-Яа-яЁёA-Za-z\s]+)\s+(\d+)\s+уровн/i);
    const className = classLevelMatch?.[1]?.trim() || null;
    const level = parseInt(classLevelMatch?.[2] || '1', 10);
    
    // Извлекаем расу
    const raceMatch = blockText.match(/РАСА[\s\S]{0,200}?([А-Яа-яЁёA-Za-z\s]+)/i);
    const race = raceMatch?.[1]?.trim() || null;
    
    // Извлекаем базовую характеристику заклинаний (WIS для друида)
    const spellAbilityMatch = blockText.match(/БАЗОВАЯ ХАРАКТЕРИСТИКА ЗАКЛИНАНИЙ[\s\S]{0,200}?(\d+)/i);
    const spellAbility = parseInt(spellAbilityMatch?.[1] || '13', 10);
    
    // Извлекаем характеристики из таблиц или текста
    // Ищем паттерны типа "STR 10", "СИЛ 12", "Сила: 14"
    const strMatch = blockText.match(/(?:STR|СИЛ|Сила)[:\s]+(\d+)/i);
    const dexMatch = blockText.match(/(?:DEX|ЛОВ|Ловкость)[:\s]+(\d+)/i);
    const conMatch = blockText.match(/(?:CON|ТЕЛ|Телосложение)[:\s]+(\d+)/i);
    const intMatch = blockText.match(/(?:INT|ИНТ|Интеллект)[:\s]+(\d+)/i);
    const wisMatch = blockText.match(/(?:WIS|МДР|Мудрость)[:\s]+(\d+)/i);
    const chaMatch = blockText.match(/(?:CHA|ХАР|Харизма)[:\s]+(\d+)/i);
    
    // Извлекаем HP и AC
    const hpMatch = blockText.match(/(?:HP|ХП|Хиты)[:\s]+(\d+)\/?(\d+)?/i);
    const acMatch = blockText.match(/(?:AC|КД|Класс[^\n]*брони)[:\s]+(\d+)/i);
    
    // Определяем, игровой персонаж или NPC
    // В формате LSS обычно это игровые персонажи
    const isPlayable = !/(?:НИП|NPC|неигровой|враг|противник|enemy|cultist|mimic)/i.test(blockText);
    
    const char = {
      name,
      isPlayable,
      race: race || null,
      gender: blockText.match(/(?:женщина|женский|female|мужчина|мужской|male)/i)?.[0] || null,
      level: isNaN(level) ? 1 : level,
      class: className || null,
      hp: hpMatch ? parseInt(hpMatch[1] || '10', 10) : 10,
      maxHp: hpMatch ? parseInt(hpMatch[2] || hpMatch[1] || '10', 10) : 10,
      ac: acMatch ? parseInt(acMatch[1] || '10', 10) : 10,
      str: strMatch ? parseInt(strMatch[1] || '10', 10) : 10,
      dex: dexMatch ? parseInt(dexMatch[1] || '10', 10) : 10,
      con: conMatch ? parseInt(conMatch[1] || '10', 10) : 10,
      int: intMatch ? parseInt(intMatch[1] || '10', 10) : 10,
      wis: wisMatch ? parseInt(wisMatch[1] || spellAbility, 10) : spellAbility,
      cha: chaMatch ? parseInt(chaMatch[1] || '10', 10) : 10,
      role: isPlayable ? 'Игровой персонаж' : 'NPC',
      persona: blockText.match(/ПРЕДЫСТОРИЯ ПЕРСОНАЖА[\s\S]{0,2000}/i)?.[0]?.slice(0, 1000) || null,
    };
    
    // Добавляем только если есть реальные данные (не все значения по умолчанию)
    if (name && (className || strMatch || dexMatch || conMatch || intMatch || wisMatch || chaMatch || hpMatch || acMatch)) {
      chars.push(char);
    }
  }
  
  // ВАРИАНТ 2: Структурированные карточки D&D 5e с характеристиками
  if (chars.length === 0) {
    const cardPatterns = [
    // Формат: Имя\nУровень: X, Класс: Y\nHP: A/B, AC: C\nSTR: D, DEX: E, CON: F, INT: G, WIS: H, CHA: I
    /([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z\s]{2,40})\s*\n[^\n]*(?:Уровень|Level|Ур\.)[:\s]+(\d+)[^\n]*(?:Класс|Class)[:\s]+([А-Яа-яЁёA-Za-z\s]+)[^\n]*(?:HP|ХП|Хиты)[:\s]+(\d+)\/?(\d+)?[^\n]*(?:AC|КД|Класс[^\n]*брони)[:\s]+(\d+)[^\n]*(?:STR|СИЛ|Сила)[:\s]+(\d+)[^\n]*(?:DEX|ЛОВ|Ловкость)[:\s]+(\d+)[^\n]*(?:CON|ТЕЛ|Телосложение)[:\s]+(\d+)[^\n]*(?:INT|ИНТ|Интеллект)[:\s]+(\d+)[^\n]*(?:WIS|МДР|Мудрость)[:\s]+(\d+)[^\n]*(?:CHA|ХАР|Харизма)[:\s]+(\d+)/gis,
    // Формат: Имя (Уровень X Класс)\nHP A/B AC C\nSTR D DEX E CON F INT G WIS H CHA I
    /([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z\s]{2,40})\s*\([^\n]*(?:Ур\.|Уровень|Level)\s*(\d+)[^\n]*(?:Класс|Class)[:\s]*([А-Яа-яЁёA-Za-z\s]+)[^\n]*\)[^\n]*(?:HP|ХП)[:\s]*(\d+)\/?(\d+)?[^\n]*(?:AC|КД)[:\s]*(\d+)[^\n]*(?:STR|СИЛ)[:\s]*(\d+)[^\n]*(?:DEX|ЛОВ)[:\s]*(\d+)[^\n]*(?:CON|ТЕЛ)[:\s]*(\d+)[^\n]*(?:INT|ИНТ)[:\s]*(\d+)[^\n]*(?:WIS|МДР)[:\s]*(\d+)[^\n]*(?:CHA|ХАР)[:\s]*(\d+)/gis,
  ];
  
  for (const pattern of cardPatterns) {
    let match;
    while ((match = pattern.exec(srcText)) !== null && chars.length < 20) {
      const name = match[1]?.trim();
      const level = parseInt(match[2] || '1', 10);
      const className = match[3]?.trim();
      const hp = parseInt(match[4] || '10', 10);
      const maxHp = parseInt(match[5] || match[4] || '10', 10);
      const ac = parseInt(match[6] || '10', 10);
      const str = parseInt(match[7] || '10', 10);
      const dex = parseInt(match[8] || '10', 10);
      const con = parseInt(match[9] || '10', 10);
      const int = parseInt(match[10] || '10', 10);
      const wis = parseInt(match[11] || '10', 10);
      const cha = parseInt(match[12] || '10', 10);
      
      if (name && name.length >= 2 && name.length <= 50) {
        // Определяем, игровой персонаж или NPC по контексту
        const matchText = match[0].toLowerCase();
        const isPlayable = /(?:игровой|игрок|pc|player|персонаж игрока|playable)/i.test(matchText) || 
                          !/(?:нип|npc|неигровой|враг|противник|enemy)/i.test(matchText);
        
        chars.push({
          name,
          isPlayable,
          level: isNaN(level) ? 1 : level,
          class: className || null,
          hp: isNaN(hp) ? 10 : hp,
          maxHp: isNaN(maxHp) ? hp : maxHp,
          ac: isNaN(ac) ? 10 : ac,
          str: isNaN(str) ? 10 : str,
          dex: isNaN(dex) ? 10 : dex,
          con: isNaN(con) ? 10 : con,
          int: isNaN(int) ? 10 : int,
          wis: isNaN(wis) ? 10 : wis,
          cha: isNaN(cha) ? 10 : cha,
          role: isPlayable ? 'Игровой персонаж' : 'NPC',
        });
      }
    }
    if (chars.length > 0) break; // Если нашли хотя бы одного персонажа, используем этот формат
  }
}
  
  // Вариант 2: Поиск в блоке "Статистика НИП" или "Персонажи" с построчным парсингом
  if (chars.length === 0) {
    const sectionPatterns = [
      /(?:Статистика НИП|Персонажи|Игровые персонажи|Карточки персонажей|Character Stats)[\s\S]{0,8000}/i,
      /(?:NPC|НИП|Non-Player Characters)[\s\S]{0,5000}/i,
    ];
    
    for (const sectionPattern of sectionPatterns) {
      const sectionMatch = srcText.match(sectionPattern);
      if (!sectionMatch) continue;
      
      const section = sectionMatch[0];
      const lines = section.split('\n');
      let currentChar: any = null;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Имя персонажа (строка с большой буквы, без цифр в начале, не слишком длинная)
        if (/^[А-ЯA-Z][А-Яа-яЁёA-Za-z\s]{2,40}$/.test(line) && !/^[0-9]/.test(line) && !/^(?:HP|AC|STR|DEX|CON|INT|WIS|CHA|Уровень|Класс|Level|Class)/i.test(line)) {
          if (currentChar && currentChar.name) {
            chars.push(currentChar);
          }
          const isPlayable = /(?:игровой|игрок|pc|player|playable)/i.test(section);
          currentChar = {
            name: line,
            isPlayable,
            level: 1,
            hp: 10,
            maxHp: 10,
            ac: 10,
            str: 10,
            dex: 10,
            con: 10,
            int: 10,
            wis: 10,
            cha: 10,
            role: isPlayable ? 'Игровой персонаж' : 'NPC',
          };
        }
        
        // Извлечение характеристик из следующих строк
        if (currentChar) {
          const hpMatch = line.match(/(?:HP|ХП|Хиты)[:\s]+(\d+)\/?(\d+)?/i);
          if (hpMatch) {
            currentChar.hp = parseInt(hpMatch[1] || '10', 10);
            currentChar.maxHp = parseInt(hpMatch[2] || hpMatch[1] || '10', 10);
          }
          
          const acMatch = line.match(/(?:AC|КД|Класс[^\n]*брони)[:\s]+(\d+)/i);
          if (acMatch) currentChar.ac = parseInt(acMatch[1] || '10', 10);
          
          const levelMatch = line.match(/(?:Уровень|Level|Ур\.)[:\s]+(\d+)/i);
          if (levelMatch) currentChar.level = parseInt(levelMatch[1] || '1', 10);
          
          const classMatch = line.match(/(?:Класс|Class)[:\s]+([А-Яа-яЁёA-Za-z\s]+)/i);
          if (classMatch) currentChar.class = classMatch[1].trim();
          
          const strMatch = line.match(/(?:STR|СИЛ|Сила)[:\s]+(\d+)/i);
          if (strMatch) currentChar.str = parseInt(strMatch[1] || '10', 10);
          
          const dexMatch = line.match(/(?:DEX|ЛОВ|Ловкость)[:\s]+(\d+)/i);
          if (dexMatch) currentChar.dex = parseInt(dexMatch[1] || '10', 10);
          
          const conMatch = line.match(/(?:CON|ТЕЛ|Телосложение)[:\s]+(\d+)/i);
          if (conMatch) currentChar.con = parseInt(conMatch[1] || '10', 10);
          
          const intMatch = line.match(/(?:INT|ИНТ|Интеллект)[:\s]+(\d+)/i);
          if (intMatch) currentChar.int = parseInt(intMatch[1] || '10', 10);
          
          const wisMatch = line.match(/(?:WIS|МДР|Мудрость)[:\s]+(\d+)/i);
          if (wisMatch) currentChar.wis = parseInt(wisMatch[1] || '10', 10);
          
          const chaMatch = line.match(/(?:CHA|ХАР|Харизма)[:\s]+(\d+)/i);
          if (chaMatch) currentChar.cha = parseInt(chaMatch[1] || '10', 10);
        }
        
        if (chars.length >= 15) break;
      }
      
      if (currentChar && currentChar.name) {
        chars.push(currentChar);
      }
      
      if (chars.length > 0) break;
    }
  }
  
  // ВАРИАНТ 3: Извлечение из раздела "Приложение В. Статистика НИП" (структурированный формат)
  if (chars.length === 0) {
    const npcSectionMatch = srcText.match(/(?:Приложение[^\n]*В|Приложение В|Статистика НИП)[\s\S]{0,10000}/i);
    if (npcSectionMatch) {
      const npcSection = npcSectionMatch[0];
      
      // Ищем блоки персонажей в формате: Имя[Класс]\nХарактеристики...
      const npcPattern = /([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z\s]{2,40})(?:\[([А-Яа-яЁёA-Za-z\s]+)\])?[\s\S]{0,500}?(?:HP|ХП|Хиты)[:\s]+(\d+)[^\n]*(?:AC|КД)[:\s]+(\d+)[^\n]*(?:STR|СИЛ)[:\s]+(\d+)[^\n]*(?:DEX|ЛОВ)[:\s]+(\d+)[^\n]*(?:CON|ТЕЛ)[:\s]+(\d+)[^\n]*(?:INT|ИНТ)[:\s]+(\d+)[^\n]*(?:WIS|МДР)[:\s]+(\d+)[^\n]*(?:CHA|ХАР)[:\s]+(\d+)/gi;
      
      let npcMatch;
      while ((npcMatch = npcPattern.exec(npcSection)) !== null && chars.length < 20) {
        const name = npcMatch[1]?.trim();
        const className = npcMatch[2]?.trim() || null;
        const hp = parseInt(npcMatch[3] || '10', 10);
        const ac = parseInt(npcMatch[4] || '10', 10);
        const str = parseInt(npcMatch[5] || '10', 10);
        const dex = parseInt(npcMatch[6] || '10', 10);
        const con = parseInt(npcMatch[7] || '10', 10);
        const int = parseInt(npcMatch[8] || '10', 10);
        const wis = parseInt(npcMatch[9] || '10', 10);
        const cha = parseInt(npcMatch[10] || '10', 10);
        
        if (name && name.length >= 2 && name.length <= 50) {
          // В разделе "Статистика НИП" обычно NPC
          chars.push({
            name,
            isPlayable: false,
            level: 1,
            class: className,
            hp,
            maxHp: hp,
            ac,
            str,
            dex,
            con,
            int,
            wis,
            cha,
            role: 'NPC',
          });
        }
      }
    }
  }
  
  return chars;
}

app.post('/api/admin/ingest/pdf', upload.single('file'), async (req, res) => {
  try {
    const fixLatin1 = (s: unknown): string => {
      const str = typeof s === 'string' ? s : '';
      if (!str) return '';
      if (/[ÐÑÂ]/.test(str)) {
        try { return Buffer.from(str, 'latin1').toString('utf8'); } catch {  }
      }
      return str;
    };
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'file_required' });
    if (req.file.buffer.length === 0) return res.status(400).json({ error: 'file_empty' });
    
    // Проверка типа файла
    const fileName = req.file.originalname || '';
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'invalid_file_type', expected: 'PDF' });
    }
    if (req.file.mimetype && req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'invalid_mime_type', expected: 'application/pdf' });
    }
    
    // Парсинг PDF с обработкой ошибок
    let parsed;
    try {
      parsed = await pdfParse(req.file.buffer);
    } catch (e) {
      console.error('[PDF INGEST] Parse error:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (errorMsg.includes('password') || errorMsg.includes('encrypted')) {
        return res.status(400).json({ error: 'pdf_password_protected', message: 'PDF защищен паролем. Снимите защиту перед загрузкой.' });
      }
      return res.status(400).json({ error: 'pdf_parse_failed', details: errorMsg });
    }
    
    if (!parsed || !parsed.text) {
      return res.status(400).json({ error: 'pdf_no_text', message: 'PDF не содержит извлекаемого текста. Возможно, это сканированное изображение.' });
    }
    
    const rawText = parsed.text.replace(/\r/g, '\n');
    const stripTocAndLeaders = (src: string): string => {
      let t = src;
      const m = t.match(/^\s*Оглавлени[ея]\b[\s\S]*?$/im);
      if (m) {
        const start = m.index || 0;
        const rest = t.slice(start);
        const reEnd = /(^|\n)\s*(Введение|Предыстория|Зацепк[аи][^\n]*приключ|Глава|Часть|Сцена|Локация)\s*($|\n)|(\f)/im;
        const endM = reEnd.exec(rest);
        if (endM && typeof endM.index === 'number' && endM.index > 0) {
          t = t.slice(0, start) + rest.slice(endM.index);
        } else {
          t = t.slice(0, start) + rest.slice(Math.min(rest.length, 4000));
        }
      }
      const limit = 15000;
      let head = t.slice(0, limit);
      const tail = t.slice(limit);
      head = head.split('\n').filter((ln) => {
        return !/^\s*\S.{0,120}\.{3,}\s*\d+\s*$/.test(ln);
      }).join('\n');
      return head + tail;
    };
    // Увеличиваем лимит для больших PDF с правилами (до 70+ страниц = ~500000 символов)
    // Ограничение нужно только для защиты от переполнения памяти, но должно быть достаточным для больших правил
    const text = stripTocAndLeaders(rawText).slice(0, 1000000);
    if (!text.trim()) return res.status(400).json({ error: 'pdf_empty' });
    const fast = String(req.query.fast || req.body?.fast || '') === '1';
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    let scenario: any = null;
    if ((geminiKey || apiKey) && !fast) {
      try {
        const sys = 'Ты помощник-редактор настольных приключений (D&D). Верни строго JSON-схему полного сценария для нашей игры без комментариев и лишнего текста.';
        const shape = '{ "game": {"title":"...","description":"...","author":"...","worldRules":"...","gameplayRules":"...","introduction":"...","backstory":"...","adventureHooks":"...","promoDescription":"...","ageRating":"G16","winCondition":"...","loseCondition":"...","deathCondition":"..."}, "locations":[{"key":"loc1","order":1,"title":"...","description":"...","rulesPrompt":"...","backgroundUrl":null,"musicUrl":null}], "exits":[{"fromKey":"loc1","type":"BUTTON","buttonText":"Дальше","triggerText":null,"toKey":"loc2","isGameOver":false}], "characters":[{"name":"...","isPlayable":true,"race":"...","gender":"...","avatarUrl":null,"voiceId":null,"persona":null,"origin":null,"role":null,"abilities":null,"level":1,"class":"...","hp":10,"maxHp":10,"ac":10,"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}], "editions":[{"name":"Стандарт","description":"...","price":990,"badge":null}] }';
        const prompt = `Исходный текст PDF:\n---\n${text.slice(0, 150000)}\n---\nВерни только JSON без комментариев, строго формы:\n${shape}\n\nКРИТИЧЕСКИ ВАЖНЫЕ ТРЕБОВАНИЯ:\n\n1. ЛОКАЦИИ:\n   - 8-14 локаций, связанный граф переходов\n   - Осмысленные названия сцен и короткие (2-3 предложения) описания\n   - НЕ создавай локации с названиями типа "Часть 1", "Часть 2" - это заголовки разделов, а не локации!\n   - Если в тексте есть заголовки "Часть X", пропускай их при создании локаций\n\n2. ПЕРЕХОДЫ (exits):\n   - Создавай переходы между всеми связанными локациями\n   - Для финальных локаций (где происходит победа/поражение/смерть) создавай выходы с типом "GAMEOVER" и isGameOver: true\n   - Пример финального выхода: {"fromKey":"loc_final","type":"GAMEOVER","buttonText":"Завершить игру","triggerText":null,"toKey":null,"isGameOver":true}\n\n3. УСЛОВИЯ ФИНАЛА (ОБЯЗАТЕЛЬНО!):\n   - winCondition: описание условий победы (например: "Спасти Элиару и победить Тал'Киара", "Остановить ритуал воскрешения Ноктуса")\n   - loseCondition: описание условий поражения (например: "Все персонажи погибли", "Ритуал завершен, Ноктус воскрешен")\n   - deathCondition: описание условий смерти (например: "Персонаж получает смертельный урон и не получает помощи", "HP падает до 0")\n   - ИЩИ в тексте разделы: "Условия победы", "Условия поражения", "Условия смерти", "Победа", "Поражение", "Смерть", "Завершение", "Финал"\n   - Если явных условий нет в тексте - СГЕНЕРИРУЙ их логически на основе сюжета!\n   - НИКОГДА не оставляй winCondition, loseCondition, deathCondition пустыми или равными "..."!\n\n4. ОБЩЕЕ:\n   - Опирайся на D&D 5e и единый мир\n   - Все переходы должны быть двусторонними где это логично (если можно вернуться - создавай обратный переход)\n   - Секретные проходы тоже должны быть переходами`;
        
        const { text: generatedText } = await generateChatCompletion({
          systemPrompt: sys,
          userPrompt: prompt,
          history: []
        });
        
        const content = generatedText || '{}';
        const startIdx = content.indexOf('{');
        const endIdx = content.lastIndexOf('}');
        const cleaned = (startIdx >= 0 && endIdx >= 0) ? content.slice(startIdx, endIdx + 1) : content;
        
        // Валидация JSON
        try {
          scenario = JSON.parse(cleaned);
          
          // Проверка структуры
          if (!scenario || typeof scenario !== 'object') {
            throw new Error('Invalid JSON structure');
          }
          
          if (!Array.isArray(scenario.locations) || scenario.locations.length === 0) {
            console.warn('[PDF INGEST] AI returned no locations, using fallback');
            scenario = null;
          }
          
          if (!scenario.game || typeof scenario.game !== 'object') {
            scenario.game = scenario.game || {};
          }
        } catch (e) {
          console.error('[PDF INGEST] JSON parse error:', e);
          console.error('[PDF INGEST] Content preview:', cleaned.slice(0, 500));
          scenario = null; // Использовать fallback
        }
      } catch (e) {
        console.error('[PDF INGEST] AI failed:', e);
        scenario = null; // Использовать fallback
      }
    }
    const buildScenarioFromText = (srcText: string) => {
      const pickBlock = (labelRe: RegExp, labelName?: 'intro' | 'back' | 'hooks', maxLength?: number): string | null => {
        const idx = srcText.search(labelRe);
        if (idx < 0) return null;
        const tail = srcText.slice(idx);
        const lines = tail.split('\n');
        lines.shift();
        const acc: string[] = [];
        for (const ln of lines) {
          const isIntro = /^\s*Введение\b/i.test(ln);
          const isBack = /^\s*Предыстория\b/i.test(ln);
          const isHooks = /^\s*Зацепк[аи][^\n]*приключ/i.test(ln);
          if (labelName !== 'intro' && isIntro) break;
          if (labelName !== 'back' && isBack) break;
          if (labelName !== 'hooks' && isHooks) break;
          if (/^\s*(Глава|Локация|Сцена|Часть)\b/i.test(ln)) break;
          if (/^\s*\d+[\.\)]\s+[^\n]+$/.test(ln)) break;
          acc.push(ln);
          // Если maxLength указан, ограничиваем длину. Если не указан - без ограничений (для полных правил)
          if (maxLength !== undefined && acc.join('\n').length > maxLength) break;
        }
        const s = acc.join('\n').trim();
        // Если maxLength указан, обрезаем до него. Если не указан - возвращаем полностью (для полных правил)
        return s ? (maxLength !== undefined ? s.slice(0, maxLength) : s) : null;
      };
      const introduction = pickBlock(/(^|\n)\s*Введение\s*$/im, 'intro') || null;
      const backstory = pickBlock(/(^|\n)\s*Предыстория\s*$/im, 'back') || null;
      const adventureHooks = pickBlock(/(^|\n)\s*Зацепк[аи][^\n]*приключ[^\n]*\s*$/im, 'hooks') || null;
      const winCondition = pickBlock(/(^|\n)\s*Услови[ея]\s+побед[ыы]\s*$/im) || pickBlock(/(^|\n)\s*Побед[аы]\s*$/im) || null;
      const loseCondition = pickBlock(/(^|\n)\s*Услови[ея]\s+поражени[яя]\s*$/im) || pickBlock(/(^|\n)\s*Поражени[ея]\s*$/im) || null;
      const deathCondition = pickBlock(/(^|\n)\s*Услови[ея]\s+смерти\s*$/im) || pickBlock(/(^|\n)\s*Смерть\s*$/im) || null;
      const extractSections = (): Array<{ title: string; body: string }> => {
        const markers: RegExp[] = [
          /^\s*(Глава|Локация|Сцена|Часть)\s+([^\n]{3,100})/gmi,
          /^\s*\d+[\.\)]\s+([A-Za-zА-Яа-яЁё0-9][^\n]{3,100})/gm,
          /^\s*#{1,3}\s+([^\n]{3,100})/gm,
        ];
        let matches: Array<{ title: string; index: number }> = [];
        for (const re of markers) {
          const m: Array<{ title: string; index: number }> = [];
          let r: RegExpExecArray | null;
          while ((r = re.exec(srcText)) !== null) {
            const t = (r[2] || r[1] || '').toString().trim();
            if (t) m.push({ title: t, index: r.index });
          }
          if (m.length >= 3) { matches = m; break; }
        }
        const out: Array<{ title: string; body: string }> = [];
        if (matches.length >= 2) {
          for (let i = 0; i < matches.length; i++) {
            const cur = matches[i];
            const next = matches[i + 1];
            const body = srcText.slice(cur.index, next ? next.index : undefined);
            const cleanBody = body.split('\n').slice(1).join('\n').trim();
            const b = cleanBody ? cleanBody.slice(0, 1800) : '';
            out.push({ title: cur.title, body: b });
            if (out.length >= 14) break;
          }
          return out.filter(s => s.title && s.body);
        }
        const paragraphs = srcText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
        const chunks: string[] = [];
        let buf = '';
        for (const p of paragraphs) {
          if ((buf + '\n\n' + p).length > 1200) {
            if (buf) chunks.push(buf);
            buf = p;
          } else {
            buf = buf ? (buf + '\n\n' + p) : p;
          }
          if (chunks.length >= 12) break;
        }
        if (buf && chunks.length < 14) chunks.push(buf);
        return chunks.map((c, i) => {
          const first = c.split(/[\.!\?]\s/)[0] || 'Сцена';
          const title = (first.trim().slice(0, 60) || `Сцена ${i + 1}`);
          return { title, body: c.slice(0, 1800) };
        });
      };
      const sections = extractSections();
      // Извлекаем полные правила БЕЗ ограничения длины (maxLength не передаем)
      const worldRulesFull = (pickBlock(/Правила мира/i) || pickBlock(/Особенности местности/i) || '').trim();
      const gameplayRulesFull = (pickBlock(/Правила игрового процесса/i) || pickBlock(/Дальнейшие события/i) || '').trim();
      // Краткие версии для UI (максимум 500 символов)
      const worldRules = worldRulesFull ? worldRulesFull.slice(0, 500) : '—';
      const gameplayRules = gameplayRulesFull ? gameplayRulesFull.slice(0, 500) : '—';
      const locations = sections.length ? sections.map((s, i) => ({ key: `loc${i + 1}`, order: i + 1, title: s.title, description: s.body, backgroundUrl: null, musicUrl: null })) :
        [{ key: 'start', order: 1, title: 'Стартовая локация', description: srcText.split('\n').slice(0, 8).join('\n'), backgroundUrl: null, musicUrl: null }];
      const exits = locations.length > 1 ? locations.slice(0, -1).map((_, i) => ({ fromKey: `loc${i + 1}`, type: 'BUTTON', buttonText: 'Дальше', triggerText: null, toKey: `loc${i + 2}`, isGameOver: false })) : [];
      const characters = parseCharacterCards(srcText);
      return {
        game: { 
          title: fixLatin1(req.file.originalname.replace(/\.pdf$/i, '')), 
          description: 'Импортировано из PDF', 
          author: 'GM', 
          worldRules, 
          gameplayRules, 
          worldRulesFull: worldRulesFull || null, // Сохраняем полные правила для ИИ (без ограничения длины)
          gameplayRulesFull: gameplayRulesFull || null, // Сохраняем полные правила для ИИ (без ограничения длины)
          introduction, 
          backstory, 
          adventureHooks, 
          winCondition, 
          loseCondition, 
          deathCondition 
        },
        locations, exits, characters,
      };
    };
    if (!scenario || !scenario.locations || !scenario.locations.length) {
      scenario = buildScenarioFromText(text);
    } else {
      if (!scenario.game) scenario.game = {};
      // Извлекаем полные правила БЕЗ ограничения длины из исходного текста
      if (!scenario.game.worldRulesFull) {
        const worldRulesFullMatch = text.match(/Правила мира[\s\S]*?(?=\n\s*(?:Глава|Локация|Сцена|Часть|Введение|Предыстория|Зацепк|Правила игрового процесса|$))/i);
        if (worldRulesFullMatch && worldRulesFullMatch[0]) {
          const worldRulesFullBlk = worldRulesFullMatch[0].replace(/^Правила мира\s*/i, '').trim();
          if (worldRulesFullBlk) {
            scenario.game.worldRulesFull = worldRulesFullBlk;
            if (!scenario.game.worldRules) {
              scenario.game.worldRules = worldRulesFullBlk.slice(0, 500);
            }
          }
        }
      }
      if (!scenario.game.gameplayRulesFull) {
        const gameplayRulesFullMatch = text.match(/Правила игрового процесса[\s\S]*?(?=\n\s*(?:Глава|Локация|Сцена|Часть|Введение|Предыстория|Зацепк|Правила мира|$))/i);
        if (gameplayRulesFullMatch && gameplayRulesFullMatch[0]) {
          const gameplayRulesFullBlk = gameplayRulesFullMatch[0].replace(/^Правила игрового процесса\s*/i, '').trim();
          if (gameplayRulesFullBlk) {
            scenario.game.gameplayRulesFull = gameplayRulesFullBlk;
            if (!scenario.game.gameplayRules) {
              scenario.game.gameplayRules = gameplayRulesFullBlk.slice(0, 500);
            }
          }
        }
      }
      // Fallback для кратких версий, если полные не найдены
      if (!scenario.game.worldRules) scenario.game.worldRules = ((): string | null => {
        const blk = (text.match(/Правила мира[\s\S]{0,1000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 500) : null;
      })();
      if (!scenario.game.gameplayRules) scenario.game.gameplayRules = ((): string | null => {
        const blk = (text.match(/Правила игрового процесса[\s\S]{0,1000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 500) : null;
      })();
      if (!scenario.game.winCondition) scenario.game.winCondition = ((): string | null => {
        const patterns = [
          /(?:Услови[ея]\s+побед[ыы]|Побед[аы]|Завершени[ея]\s+приключени[яя])[\s\S]{0,2000}/i,
          /(?:Часть\s+3|Финал|Завершение)[\s\S]{0,2000}/i,
        ];
        for (const pattern of patterns) {
          const blk = (text.match(pattern)?.[0] || '').trim();
          if (blk) return blk.slice(0, 1800);
        }
        // Если не найдено, генерируем на основе сюжета
        if (text.includes('спасти') || text.includes('победить') || text.includes('остановить')) {
          return 'Завершить основную цель приключения (спасти персонажей, победить главного врага, остановить ритуал)';
        }
        return 'Завершить приключение успешно';
      })();
      if (!scenario.game.loseCondition) scenario.game.loseCondition = ((): string | null => {
        const patterns = [
          /(?:Услови[ея]\s+поражени[яя]|Поражени[ея])[\s\S]{0,2000}/i,
          /(?:Ритуал\s+заверш[её]н|Враг\s+победил)[\s\S]{0,2000}/i,
        ];
        for (const pattern of patterns) {
          const blk = (text.match(pattern)?.[0] || '').trim();
          if (blk) return blk.slice(0, 1800);
        }
        // Если не найдено, генерируем на основе сюжета
        if (text.includes('ритуал') || text.includes('воскресить')) {
          return 'Ритуал завершен, главный враг достиг своей цели';
        }
        return 'Все персонажи погибли или главная цель не достигнута';
      })();
      if (!scenario.game.deathCondition) scenario.game.deathCondition = ((): string | null => {
        const patterns = [
          /(?:Услови[ея]\s+смерти|Смерть)[\s\S]{0,2000}/i,
        ];
        for (const pattern of patterns) {
          const blk = (text.match(pattern)?.[0] || '').trim();
          if (blk) return blk.slice(0, 1800);
        }
        // Стандартное условие смерти для D&D 5e
        return 'Персонаж получает смертельный урон (HP падает до 0) и не получает помощи в течение времени';
      })();
    }
    try {
      if (scenario?.game) {
        scenario.game.title = fixLatin1(scenario.game.title);
        scenario.game.author = fixLatin1(scenario.game.author);
        scenario.game.description = fixLatin1(scenario.game.description);
      }
    } catch {}
    return res.json({ import: scenario });
  } catch (e) {
    console.error('ingest_pdf_error', e);
    return res.status(500).json({ error: 'ingest_failed' });
  }
});

type IngestJob = { status: 'queued' | 'running' | 'done' | 'error'; error?: string; gameId?: string; progress?: string };
const ingestJobs = new Map<string, IngestJob>();

// Map для отслеживания флагов остановки генерации по gameId
const generationStopFlags = new Map<string, boolean>();

app.post('/api/admin/ingest-import', (req, res, next) => {
  upload.fields([
    { name: 'rulesFile', maxCount: 1 },
    { name: 'scenarioFile', maxCount: 1 }
  ])(req, res, (err: any) => {
    if (err) {
      console.error('[INGEST-IMPORT] Multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large', message: 'Файл слишком большой. Максимальный размер: 100MB' });
      }
      return res.status(500).json({ error: 'upload_error', details: String(err) });
    }
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files as { rulesFile?: Express.Multer.File[], scenarioFile?: Express.Multer.File[] };
    const rulesFile = files?.rulesFile?.[0];
    const scenarioFile = files?.scenarioFile?.[0];
    
    console.log('[INGEST-IMPORT] Received request, rulesFile:', rulesFile?.originalname, 'scenarioFile:', scenarioFile?.originalname);
    
    if (!rulesFile || !scenarioFile) {
      console.error('[INGEST-IMPORT] Missing files - rulesFile:', !!rulesFile, 'scenarioFile:', !!scenarioFile);
      return res.status(400).json({ error: 'both_files_required', message: 'Необходимо загрузить оба файла: правила и сценарий' });
    }
    
    // Проверяем типы файлов
    const checkFile = (file: Express.Multer.File, name: string) => {
      const fileName = file.originalname || '';
      const ext = fileName.toLowerCase().split('.').pop() || '';
      if (!['pdf', 'txt'].includes(ext)) {
        console.error(`[INGEST-IMPORT] Invalid ${name} file type:`, fileName);
        return false;
      }
      return true;
    };
    
    if (!checkFile(rulesFile, 'rulesFile') || !checkFile(scenarioFile, 'scenarioFile')) {
      return res.status(400).json({ error: 'invalid_file_type', expected: 'PDF or TXT' });
    }
    
    const jobId = (crypto as any).randomUUID ? (crypto as any).randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    ingestJobs.set(jobId, { status: 'queued', progress: 'Scheduled' });
    res.json({ jobId });
    (async () => {
      const set = (patch: Partial<IngestJob>) => {
        const cur = ingestJobs.get(jobId) || { status: 'running' as const };
        ingestJobs.set(jobId, { ...cur, ...patch });
      };
      try {
        set({ status: 'running', progress: 'Чтение файлов...' });
        
        // ═══════════════════════════════════════════════════════════════════════════════
        // ОБРАБОТКА ДВУХ ФАЙЛОВ: ПРАВИЛА И СЦЕНАРИЙ
        // ═══════════════════════════════════════════════════════════════════════════════
        
        // Сохраняем PDF файлы на диск
        set({ progress: 'Сохранение файлов...' });
        const rulesPdfFilePath = path.join(PDF_DIR, `rules-${Date.now()}-${Math.round(Math.random() * 1E9)}.pdf`);
        const scenarioPdfFilePath = path.join(PDF_DIR, `scenario-${Date.now()}-${Math.round(Math.random() * 1E9)}.pdf`);
        
        fs.writeFileSync(rulesPdfFilePath, rulesFile.buffer);
        fs.writeFileSync(scenarioPdfFilePath, scenarioFile.buffer);
        
        const rulesPdfUrl = `/uploads/pdfs/${path.basename(rulesPdfFilePath)}`;
        const scenarioPdfUrl = `/uploads/pdfs/${path.basename(scenarioPdfFilePath)}`;
        
        // Функция для чтения файла из буфера или с диска
        const readFile = async (file: Express.Multer.File | string): Promise<string> => {
          let buffer: Buffer;
          let fileName: string;
          
          if (typeof file === 'string') {
            // Читаем с диска
            buffer = fs.readFileSync(file);
            fileName = file;
          } else {
            // Читаем из буфера
            buffer = file.buffer;
            fileName = file.originalname || '';
          }
          
          const ext = path.extname(fileName).toLowerCase().slice(1) || fileName.toLowerCase().split('.').pop() || '';
          
          if (ext === 'txt') {
            return buffer.toString('utf-8').replace(/\r/g, '\n');
          } else {
            // Примечание: pdf-parse может выводить предупреждения "Warning: TT: undefined function" и "Warning: TT: invalid function id"
            // Это не критичные ошибки - они связаны с обработкой шрифтов TrueType в PDF и не влияют на извлечение текста
            const parsed = await pdfParse(buffer).catch(() => null);
            if (parsed && parsed.text) {
              return (parsed.text || '').replace(/\r/g, '\n');
            }
          }
          return '';
        };
        
        set({ progress: 'Чтение файла правил...' });
        const rulesText = await readFile(rulesFile);
        if (!rulesText || !rulesText.trim()) {
          set({ status: 'error', error: 'Не удалось извлечь текст из файла правил' });
          return;
        }
        
        set({ progress: 'Чтение файла сценария...' });
        const scenarioText = await readFile(scenarioFile);
        if (!scenarioText || !scenarioText.trim()) {
          set({ status: 'error', error: 'Не удалось извлечь текст из файла сценария' });
          return;
        }
        
        // Очистка текста от оглавления
        const stripToc = (src: string): string => {
          let t = src;
          const tocMatch = t.match(/^\s*Оглавлени[ея]\b[\s\S]*?$/im);
          if (tocMatch) {
            const tocStart = tocMatch.index || 0;
            const restAfterToc = t.slice(tocStart);
            const reEndToc = /(^|\n)\s*(Введение|Предыстория|Зацепк[аи][^\n]*приключ|Часть\s+\d+|Глава\s+\d+|Сцена|Локация|\d+[\.\)]\s+[А-ЯA-Z])/im;
            const endTocMatch = reEndToc.exec(restAfterToc);
            if (endTocMatch && typeof endTocMatch.index === 'number' && endTocMatch.index > 0) {
              t = t.slice(0, tocStart) + restAfterToc.slice(endTocMatch.index);
            } else {
              t = t.slice(0, tocStart) + restAfterToc.slice(Math.min(restAfterToc.length, 4000));
            }
          }
          const limit = 20000;
          let head = t.slice(0, limit);
          const tail = t.slice(limit);
          head = head.split('\n').filter((ln) => {
            return !/^\s*\S.{0,120}\.{3,}\s*\d+\s*$/.test(ln);
          }).join('\n');
          return head + tail;
        };
        
        const cleanRulesText = stripToc(rulesText);
        const cleanScenarioText = stripToc(scenarioText);
        
        set({ progress: 'AI анализирует оба файла...' });
        const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
        let scenario: any = { game: {}, locations: [], exits: [], characters: [], editions: [] };
        
        // ═══════════════════════════════════════════════════════════════════════════════
        // СЕМАНТИЧЕСКИЙ АНАЛИЗ ДВУХ ФАЙЛОВ: ПРАВИЛА И СЦЕНАРИЙ
        // ═══════════════════════════════════════════════════════════════════════════════
        
        if (cleanRulesText && cleanScenarioText) {
          set({ progress: 'AI анализирует: правила + сценарий' });
          console.log('[INGEST-IMPORT] Starting AI analysis...');
          console.log('[INGEST-IMPORT] Rules text length:', cleanRulesText.length);
          console.log('[INGEST-IMPORT] Scenario text length:', cleanScenarioText.length);
          console.log('[INGEST-IMPORT] Rules text preview:', cleanRulesText.slice(0, 200));
          console.log('[INGEST-IMPORT] Scenario text preview:', cleanScenarioText.slice(0, 200));
          
          // ЭТАП 1: Сначала анализируем сценарий, чтобы понять контекст приключения
          console.log('[INGEST-IMPORT] Stage 1: Analyzing scenario first to understand adventure context...');
          
          // Временно сохраняем информацию о сценарии для использования в ЭТАПЕ 2
          let scenarioSummary = '';
          let scenarioLocations: any[] = [];
          let scenarioCharacters: any[] = [];
          
          // Быстрый анализ сценария для получения контекста
          if (cleanScenarioText && cleanScenarioText.length > 0) {
            try {
              const scenarioChunkSize = 200000;
              const firstScenarioChunk = cleanScenarioText.slice(0, scenarioChunkSize);
              
              const summaryPrompt = `Проанализируй начало сценария приключения и создай краткое описание контекста:
              
${firstScenarioChunk}

Извлеки ключевую информацию:
- Название мира/региона, где происходит приключение
- Основные локации (первые 3-5)
- Основные персонажи/фракции (первые 3-5)
- Уровни персонажей для приключения
- Атмосфера и стиль приключения

Верни краткое описание (максимум 1000 символов) для использования при анализе правил.`;
              
              const summaryResult = await generateChatCompletion({
                systemPrompt: 'Ты помощник, который анализирует сценарии приключений D&D и извлекает ключевую информацию о контексте.',
                userPrompt: summaryPrompt,
                history: []
              });
              
              if (summaryResult?.text) {
                scenarioSummary = summaryResult.text.trim();
                console.log('[INGEST-IMPORT] Stage 1: Scenario context extracted:', scenarioSummary.slice(0, 200));
              }
            } catch (e) {
              console.error('[INGEST-IMPORT] Stage 1: Failed to extract scenario context:', e);
            }
          }
          
          // ЭТАП 2: Анализ правил игры с учетом контекста сценария (обрабатываем весь файл по частям)
          console.log('[INGEST-IMPORT] Stage 2: Analyzing rules with scenario context...');
          const chunkSize = 250000; // Размер чанка для обработки
          const rulesChunks: string[] = [];
          for (let i = 0; i < cleanRulesText.length; i += chunkSize) {
            rulesChunks.push(cleanRulesText.slice(i, i + chunkSize));
          }
          console.log(`[INGEST-IMPORT] Stage 2: Processing ${rulesChunks.length} chunks of rules`);
          
          let worldRulesParts: string[] = [];
          let gameplayRulesParts: string[] = [];
          let worldRulesShortParts: string[] = [];
          let gameplayRulesShortParts: string[] = [];
          
          for (let chunkIdx = 0; chunkIdx < rulesChunks.length; chunkIdx++) {
            try {
              const rulesSys = `Ты интеллектуальный ассистент для анализа правил настольных ролевых игр D&D 5e.
Твоя задача - извлечь из ЧАСТИ файла правил два типа информации:
1. ПРАВИЛА МИРА (worldRules) - описание сеттинга, мира, вселенной
2. ПРАВИЛА ИГРОВОГО ПРОЦЕССА (gameplayRules) - механики игры, как играть

ВАЖНО: Это часть ${chunkIdx + 1} из ${rulesChunks.length} файла правил. Извлекай информацию из этой части.`;

              const rulesShape = '{ "worldRules": "...", "gameplayRules": "...", "worldRulesFull": "...", "gameplayRulesFull": "..." }';
              const chunk = rulesChunks[chunkIdx];
              
              const rulesPrompt = `Проанализируй ЧАСТЬ ${chunkIdx + 1} из ${rulesChunks.length} файла ПРАВИЛ ИГРЫ для настольной ролевой игры D&D 5e:

═══════════════════════════════════════════════════════════════════════════════
КОНТЕКСТ ПРИКЛЮЧЕНИЯ (из сценария):
═══════════════════════════════════════════════════════════════════════════════
${scenarioSummary || 'Контекст сценария пока не доступен'}
═══════════════════════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════════════════════
ЧАСТЬ ${chunkIdx + 1}/${rulesChunks.length}: ПРАВИЛА ИГРЫ
═══════════════════════════════════════════════════════════════════════════════
---
${chunk}
---

⚠️ КРИТИЧЕСКИ ВАЖНО: СОПОСТАВЛЯЙ общие правила D&D с КОНКРЕТНЫМ ПРИКЛЮЧЕНИЕМ из контекста выше!
Используй контекст приключения, чтобы понять, какие правила относятся к ЭТОМУ приключению, а какие - общие для D&D.

ИСКЛЮЧИ из извлечения:
- Авторские права, торговые марки, логотипы
- Предупреждения (например, "Предупреждение: Корпорация Wizards of the Coast...")
- Информацию "НА ОБЛОЖКЕ", "на обложке изображён..."
- Информацию о художниках, иллюстраторах
- Техническую информацию о документе
- ОБЩИЕ описания мультивселенной D&D, планов существования, космологии (если они не относятся к конкретному приключению)
- ОБЩИЕ описания богов, пантеонов (если они не относятся к конкретному приключению)
- ОБЩИЕ правила создания персонажей, классов, рас
- ОБЩИЕ описания магических предметов, артефактов (если они не упоминаются в приключении)
- ОБЩИЕ описания форм правления, валют, календарей (если они не относятся к конкретному приключению)

ИЗВЛЕКИ из ЭТОЙ ЧАСТИ:

1. ПРАВИЛА МИРА (worldRules):
   ⚠️ КРИТИЧЕСКИ ВАЖНО: Это КРАТКОЕ описание СЕТТИНГА КОНКРЕТНОГО ПРИКЛЮЧЕНИЯ - где происходит действие, атмосфера.
   ⚠️ НЕ ОБОБЩАЙ! Сопоставляй общие правила D&D с КОНКРЕТНЫМ приключением из текста.
   ⚠️ СОЗДАВАЙ КРАТКУЮ ВЕРСИЮ: Не просто обрезай текст до 500 символов! Сжимай информацию, сохраняя ВЕСЬ СМЫСЛ в 500 символах.
   Используй краткие формулировки, убирай повторы, оставляй только ключевую информацию.
   
   ❌ СТРОГО ЗАПРЕЩЕНО включать общие правила D&D:
   - "Мир D&D — это древняя магическая вселенная с реальными богами" - это ОБЩЕЕ описание мира D&D!
   - "Мультивселенная состоит из Материального Плана, его отражений (Страна Фей и Царство Теней)" - это ОБЩЕЕ описание космологии D&D!
   - "Влиятельные фракции, такие как Арфисты и Жентарим" - это ОБЩЕЕ описание фракций D&D (если они не упомянуты в конкретном приключении)!
   - "Стиль игры варьируется от героического фэнтези до тёмного ужаса" - это ОБЩЕЕ описание стилей игры!
   - Общие описания мультивселенной D&D, планов существования, космологии
   - Общие описания всех богов, пантеонов D&D
   - Общие описания форм правления, валют, календарей
   - Общие утверждения о мире D&D без привязки к конкретному приключению
   
   ✅ ВКЛЮЧАЙ ТОЛЬКО (если это упомянуто в КОНКРЕТНОМ приключении):
   - Название мира/региона, где происходит ЭТО приключение (например: "Действие происходит в мире Забвенных земель, в городе Люмерия")
   - Атмосферу, окружение ЭТОГО приключения (например: "Подземелье освещает красный каменный пол, из‑за чего везде висит красноватый туман")
   - Описание того, что видят/слышат/ощущают персонажи В ЭТОМ приключении
   - Конкретные боги, религии, упомянутые В ЭТОМ приключении (не общие описания пантеонов!)
   - Конкретные фракции, организации В ЭТОМ приключении
   - Конкретные особенности мира В ЭТОМ приключении
   
   ПРИМЕР worldRules (короткий, конкретный!):
   "Действие происходит в мире Забвенных земель, в городе Люмерия. Подземелье под храмом Мистры освещает красный каменный пол, из‑за чего везде висит красноватый туман. Культисты Ноктуса проводят ритуалы в подземелье."
   
   ПРИМЕР НЕПРАВИЛЬНОГО (обобщение):
   "Мир D&D — это древняя магическая вселенная с реальными богами, обширной дикой местностью и руинами павших империй. Мультивселенная состоит из разли..."

2. ПРАВИЛА ИГРОВОГО ПРОЦЕССА (gameplayRules):
   ⚠️ КРИТИЧЕСКИ ВАЖНО: Это КРАТКОЕ описание КОНКРЕТНЫХ МЕХАНИК ДЛЯ ЭТОГО ПРИКЛЮЧЕНИЯ - как играть.
   ⚠️ НЕ ОБОБЩАЙ! Сопоставляй общие правила D&D с КОНКРЕТНЫМ приключением из текста.
   ⚠️ СОЗДАВАЙ КРАТКУЮ ВЕРСИЮ: Не просто обрезай текст до 500 символов! Сжимай информацию, сохраняя ВЕСЬ СМЫСЛ в 500 символах.
   Используй краткие формулировки, убирай повторы, оставляй только ключевую информацию.
   
   ❌ СТРОГО ЗАПРЕЩЕНО включать общие правила D&D:
   - "Игровой процесс разделен на 4 этапа (1-20 уровни)" - это ОБЩЕЕ правило D&D, не для конкретного приключения!
   - "Введена опциональная система 'Слава'" - это ОБЩЕЕ опциональное правило, не для конкретного приключения!
   - "Путешествия по планам имеют свои правила" - это ОБЩЕЕ описание планов D&D!
   - "Приключения строятся на исследовании, социальном взаимодействии и боях" - это ОБЩЕЕ описание структуры приключений!
   - Общие описания всех механик D&D 5e
   - Общие правила создания персонажей, классов, рас
   - Общие описания всех опциональных правил
   - Общие описания создания приключений, кампаний
   - Общие описания роли мастера
   
   ✅ ВКЛЮЧАЙ ТОЛЬКО (если это упомянуто в КОНКРЕТНОМ приключении):
   - Уровни персонажей для ЭТОГО приключения (например: "для персонажей 2–3 уровня")
   - Редакция правил (например: "Используются правила D&D 5‑й редакции")
   - Конкретные проверки, упомянутые В ЭТОМ приключении (например: "Восприятие (Мудрость) Сл. 15 для поиска секретной двери, Ловкость (Акробатика) Сл. 10 для уклонения от ловушки")
   - Конкретные механики В ЭТОМ приключении (ловушки, спасброски, боевые сцены)
   - Роль AI-ведущего (например: "AI‑ведущий описывает последствия успеха/провала")
   
   ПРИМЕР gameplayRules (короткий, конкретный!):
   "Используются правила D&D 5‑й редакции для персонажей 2–3 уровня. Все проверки выполняются d20. AI‑ведущий описывает последствия успеха/провала."
   
   ПРИМЕР НЕПРАВИЛЬНОГО (обобщение):
   "Игровой процесс разделен на 4 этапа (1-20 уровни), где герои растут от местных спасителей до владык мира. Введена опциональная система 'Слава'..."

ПРИМЕРЫ РАЗДЕЛЕНИЯ:
- "Действие происходит в мире Забвенных земель. Подземелье освещает красный каменный пол..." → worldRules (описание сеттинга, атмосферы)
- "Боги наблюдают за миром. Боги реальны..." → worldRules (описание мира)
- "План Воды — это бесконечное море..." → worldRules (описание планов)
- "Деревня. Население: До 1000..." → worldRules (описание поселений)
- "Используются правила D&D 5‑й редакции для персонажей 2–3 уровня..." → gameplayRules (механика уровней)
- "Все проверки выполняются d20: Восприятие (Мудрость) для поиска..." → gameplayRules (механика проверок)
- "AI‑ведущий описывает последствия успеха/провала" → gameplayRules (механика игры)
- "Очки героизма. Каждый персонаж начинает с 5 очками..." → gameplayRules (механика правил)
- "Травмы. Опция вводит в игру травмы при получении критического попадания..." → gameplayRules (механика правил)

Верни только JSON без комментариев, строго формы:
${rulesShape}

⚠️ КРИТИЧЕСКИ ВАЖНО:
- worldRules: МАКСИМУМ 500 символов! СОЗДАЙ краткое описание сеттинга ЭТОГО приключения (для UI), сжимая информацию, но сохраняя ВЕСЬ СМЫСЛ. 
  ❌ ЗАПРЕЩЕНО: просто обрезать текст до 500 символов (например: "Действие происходит в мультивселенной, состоящей из разли..." - это ОБРЕЗКА!)
  ✅ ПРАВИЛЬНО: сжать информацию, убрав повторы и обобщения, оставив только конкретные детали этого приключения в 500 символах
  Пример правильного сжатия: "Действие в Забвенных землях, городе Люмерия. Подземелье с красным каменным полом и туманом. Культисты Ноктуса проводят ритуалы."
- gameplayRules: МАКСИМУМ 500 символов! СОЗДАЙ краткое описание механик ЭТОГО приключения (для UI), сжимая информацию, но сохраняя ВЕСЬ СМЫСЛ.
  ❌ ЗАПРЕЩЕНО: просто обрезать текст до 500 символов
  ✅ ПРАВИЛЬНО: сжать информацию, убрав повторы и обобщения, оставив только конкретные механики этого приключения в 500 символах
  Пример правильного сжатия: "D&D 5e для персонажей 2-3 уровня. Проверки d20. Восприятие Сл.15 для поиска двери, Ловкость Сл.10 для ловушек."
- worldRulesFull: ПОЛНОЕ описание сеттинга из ЭТОЙ ЧАСТИ файла (для ИИ, БЕЗ ограничений длины, включай ВСЕ релевантные детали из этой части, даже если это десятки страниц текста!).
- gameplayRulesFull: ПОЛНОЕ описание механик из ЭТОЙ ЧАСТИ файла (для ИИ, БЕЗ ограничений длины, включай ВСЕ релевантные детали из этой части, даже если это десятки страниц текста!). 
- 🔥 КРИТИЧЕСКИ ВАЖНО: worldRulesFull и gameplayRulesFull должны содержать ПОЛНЫЙ текст из этой части файла правил, не сокращай их! Эти поля будут объединены из всех чанков и переданы ИИ при генерации сцен.
- НЕ включай общие описания мультивселенной, планов, богов, механик D&D в краткие версии!
- Если информации нет в этой части - верни пустую строку "" для соответствующего поля.`;

              console.log(`[INGEST-IMPORT] Stage 2: Processing chunk ${chunkIdx + 1}/${rulesChunks.length}...`);
              const rulesResult = await generateChatCompletion({
                systemPrompt: rulesSys,
                userPrompt: rulesPrompt,
                history: []
              });
              
              if (rulesResult?.text) {
                let rulesContent = rulesResult.text.trim();
                if (rulesContent.includes('{')) {
                  const startIdx = rulesContent.indexOf('{');
                  const endIdx = rulesContent.lastIndexOf('}');
                  if (startIdx >= 0 && endIdx >= 0) {
                    rulesContent = rulesContent.slice(startIdx, endIdx + 1);
                    try {
                      const rulesData = JSON.parse(rulesContent);
                      // Сохраняем краткие версии для UI (AI создает их с полным смыслом в 500 символах)
                      const worldRulesShort = rulesData.worldRules || '';
                      const gameplayRulesShort = rulesData.gameplayRules || '';
                      // Сохраняем полные правила для AI (если есть worldRulesFull, используем их, иначе worldRules)
                      const worldRulesFull = rulesData.worldRulesFull || rulesData.worldRules || '';
                      const gameplayRulesFull = rulesData.gameplayRulesFull || rulesData.gameplayRules || '';
                      
                      if (worldRulesShort && worldRulesShort.trim()) {
                        worldRulesShortParts.push(worldRulesShort);
                      }
                      if (gameplayRulesShort && gameplayRulesShort.trim()) {
                        gameplayRulesShortParts.push(gameplayRulesShort);
                      }
                      if (worldRulesFull && worldRulesFull.trim()) {
                        worldRulesParts.push(worldRulesFull);
                      }
                      if (gameplayRulesFull && gameplayRulesFull.trim()) {
                        gameplayRulesParts.push(gameplayRulesFull);
                      }
                    } catch (e) {
                      console.error(`[INGEST-IMPORT] Stage 2: Failed to parse rules JSON for chunk ${chunkIdx + 1}:`, e);
                    }
                  }
                }
              }
            } catch (e) {
              console.error(`[INGEST-IMPORT] Stage 2: Chunk ${chunkIdx + 1} analysis failed:`, e);
            }
          }
          
          // Объединяем результаты из всех чанков
          // Полные правила для ИИ
          let worldRulesFull = worldRulesParts.length > 0 ? worldRulesParts.join(' ').trim() : null;
          let gameplayRulesFull = gameplayRulesParts.length > 0 ? gameplayRulesParts.join(' ').trim() : null;
          
          // Краткие правила для UI
          // Если есть несколько чанков с краткими версиями, объединяем их и создаем финальную краткую версию через AI
          // Если чанк один, используем его краткую версию напрямую
          let worldRulesShort = worldRulesShortParts.length > 0 ? worldRulesShortParts.join(' ').trim() : null;
          let gameplayRulesShort = gameplayRulesShortParts.length > 0 ? gameplayRulesShortParts.join(' ').trim() : null;
          
          // Финальная обработка: создаем краткие версии на основе сценария + правил
          if (scenarioSummary && (worldRulesFull || gameplayRulesFull)) {
            try {
              // Создаем финальные краткие версии с учетом сценария
              if (worldRulesFull && (!worldRulesShort || worldRulesShort.length > 500)) {
                const finalWorldRulesPrompt = `На основе КОНТЕКСТА ПРИКЛЮЧЕНИЯ и ОБЩИХ ПРАВИЛ D&D создай краткое описание правил мира для ЭТОГО конкретного приключения (максимум 500 символов, сохраняя весь смысл):

КОНТЕКСТ ПРИКЛЮЧЕНИЯ:
${scenarioSummary}

ОБЩИЕ ПРАВИЛА D&D (извлеченные из файла правил):
${worldRulesFull}

⚠️ КРИТИЧЕСКИ ВАЖНО:
- СОПОСТАВЛЯЙ общие правила D&D с конкретным приключением из контекста
- Включай только то, что относится к ЭТОМУ приключению
- Исключи общие описания мультивселенной, планов, богов (если они не упомянуты в приключении)
- Сожми информацию, сохраняя весь смысл в 500 символах
- НЕ просто обрезай текст!

Верни только краткое описание правил мира для этого приключения (максимум 500 символов).`;
                
                const finalWorldRulesResult = await generateChatCompletion({
                  systemPrompt: 'Ты помощник, который создает краткие описания правил мира для конкретных приключений D&D, сопоставляя общие правила с контекстом приключения.',
                  userPrompt: finalWorldRulesPrompt,
                  history: []
                });
                
                if (finalWorldRulesResult?.text) {
                  const compressed = finalWorldRulesResult.text.trim();
                  worldRulesShort = compressed.length > 500 ? compressed.slice(0, 500) : compressed;
                }
              }
              
              if (gameplayRulesFull && (!gameplayRulesShort || gameplayRulesShort.length > 500)) {
                const finalGameplayRulesPrompt = `На основе КОНТЕКСТА ПРИКЛЮЧЕНИЯ и ОБЩИХ ПРАВИЛ D&D создай краткое описание правил игрового процесса для ЭТОГО конкретного приключения (максимум 500 символов, сохраняя весь смысл):

КОНТЕКСТ ПРИКЛЮЧЕНИЯ:
${scenarioSummary}

ОБЩИЕ ПРАВИЛА D&D (извлеченные из файла правил):
${gameplayRulesFull}

⚠️ КРИТИЧЕСКИ ВАЖНО:
- СОПОСТАВЛЯЙ общие правила D&D с конкретным приключением из контекста
- Включай только то, что относится к ЭТОМУ приключению
- Исключи общие описания всех механик D&D (если они не используются в приключении)
- Сожми информацию, сохраняя весь смысл в 500 символах
- НЕ просто обрезай текст!

Верни только краткое описание правил игрового процесса для этого приключения (максимум 500 символов).`;
                
                const finalGameplayRulesResult = await generateChatCompletion({
                  systemPrompt: 'Ты помощник, который создает краткие описания правил игрового процесса для конкретных приключений D&D, сопоставляя общие правила с контекстом приключения.',
                  userPrompt: finalGameplayRulesPrompt,
                  history: []
                });
                
                if (finalGameplayRulesResult?.text) {
                  const compressed = finalGameplayRulesResult.text.trim();
                  gameplayRulesShort = compressed.length > 500 ? compressed.slice(0, 500) : compressed;
                }
              }
            } catch (e) {
              console.error('[INGEST-IMPORT] Stage 2: Failed to create final rules with scenario context:', e);
            }
          }
          
          // Если объединенная краткая версия превышает 500 символов или отсутствует, создаем финальную краткую версию из полных через AI
          if ((!worldRulesShort || worldRulesShort.length > 500) && worldRulesFull) {
            try {
              const sourceText = worldRulesShort && worldRulesShort.length > 500 ? worldRulesShort : worldRulesFull;
              const compressPrompt = `Создай КРАТКУЮ версию этого текста о правилах мира для конкретного приключения, сохраняя ВЕСЬ СМЫСЛ в максимум 500 символах. 
⚠️ КРИТИЧЕСКИ ВАЖНО: НЕ просто обрезай текст! Сожми информацию, убрав повторы и обобщения, оставив только КОНКРЕТНЫЕ детали этого приключения.
Исключи общие описания мультивселенной D&D, планов, богов (если они не относятся к конкретному приключению).
Включи только: название мира/региона этого приключения, атмосферу, конкретных богов/фракции из приключения, особенности мира в этом приключении.

Текст для сжатия:
${sourceText}`;
              const compressResult = await generateChatCompletion({
                systemPrompt: 'Ты помощник, который создает краткие версии текстов о правилах мира для настольных игр, сохраняя весь смысл и конкретику приключения.',
                userPrompt: compressPrompt,
                history: []
              });
              if (compressResult?.text) {
                const compressed = compressResult.text.trim();
                worldRulesShort = compressed.length > 500 ? compressed.slice(0, 500) : compressed;
              }
            } catch (e) {
              console.error('[INGEST-IMPORT] Failed to compress worldRules:', e);
              // Fallback: используем первую краткую версию или обрезаем полную
              if (!worldRulesShort && worldRulesFull) {
                worldRulesShort = worldRulesFull.slice(0, 500);
              }
            }
          }
          if ((!gameplayRulesShort || gameplayRulesShort.length > 500) && gameplayRulesFull) {
            try {
              const sourceText = gameplayRulesShort && gameplayRulesShort.length > 500 ? gameplayRulesShort : gameplayRulesFull;
              const compressPrompt = `Создай КРАТКУЮ версию этого текста о правилах игрового процесса для конкретного приключения, сохраняя ВЕСЬ СМЫСЛ в максимум 500 символах.
⚠️ КРИТИЧЕСКИ ВАЖНО: НЕ просто обрезай текст! Сожми информацию, убрав повторы и обобщения, оставив только КОНКРЕТНЫЕ механики этого приключения.
Исключи общие описания всех механик D&D 5e, опциональных правил (если они не используются в этом приключении).
Включи только: уровни персонажей для этого приключения, редакцию правил, конкретные проверки/механики из приключения.

Текст для сжатия:
${sourceText}`;
              const compressResult = await generateChatCompletion({
                systemPrompt: 'Ты помощник, который создает краткие версии текстов о правилах игрового процесса для настольных игр, сохраняя весь смысл и конкретику приключения.',
                userPrompt: compressPrompt,
                history: []
              });
              if (compressResult?.text) {
                const compressed = compressResult.text.trim();
                gameplayRulesShort = compressed.length > 500 ? compressed.slice(0, 500) : compressed;
              }
            } catch (e) {
              console.error('[INGEST-IMPORT] Failed to compress gameplayRules:', e);
              // Fallback: используем первую краткую версию или обрезаем полную
              if (!gameplayRulesShort && gameplayRulesFull) {
                gameplayRulesShort = gameplayRulesFull.slice(0, 500);
              }
            }
          }
          
          // Используем краткие версии для UI (они содержат весь смысл в 500 символах)
          // ОБЪЕДИНЯЕМ правила в одно поле - один файл правил содержит все
          const combinedRules = [worldRulesShort, gameplayRulesShort].filter(Boolean).join('\n\n').slice(0, 500);
          if (combinedRules) {
            scenario.game.worldRules = combinedRules; // Используем worldRules как общее поле для правил
            scenario.game.gameplayRules = combinedRules; // Дублируем для обратной совместимости
            // Сохраняем путь к PDF правил - ОДИН ФАЙЛ ПРАВИЛ
            scenario.game.rulesPdfPath = rulesPdfUrl;
          }
          // Сохраняем путь к PDF сценария - ВТОРОЙ ФАЙЛ
          scenario.game.scenarioPdfPath = scenarioPdfUrl;
          console.log(`[INGEST-IMPORT] Stage 2 complete: Rules extracted from ${rulesChunks.length} chunks with scenario context`);
          
          // ЭТАП 3: Анализ сценария игры
          console.log('[INGEST-IMPORT] Stage 3: Analyzing scenario...');
          try {
            const sys = `Ты интеллектуальный ассистент для анализа сценариев настольных ролевых игр D&D 5e.

Твоя задача - ПОНЯТЬ СЕМАНТИЧЕСКИЙ СМЫСЛ каждого элемента в сценарии и правильно сопоставить их с полями на фронтенде.

НА ФРОНТЕНДЕ ЕСТЬ СЛЕДУЮЩИЕ РАЗДЕЛЫ:
1. "Описание и промо" → game.promoDescription
2. "Введение" → game.introduction (начальная сцена для игроков)
3. "Предыстория" → game.backstory (история мира до начала игры)
4. "Зацепки приключения" → game.adventureHooks (способы начать приключение)
5. "Локации" → locations[] (из файла сценария)
6. "Персонажи" → characters[] (NPC из файла сценария)
7. "Условия финала" → winCondition, loseCondition, deathCondition

Ты должен РАСПОЗНАТЬ смысл каждого элемента и правильно сопоставить его с нужным полем, понимая КОНТЕКСТ и НАЗНАЧЕНИЕ каждого поля.`;

            const shape = '{ "game": {"title":"...","description":"...","author":"...","introduction":"...","backstory":"...","adventureHooks":"...","promoDescription":"...","winCondition":"...","loseCondition":"...","deathCondition":"..."}, "locations":[{"key":"loc1","order":1,"title":"...","description":"...","rulesPrompt":"...","parentKey":null}], "exits":[{"fromKey":"loc1","type":"BUTTON","buttonText":"Дальше","triggerText":"фраза для перехода","toKey":"loc2","isGameOver":false}], "characters":[{"name":"...","isPlayable":false,"race":"...","gender":"...","role":"...","origin":"...","persona":"...","abilities":"...","level":1,"class":"воин","hp":10,"maxHp":10,"ac":10,"str":14,"dex":12,"con":13,"int":10,"wis":11,"cha":9}] }';
            
            // Обрабатываем весь сценарий (может быть разбит на части)
            const scenarioChunkSize = 150000;
            const scenarioChunks: string[] = [];
            for (let i = 0; i < cleanScenarioText.length; i += scenarioChunkSize) {
              scenarioChunks.push(cleanScenarioText.slice(i, i + scenarioChunkSize));
            }
            console.log(`[INGEST-IMPORT] Stage 3: Processing ${scenarioChunks.length} chunks of scenario`);
            
            // Для сценария обрабатываем все части, но первую часть используем для основных полей игры
            let allLocations: any[] = [];
            let allExits: any[] = [];
            let allCharacters: any[] = [];
            let gameDataFromFirstChunk: any = null;
            
            for (let chunkIdx = 0; chunkIdx < scenarioChunks.length; chunkIdx++) {
              const chunk = scenarioChunks[chunkIdx];
              const isFirstChunk = chunkIdx === 0;
              
              const chunkSys = isFirstChunk ? sys : `Ты анализируешь ЧАСТЬ ${chunkIdx + 1} из ${scenarioChunks.length} файла сценария.
Из этой части извлеки ТОЛЬКО локации, персонажей и выходы (если они есть).
Основные поля игры (промо, введение, предыстория) уже извлечены из первой части.`;
              
              const chunkShape = isFirstChunk ? shape : '{ "locations":[...], "exits":[...], "characters":[...] }';
              
              const chunkPrompt = isFirstChunk 
                ? `Проанализируй файл СЦЕНАРИЯ ИГРЫ для настольной ролевой игры D&D 5e:

═══════════════════════════════════════════════════════════════════════════════
ФАЙЛ: СЦЕНАРИЙ ИГРЫ${scenarioChunks.length > 1 ? ` (часть 1 из ${scenarioChunks.length})` : ''}
═══════════════════════════════════════════════════════════════════════════════
---
${chunk}
---

Верни только JSON без комментариев, строго формы:
${shape}
${shape}

═══════════════════════════════════════════════════════════════════════════════
СЕМАНТИЧЕСКОЕ ОПИСАНИЕ ПОЛЕЙ И ИНСТРУКЦИИ ПО РАСПОЗНАВАНИЮ
═══════════════════════════════════════════════════════════════════════════════

ИЗ ФАЙЛА СЦЕНАРИЯ ИЗВЛЕКИ:

1. ПРОМО ОПИСАНИЕ (game.promoDescription):
   - Текст ПЕРЕД первым разделом "Введение"
   - Краткое привлекательное описание (2-4 предложения)
   - Художественный текст, который "продает" игру
   - Может начинаться с большой декоративной буквы

2. ВВЕДЕНИЕ (game.introduction):
   - РЕАЛЬНОЕ введение - описание начальной сцены
   - Где находятся персонажи, что они видят
   - Начинается с "Вы прибываете...", "Вы оказываетесь..."
   - НЕ метаинформация про уровень персонажей!

3. ПРЕДЫСТОРИЯ (game.backstory):
   - История мира/событий ДО начала игры
   - События, которые привели к текущей ситуации
   - Политическая ситуация, конфликты

4. ЗАЦЕПКИ ПРИКЛЮЧЕНИЯ (game.adventureHooks):
   - Способы начать приключение
   - Несколько вариантов (обычно 2-4)
   - Мотивация персонажей

5. ЛОКАЦИИ (locations[]):
   - ВАЖНО: Создавай локацию ТОЛЬКО если это РЕАЛЬНАЯ ИГРОВАЯ ЛОКАЦИЯ, где персонажи могут находиться и взаимодействовать
   - НЕ создавай локации для:
     * Описательных разделов (например, "Общая информация", "Введение", "Предыстория")
     * Мета-информации (правила, советы мастеру)
     * Разделов с персонажами (статистика НИП)
     * Разделов с условиями финала (если они не являются локациями)
   - РАСПОЗНАВАЙ ЛОКАЦИИ И ПОДЛОКАЦИИ:
     * Основные локации: "Часть 1", "Глава 1", крупные разделы с описанием места действия
     * Подлокации: вложенные разделы внутри глав (например, "Помещение с урнами", "Коридор с фальшивой дверью")
     * Если подлокация входит в основную локацию - используй order больше чем у родителя (например, основная локация order=1, подлокация order=1.1 или order=2)
   - ПРОВЕРЯЙ СТРУКТУРУ: Локация должна иметь:
     * Описание места (где находятся персонажи)
     * Упоминания о возможных действиях или переходах (даже если переходы не описаны явно)
     * Или явное указание, что это тупик/конечная точка
   - title, description для каждой (и основной, и подлокации)
   - rulesPrompt: НЕ копируй из PDF! Сгенерируй краткое описание (2-3 предложения):
     * Что окружает персонажей в этой локации (окружение, атмосфера)
     * Что нужно сделать в локации (действия, задачи, объекты для взаимодействия)
     * Что нужно сделать для перехода дальше (условия перехода, необходимые действия)
   - Пример: "Вы находитесь в темном подземелье. В центре комнаты стоит алтарь с древними рунами. Чтобы открыть дверь, нужно активировать все руны на алтаре."

6. ПЕРСОНАЖИ (characters[]):
   - Раздел "Приложение В. Статистика НИП" или похожий
   - ВСЕХ NPC с полной статистикой D&D 5e
   - isPlayable: false для всех NPC
   - ⚠️ КРИТИЧЕСКИ ВАЖНО: ОБЯЗАТЕЛЬНО заполни ВСЕ поля для каждого персонажа, включая ВСЕ статы D&D 5e!
   - ОБЯЗАТЕЛЬНЫЕ поля для каждого персонажа:
     * name: имя персонажа
     * race: раса (эльф, человек, гном, орк и т.д.)
     * gender: пол (мужской, женский, не указан)
     * role: роль в истории (страж, торговец, злодей, союзник и т.д.)
     * origin: происхождение (откуда родом, социальный статус)
     * persona: характер, личность (2-3 предложения о том, как персонаж ведет себя, говорит, что его мотивирует)
     * abilities: способности, навыки (магические способности, особые умения, заклинания)
     * class: класс D&D 5e (воин/Fighter, маг/Wizard, жрец/Cleric, плут/Rogue, варвар/Barbarian, паладин/Paladin, следопыт/Ranger, бард/Bard, друид/Druid, монах/Monk, колдун/Warlock, чародей/Sorcerer)
     * ⚠️ СТАТИСТИКА D&D 5e (ОБЯЗАТЕЛЬНО для ВСЕХ персонажей):
       - level: уровень персонажа (1-20, обычно 1-5 для обычных NPC, 5-10 для важных NPC, 10+ для боссов)
       - hp: текущие очки здоровья (обычно равно maxHp для начала)
       - maxHp: максимальные очки здоровья (рассчитывается по формуле: базовые HP класса × уровень + CON модификатор × уровень)
       - ac: класс брони (10 + DEX модификатор для легкой брони, или указанное в статистике)
       - str: сила (1-30, обычно 8-18 для NPC)
       - dex: ловкость (1-30, обычно 8-18 для NPC)
       - con: телосложение (1-30, обычно 8-18 для NPC)
       - int: интеллект (1-30, обычно 8-18 для NPC)
       - wis: мудрость (1-30, обычно 8-18 для NPC)
       - cha: харизма (1-30, обычно 8-18 для NPC)
   - ⚠️ ПРАВИЛА ЗАПОЛНЕНИЯ СТАТОВ:
     * Если статы указаны в PDF - используй их ТОЧНО
     * Если статы НЕ указаны в PDF - СГЕНЕРИРУЙ их на основе:
       - Класса персонажа (воин → высокий STR/CON, маг → высокий INT, жрец → высокий WIS, плут → высокий DEX)
       - Роли персонажа (страж → боевые статы, торговец → высокий CHA, ученый → высокий INT)
       - Уровня персонажа (более высокий уровень → более высокие статы и HP)
     * Базовые значения для обычных NPC (уровень 1-3):
       - Основная характеристика класса: 14-16
       - Вторичная характеристика: 12-14
       - Остальные: 8-12
       - HP: базовое HP класса × уровень + CON модификатор × уровень
       - AC: 10-15 (зависит от класса и брони)
     * Значения для важных NPC (уровень 4-8):
       - Основная характеристика класса: 16-18
       - Вторичная характеристика: 14-16
       - Остальные: 10-14
     * Значения для боссов (уровень 9+):
       - Основная характеристика класса: 18-20
       - Вторичная характеристика: 16-18
       - Остальные: 12-16
   - ⚠️ НИКОГДА не оставляй статы пустыми или равными 0! Всегда заполняй level, hp, maxHp, ac, str, dex, con, int, wis, cha реальными значениями!

7. ВЫХОДЫ (exits[]):
   - Связи между локациями (переходы)
   - КРИТИЧЕСКИ ВАЖНО: Анализируй КАЖДУЮ созданную локацию на наличие переходов:
     * ПРОВЕРЯЙ текст локации на упоминания: "дверь", "проход", "лестница", "коридор", "вернуться", "пойти", "перейти", "открыть", "спуститься", "подняться", "налево", "направо", "север", "юг", "восток", "запад", "дальше", "следующая", "вход", "выход"
     * ИЩИ упоминания других локаций по номерам: "Area 1", "Area 4", "Corridor 8", "area 3", "area 9", "area 11", "Area 4", "Corridor 8" и т.д. - если локация упоминается в тексте другой локации, это может означать переход!
     * ИЩИ упоминания других локаций по названиям: если в тексте локации упоминается название другой локации (например, "Главное святилище", "Кухня", "Спальня") - это может означать переход!
     * ИЩИ фразы о соединении: "соединяет Area 4 с Corridor 8", "служит для движения из Areas 6 и 7 в Areas 1 и 5", "соединяет... с...", "ведет из... в...", "доступ через... из...", "доступ к... через...", "используется для перетаскивания жертв через Area 1 в Area 11"
     * ИЩИ описания направлений: "северное крыло ведет в...", "южное крыло ведет в...", "направо...", "налево...", "дальше по коридору...", "северное крыло ведет в ванную (area 9)", "южное крыло ведет в Комнату потрошителя (area 11)"
     * ИЩИ секретные проходы: "секретный проход", "тайный коридор", "скрытый проход", "культисты могут показать секретный проход", "один из книг на полке активирует механизм", "чтобы попасть в Area 5, нужно сдвинуть одну из книг на полке"
     * ИЩИ упоминания использования: "используется для перехода", "служит для движения", "используется для перетаскивания жертв", "может служить быстрым способом выхода из святилища"
     * ИЩИ упоминания доступа: "доступ через каменную дверь из area 3", "доступ к... через...", "можно попасть через..."
     * Если в тексте локации ЕСТЬ упоминания о переходах - ОБЯЗАТЕЛЬНО создай exit для каждого перехода
     * Если в тексте локации НЕТ упоминаний о переходах И локация явно описана как тупик/конец - НЕ создавай выходы
     * Если локация является подлокацией - проверь, есть ли переходы из неё обратно в основную локацию или в другие подлокации
     * ВАЖНО: Если локация упоминается в тексте другой локации (по номеру или названию) - это СИГНАЛ о возможном переходе! Проверь контекст упоминания.
   - ВАЖНО: Извлекай ВСЕ переходы, которые описаны в тексте (явные И неявные):
     * Прямые переходы (из локации A в локацию B)
     * Неявные переходы ("соединяет Area 4 с Corridor 8" → создай переходы в обе стороны)
     * Переходы через упоминания ("доступ через каменную дверь из area 3" → создай переход из area 3 в эту локацию)
     * Переходы через направления ("северное крыло ведет в ванную (area 9)" → создай переход)
     * Переходы через функциональность ("служит для движения из Areas 6 и 7 в Areas 1 и 5" → создай переходы из 6→1, 6→5, 7→1, 7→5)
     * Обратные переходы (возврат назад, например "вернуться к...", "вернуться к Болвару")
     * Переходы через действия ("открыть дверь", "спуститься", "подняться", "спуститься в грот")
     * Переходы через выбор ("пойти налево", "пойти направо", "в северное крыло", "в южное крыло")
     * Секретные проходы ("культисты могут показать секретный проход", "один из книг на полке активирует механизм")
     * Переходы из подлокаций обратно в основную локацию (если описаны)
     * Переходы между подлокациями внутри одной части (если описаны)
   - ПРИМЕРЫ ИЗВЛЕЧЕНИЯ:
     * "5. Секретный коридор. Этот коридор соединяет Area 4 с Corridor 8" → создай переходы: из "5. Секретный коридор" в "4. Главное святилище" и в "8. Тайный коридор с перекрёстком", а также обратные переходы
     * "8. Тайный коридор с перекрёстком. Этот коридор служит для движения из Areas 6 и 7 в Areas 1 и 5" → создай переходы: из "6. Кухня" в "1. Помещение с урнами" и в "5. Секретный коридор", из "7. Спальня" в "1. Помещение с урнами" и в "5. Секретный коридор"
     * "10. Коридор с ловушкой. Доступ через каменную дверь из area 3. Северное крыло ведет в ванную (area 9), южное крыло ведет в Комнату потрошителя (area 11)" → создай переходы: из "3. Путь скорби" в "10. Коридор с ловушкой", из "10. Коридор с ловушкой" в "9. Ванная комната", из "10. Коридор с ловушкой" в "11. Комната потрошителя"
     * "Культисты могут показать секретный проход" → создай переход из "7. Спальня" в соответствующую локацию (обычно в "5. Секретный коридор" или "8. Тайный коридор с перекрёстком")
     * "5. Секретный коридор. Используется для перетаскивания жертв через Area 1 в Area 11" → создай переходы: из "1. Помещение с урнами" в "5. Секретный коридор", из "5. Секретный коридор" в "11. Комната потрошителя"
   - ВАЖНО: Проверяй не только текст самой локации, но и текст других локаций, которые могут упоминать эту локацию:
     * Если в локации A написано "доступ через... из локации B" → создай переход из локации B в локацию A
     * Если в локации A написано "ведет в локацию B" → создай переход из локации A в локацию B
     * Если в локации A написано "соединяет... с локацией B" → создай переходы в обе стороны
   - ПРАВИЛА ДЛЯ ТУПИКОВ:
     * Если локация описана как тупик (нет упоминаний о переходах, явно указано "тупик", "конец", "финал") - НЕ создавай для неё выходы
     * Если локация имеет только вход, но нет выхода (тупик) - это нормально, не создавай искусственные выходы
     * Если локация является финальной (winCondition/loseCondition/deathCondition) - может не иметь выходов
   - ПРОВЕРКА СВЯЗНОСТИ:
     * Стартовая локация (обычно order=1) должна иметь хотя бы один выход (если это не финальная локация)
     * Если локация не является тупиком и не является финальной - она должна иметь хотя бы один выход
     * Если создал локацию без выходов - убедись, что это действительно тупик/финал
   - fromKey: ключ локации, откуда переход
   - toKey: ключ локации, куда переход (может быть null только для явных тупиков/финалов)
   - type: "BUTTON" (кнопка) или "TRIGGER" (триггер-фраза)
   - buttonText: текст кнопки (если type="BUTTON"), должен точно соответствовать описанию в PDF или быть логичным (например, "Пойти в северное крыло", "Использовать секретный проход")
   - triggerText: ОБЯЗАТЕЛЬНО сгенерируй фразы для перехода (если type="TRIGGER" или для дополнения к BUTTON)
     * Это фразы, которые игрок может сказать для перехода
     * Примеры: "открыть дверь", "спуститься вниз", "осмотреть алтарь", "активировать руны", "вернуться назад", "вернуться к Болвару", "пойти налево", "пойти направо", "активировать механизм на полке"
     * Генерируй 2-3 варианта фраз через запятую
     * КРИТИЧЕСКИ ВАЖНО: triggerText должен быть КОНКРЕТНЫМ и ОДНОЗНАЧНЫМ, чтобы игрок мог легко выбрать нужный вариант
   - isGameOver: true ТОЛЬКО если это РЕАЛЬНЫЙ конец игры (победа, поражение, смерть), БЕЗ targetLocationId
     * КРИТИЧЕСКИ ВАЖНО: Если у exit есть toKey (targetLocationId), то isGameOver ДОЛЖЕН быть false!
     * isGameOver: true только для финальных exits БЕЗ toKey, которые завершают игру

8. УСЛОВИЯ ФИНАЛА:
   - winCondition, loseCondition, deathCondition
   - Обычно в конце документа

═══════════════════════════════════════════════════════════════════════════════
КРИТИЧЕСКИ ВАЖНО:
═══════════════════════════════════════════════════════════════════════════════

1. ПОНИМАЙ СМЫСЛ: Анализируй СОДЕРЖИМОЕ, а не только заголовки
2. ПРАВИЛЬНО СОПОСТАВЛЯЙ: Каждый элемент в правильное поле
3. ИЗВЛЕКАЙ ВСЁ: Не обрезай текст, извлекай полностью
4. НЕ ПРИДУМЫВАЙ: Только реальные данные, если нет - верни null

Верни ТОЛЬКО JSON, никаких комментариев!`
                : `Проанализируй ЧАСТЬ ${chunkIdx + 1} из ${scenarioChunks.length} файла СЦЕНАРИЯ ИГРЫ:

═══════════════════════════════════════════════════════════════════════════════
ЧАСТЬ ${chunkIdx + 1}/${scenarioChunks.length}: СЦЕНАРИЙ ИГРЫ
═══════════════════════════════════════════════════════════════════════════════
---
${chunk}
---

Из ЭТОЙ ЧАСТИ извлеки ТОЛЬКО:
- locations[] (если есть локации в этой части)
- characters[] (если есть персонажи в этой части)
- exits[] (если есть выходы в этой части)

Верни только JSON без комментариев, строго формы:
${chunkShape}`;
              
              console.log(`[INGEST-IMPORT] Stage 3: Processing chunk ${chunkIdx + 1}/${scenarioChunks.length}...`);
              const result = await generateChatCompletion({
                systemPrompt: chunkSys,
                userPrompt: chunkPrompt,
                history: []
              });
              
              const content = result?.text || '';
              if (content && content.trim().includes('{')) {
                // Убираем markdown обертку (```json ... ```)
                let cleaned = content.trim();
                if (cleaned.startsWith('```')) {
                  const jsonStart = cleaned.indexOf('{');
                  const jsonEnd = cleaned.lastIndexOf('}');
                  if (jsonStart >= 0 && jsonEnd >= 0 && jsonEnd > jsonStart) {
                    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
                  } else {
                    const codeBlockMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
                    if (codeBlockMatch && codeBlockMatch[1]) {
                      cleaned = codeBlockMatch[1];
                    }
                  }
                } else {
                  const startIdx = cleaned.indexOf('{');
                  const endIdx = cleaned.lastIndexOf('}');
                  if (startIdx >= 0 && endIdx >= 0 && endIdx > startIdx) {
                    cleaned = cleaned.slice(startIdx, endIdx + 1);
                  }
                }
                
                try {
                  const chunkData = JSON.parse(cleaned);
                  
                  // Для первого чанка сохраняем данные игры
                  if (isFirstChunk && chunkData.game) {
                    gameDataFromFirstChunk = chunkData.game;
                  }
                  
                  // Собираем локации, выходы и персонажей из всех чанков
                  if (Array.isArray(chunkData.locations) && chunkData.locations.length > 0) {
                    allLocations.push(...chunkData.locations);
                  }
                  if (Array.isArray(chunkData.exits) && chunkData.exits.length > 0) {
                    allExits.push(...chunkData.exits);
                  }
                  if (Array.isArray(chunkData.characters) && chunkData.characters.length > 0) {
                    allCharacters.push(...chunkData.characters);
                  }
                  
                  console.log(`[INGEST-IMPORT] Stage 3: Chunk ${chunkIdx + 1} processed - locations: ${chunkData.locations?.length || 0}, exits: ${chunkData.exits?.length || 0}, characters: ${chunkData.characters?.length || 0}`);
                } catch (parseError) {
                  console.error(`[INGEST-IMPORT] Stage 3: Failed to parse JSON for chunk ${chunkIdx + 1}:`, parseError);
                }
              }
            }
            
            // Объединяем результаты из всех чанков
            if (gameDataFromFirstChunk) {
              const existingRules = {
                worldRules: scenario.game.worldRules,
                gameplayRules: scenario.game.gameplayRules
              };
              Object.assign(scenario.game, gameDataFromFirstChunk);
              if (existingRules.worldRules) scenario.game.worldRules = existingRules.worldRules;
              if (existingRules.gameplayRules) scenario.game.gameplayRules = existingRules.gameplayRules;
            }
            
            if (allLocations.length > 0) {
              scenario.locations = allLocations;
              console.log(`[INGEST-IMPORT] Stage 3: Total locations from all chunks: ${allLocations.length}`);
            }
            if (allExits.length > 0) {
              scenario.exits = allExits;
              console.log(`[INGEST-IMPORT] Stage 3: Total exits from all chunks: ${allExits.length}`);
            }
            if (allCharacters.length > 0) {
              scenario.characters.push(...allCharacters);
              console.log(`[INGEST-IMPORT] Stage 3: Total characters from all chunks: ${allCharacters.length}`);
            }
            
            console.log(`[INGEST-IMPORT] Stage 3 complete: Scenario processed from ${scenarioChunks.length} chunks`);
          } catch (e) {
            console.error('[INGEST-IMPORT] Game analysis failed:', e);
            console.error('[INGEST-IMPORT] Error stack:', (e as Error).stack);
          }
        }
        
        const ensureScenario = (sc: any) => {
          const extractSections = (srcText: string): Array<{ title: string; body: string }> => {
            const markers: RegExp[] = [
              /^\s*(Глава|Локация|Сцена|Часть)\s+([^\n]{3,100})/gmi,
              /^\s*\d+[\.\)]\s+([A-Za-zА-Яа-яЁё0-9][^\n]{3,100})/gm,
              /^\s*#{1,3}\s+([^\n]{3,100})/gm,
            ];
            let matches: Array<{ title: string; index: number }> = [];
            for (const re of markers) {
              const m: Array<{ title: string; index: number }> = [];
              let r: RegExpExecArray | null;
              while ((r = re.exec(srcText)) !== null) {
                const t = (r[2] || r[1] || '').toString().trim();
                if (t) m.push({ title: t, index: r.index });
              }
              if (m.length >= 3) { matches = m; break; }
            }
            const out: Array<{ title: string; body: string }> = [];
            if (matches.length >= 2) {
              for (let i = 0; i < matches.length; i++) {
                const cur = matches[i];
                const next = matches[i + 1];
                const body = srcText.slice(cur.index, next ? next.index : undefined);
                const cleanBody = body.split('\n').slice(1).join('\n').trim();
                const b = cleanBody ? cleanBody.slice(0, 1800) : '';
                out.push({ title: cur.title, body: b });
                if (out.length >= 14) break;
              }
              return out.filter(s => s.title && s.body);
            }
            const paragraphs = srcText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
            const chunks: string[] = [];
            let buf = '';
            for (const p of paragraphs) {
              if ((buf + '\n\n' + p).length > 1200) {
                if (buf) chunks.push(buf);
                buf = p;
              } else {
                buf = buf ? (buf + '\n\n' + p) : p;
              }
              if (chunks.length >= 12) break;
            }
            if (buf && chunks.length < 14) chunks.push(buf);
            return chunks.map((c, i) => {
              const first = c.split(/[\.!\?]\s/)[0] || 'Сцена';
              const title = (first.trim().slice(0, 60) || `Сцена ${i + 1}`);
              return { title, body: c.slice(0, 1800) };
            });
          };
          const out: any = sc && typeof sc === 'object' ? sc : {};
          const scenarioFileName = scenarioFile?.originalname || 'Scenario';
          out.game = out.game || { 
            title: scenarioFileName.replace(/\.(pdf|txt)$/i, ''), 
            description: `Импортировано из файлов правил и сценария`, 
            author: 'GM', 
            worldRules: null, 
            gameplayRules: null 
          };
          
          // НЕТ FALLBACK - если AI не извлек данные, поля остаются пустыми
          // Все данные должны быть извлечены AI из промпта
          // НЕ создаем искусственные выходы - если AI не нашел переходы, значит их нет в PDF
          // Тупики (локации без выходов) - это нормально для D&D приключений
          if (!Array.isArray(out.exits)) {
            out.exits = [];
          }
          if (!Array.isArray(out.characters)) out.characters = [];
          
          // НЕТ FALLBACK - персонажи должны быть извлечены AI
          
          // Убираем дубликаты по имени (на всякий случай)
          const uniqueChars = new Map<string, any>();
          for (const char of out.characters) {
            if (char.name) {
              const key = char.name.toLowerCase();
              if (!uniqueChars.has(key)) {
                uniqueChars.set(key, char);
              } else {
                // Если уже есть, берем более полную версию
                const existing = uniqueChars.get(key);
                const existingFields = Object.keys(existing).filter(k => existing[k] !== null && existing[k] !== undefined && existing[k] !== '' && existing[k] !== 0 && existing[k] !== 10);
                const newFields = Object.keys(char).filter(k => char[k] !== null && char[k] !== undefined && char[k] !== '' && char[k] !== 0 && char[k] !== 10);
                if (newFields.length > existingFields.length) {
                  uniqueChars.set(key, char);
                }
              }
            }
          }
          out.characters = Array.from(uniqueChars.values());
          // Fallback удален - только реальные данные из файлов
          if (!Array.isArray(out.editions) || !out.editions.length) out.editions = [{ name: 'Стандарт', description: '—', price: 0, badge: null }];
          return out;
        };
        scenario = ensureScenario(scenario);
        set({ progress: 'Сохранение игры...' });
        const prisma = getPrisma();
        const g = scenario.game || {};
        const scenarioFileName = scenarioFile?.originalname || 'Scenario';
        const game = await prisma.game.create({
          data: {
            title: g.title || scenarioFileName.replace(/\.(pdf|txt)$/i, ''),
            description: g.description || `Импортировано из файлов правил и сценария`,
            author: g.author || 'GM',
            coverUrl: g.coverUrl || '',
            tags: g.tags || [],
            rules: g.rules || '',
            worldRules: g.worldRules || null,
            gameplayRules: g.gameplayRules || null,
            rulesPdfPath: g.rulesPdfPath || null, // Путь к PDF с правилами игры (ОДИН ФАЙЛ)
            scenarioPdfPath: g.scenarioPdfPath || null, // Путь к PDF со сценарием (ВТОРОЙ ФАЙЛ)
            introduction: g.introduction || null,
            backstory: g.backstory || null,
            adventureHooks: g.adventureHooks || null,
            promoDescription: g.promoDescription || null,
            marketplaceLinks: g.marketplaceLinks || [],
            shelfCategory: g.shelfCategory || null,
            shelfPosition: typeof g.shelfPosition === 'number' ? g.shelfPosition : null,
            bannerStyle: g.bannerStyle || null,
            ageRating: g.ageRating || null,
            status: g.status || 'DRAFT',
            winCondition: g.winCondition || null,
            loseCondition: g.loseCondition || null,
            deathCondition: g.deathCondition || null,
          },
        });
        
        // АВТОМАТИЧЕСКАЯ индексация правил для RAG в ФОНОВОМ режиме (не блокирует создание локаций)
        // ДВА ФАЙЛА: rulesPdfPath (правила игры) и scenarioPdfPath (сценарий)
        const rulesPdfPath = g.rulesPdfPath;
        if (rulesPdfPath || g.scenarioPdfPath) {
          set({ progress: 'Запуск индексации RAG в фоне...' });
          console.log(`[INGEST-IMPORT] 🔍 Запуск автоматической индексации RAG для игры ${game.id} в фоновом режиме...`);
          console.log(`[INGEST-IMPORT] 📄 Файлы: rules=${rulesPdfPath || 'нет'}, scenario=${g.scenarioPdfPath || 'нет'}`);
          
          // Запускаем индексацию в фоне, не ждем её завершения
          setImmediate(async () => {
            try {
              console.log(`[INGEST-IMPORT] 🔍 Начало фоновой индексации RAG для игры ${game.id}...`);
              console.log(`[INGEST-IMPORT] 📄 Передаем в indexRulesForRAG: rulesPdfPath=${rulesPdfPath || 'null'}, scenarioPdfPath=${g.scenarioPdfPath || 'null'}`);
              await indexRulesForRAG(prisma, game.id, rulesPdfPath || null, g.scenarioPdfPath || null);
              const chunkCount = await prisma.ruleChunk.count({ where: { gameId: game.id } });
              const scenarioChunkCount = await prisma.ruleChunk.count({ where: { gameId: game.id, chunkType: 'scenario' } });
              console.log(`[INGEST-IMPORT] ✅ RAG индексация завершена для игры ${game.id}: ${chunkCount} чанков проиндексировано (scenario: ${scenarioChunkCount})`);
              
              // Обновляем прогресс, если job еще активен
              const currentJob = ingestJobs.get(jobId);
              if (currentJob && currentJob.status === 'running') {
                ingestJobs.set(jobId, { ...currentJob, progress: `Индексация RAG завершена: ${chunkCount} чанков` });
              }
            } catch (e) {
              console.error(`[INGEST-IMPORT] ❌ Ошибка индексации RAG:`, e);
              // Не прерываем процесс, если индексация не удалась - игра уже создана
            }
          });
          
          console.log(`[INGEST-IMPORT] ✅ Индексация RAG запущена в фоне, продолжаем создание локаций...`);
        } else {
          console.log(`[INGEST-IMPORT] ⚠️ Индексация RAG не запущена: нет PDF файлов (scenario или rules)`);
        }
        const keyToId = new Map<string, string>();
        // Сначала создаем все основные локации (без parentKey)
        const locationsWithoutParent = scenario.locations.filter((l: any) => !l.parentKey);
        const locationsWithParent = scenario.locations.filter((l: any) => l.parentKey);
        
        for (let i = 0; i < locationsWithoutParent.length; i++) {
          const l = locationsWithoutParent[i] || {};
          const order = Number(l.order || i + 1);
          const created = await prisma.location.create({
            data: {
              gameId: game.id, order,
              title: l.title || `Локация ${order}`,
              description: l.description || null,
              rulesPrompt: l.rulesPrompt || null,
              backgroundUrl: l.backgroundUrl || null,
              layout: l.layout || null,
              musicUrl: l.musicUrl || null,
            },
          });
          if (l.key) keyToId.set(String(l.key), created.id);
        }
        
        // Затем создаем подлокации (с parentKey)
        // Примечание: parentLocationId не существует в схеме, поэтому подлокации создаются как обычные локации
        // но с увеличенным order для группировки
        for (let i = 0; i < locationsWithParent.length; i++) {
          const l = locationsWithParent[i] || {};
          const parentId = l.parentKey ? keyToId.get(String(l.parentKey)) : null;
          const parentOrder = parentId ? (await prisma.location.findUnique({ where: { id: parentId }, select: { order: true } }))?.order || 0 : 0;
          const order = Number(l.order || parentOrder + (i + 1) * 0.1);
          const created = await prisma.location.create({
            data: {
              gameId: game.id, order,
              title: l.title || `Подлокация ${i + 1}`,
              description: l.description || null,
              rulesPrompt: l.rulesPrompt || null,
              backgroundUrl: l.backgroundUrl || null,
              layout: l.layout || null,
              musicUrl: l.musicUrl || null,
            },
          });
          if (l.key) keyToId.set(String(l.key), created.id);
        }
        
        // Генерируем rulesPrompt для локаций, где он пустой
        const locationsToUpdate = await prisma.location.findMany({
          where: { gameId: game.id, OR: [{ rulesPrompt: null }, { rulesPrompt: '' }] },
        });
        
        if (locationsToUpdate.length > 0) {
          console.log(`[INGEST-IMPORT] Generating rulesPrompt for ${locationsToUpdate.length} locations`);
          for (const loc of locationsToUpdate) {
            if (!loc.description || loc.description.trim().length < 10) continue;
            
            try {
              const prompt = `На основе описания локации из настольной ролевой игры D&D 5e, создай краткое описание "Правил Локации" (2-3 предложения):

ОПИСАНИЕ ЛОКАЦИИ:
${loc.description}

ПРАВИЛА ЛОКАЦИИ должны содержать:
1. Что окружает персонажей (окружение, атмосфера, что они видят)
2. Что нужно сделать в локации (действия, задачи, объекты для взаимодействия)
3. Что нужно сделать для перехода дальше (условия перехода, необходимые действия)

Верни ТОЛЬКО текст правил локации, без заголовков и пояснений.`;

              const result = await generateChatCompletion({
                systemPrompt: 'Ты помощник для создания правил локаций в настольных ролевых играх. Создавай краткие, понятные описания.',
                userPrompt: prompt,
                apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY || process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY,
              });
              
              const generatedRules = result?.text?.trim() || '';
              if (generatedRules && generatedRules.length > 20) {
                await prisma.location.update({
                  where: { id: loc.id },
                  data: { rulesPrompt: generatedRules.slice(0, 500) },
                });
                console.log(`[INGEST-IMPORT] Generated rulesPrompt for location: ${loc.title}`);
              }
            } catch (e) {
              console.error(`[INGEST-IMPORT] Failed to generate rulesPrompt for location ${loc.id}:`, e);
            }
          }
        }
        
        let createdExits = 0;
        for (const e of scenario.exits) {
          const fromId = keyToId.get(String(e.fromKey || ''));
          const toId = e.toKey ? keyToId.get(String(e.toKey)) : null;
          if (!fromId) continue;
          // КРИТИЧЕСКИ ВАЖНО: Если у exit есть targetLocationId (переход в другую локацию), то isGameOver ДОЛЖЕН быть false
          // isGameOver: true только для финальных exits БЕЗ targetLocationId (завершение игры)
          const isGameOver = toId ? false : Boolean(e.isGameOver);
          await prisma.locationExit.create({
            data: {
              locationId: fromId,
              type: (e.type || 'BUTTON') as any,
              buttonText: e.buttonText || null,
              triggerText: e.triggerText || null,
              targetLocationId: toId || null,
              isGameOver,
            },
          });
          createdExits++;
        }
        
        // ═══════════════════════════════════════════════════════════════════════════════
        // ПРОВЕРКА СВЯЗНОСТИ ЛОКАЦИЙ И ВЫХОДОВ
        // ═══════════════════════════════════════════════════════════════════════════════
        const allLocations = await prisma.location.findMany({
          where: { gameId: game.id },
          include: { exits: true },
        });
        
        const locationsWithExits = new Set<string>();
        const locationsWithIncomingExits = new Set<string>();
        
        for (const loc of allLocations) {
          if (loc.exits && loc.exits.length > 0) {
            locationsWithExits.add(loc.id);
            for (const exit of loc.exits) {
              if (exit.targetLocationId) {
                locationsWithIncomingExits.add(exit.targetLocationId);
              }
            }
          }
        }
        
        // Проверяем локации без выходов
        const locationsWithoutExits = allLocations.filter(loc => !locationsWithExits.has(loc.id));
        if (locationsWithoutExits.length > 0) {
          console.log(`[INGEST-IMPORT] ⚠️  Найдено ${locationsWithoutExits.length} локаций без выходов:`);
          for (const loc of locationsWithoutExits) {
            const isStartLocation = loc.order === 1 || loc.order === Math.min(...allLocations.map(l => l.order || 999));
            const isFinalLocation = scenario.game?.winCondition || scenario.game?.loseCondition || scenario.game?.deathCondition;
            const description = loc.description || '';
            const isDeadEnd = description.toLowerCase().includes('тупик') || 
                             description.toLowerCase().includes('конец') || 
                             description.toLowerCase().includes('финал') ||
                             description.toLowerCase().includes('завершени');
            
            if (isStartLocation && !isDeadEnd) {
              console.log(`[INGEST-IMPORT] ⚠️  СТАРТОВАЯ локация "${loc.title}" (order=${loc.order}) не имеет выходов! Это может быть ошибкой.`);
            } else if (!isDeadEnd && !isFinalLocation) {
              console.log(`[INGEST-IMPORT] ⚠️  Локация "${loc.title}" (order=${loc.order}) не имеет выходов. Проверь, является ли она тупиком/финалом.`);
            } else {
              console.log(`[INGEST-IMPORT] ✓ Локация "${loc.title}" (order=${loc.order}) без выходов - вероятно, тупик/финал (это нормально).`);
            }
          }
        }
        
        // Проверяем изолированные локации (без входящих и исходящих переходов)
        const isolatedLocations = allLocations.filter(loc => 
          !locationsWithExits.has(loc.id) && !locationsWithIncomingExits.has(loc.id)
        );
        if (isolatedLocations.length > 0) {
          console.log(`[INGEST-IMPORT] ⚠️  ⚠️  КРИТИЧНО: Найдено ${isolatedLocations.length} ИЗОЛИРОВАННЫХ локаций (без входящих и исходящих переходов):`);
          for (const loc of isolatedLocations) {
            console.log(`[INGEST-IMPORT] ⚠️  - "${loc.title}" (order=${loc.order}, id=${loc.id})`);
          }
        }
        
        // Проверяем стартовую локацию
        const startLocation = allLocations.find(loc => loc.order === 1 || loc.order === Math.min(...allLocations.map(l => l.order || 999)));
        if (startLocation && !locationsWithExits.has(startLocation.id)) {
          console.log(`[INGEST-IMPORT] ⚠️  ⚠️  КРИТИЧНО: Стартовая локация "${startLocation.title}" не имеет выходов! Игра не может начаться.`);
        }
        
        console.log(`[INGEST-IMPORT] ✓ Проверка связности завершена. Всего локаций: ${allLocations.length}, с выходами: ${locationsWithExits.size}, изолированных: ${isolatedLocations.length}`);
        for (const c of (scenario.characters || [])) {
          const abilitiesValue =
            Array.isArray(c.abilities) ? c.abilities.filter((s: any) => typeof s === 'string' && s.trim()).join('\n') :
            (typeof c.abilities === 'string' ? c.abilities : null);
          await prisma.character.create({
            data: {
              gameId: game.id,
              name: c.name || 'Персонаж',
              gender: c.gender || null,
              race: c.race || null,
              avatarUrl: c.avatarUrl || `https://picsum.photos/seed/${Math.random().toString(36).slice(2)}/80/80`,
              description: c.description || null,
              rating: typeof c.rating === 'number' ? c.rating : null,
              role: c.role || null,
              voiceId: c.voiceId || null,
              persona: c.persona || null,
              origin: c.origin || null,
              isPlayable: Boolean(c.isPlayable),
              abilities: abilitiesValue,
              level: Number.isFinite(c.level) ? Number(c.level) : undefined,
              class: c.class || null,
              hp: Number.isFinite(c.hp) ? Number(c.hp) : undefined,
              maxHp: Number.isFinite(c.maxHp) ? Number(c.maxHp) : undefined,
              ac: Number.isFinite(c.ac) ? Number(c.ac) : undefined,
              str: Number.isFinite(c.str) ? Number(c.str) : undefined,
              dex: Number.isFinite(c.dex) ? Number(c.dex) : undefined,
              con: Number.isFinite(c.con) ? Number(c.con) : undefined,
              int: Number.isFinite(c.int) ? Number(c.int) : undefined,
              wis: Number.isFinite(c.wis) ? Number(c.wis) : undefined,
              cha: Number.isFinite(c.cha) ? Number(c.cha) : undefined,
              skills: c.skills || null,
              inventory: c.inventory || null,
              spells: c.spells || null,
              equipment: c.equipment || null,
            },
          });
        }
        for (const e of (scenario.editions || [])) {
          await prisma.edition.create({
            data: {
              gameId: game.id,
              name: e.name || 'Стандарт',
              description: e.description || '',
              price: typeof e.price === 'number' ? e.price : 0,
              badge: e.badge || null,
            },
          });
        }
        
        // Теги генерируются AI и могут быть добавлены в tags массив, если нужно
        // Пока убираем отдельную генерацию, так как поля descriptionTags и promoDescriptionTags нет в схеме
        
        // Валидация: проверка наличия игровых персонажей
        const playableChars = await prisma.character.findMany({ 
          where: { gameId: game.id, isPlayable: true } 
        });
        if (playableChars.length === 0) {
          // При импорте создаем дефолтного игрового персонажа, если его нет
          console.log('[INGEST-IMPORT] No playable characters found, creating default character');
          await prisma.character.create({
            data: {
              gameId: game.id,
              name: 'Игрок',
              isPlayable: true,
              race: 'Человек',
              gender: 'Не указан',
              level: 1,
              class: 'Авантюрист',
              hp: 10,
              maxHp: 10,
              ac: 10,
              str: 10,
              dex: 10,
              con: 10,
              int: 10,
              wis: 10,
              cha: 10,
              avatarUrl: `https://picsum.photos/seed/player_${game.id}/80/80`,
              description: 'Игровой персонаж по умолчанию. Вы можете изменить его в разделе "Персонажи".'
            }
          });
          console.log('[INGEST-IMPORT] Default playable character created');
        }
        
        set({ progress: 'Generate backgrounds' });
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
        const oaKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
        const locList = await prisma.location.findMany({ where: { gameId: game.id }, orderBy: { order: 'asc' } });
        let done = 0;
        for (const loc of locList) {
          if (done >= 8) break;
          if (loc.backgroundUrl) continue;
          const guidance = 'Атмосферный фон сцены (без текста и водяных знаков). Киношный свет, глубина, без крупных персонажей.';
          const worldRulesForAI = (g as any)?.worldRulesFull || g.worldRules || '';
          const gameplayRulesForAI = (g as any)?.gameplayRulesFull || g.gameplayRules || '';
          const prompt = [guidance, `Сцена: ${loc.title}`, (loc.description || ''), worldRulesForAI, gameplayRulesForAI].filter(Boolean).join('\n\n').slice(0, 1600);
          let b64 = '';
          try {
            if (geminiKey) b64 = await generateViaGemini(prompt, '1536x1024', geminiKey);
            if (!b64 && oaKey) {
              try {
                const client = createOpenAIClient(oaKey);
                const img = await client.images.generate({ model: 'gpt-image-1', prompt, size: '1536x1024', quality: 'high' } as any);
                b64 = img?.data?.[0]?.b64_json || '';
                const url = img?.data?.[0]?.url || '';
                if (!b64 && url) {
                  const r = await undiciFetch(url);
                  const buf = Buffer.from(await r.arrayBuffer());
                  b64 = buf.toString('base64');
                }
              } catch {}
            }
          } catch {}
          if (b64) {
            try {
              const buf = Buffer.from(b64, 'base64');
              const fname = `bg_${game.id}_${loc.id}.png`;
              const dir = path.join(UPLOAD_DIR, 'image');
              try { fs.mkdirSync(dir, { recursive: true }); } catch {}
              fs.writeFileSync(path.join(dir, fname), buf);
              await prisma.location.update({ where: { id: loc.id }, data: { backgroundUrl: `/uploads/image/${fname}` } });
              done++;
            } catch {}
          }
        }
        
        set({ status: 'done', gameId: game.id, progress: 'Completed' });
      } catch (e: any) {
        console.error('ingest_import_job_error', e);
        set({ status: 'error', error: (e?.message || String(e)).slice(0, 500) });
      }
    })();
  } catch (e: any) {
    console.error('[INGEST-IMPORT] Error in handler:', e);
    const errorMsg = e?.message || String(e) || 'unknown_error';
    return res.status(500).json({ error: 'ingest_start_failed', details: errorMsg });
  }
});

// Endpoint для проверки статуса RAG индексации
app.get('/api/admin/games/:id/rag-status', async (req, res) => {
  try {
    const prisma = getPrisma();
    const game = await prisma.game.findUnique({ 
      where: { id: req.params.id },
      select: { 
        id: true, 
        title: true,
        rulesPdfPath: true,
        scenarioPdfPath: true
      }
    });
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    const chunks = await prisma.ruleChunk.findMany({
      where: { gameId: game.id },
      select: { chunkType: true }
    });
    
    const worldChunks = chunks.filter(c => c.chunkType === 'worldRules').length;
    const gameplayChunks = chunks.filter(c => c.chunkType === 'gameplayRules').length;
    const scenarioChunks = chunks.filter(c => c.chunkType === 'scenario').length;
    const totalChunks = chunks.length;
    
    res.json({
      gameId: game.id,
      gameTitle: game.title,
      hasRulesPdf: !!(game as any).rulesPdfPath,
      hasScenarioPdf: !!(game as any).scenarioPdfPath,
      indexed: {
        total: totalChunks,
        worldRules: worldChunks,
        gameplayRules: gameplayChunks,
        scenario: scenarioChunks
      },
      status: totalChunks > 0 ? 'indexed' : 'not_indexed'
    });
  } catch (e: any) {
    console.error('[RAG-STATUS] Failed to get RAG status:', e);
    res.status(500).json({ error: 'status_check_failed', details: String(e) });
  }
});

app.get('/api/admin/ingest-import/:id', async (req, res) => {
  const j = ingestJobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not_found' });
  return res.json(j);
});

app.post('/api/admin/locations/:id/generate-background', async (req, res) => {
  try {
    const prisma = getPrisma();
    const id = String(req.params.id);
    const size = String(req.query.size || req.body?.size || '1536x1024');
    const provider = String(req.query.provider || req.body?.provider || '').toLowerCase(); 
    const loc = await prisma.location.findUnique({ where: { id } });
    if (!loc) return res.status(404).json({ error: 'location_not_found' });
    const game = await prisma.game.findUnique({ where: { id: loc.gameId } });
    if (!game) return res.status(404).json({ error: 'game_not_found' });
    const guidance = 'Атмосферный реалистичный фон сцены для приключенческой ролевой игры. Без текста и водяных знаков. Киношный свет, глубина, без персонажей крупным планом.';
    const worldRulesForAI = (game as any)?.worldRulesFull || game.worldRules || '';
    const gameplayRulesForAI = (game as any)?.gameplayRulesFull || game.gameplayRules || '';
    const prompt = [guidance, `Сцена: ${loc.title}`, (loc.description || ''), worldRulesForAI, gameplayRulesForAI]
      .filter(Boolean).join('\n\n').slice(0, 1800);
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    const oaKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    const stabilityKey = process.env.STABILITY_API_KEY;
    console.log('[BGGEN] request', { locId: id, size, provider: provider || 'auto', promptLen: prompt.length, title: loc.title });
    let b64 = '';
    try {
      if (provider === 'gemini') {
        if (!geminiKey) return res.status(400).json({ error: 'gemini_key_missing' });
        try {
          b64 = await generateViaGemini(prompt, size, geminiKey);
        } catch (e) {
          console.error('[BGGEN] gemini error', e);
        }
      } else if (provider === 'openai') {
        if (!oaKey) return res.status(400).json({ error: 'openai_key_missing' });
        try {
          const client = createOpenAIClient(oaKey);
          const img = await client.images.generate({ model: 'gpt-image-1', prompt, size, quality: 'high' } as any);
          b64 = img?.data?.[0]?.b64_json || '';
          const url = img?.data?.[0]?.url || '';
          if (!b64 && url) {
            const r = await undiciFetch(url);
            const buf = Buffer.from(await r.arrayBuffer());
            b64 = buf.toString('base64');
          }
        } catch (e) {
          console.error('[BGGEN] openai error', e);
        }
      } else if (provider === 'stability') {
        if (!stabilityKey) return res.status(400).json({ error: 'stability_key_missing' });
        try {
          const r = await undiciFetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${stabilityKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text_prompts: [{ text: prompt, weight: 1 }],
              cfg_scale: 7,
              height: 1024,
              width: 1024,
              samples: 1,
              steps: 30,
            }),
          });
          if (!r.ok) {
            const body = await r.text();
            console.error('[BGGEN] stability http', r.status, body.slice(0, 200));
          } else {
            const j = await r.json();
            b64 = j?.artifacts?.[0]?.base64 || '';
          }
        } catch (e) {
          console.error('[BGGEN] stability error', e);
        }
      } else {
        if (geminiKey) {
          try { b64 = await generateViaGemini(prompt, size, geminiKey); } catch (e) {
            console.error('[BGGEN] gemini auto error', e);
          }
        }
        if (!b64 && oaKey) {
          try {
            const client = createOpenAIClient(oaKey);
            const img = await client.images.generate({ model: 'gpt-image-1', prompt, size, quality: 'high' } as any);
            b64 = img?.data?.[0]?.b64_json || '';
            const url = img?.data?.[0]?.url || '';
            if (!b64 && url) {
              const r = await undiciFetch(url);
              const buf = Buffer.from(await r.arrayBuffer());
              b64 = buf.toString('base64');
            }
          } catch (e) {
            console.error('[BGGEN] openai auto error', e);
          }
        }
        if (!b64 && stabilityKey) {
          try {
            const r = await undiciFetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${stabilityKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text_prompts: [{ text: prompt, weight: 1 }],
                cfg_scale: 7,
                height: 1024,
                width: 1024,
                samples: 1,
                steps: 30,
              }),
            });
            if (!r.ok) {
              const body = await r.text();
              console.error('[BGGEN] stability auto http', r.status, body.slice(0, 200));
            } else {
              const j = await r.json();
              b64 = j?.artifacts?.[0]?.base64 || '';
            }
          } catch (e) {
            console.error('[BGGEN] stability auto error', e);
          }
        }
      }
    } catch (e) {
      console.error('[BGGEN] error', e);
    }
    if (!b64) return res.status(502).json({ error: 'image_generation_failed', providerTried: provider || 'auto' });
    const buf = Buffer.from(b64, 'base64');
    const fname = `bg_${loc.gameId}_${loc.id}_${Date.now()}.png`;
    const dir = path.join(UPLOAD_DIR, 'image');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    fs.writeFileSync(path.join(dir, fname), buf);
    const url = `/uploads/image/${fname}`;
    await prisma.location.update({ where: { id: loc.id }, data: { backgroundUrl: url } });
    return res.json({ ok: true, url });
  } catch (e) {
    return res.status(500).json({ error: 'generate_background_failed', details: String(e) });
  }
});

app.post('/api/admin/scenario/import', async (req, res) => {
  try {
    const body = req.body as any;
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });
    const g = body.game || {};
    if (!g.title) return res.status(400).json({ error: 'title_required' });
    const locs = Array.isArray(body.locations) ? body.locations : [];
    const exs = Array.isArray(body.exits) ? body.exits : [];
    const chars = Array.isArray(body.characters) ? body.characters : [];
    const eds = Array.isArray(body.editions) ? body.editions : [];
    const prisma = getPrisma();
    const game = await prisma.game.create({
      data: {
        title: g.title,
        description: g.description || '',
        author: g.author || 'Автор',
        coverUrl: g.coverUrl || '',
        tags: g.tags || [],
        rules: g.rules || '',
        worldRules: g.worldRules || null,
        gameplayRules: g.gameplayRules || null,
        introduction: g.introduction || null,
        backstory: g.backstory || null,
        adventureHooks: g.adventureHooks || null,
        promoDescription: g.promoDescription || null,
        marketplaceLinks: g.marketplaceLinks || [],
        shelfCategory: g.shelfCategory || null,
        shelfPosition: typeof g.shelfPosition === 'number' ? g.shelfPosition : null,
        bannerStyle: g.bannerStyle || null,
        ageRating: g.ageRating || null,
        status: g.status || 'DRAFT',
      },
    });
    const keyToId = new Map<string, string>();
    for (let i = 0; i < locs.length; i++) {
      const l = locs[i] || {};
      const order = Number(l.order || i + 1);
      const created = await prisma.location.create({
        data: {
          gameId: game.id,
          order,
          title: l.title || `Локация ${order}`,
          description: l.description || null,
          rulesPrompt: l.rulesPrompt || null,
          backgroundUrl: l.backgroundUrl || null,
          layout: l.layout || null,
          musicUrl: l.musicUrl || null,
        },
      });
      if (l.key) keyToId.set(String(l.key), created.id);
    }
    let createdExits = 0;
    for (const e of exs) {
      const fromId = keyToId.get(String(e.fromKey || ''));
      const toId = e.toKey ? keyToId.get(String(e.toKey)) : null;
      if (!fromId) continue;
      // КРИТИЧЕСКИ ВАЖНО: Если у exit есть targetLocationId (переход в другую локацию), то isGameOver ДОЛЖЕН быть false
      // isGameOver: true только для финальных exits БЕЗ targetLocationId (завершение игры)
      const isGameOver = toId ? false : Boolean(e.isGameOver);
      await prisma.locationExit.create({
        data: {
          locationId: fromId,
          type: (e.type || 'BUTTON') as any,
          buttonText: e.buttonText || null,
          triggerText: e.triggerText || null,
          targetLocationId: toId || null,
          isGameOver,
        },
      });
      createdExits++;
    }
    let createdChars = 0;
    for (const c of chars) {
      const abilitiesValue =
        Array.isArray(c.abilities) ? c.abilities.filter((s: any) => typeof s === 'string' && s.trim()).join('\n') :
        (typeof c.abilities === 'string' ? c.abilities : null);
      await prisma.character.create({
        data: {
          gameId: game.id,
          name: c.name || 'Персонаж',
          gender: c.gender || null,
          race: c.race || null,
          avatarUrl: c.avatarUrl || 'https://picsum.photos/seed/char_' + Math.random().toString(36).slice(2, 8) + '/80/80',
          description: c.description || null,
          rating: typeof c.rating === 'number' ? c.rating : null,
          role: c.role || null,
          voiceId: c.voiceId || null,
          persona: c.persona || null,
          origin: c.origin || null,
          isPlayable: Boolean(c.isPlayable),
          abilities: abilitiesValue,
        },
      });
      createdChars++;
    }
    let createdEds = 0;
    for (const e of eds) {
      await prisma.edition.create({
        data: {
          gameId: game.id,
          name: e.name || 'Стандарт',
          description: e.description || '',
          price: typeof e.price === 'number' ? e.price : 0,
          badge: e.badge || null,
        },
      });
      createdEds++;
    }
    const enableBg = String((req.query.bg ?? '1')) !== '0';
    if (enableBg) {
      setImmediate(async () => {
        try {
          const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
          const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
          const locList = await prisma.location.findMany({ where: { gameId: game.id }, orderBy: { order: 'asc' } });
          let done = 0;
          for (const loc of locList) {
            if (done >= 10) break; 
            if (loc.backgroundUrl) continue;
            const guidance = 'Сгенерируй атмосферный фон сцены (без текста и водяных знаков). Киношный свет, глубина, без персонажей крупным планом.';
            const worldRulesForAI = (game as any)?.worldRulesFull || game.worldRules || '';
            const gameplayRulesForAI = (game as any)?.gameplayRulesFull || game.gameplayRules || '';
            const prompt = [guidance, `Сцена: ${loc.title}`, (loc.description || ''), worldRulesForAI, gameplayRulesForAI].filter(Boolean).join('\n\n').slice(0, 1600);
            let b64: string = '';
            try {
              if (geminiKey) {
                b64 = await generateViaGemini(prompt, '1536x1024', geminiKey);
              }
              if (!b64 && apiKey) {
                try {
                  const client = createOpenAIClient(apiKey);
                  const img = await client.images.generate({ model: 'gpt-image-1', prompt, size: '1536x1024', quality: 'high' } as any);
                  b64 = img?.data?.[0]?.b64_json || '';
                  const url = img?.data?.[0]?.url || '';
                  if (!b64 && url) {
                    const r = await undiciFetch(url);
                    const buf = Buffer.from(await r.arrayBuffer());
                    b64 = buf.toString('base64');
                  }
                } catch {  }
              }
            } catch {  }
            if (b64) {
              try {
                const buf = Buffer.from(b64, 'base64');
                const fname = `bg_${game.id}_${loc.id}.png`;
                const dir = path.join(UPLOAD_DIR, 'image');
                try { fs.mkdirSync(dir, { recursive: true }); } catch {}
                fs.writeFileSync(path.join(dir, fname), buf);
                await prisma.location.update({ where: { id: loc.id }, data: { backgroundUrl: `/uploads/image/${fname}` } });
                done++;
              } catch {  }
            }
          }
        } catch (e) {
          console.error('bg_generation_async_error', e);
        }
      });
    }
    
    
    return res.status(201).json({ ok: true, gameId: game.id, locations: locs.length, exits: createdExits, characters: createdChars, editions: createdEds });
  } catch (e) {
    return res.status(500).json({ error: 'scenario_import_failed', details: String(e) });
  }
});

const serverHttp = app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Server is running on http://0.0.0.0:${port}`);
});

type WsClient = { socket: WebSocket; userId: string };
const userIdToSockets = new Map<string, Set<WebSocket>>();
const lobbyTurns = new Map<string, { order: string[]; idx: number }>();

function wsNotifyUser(userId: string, event: unknown) {
  const set = userIdToSockets.get(userId);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(payload); } catch {}
    }
  }
}
async function wsNotifyLobby(lobbyId: string, event: unknown) {
  try {
    const prisma = getPrisma();
    const members = await prisma.lobbyMember.findMany({ where: { lobbyId } });
    for (const m of members as any[]) wsNotifyUser(m.userId, event);
  } catch {}
}

const wss = new WebSocketServer({ server: serverHttp, path: '/ws' });
wss.on('connection', async (socket, req) => {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const tgId = url.searchParams.get('tgId') || undefined;
    const tgUsername = url.searchParams.get('tgUsername') || undefined;
    const userId = url.searchParams.get('userId') || undefined;
    const deviceId = url.searchParams.get('deviceId') || undefined;
    const prisma = getPrisma();
    const resolved = await (async () => {
      if (tgId || tgUsername) {
        let u = tgId ? await prisma.user.findFirst({ where: { tgId } }) : null;
        if (!u && tgUsername) u = await prisma.user.findFirst({ where: { tgUsername: String(tgUsername).replace(/^@+/, '') } });
        if (!u) u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: tgId || undefined, tgUsername: tgUsername ? String(tgUsername).replace(/^@+/, '') : undefined, status: 'active' } });
        return u.id;
      }
      if (userId) return userId;
      if (deviceId) {
        const devTgId = 'device:' + deviceId;
        let u = await prisma.user.findFirst({ where: { tgId: devTgId } });
        if (!u) u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: devTgId, status: 'active' } });
        return u.id;
      }
      return null;
    })();
    if (!resolved) {
      socket.close();
      return;
    }
    if (!userIdToSockets.has(resolved)) userIdToSockets.set(resolved, new Set());
    userIdToSockets.get(resolved)!.add(socket);
    socket.on('close', () => {
      const set = userIdToSockets.get(resolved);
      if (set) {
        set.delete(socket);
        if (set.size === 0) userIdToSockets.delete(resolved);
      }
    });
  } catch {
    try { socket.close(); } catch {}
  }
});

if (process.env.BOT_TOKEN) {
  import('./bot.js')
    .then(() => {
      console.log('Telegram bot module loaded');
    })
    .catch((err) => {
      console.error('Failed to start Telegram bot:', err);
    });
}

app.get('/api/profile', async (req, res) => {
  const tgId = typeof req.query.tgId === 'string' ? req.query.tgId : undefined;
  const tgUsername = typeof req.query.tgUsername === 'string' ? req.query.tgUsername : undefined;
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  const firstName = typeof req.query.firstName === 'string' ? req.query.firstName : undefined;
  const lastName = typeof req.query.lastName === 'string' ? req.query.lastName : undefined;

  try {
    const prisma = getPrisma();
    let u = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
    if (!u && tgId) u = await prisma.user.findFirst({ where: { tgId } });
    if (!u && tgUsername) u = await prisma.user.findFirst({ where: { tgUsername } });
    if (!u && (tgId || tgUsername)) {
      u = await prisma.user.create({
        data: {
          firstName: firstName || 'User',
          lastName: lastName || '',
          tgUsername,
          tgId,
          status: 'active',
        },
      });
    }
    if (u) {
      return res.json({
        id: u.id,
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.tgUsername ? '@' + u.tgUsername : 'User'),
        avatarUrl: 'https://picsum.photos/seed/avatar_' + u.id + '/100/100',
        subscriptionUntil: u.subscriptionUntil || new Date(Date.now() + 30 * 86400000).toISOString(),
        totalEarned: u.balance || 0,
        totalFriends: u.referralsCount || 0,
        autoRenewal: true,
        cardMasked: '',
      } satisfies import('./types').Profile);
    }
  } catch {}

  let u = users.find((x) => x.id === userId);
  if (!u && tgId) u = users.find((x) => x.tgId === tgId);
  if (!u && tgUsername) u = users.find((x) => (x.tgUsername || '').toLowerCase() === String(tgUsername).toLowerCase());
  if (!u && (tgId || tgUsername)) {
    u = createUser({ firstName: firstName || 'User', lastName: lastName || '', tgUsername, tgId, status: 'active', balance: 0, referralsCount: 0, registeredAt: new Date().toISOString() });
  }
  if (u) {
    return res.json({
      id: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || (u.tgUsername ? '@' + u.tgUsername : 'User'),
      avatarUrl: 'https://picsum.photos/seed/avatar_' + u.id + '/100/100',
      subscriptionUntil: u.subscriptionUntil || new Date(Date.now() + 30 * 86400000).toISOString(),
      totalEarned: u.balance || 0,
      totalFriends: u.referralsCount || 0,
      autoRenewal: true,
      cardMasked: '',
    } satisfies import('./types').Profile);
  }
  res.json({ ...profile, cardMasked: profile.cardMasked });
});

app.get('/api/friends', (_req, res) => {
  res.json(friends);
});

async function resolveUserIdFromQueryOrBody(req: express.Request, prisma: ReturnType<typeof getPrisma>): Promise<string | null> {
  const q = req.method === 'GET' ? req.query : (req.body as any);
  const userIdRaw = typeof q.userId === 'string' ? q.userId : undefined;
  const tgId = typeof q.tgId === 'string' ? q.tgId : undefined;
  const tgUsernameRaw = typeof q.tgUsername === 'string' ? q.tgUsername : undefined;
  const deviceId = typeof q.deviceId === 'string' ? q.deviceId : undefined;
  const normUsername = tgUsernameRaw ? String(tgUsernameRaw).replace(/^@+/, '') : undefined;

  if (tgId || normUsername) {
    let u = tgId ? await prisma.user.findFirst({ where: { tgId } }) : null;
    if (!u && normUsername) u = await prisma.user.findFirst({ where: { tgUsername: normUsername } });
    if (!u) {
      u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: tgId || undefined, tgUsername: normUsername || undefined, status: 'active' } });
    }
    return u.id;
  }

  if (userIdRaw) return userIdRaw;

  if (deviceId) {
    const devTgId = 'device:' + deviceId;
    let u = await prisma.user.findFirst({ where: { tgId: devTgId } });
    if (!u) u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: devTgId, status: 'active' } });
    return u.id;
  }
  return null;
}

function genInviteCode(len = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

app.get('/api/friends/list', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const edges = await prisma.friendEdge.findMany({
      where: { status: 'ACCEPTED' as any, OR: [{ userId: uid }, { friendId: uid }] },
    });
    const otherIds = Array.from(new Set(edges.map((e: any) => (e.userId === uid ? e.friendId : e.userId))));
    const usersList = otherIds.length ? await prisma.user.findMany({ where: { id: { in: otherIds } } }) : [];
    const list = otherIds.map((id) => {
      const u = usersList.find((x) => x.id === id);
      const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || (u.tgUsername ? '@' + u.tgUsername : 'User')) : 'User';
      return { id, name, avatarUrl: 'https://picsum.photos/seed/avatar_' + id + '/80/80' };
    });
    return res.json(list);
  } catch (e) {
    return res.json(friends);
  }
});

app.post('/api/friends/addByUsername', async (req, res) => {
  const targetRaw = typeof req.body?.username === 'string' ? req.body.username : '';
  const username = targetRaw.replace(/^@+/, '').trim();
  if (!username) return res.status(400).json({ error: 'username_required' });
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    let target = await prisma.user.findFirst({
      where: {
        OR: [
          { tgUsername: { equals: username, mode: 'insensitive' } },
          { tgUsername: { equals: '@' + username, mode: 'insensitive' } },
        ],
      },
    });
    if (!target) {
      target = await prisma.user.create({
        data: {
          firstName: username,
          lastName: '',
          tgUsername: username.replace(/^@+/, ''),
          status: 'active',
        },
      });
    }
    if (target.id === uid) return res.status(400).json({ error: 'cannot_add_self' });
    await prisma.friendEdge.upsert({ where: { userId_friendId: { userId: uid, friendId: target.id } }, update: { status: 'ACCEPTED' as any }, create: { userId: uid, friendId: target.id, status: 'ACCEPTED' as any } });
    await prisma.friendEdge.upsert({ where: { userId_friendId: { userId: target.id, friendId: uid } }, update: { status: 'ACCEPTED' as any }, create: { userId: target.id, friendId: uid, status: 'ACCEPTED' as any } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_add' });
  }
});

app.post('/api/friends/invite/create', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const ttlHours = Math.max(1, Math.min(24 * 14, Number(req.body?.ttlHours || 24 * 7)));
    const code = 'F' + genInviteCode(11);
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    await prisma.friendInvite.create({ data: { code, inviterId: uid, expiresAt } });
    const bot = (process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || process.env.BOT_NAME || process.env.BOT || '').replace(/^@+/, '');
    let tgLink = '';
    let tgAppLink = '';
    if (bot) {
      tgLink = `https://t.me/${bot}?start=${encodeURIComponent('friend_' + code)}`;
      tgAppLink = `https://t.me/${bot}?startapp=${encodeURIComponent('friend_' + code)}`;
    } else {
      tgLink = `https://t.me/share/url?url=${encodeURIComponent('friend_' + code)}&text=${encodeURIComponent('Открой ссылку с нашим ботом, чтобы принять приглашение в друзья.')}`;
    }
    return res.json({ code, tgLink, tgAppLink });
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_create_invite' });
  }
});

app.post('/api/friends/invite/accept', async (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!code) return res.status(400).json({ error: 'code_required' });
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const inv = await prisma.friendInvite.findUnique({ where: { code } });
    if (!inv) return res.status(404).json({ error: 'invite_not_found' });
    if (inv.usedAt || inv.usedById) return res.status(400).json({ error: 'invite_used' });
    if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) return res.status(400).json({ error: 'invite_expired' });
    if (inv.inviterId === uid) return res.status(400).json({ error: 'cannot_use_own_invite' });
    await prisma.friendEdge.upsert({ where: { userId_friendId: { userId: inv.inviterId, friendId: uid } }, update: { status: 'ACCEPTED' as any }, create: { userId: inv.inviterId, friendId: uid, status: 'ACCEPTED' as any } });
    await prisma.friendEdge.upsert({ where: { userId_friendId: { userId: uid, friendId: inv.inviterId } }, update: { status: 'ACCEPTED' as any }, create: { userId: uid, friendId: inv.inviterId, status: 'ACCEPTED' as any } });
    await prisma.friendInvite.update({ where: { code }, data: { usedAt: new Date(), usedById: uid } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_accept' });
  }
});

app.post('/api/feedback', async (req, res) => {
  const { userId, tgId, tgUsername, rating, comment, gameId } = req.body as { userId?: string; tgId?: string; tgUsername?: string; rating: number; comment?: string; gameId?: string };
  try {
    const prisma = getPrisma();
    let uid = userId || '';
    if (!uid && (tgId || tgUsername)) {
      let u = tgId ? await prisma.user.findFirst({ where: { tgId } }) : null;
      if (!u && tgUsername) u = await prisma.user.findFirst({ where: { tgUsername } });
      if (!u && (tgId || tgUsername)) {
        u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: tgId || undefined, tgUsername: tgUsername || undefined, status: 'active' } });
      }
      uid = u?.id || '';
    }
    const created = await prisma.feedback.create({ data: { userId: uid || 'unknown', gameId, rating: Number(rating) || 0, comment } });
    return res.status(201).json(created);
  } catch {
    feedbacks.push({ id: String(feedbacks.length + 1), userId: userId || 'u1', gameId, rating, comment, createdAt: new Date().toISOString() });
    res.status(201).json({ ok: true });
  }
});
app.get('/api/feedback', async (_req, res) => {
  try {
    const prisma = getPrisma();
    const list = await prisma.feedback.findMany({ orderBy: { createdAt: 'desc' } });
    return res.json(list);
  } catch {
    res.json(feedbacks);
  }
});

app.get('/api/users', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const page = Number(req.query.page || 1);
  const limit = Math.min(100, Number(req.query.limit || 20));
  const status = (req.query.status as string | undefined) as User['status'] | undefined;
  const subscriptionType = (req.query.subscriptionType as string | undefined) as User['subscriptionType'] | undefined;
  const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : undefined;
  const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : undefined;

  try {
    const prisma = getPrisma();
    const where: any = {};
    if (q) where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { tgUsername: { contains: q, mode: 'insensitive' } },
      { tgId: { contains: q, mode: 'insensitive' } },
    ];
    if (status) where.status = status;
    if (subscriptionType) where.subscriptionType = subscriptionType;
    if (dateFrom || dateTo) where.registeredAt = {
      gte: dateFrom || undefined,
      lte: dateTo || undefined,
    };
    const total = await prisma.user.count({ where });
    const data = await prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { registeredAt: 'desc' } });
    return res.json({ data, total, page, limit });
  } catch {
    let filtered = users;
    if (q) {
      filtered = filtered.filter((u) => [u.firstName, u.lastName, u.tgUsername, u.tgId].some((f) => (f || '').toLowerCase().includes(q)));
    }
    if (status) filtered = filtered.filter((u) => u.status === status);
    if (subscriptionType) filtered = filtered.filter((u) => u.subscriptionType === subscriptionType);
    if (dateFrom) filtered = filtered.filter((u) => new Date(u.registeredAt).getTime() >= dateFrom.getTime());
    if (dateTo) filtered = filtered.filter((u) => new Date(u.registeredAt).getTime() <= dateTo.getTime());
    const start = (page - 1) * limit;
    const data = filtered.slice(start, start + limit);
    res.json({ data, total: filtered.length, page, limit });
  }
});

app.get('/api/users.csv', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const status = (req.query.status as string | undefined) as User['status'] | undefined;
  const subscriptionType = (req.query.subscriptionType as string | undefined) as User['subscriptionType'] | undefined;
  const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : undefined;
  const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : undefined;

  try {
    const prisma = getPrisma();
    const where: any = {};
    if (q) where.OR = [
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
      { tgUsername: { contains: q, mode: 'insensitive' } },
      { tgId: { contains: q, mode: 'insensitive' } },
    ];
    if (status) where.status = status;
    if (subscriptionType) where.subscriptionType = subscriptionType;
    if (dateFrom || dateTo) where.registeredAt = { gte: dateFrom || undefined, lte: dateTo || undefined };
    const list = await prisma.user.findMany({ where, orderBy: { registeredAt: 'desc' } });
    const header = ['id','firstName','lastName','tgUsername','tgId','subscriptionType','status','registeredAt','balance','referralsCount','subscriptionUntil','lastSeenAt'];
    const rows = [header.join(',')].concat(list.map((u) => header.map((k) => (String((u as any)[k] ?? '').replace(/,/g, ' '))).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    return res.send('\uFEFF' + rows.join('\n'));
  } catch {
    let filtered = users;
    if (q) filtered = filtered.filter((u) => [u.firstName, u.lastName, u.tgUsername, u.tgId].some((f) => (f || '').toLowerCase().includes(q)));
    if (status) filtered = filtered.filter((u) => u.status === status);
    if (subscriptionType) filtered = filtered.filter((u) => u.subscriptionType === subscriptionType);
    if (dateFrom) filtered = filtered.filter((u) => new Date(u.registeredAt).getTime() >= dateFrom.getTime());
    if (dateTo) filtered = filtered.filter((u) => new Date(u.registeredAt).getTime() <= dateTo.getTime());
    const header = ['id','firstName','lastName','tgUsername','tgId','subscriptionType','status','registeredAt','balance','referralsCount','subscriptionUntil','lastSeenAt'];
    const rows = [header.join(',')].concat(filtered.map((u) => header.map((k) => (String((u as any)[k] ?? '').replace(/,/g, ' '))).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
    res.send('\uFEFF' + rows.join('\n'));
  }
});

app.post('/api/users', async (req, res) => {
  const payload = req.body as Omit<User, 'id'>;
  if (!payload.firstName) return res.status(400).json({ error: 'firstName required' });
  try {
    const prisma = getPrisma();
    const created = await prisma.user.create({
      data: {
        firstName: payload.firstName,
        lastName: payload.lastName,
        tgUsername: payload.tgUsername,
        tgId: payload.tgId,
        subscriptionType: payload.subscriptionType,
        status: payload.status || 'active',
        registeredAt: payload.registeredAt ? new Date(payload.registeredAt) : undefined,
        balance: payload.balance ?? 0,
        referralsCount: payload.referralsCount ?? 0,
        subscriptionUntil: payload.subscriptionUntil ? new Date(payload.subscriptionUntil) : undefined,
        lastSeenAt: payload.lastSeenAt ? new Date(payload.lastSeenAt) : undefined,
      },
    });
    return res.status(201).json(created);
  } catch {
    const created = createUser(payload);
    res.status(201).json(created);
  }
});

app.patch('/api/users/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.user.update({ where: { id: req.params.id }, data: req.body });
    return res.json(updated);
  } catch {
    const updated = updateUser(req.params.id, req.body as Partial<User>);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.user.delete({ where: { id: req.params.id } });
    return res.status(204).end();
  } catch {
    const ok = deleteUser(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  }
});

app.get('/api/subscriptions/plans', (_req, res) => {
  res.json(subscriptionPlans);
});

app.get('/api/characters', async (req, res) => {
  try {
    const prisma = getPrisma();
    const where: any = {};
    if (typeof req.query.gameId === 'string') where.gameId = req.query.gameId;
    if (typeof req.query.isPlayable === 'string') where.isPlayable = req.query.isPlayable === '1' || req.query.isPlayable === 'true';
    const list = await prisma.character.findMany({ where });
    return res.json(list);
  } catch {
    let list = characters;
    if (typeof req.query.gameId === 'string') list = list.filter((c) => c.gameId === req.query.gameId);
    if (typeof req.query.isPlayable === 'string') {
      const flag = req.query.isPlayable === '1' || req.query.isPlayable === 'true';
      list = list.filter((c) => Boolean((c as any).isPlayable) === flag);
    }
    return res.json(list);
  }
});
// Импорт одного персонажа из PDF через ИИ
app.post('/api/admin/characters/import-pdf', upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'file_required', message: 'Файл не загружен' });
    }
    
    const fileName = req.file.originalname || '';
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      return res.status(400).json({ error: 'invalid_file_type', expected: 'PDF' });
    }
    
    console.log('[CHARACTER IMPORT] Parsing PDF:', fileName);
    
    // Парсинг PDF
    let parsed;
    try {
      parsed = await pdfParse(req.file.buffer);
    } catch (e) {
      console.error('[CHARACTER IMPORT] Parse error:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      if (errorMsg.includes('password') || errorMsg.includes('encrypted')) {
        return res.status(400).json({ error: 'pdf_password_protected', message: 'PDF защищен паролем' });
      }
      return res.status(400).json({ error: 'pdf_parse_failed', details: errorMsg });
    }
    
    if (!parsed || !parsed.text) {
      return res.status(400).json({ error: 'pdf_no_text', message: 'PDF не содержит текста' });
    }
    
    const rawText = parsed.text.replace(/\r/g, '\n');
    console.log('[CHARACTER IMPORT] Extracted text length:', rawText.length);
    
    // Используем ИИ для парсинга персонажа
    const sys = `Ты интеллектуальный ассистент для анализа карточек персонажей D&D 5e в формате Long Story Short.

Твоя задача - извлечь ВСЕ данные персонажа из PDF карточки и вернуть их в формате JSON.

⚠️ КРИТИЧЕСКИ ВАЖНО: ОБЯЗАТЕЛЬНО заполни ВСЕ поля, включая ВСЕ статы D&D 5e!`;

    const shape = '{ "name":"...","isPlayable":true,"race":"...","gender":"...","role":"...","origin":"...","persona":"...","abilities":"...","description":"...","level":1,"class":"друид","hp":10,"maxHp":10,"ac":10,"str":10,"dex":10,"con":10,"int":10,"wis":13,"cha":10 }';

    const prompt = `Проанализируй карточку персонажа D&D 5e из файла:

═══════════════════════════════════════════════════════════════════════════════
ФАЙЛ: КАРТОЧКА ПЕРСОНАЖА
═══════════════════════════════════════════════════════════════════════════════
${rawText.slice(0, 50000)}
═══════════════════════════════════════════════════════════════════════════════

Верни только JSON без комментариев, строго формы:
${shape}

ИНСТРУКЦИИ ПО ИЗВЛЕЧЕНИЮ:

1. ИМЯ (name):
   - Извлеки имя персонажа из раздела "ИМЯ ПЕРСОНАЖА" или начала карточки
   - Если имя не указано явно, используй описание для определения имени

2. РАСА (race):
   - Извлеки расу из раздела "РАСА" (например: "Дварфийка", "Эльф", "Человек")
   - Приведи к стандартному формату: "дварф", "эльф", "человек", "гном", "орк" и т.д.

3. ПОЛ (gender):
   - Определи пол из текста (мужской, женский, не указан)
   - Если указано "Дварфийка" → женский, "Дварф" → мужской

4. КЛАСС (class):
   - Извлеки класс из раздела "КЛАСС И УРОВЕНЬ" или "КЛАСС ЗАКЛИНАТЕЛЯ"
   - Приведи к стандартному формату: "друид", "воин", "маг", "жрец", "плут", "варвар", "паладин", "следопыт", "бард", "монах", "колдун", "чародей"

5. УРОВЕНЬ (level):
   - Извлеки уровень из раздела "КЛАСС И УРОВЕНЬ" или текста
   - Если не указан, определи по контексту (обычно 1-5 для игровых персонажей)

6. СТАТИСТИКА D&D 5e (ОБЯЗАТЕЛЬНО):
   - ⚠️ ВСЕ статы должны быть заполнены реальными значениями!
   - hp, maxHp: извлеки из текста или рассчитай на основе класса и уровня
   - ac: класс брони (обычно 10-15 для друида)
   - str, dex, con, int, wis, cha: извлеки из текста или сгенерируй на основе класса
   - Для друида: WIS должна быть высокой (13-16), CON средняя (12-14)
   - Если статы не указаны в PDF - СГЕНЕРИРУЙ их на основе класса и уровня

7. ОПИСАНИЕ (description):
   - Извлеки описание из раздела "ПРЕДЫСТОРИЯ ПЕРСОНАЖА" или общего описания
   - Объедини всю информацию о персонаже в одно описание

8. РОЛЬ (role):
   - Определи роль персонажа (например: "Отшельница", "Защитник", "Исследователь")

9. ПРОИСХОЖДЕНИЕ (origin):
   - Извлеки информацию о происхождении из предыстории

10. ЛИЧНОСТЬ (persona):
    - Извлеки описание характера и поведения персонажа

11. СПОСОБНОСТИ (abilities):
    - Извлеки список заклинаний и способностей из раздела "ЗАГОВОРЫ" и списка заклинаний
    - Укажи все заклинания и способности персонажа

12. ИГРОВОЙ ПЕРСОНАЖ (isPlayable):
    - Для карточек Long Story Short обычно isPlayable: true
    - Если это NPC из сценария → isPlayable: false

⚠️ ВАЖНО: Если какие-то статы не указаны в PDF, СГЕНЕРИРУЙ их на основе:
- Класса персонажа (друид → высокий WIS, средний CON)
- Уровня персонажа
- Роли персонажа

НИКОГДА не оставляй статы пустыми или равными 0!`;

    console.log('[CHARACTER IMPORT] Calling AI for parsing...');
    const aiResponse = await generateChatCompletion({
      systemPrompt: sys,
      userPrompt: prompt,
      history: []
    });
    
    if (!aiResponse || !aiResponse.text) {
      return res.status(500).json({ error: 'ai_parse_failed', message: 'ИИ не смог обработать файл' });
    }
    
    console.log('[CHARACTER IMPORT] AI response received, length:', aiResponse.text.length);
    
    // Парсинг JSON из ответа ИИ
    let characterData: any;
    try {
      // Извлекаем JSON из ответа (может быть обернут в markdown код)
      let jsonText = aiResponse.text.trim();
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }
      characterData = JSON.parse(jsonText);
    } catch (e) {
      console.error('[CHARACTER IMPORT] JSON parse error:', e);
      console.error('[CHARACTER IMPORT] AI response:', aiResponse.text);
      return res.status(500).json({ error: 'json_parse_failed', message: 'Не удалось распарсить ответ ИИ', details: String(e) });
    }
    
    // Валидация и нормализация данных
    if (!characterData.name) {
      return res.status(400).json({ error: 'missing_name', message: 'Имя персонажа не найдено' });
    }
    
    // Убеждаемся, что все статы заполнены
    const defaultStats = {
      level: characterData.level || 1,
      class: characterData.class || 'друид',
      hp: characterData.hp || 10,
      maxHp: characterData.maxHp || 10,
      ac: characterData.ac || 10,
      str: characterData.str || 10,
      dex: characterData.dex || 10,
      con: characterData.con || 10,
      int: characterData.int || 10,
      wis: characterData.wis || 13,
      cha: characterData.cha || 10,
    };
    
    const normalizedCharacter = {
      name: characterData.name,
      isPlayable: characterData.isPlayable !== undefined ? Boolean(characterData.isPlayable) : true,
      race: characterData.race || 'не указана',
      gender: characterData.gender || 'не указан',
      role: characterData.role || null,
      origin: characterData.origin || null,
      persona: characterData.persona || null,
      abilities: characterData.abilities || null,
      description: characterData.description || null,
      avatarUrl: characterData.avatarUrl || `https://picsum.photos/seed/${characterData.name}/80/80`,
      ...defaultStats,
    };
    
    console.log('[CHARACTER IMPORT] Parsed character:', normalizedCharacter.name);
    
    // Возвращаем данные персонажа для заполнения формы (без сохранения в базу)
    // Пользователь сможет проверить и отредактировать данные перед созданием
    return res.json(normalizedCharacter);
  } catch (e) {
    console.error('[CHARACTER IMPORT] Error:', e);
    return res.status(500).json({ error: 'server_error', message: 'Внутренняя ошибка сервера', details: String(e) });
  }
});

app.post('/api/characters', async (req, res) => {
  try {
    const prisma = getPrisma();
    const created = await prisma.character.create({ data: {
      gameId: req.body.gameId || null,
      name: req.body.name,
      gender: req.body.gender,
      race: req.body.race,
      avatarUrl: req.body.avatarUrl,
      description: req.body.description,
      abilities: req.body.abilities,
      rating: req.body.rating,
      role: req.body.role,
      voiceId: req.body.voiceId,
      persona: req.body.persona,
      origin: req.body.origin,
      isPlayable: Boolean(req.body.isPlayable),
      // D&D 5e Stats
      level: Number.isFinite(req.body.level) ? Number(req.body.level) : undefined,
      class: req.body.class || null,
      hp: Number.isFinite(req.body.hp) ? Number(req.body.hp) : undefined,
      maxHp: Number.isFinite(req.body.maxHp) ? Number(req.body.maxHp) : undefined,
      ac: Number.isFinite(req.body.ac) ? Number(req.body.ac) : undefined,
      str: Number.isFinite(req.body.str) ? Number(req.body.str) : undefined,
      dex: Number.isFinite(req.body.dex) ? Number(req.body.dex) : undefined,
      con: Number.isFinite(req.body.con) ? Number(req.body.con) : undefined,
      int: Number.isFinite(req.body.int) ? Number(req.body.int) : undefined,
      wis: Number.isFinite(req.body.wis) ? Number(req.body.wis) : undefined,
      cha: Number.isFinite(req.body.cha) ? Number(req.body.cha) : undefined,
      skills: req.body.skills || null,
      inventory: req.body.inventory || null,
      spells: req.body.spells || null,
      equipment: req.body.equipment || null,
    } });
    return res.status(201).json(created);
  } catch {
    const created = createCharacter(req.body);
    return res.status(201).json(created);
  }
});
app.get('/api/characters/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const item = await prisma.character.findUnique({ where: { id: req.params.id } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    return res.json(item);
  } catch {
    const item = characters.find((c) => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    return res.json(item);
  }
});
app.patch('/api/characters/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const updated = await prisma.character.update({ where: { id: req.params.id }, data: req.body });
    return res.json(updated);
  } catch {
    const updated = updateCharacter(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    return res.json(updated);
  }
});
app.delete('/api/characters/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.character.delete({ where: { id: req.params.id } });
    return res.status(204).end();
  } catch {
    const ok = deleteCharacter(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    return res.status(204).end();
  }
});

app.get('/api/admin/characters', async (_req, res) => {
  try {
    const prisma = getPrisma();
    const db = await prisma.character.findMany();
    const mem = characters.filter((c) => !db.some((x: any) => x.id === c.id));
    return res.json([...db, ...mem]);
  } catch {
    return res.json(characters);
  }
});

app.get('/api/analytics/overview', (_req, res) => {
  const totalUsers = users.length;
  const premium = users.filter((u) => u.subscriptionType === 'premium').length;
  const trial = users.filter((u) => u.subscriptionType === 'trial').length;
  const free = totalUsers - premium - trial;
  const totalGames = games.length;
  const topGame = games[0]?.title || null;
  res.json({ totalUsers, premium, trial, free, totalGames, topGame });
});
app.get('/api/analytics/games-top', (_req, res) => {
  const top = [...games].sort((a, b) => b.rating - a.rating).slice(0, 10).map((g) => ({ id: g.id, title: g.title, rating: g.rating }));
  res.json(top);
});

function presentLobby(l: any, usersMap: Map<string, any>) {
  const members = (l.members || []).map((m: any) => {
    const u = usersMap.get(m.userId);
    const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || (u.tgUsername ? '@' + u.tgUsername : 'User')) : 'User';
    return { userId: m.userId, role: m.role, name, avatarUrl: 'https://picsum.photos/seed/avatar_' + m.userId + '/80/80' };
  });
  const invitedSet = lobbyInvitedSet.get(l.id) || new Set<string>();
  const invitedIds = Array.from(invitedSet).filter((uid) => !(l.members || []).some((m: any) => m.userId === uid));
  const invited = invitedIds.map((id) => {
    const u = usersMap.get(id);
    const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || (u.tgUsername ? '@' + u.tgUsername : 'User')) : 'User';
    return { userId: id, name, avatarUrl: 'https://picsum.photos/seed/avatar_' + id + '/80/80' };
  });
  const inviteExpiresAt = lobbyInviteDeadline.get(l.id) ? new Date(lobbyInviteDeadline.get(l.id)!).toISOString() : undefined;
  const turn = lobbyTurns.get(l.id);
  const currentTurnUserId = turn && turn.order.length ? turn.order[turn.idx] : undefined;
  return { id: l.id, gameId: l.gameId, status: l.status, hostUserId: l.hostUserId, maxPlayers: l.maxPlayers, members, invited, inviteExpiresAt, currentTurnUserId };
}

app.post('/api/lobbies', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const maxPlayers = Math.min(4, Math.max(2, Number(req.body?.maxPlayers || 4)));
    const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
    const lobby = await prisma.gameLobby.create({ data: { hostUserId: uid, gameId, maxPlayers, status: 'OPEN' as any } });
    await prisma.lobbyMember.create({ data: { lobbyId: lobby.id, userId: uid, role: 'HOST' as any } });
    const members = await prisma.lobbyMember.findMany({ where: { lobbyId: lobby.id } });
    const usersList = await prisma.user.findMany({ where: { id: { in: members.map((m: any) => m.userId) } } });
    const usersMap = new Map(usersList.map((u: any) => [u.id, u] as const));
    return res.status(201).json(presentLobby({ ...lobby, members }, usersMap));
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_create_lobby' });
  }
});

async function sendTelegramInviteMessage(params: { tgId: string; lobbyId: string; hostName: string; gameTitle?: string; seconds: number }) {
  const token = process.env.BOT_TOKEN;
  const botUser = (process.env.BOT_USERNAME || process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@+/, '');
  if (!token) return;
  const text = [
    `Вас пригласили в игру${params.gameTitle ? ` «${params.gameTitle}»` : ''} от ${params.hostName}.`,
    `У вас ${params.seconds} сек. чтобы присоединиться.`
  ].join('\n');
  const joinLink = botUser ? `https://t.me/${botUser}?start=${encodeURIComponent('join_' + params.lobbyId)}` : '';
  const body: any = { chat_id: params.tgId, text };
  if (joinLink) {
    body.reply_markup = { inline_keyboard: [[{ text: 'Принять приглашение', url: joinLink }]] };
  }
  try {
    await undiciFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {}
}

const lobbyInviteDeadline = new Map<string, number>();
const lobbyInvitedSet = new Map<string, Set<string>>(); 

app.post('/api/lobbies/:id/invite', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const lobby = await prisma.gameLobby.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!lobby) return res.status(404).json({ error: 'not_found' });
    if (lobby.hostUserId !== uid) return res.status(403).json({ error: 'forbidden' });
    if (lobby.status !== 'OPEN') return res.status(400).json({ error: 'invalid_state' });
    const invitees = Array.isArray(req.body?.invitees) ? (req.body.invitees as string[]) : [];
    if (!invitees.length) return res.status(400).json({ error: 'invitees_required' });

    const usernames = invitees.filter((x) => x.startsWith('@')).map((x) => x.replace(/^@+/, ''));
    const ids = invitees.filter((x) => !x.startsWith('@'));
    const usersById = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } } }) : [];
    const usersByName = usernames.length ? await prisma.user.findMany({
      where: { OR: usernames.map((u) => ({ tgUsername: { equals: u, mode: 'insensitive' } })) },
    }) : [];
    let all = [...usersById, ...usersByName] as any[];
    if (ids.length && usersById.length < ids.length) {
      const missed = ids.filter((id2) => !usersById.some((u: any) => u.id === id2));
      if (missed.length) {
        const extraByName = await prisma.user.findMany({ where: { OR: missed.map((u) => ({ tgUsername: { equals: u.replace(/^@+/, ''), mode: 'insensitive' } })) } });
        if (extraByName.length) all = [...all, ...extraByName];
      }
    }
    if (!all.length) return res.status(400).json({ error: 'no_targets' });

    const currentCount = lobby.members.length;
    const max = lobby.maxPlayers || 4;
    const available = Math.max(0, max - currentCount);
    const targets = all.slice(0, available);
    if (!targets.length) return res.status(400).json({ error: 'lobby_full' });

    const seconds = 30;
    const deadline = Date.now() + seconds * 1000;
    lobbyInviteDeadline.set(lobby.id, deadline);
    lobbyInvitedSet.set(lobby.id, new Set(targets.map((u) => u.id as string)));

    const host = await prisma.user.findUnique({ where: { id: uid } });
    const game = lobby.gameId ? await prisma.game.findUnique({ where: { id: lobby.gameId } }) : null;
    const hostName = host ? ([host.firstName, host.lastName].filter(Boolean).join(' ') || (host.tgUsername ? '@' + host.tgUsername : 'Игрок')) : 'Игрок';

    for (const u of targets) {
      wsNotifyUser(u.id, { type: 'lobby_invite', lobbyId: lobby.id, fromUserId: uid, gameId: lobby.gameId, expiresAt: new Date(deadline).toISOString() });
      if (u.tgId) {
        sendTelegramInviteMessage({ tgId: u.tgId, lobbyId: lobby.id, hostName, gameTitle: game?.title || undefined, seconds });
      }
    }

    return res.json({ ok: true, expiresAt: new Date(deadline).toISOString(), invited: targets.map((u) => u.id) });
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_invite' });
  }
});

app.get('/api/lobbies/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const lob = await prisma.gameLobby.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!lob) return res.status(404).json({ error: 'not_found' });
    const invitedIds = Array.from(lobbyInvitedSet.get(req.params.id) || new Set<string>());
    const userIds = Array.from(new Set([...(lob.members.map((m: any) => m.userId)), ...invitedIds]));
    const usersList = await prisma.user.findMany({ where: { id: { in: userIds } } });
    const usersMap = new Map(usersList.map((u: any) => [u.id, u] as const));
    return res.json(presentLobby(lob, usersMap));
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_get_lobby' });
  }
});

app.get('/api/lobbies', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const memberships = await prisma.lobbyMember.findMany({ where: { userId: uid } });
    const lobbyIds = memberships.map((m: any) => m.lobbyId);
    const lobbies = lobbyIds.length ? await prisma.gameLobby.findMany({ where: { id: { in: lobbyIds } }, include: { members: true } }) : [];
    const invitedIdsAll = lobbies.flatMap((l: any) => Array.from(lobbyInvitedSet.get(l.id) || new Set<string>()));
    const allUserIds = Array.from(new Set(lobbies.flatMap((l: any) => l.members.map((m: any) => m.userId)).concat(invitedIdsAll)));
    const usersList = allUserIds.length ? await prisma.user.findMany({ where: { id: { in: allUserIds } } }) : [];
    const usersMap = new Map(usersList.map((u: any) => [u.id, u] as const));
    return res.json(lobbies.map((l: any) => presentLobby(l, usersMap)));
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_list_lobbies' });
  }
});

app.delete('/api/lobbies/:id/members/:userId', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const lob = await prisma.gameLobby.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!lob) return res.status(404).json({ error: 'not_found' });
    if (lob.hostUserId !== uid) return res.status(403).json({ error: 'forbidden' });
    const targetId = req.params.userId;
    if (targetId === uid) return res.status(400).json({ error: 'cannot_kick_self' });
    const exists = lob.members.find((m: any) => m.userId === targetId);
    if (!exists) return res.status(404).json({ error: 'not_member' });
    await prisma.lobbyMember.delete({ where: { lobbyId_userId: { lobbyId: lob.id, userId: targetId } } });
    wsNotifyLobby(lob.id, { type: 'lobby_member_left', lobbyId: lob.id, userId: targetId });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_kick' });
  }
});

app.post('/api/lobbies/:id/join', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const lobby = await prisma.gameLobby.findUnique({ where: { id: req.params.id } });
    if (!lobby) return res.status(404).json({ error: 'not_found' });
    if (lobby.status !== 'OPEN') return res.status(400).json({ error: 'lobby_not_open' });
    const deadline = lobbyInviteDeadline.get(lobby.id);
    if (deadline && Date.now() > deadline) return res.status(400).json({ error: 'invite_expired' });
    const invitedSet = lobbyInvitedSet.get(lobby.id);
    if (invitedSet && invitedSet.size && !invitedSet.has(uid)) return res.status(403).json({ error: 'not_invited' });
    const count = await prisma.lobbyMember.count({ where: { lobbyId: lobby.id } });
    const exists = await prisma.lobbyMember.findUnique({ where: { lobbyId_userId: { lobbyId: lobby.id, userId: uid } } }).catch(() => null);
    if (exists) return res.json({ ok: true });
    if (count >= (lobby.maxPlayers || 4)) return res.status(400).json({ error: 'lobby_full' });
    await prisma.lobbyMember.create({ data: { lobbyId: lobby.id, userId: uid, role: 'PLAYER' as any } });
    const lob = await prisma.gameLobby.findUnique({ where: { id: lobby.id }, include: { members: true } });
    const usersList = await prisma.user.findMany({ where: { id: { in: (lob?.members || []).map((m: any) => m.userId) } } });
    const usersMap = new Map(usersList.map((u: any) => [u.id, u] as const));
    wsNotifyLobby(lobby.id, { type: 'lobby_member_joined', lobbyId: lobby.id, userId: uid });
    const set = lobbyInvitedSet.get(lobby.id);
    if (set) set.delete(uid);
    return res.json(presentLobby(lob, usersMap));
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_join' });
  }
});

app.delete('/api/lobbies/:id/leave', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const lob = await prisma.gameLobby.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!lob) return res.status(404).json({ error: 'not_found' });
    const me = lob.members.find((m: any) => m.userId === uid);
    if (!me) return res.status(200).json({ ok: true });
    await prisma.lobbyMember.delete({ where: { lobbyId_userId: { lobbyId: lob.id, userId: uid } } });
    if (lob.hostUserId === uid) {
      const rest = await prisma.lobbyMember.findMany({ where: { lobbyId: lob.id } });
      if (!rest.length) {
        await prisma.gameLobby.update({ where: { id: lob.id }, data: { status: 'CLOSED' as any } });
      } else {
        await prisma.gameLobby.update({ where: { id: lob.id }, data: { hostUserId: rest[0].userId } });
        await prisma.lobbyMember.update({ where: { lobbyId_userId: { lobbyId: lob.id, userId: rest[0].userId } }, data: { role: 'HOST' as any } });
      }
    }
    wsNotifyLobby(lob.id, { type: 'lobby_member_left', lobbyId: lob.id, userId: uid });
    return res.status(204).end();
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_leave' });
  }
});

app.post('/api/lobbies/:id/start', async (req, res) => {
  try {
    const prisma = getPrisma();
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const lob = await prisma.gameLobby.findUnique({ where: { id: req.params.id }, include: { members: true } });
    if (!lob) return res.status(404).json({ error: 'not_found' });
    if (lob.hostUserId !== uid) return res.status(403).json({ error: 'forbidden' });
    if (lob.status !== 'OPEN') return res.status(400).json({ error: 'invalid_state' });
    if (lob.members.length < 1 || lob.members.length > (lob.maxPlayers || 4)) return res.status(400).json({ error: 'invalid_players' });
    const updated = await prisma.gameLobby.update({ where: { id: lob.id }, data: { status: 'RUNNING' as any } });
    const usersList = await prisma.user.findMany({ where: { id: { in: lob.members.map((m: any) => m.userId) } } });
    const usersMap = new Map(usersList.map((u: any) => [u.id, u] as const));
    const order = [lob.hostUserId].concat(lob.members.map((m: any) => m.userId).filter((id: string) => id !== lob.hostUserId).sort());
    lobbyTurns.set(lob.id, { order, idx: 0 });
    if (lob.gameId) {
      const existed = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lob.id, gameId: lob.gameId } } });
      const hasHistory = !!(existed && Array.isArray((existed as any).history) && (existed as any).history.length);
      if (!hasHistory) {
        try {
          const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
          const client = apiKey ? createOpenAIClient(apiKey) : null;
          const sys = getSysPrompt();
            'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
            'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
            'Играй от лица рассказчика, а не игрока: избегай фраз "вы решаете", "вы начинаете", "вы выбираете". ' +
            'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
            'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
            'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
            'КРИТИЧЕСКИ ВАЖНО: Если игрок задает прямой вопрос (например, "Знаешь ли ты мое имя?", "Что ты знаешь о...", "Расскажи о..."), ОБЯЗАТЕЛЬНО отвечай на него прямо и честно, используя информацию из контекста диалога и сцены. Не игнорируй прямые вопросы игрока. ' +
            'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
            'Если игрок пишет что-то вне кнопок (но это не прямой вопрос) — мягко возвращай его к выбору, но через атмосферное описание. ' +
            'ВАЖНО: Варианты выбора форматируй ТОЛЬКО нумерованным списком (1. Вариант, 2. Вариант), БЕЗ звездочек (*) или других символов. Каждый вариант на новой строке. ' +
            'Это нужно, чтобы игрок мог выбрать вариант, просто отправив номер (1, 2, 3), и чтобы TTS не озвучивал звездочки. ' +
            'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
          const sc = await buildGptSceneContext(prisma, { gameId: lob.gameId, lobbyId: lob.id, history: [] });
          const { text: generatedText } = await generateChatCompletion({
            systemPrompt: sys,
            userPrompt: 'Контекст сцены:\n' + sc,
            history: []
          });
          let text = generatedText;
          if (text) {
            // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
            text = formatChoiceOptions(text);
          }
          if (!text) {
            const firstLoc = await prisma.location.findFirst({ where: { gameId: lob.gameId }, orderBy: { order: 'asc' } });
            const intro = [
              firstLoc?.title ? `Сцена: ${firstLoc.title}` : '',
              firstLoc?.description || '',
              'Тусклый свет дрожит на камне. Мир ждёт вашего шага.',
            ].filter(Boolean).join('\n\n');
            text = intro || 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.';
          }
          text = (text || '').trim();
          // Не сохраняем "технические ошибки" в историю
          const shouldSave = !text || !text.trim().startsWith('Техническая ошибка');
          if (shouldSave) {
            await prisma.chatSession.upsert({
              where: { userId_gameId: { userId: 'lobby:' + lob.id, gameId: lob.gameId } },
              update: { history: ([{ from: 'bot', text }] as any) },
              create: { userId: 'lobby:' + lob.id, gameId: lob.gameId, history: ([{ from: 'bot', text }] as any) },
            });
          }
        } catch {}
      }
    }
    wsNotifyLobby(lob.id, { type: 'lobby_started', lobbyId: lob.id, gameId: lob.gameId });
    if (order.length) wsNotifyLobby(lob.id, { type: 'turn_changed', lobbyId: lob.id, userId: order[0] });
    return res.json(presentLobby({ ...updated, members: lob.members }, usersMap));
  } catch (e) {
    return res.status(500).json({ error: 'failed_to_start' });
  }
});

app.post('/api/chat/welcome', async (req, res) => {
  const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
  try {
    const prisma = getPrisma();
    if (lobbyId && gameId) {
      const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
      const hist = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
      if (hist.length) return res.json({ message: '', fallback: false });
    }
    if (lobbyId && gameId) {
      const first = await prisma.location.findFirst({ where: { gameId }, orderBy: { order: 'asc' } });
      if (!first) return res.status(404).json({ message: 'Сценарий без локаций.', fallback: true });
      let gsess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
      if (!gsess) {
        // КРИТИЧЕСКИ ВАЖНО: Создаем сессию только если её нет, НЕ сбрасываем currentLocationId если сессия уже существует
        gsess = await prisma.gameSession.create({ data: { scenarioGameId: gameId, lobbyId, userId: null, currentLocationId: first.id, state: {} as any } });
      }
      // УБРАНО: Не сбрасываем currentLocationId на first.id - он должен меняться только при реальном переходе через locationExit
      const loc = await prisma.location.findUnique({ where: { id: first.id } });
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      const chars = await prisma.character.findMany({ where: { gameId }, take: 6 });
      const base = loc?.description || '';
      
      // КРИТИЧЕСКИ ВАЖНО: Создаем фиксированный ключ для welcome message на основе locationId
      // Welcome message имеет depth=0, choiceIndex=undefined, parentHash=undefined
      // Используем фиксированный ключ вместо текста, чтобы хеш был одинаковым для одной локации
      const welcomeKey = `welcome_${first.id}_d0`; // welcome + locationId + depth=0
      const offlineText = ([
        `Сцена: ${loc?.title || 'Локация'}`,
        base,
        game?.worldRules ? `Правила мира (сопоставляй с текущей сценой, не обобщай): ${game.worldRules}` : '',
        game?.gameplayRules ? `Правила процесса (сопоставляй с текущей сценой, не обобщай): ${game.gameplayRules}` : '',
      ].filter(Boolean).join('\n\n')).trim();
      
      // КРИТИЧЕСКИ ВАЖНО: Сначала проверяем прегенерированные материалы ПЕРЕД генерацией текста
      // Получаем scenarioGameId для поиска
      let scenarioGameIdForPregen: string | undefined = undefined;
      if (lobbyId && gameId) {
        const gsess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
        scenarioGameIdForPregen = gsess?.scenarioGameId || gameId;
      } else if (gameId) {
        const uid = await resolveUserIdFromQueryOrBody(req, prisma);
        if (uid) {
          const gsess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
          scenarioGameIdForPregen = gsess?.scenarioGameId || gameId;
        } else {
          scenarioGameIdForPregen = gameId;
        }
      }
      
      // Прегенерация удалена - используем только streaming TTS
      let text = offlineText;
      if (apiKey) {
        // Генерируем в реальном времени только если не включено использование прегенерированных материалов
        try {
          const client = createOpenAIClient(apiKey);
          const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
          const sys = getSysPrompt();
          const welcomeSysPrompt = sys +
            'КРИТИЧЕСКИ ВАЖНО ДЛЯ WELCOME СООБЩЕНИЯ: Это ПЕРВОЕ сообщение в игре. Ты должен начать с ПРЕДЫСТОРИИ/ВВЕДЕНИЯ, чтобы погрузить игрока в мир и контекст, а ЗАТЕМ плавно перейти к описанию текущей сцены. ' +
            'СТРУКТУРА WELCOME СООБЩЕНИЯ: ' +
            '1. Начни с краткой предыстории/введения (2-3 предложения) - что привело к текущей ситуации, где находятся персонажи, какой контекст. ' +
            '2. Затем плавно перейди к описанию текущей сцены - что видят персонажи, какая атмосфера, что происходит вокруг. ' +
            '3. В конце предложи варианты действий из кнопок локации. ' +
            'НИКОГДА не начинай сразу с вариантов действий - сначала дай предысторию и описание сцены! ' +
            'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
            'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
            'Играй от лица рассказчика, а не игрока: избегай фраз "вы решаете", "вы начинаете", "вы выбираете". ' +
            'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
            'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
            'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
            'КРИТИЧЕСКИ ВАЖНО: Если игрок задает прямой вопрос (например, "Знаешь ли ты мое имя?", "Что ты знаешь о...", "Расскажи о..."), ОБЯЗАТЕЛЬНО отвечай на него прямо и честно, используя информацию из контекста диалога и сцены. Не игнорируй прямые вопросы игрока. ' +
            'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
            'Если игрок пишет что-то вне кнопок (но это не прямой вопрос) — мягко возвращай его к выбору, но через атмосферное описание. ' +
            'После атмосферного описания всегда выводи чёткие варианты действий, опираясь на кнопки текущей сцены. ' +
            'ВАЖНО: Варианты выбора форматируй ТОЛЬКО нумерованным списком (1. Вариант, 2. Вариант), БЕЗ звездочек (*) или других символов. Каждый вариант на новой строке. ' +
            'Это нужно, чтобы игрок мог выбрать вариант, просто отправив номер (1, 2, 3), и чтобы TTS не озвучивал звездочки. ' +
            'Обязательно формулируй их коротко и ясно, чтобы игрок понял, что делать дальше. ' +
            'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
          const visual = loc?.backgroundUrl ? `Фон (изображение): ${loc.backgroundUrl}` : '';
          // Используем полные версии правил для ИИ, если они есть, иначе краткие
          const worldRulesForAI = (game as any)?.worldRulesFull || game?.worldRules || '';
          const gameplayRulesForAI = (game as any)?.gameplayRulesFull || game?.gameplayRules || '';
          const rules = [
            worldRulesForAI ? `Правила мира (сопоставляй с текущей сценой, не обобщай): ${worldRulesForAI}` : '',
            gameplayRulesForAI ? `Правила процесса (сопоставляй с текущей сценой, не обобщай): ${gameplayRulesForAI}` : '',
          ].filter(Boolean).join('\n');
          const npcs = chars && chars.length ? (
            'Персонажи (D&D 5e):\n' + chars.map((c) => {
              const traits = [c.role, c.class, c.race, c.gender].filter(Boolean).join(', ');
              const stats = c.isPlayable ? ` (HP: ${c.hp}/${c.maxHp}, AC: ${c.ac}, STR:${c.str}, DEX:${c.dex}, CON:${c.con}, INT:${c.int}, WIS:${c.wis}, CHA:${c.cha})` : '';
              const extras = [c.persona, c.origin].filter(Boolean).join('. ');
              return `- ${c.name} (${traits})${stats}. ${extras}`;
            }).join('\n')
          ) : '';
          const userMsg = [
            game?.introduction ? `Введение: ${game.introduction}` : '',
            game?.backstory ? `Предыстория: ${game.backstory}` : '',
            game?.adventureHooks ? `Зацепки приключения: ${game.adventureHooks}` : '',
            `Сцена: ${loc?.title}`,
            visual,
            base ? `Описание сцены: ${base}` : '',
            rules,
            npcs,
          ].filter(Boolean).join('\n\n');
          const { text: generatedText } = await generateChatCompletion({
            systemPrompt: welcomeSysPrompt,
            userPrompt: userMsg,
            history: []
          });
          text = generatedText || offlineText;
          if (text) {
            text = (text || '').trim();
            // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
            text = formatChoiceOptions(text);
            
            // НОВАЯ ЛОГИКА: ensureRealExitsInChoices удалена, используем текст как есть
          }
        } catch {
          text = offlineText;
        }
      }
      // ПРЕГЕНЕРАЦИЯ ОЗВУЧКИ для первого сообщения
      // КРИТИЧЕСКИ ВАЖНО: текст и аудио ВСЕГДА идут вместе
      // ИСПРАВЛЕНИЕ: scenarioGameIdForPregen уже определен выше, не нужно определять заново
      // КРИТИЧЕСКИ ВАЖНО: Отправляем текст СРАЗУ, не ждем TTS
      // Аудио будет стримиться отдельно через /api/tts-stream на клиенте
      // Не сохраняем "технические ошибки" в историю
      const shouldSaveWelcome = !text || !text.trim().startsWith('Техническая ошибка');
      if (shouldSaveWelcome) {
        await prisma.chatSession.upsert({
          where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } },
          update: { history: ([{ from: 'bot', text }] as any) },
          create: { userId: 'lobby:' + lobbyId, gameId, history: ([{ from: 'bot', text }] as any) },
        });
      }
      wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
      
      // Отправляем текст сразу, аудио будет стримиться отдельно
      const response: any = { message: text || '', fallback: !Boolean(apiKey), audioStream: true };
      console.log('[WELCOME] ✅ Returning text immediately, audio will stream separately');
      return res.json(response);
    }
    // SOLO: стартуем/возобновляем движок c первой локации и даём описание с действиями из сцены
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    const client = apiKey ? createOpenAIClient(apiKey) : null;
    const sys = getSysPrompt();
    const welcomeSysPromptSolo = sys +
      'КРИТИЧЕСКИ ВАЖНО ДЛЯ WELCOME СООБЩЕНИЯ: Это ПЕРВОЕ сообщение в игре. Ты должен начать с ПРЕДЫСТОРИИ/ВВЕДЕНИЯ, чтобы погрузить игрока в мир и контекст, а ЗАТЕМ плавно перейти к описанию текущей сцены. ' +
      'СТРУКТУРА WELCOME СООБЩЕНИЯ: ' +
      '1. Начни с краткой предыстории/введения (2-3 предложения) - что привело к текущей ситуации, где находятся персонажи, какой контекст. ' +
      '2. Затем плавно перейди к описанию текущей сцены - что видят персонажи, какая атмосфера, что происходит вокруг. ' +
      '3. В конце предложи варианты действий из кнопок локации. ' +
      'НИКОГДА не начинай сразу с вариантов действий - сначала дай предысторию и описание сцены! ' +
      'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
      'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
      'Играй от лица рассказчика, а не игрока: избегай фраз "вы решаете", "вы начинаете", "вы выбираете". ' +
      'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
      'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
      'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
      'КРИТИЧЕСКИ ВАЖНО: Если игрок задает прямой вопрос (например, "Знаешь ли ты мое имя?", "Что ты знаешь о...", "Расскажи о..."), ОБЯЗАТЕЛЬНО отвечай на него прямо и честно, используя информацию из контекста диалога и сцены. Не игнорируй прямые вопросы игрока. ' +
      'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
      'Если игрок пишет что-то вне кнопок (но это не прямой вопрос) — мягко возвращай его к выбору, но через атмосферное описание. ' +
      'После атмосферного описания всегда выводи чёткие варианты действий, опираясь на кнопки текущей сцены. ' +
      'Обязательно формулируй их коротко и ясно, чтобы игрок понял, что делать дальше. ' +
      'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ message: 'user_required', fallback: true });
    // подготовим/стартуем session
    const first = await prisma.location.findFirst({ where: { gameId }, orderBy: { order: 'asc' } });
    if (!first) return res.status(404).json({ message: 'no_locations', fallback: true });
    let sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
    if (!sess) {
      // КРИТИЧЕСКИ ВАЖНО: Создаем сессию только если её нет, НЕ сбрасываем currentLocationId если сессия уже существует
      sess = await prisma.gameSession.create({ data: { scenarioGameId: gameId, userId: uid, currentLocationId: first.id, state: {} as any } });
    } else if (!sess.currentLocationId) {
      // Только если currentLocationId вообще не установлен (null/undefined) - устанавливаем на первую локацию
      sess = await prisma.gameSession.update({ where: { id: sess.id }, data: { currentLocationId: first.id } });
    }
    // УБРАНО: Не сбрасываем currentLocationId на first.id если он уже установлен - он должен меняться только при реальном переходе
    
    // КРИТИЧЕСКИ ВАЖНО: Создаем фиксированный ключ для welcome message на основе locationId
    // Welcome message имеет depth=0, choiceIndex=undefined, parentHash=undefined
    // Используем фиксированный ключ вместо текста, чтобы хеш был одинаковым для одной локации
    const welcomeKey = `welcome_${first.id}_d0`; // welcome + locationId + depth=0
    
    // ПРЕГЕНЕРАЦИЯ ОЗВУЧКИ для первого сообщения (SOLO режим)
    // КРИТИЧЕСКИ ВАЖНО: текст и аудио ВСЕГДА идут вместе
    let audioData: { buffer: Buffer; contentType: string } | null = null;
    let text: string | null = null;
    
        if (gameId && first?.id) {
          let scenarioGameIdForPregen: string | undefined = gameId; // Fallback на gameId
          try {
            const gsess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
            if (gsess?.scenarioGameId) {
              scenarioGameIdForPregen = gsess.scenarioGameId;
            }
          } catch (e) {
            console.warn('[WELCOME] Failed to get scenarioGameId (SOLO), using gameId:', e);
          }
          
      // Прегенерация удалена - генерируем через AI
      if (!text) {
            const sc = await buildGptSceneContext(prisma, { gameId, userId: uid, history: [] });
            // Получаем игру для добавления introduction/backstory/adventureHooks
            const game = await prisma.game.findUnique({ where: { id: gameId } });
            const contextWithIntro = [
              game?.introduction ? `Введение: ${game.introduction}` : '',
              game?.backstory ? `Предыстория: ${game.backstory}` : '',
              game?.adventureHooks ? `Зацепки приключения: ${game.adventureHooks}` : '',
              'Контекст сцены:\n' + sc
            ].filter(Boolean).join('\n\n');
            const { text: generatedText } = await generateChatCompletion({
              systemPrompt: welcomeSysPromptSolo,
              userPrompt: contextWithIntro,
              history: []
            });
            text = generatedText;
            if (text) {
              // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
              text = formatChoiceOptions(text);
              
              // НОВАЯ ЛОГИКА: ensureRealExitsInChoices удалена, используем текст как есть
            }
            text = (text || '').trim();
          }
        }
        
        // Если прегенерированного аудио нет, генерируем новое
        // КРИТИЧЕСКИ ВАЖНО: НЕ ждем TTS - отправляем текст сразу
        // Аудио будет стримиться отдельно через /api/tts-stream на клиенте
    // Не сохраняем "технические ошибки" в историю
        if (!text) {
      text = 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.';
    }
    const shouldSaveWelcomeSolo = text && !text.trim().startsWith('Техническая ошибка');
    if (shouldSaveWelcomeSolo) {
      await prisma.chatSession.upsert({
        where: { userId_gameId: { userId: uid, gameId } },
        update: { history: ([{ from: 'bot', text }] as any) },
        create: { userId: uid, gameId, history: ([{ from: 'bot', text }] as any) },
      });
    }
    
    // Отправляем текст сразу, аудио будет стримиться отдельно
    const response: any = { message: text || '', fallback: !Boolean(client), audioStream: true };
    console.log('[WELCOME] ✅ Returning text immediately (SOLO), audio will stream separately');
    return res.json(response);
  } catch (e) {
    console.error('Welcome handler error:', e);
    return res.json({ message: 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.', fallback: true });
  }
});

app.post('/api/chat/reply', async (req, res) => {
  const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  let userText = typeof req.body?.userText === 'string' ? req.body.userText : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [] as Array<{ from: 'bot' | 'me'; text: string }>;
  const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : undefined;
  const characterName = typeof req.body?.characterName === 'string' ? req.body.characterName : undefined;
  
  // КРИТИЧЕСКИ ВАЖНО: Проверяем, это текст или аудио (base64)
  // Если аудио - преобразуем через STT в текст
  if (userText && typeof userText === 'string') {
    // Проверяем, это base64 аудио или текст
    const isAudioBase64 = userText.startsWith('data:audio') || 
                          userText.startsWith('data:application/octet-stream') ||
                          (userText.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(userText.replace(/\s/g, '')));
    
    if (isAudioBase64) {
      console.log('[REPLY] 🎤 Detected AUDIO in userText, converting to TEXT via STT...');
      try {
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
        if (geminiKey) {
          // Извлекаем base64 данные (убираем префикс data:audio/webm;base64,)
          const base64Data = userText.includes(',') ? userText.split(',')[1] : userText;
          const audioBuffer = Buffer.from(base64Data, 'base64');
          
          // Преобразуем аудио в текст через STT
          const transcribedText = await transcribeViaGemini(audioBuffer, 'audio.webm', 'audio/webm', geminiKey);
          
          if (transcribedText && transcribedText.trim()) {
            userText = transcribedText.trim();
            console.log('[REPLY] ✅ Converted AUDIO to TEXT via STT:', `"${userText.slice(0, 100)}${userText.length > 100 ? '...' : ''}"`);
          } else {
            console.error('[REPLY] ❌ STT returned empty text');
            return res.status(400).json({ error: 'stt_failed', message: 'Не удалось распознать речь' });
          }
        } else {
          console.error('[REPLY] ❌ No Gemini API key for STT');
          return res.status(400).json({ error: 'stt_key_missing', message: 'Не настроен API ключ для распознавания речи' });
        }
      } catch (e: any) {
        console.error('[REPLY] ❌ STT error:', e?.message || String(e));
        return res.status(400).json({ error: 'stt_error', message: `Ошибка распознавания речи: ${e?.message || 'Неизвестная ошибка'}` });
      }
    } else {
      console.log('[REPLY] ✅ Received TEXT (not audio):', `"${userText.slice(0, 100)}${userText.length > 100 ? '...' : ''}"`);
    }
  }
  
  const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
  try {
    const prisma = getPrisma();
    
    // ОПТИМИЗАЦИЯ: Получаем userId один раз в начале и кэшируем
    let cachedUserId: string | null = null;
    const getUserId = async () => {
      if (cachedUserId !== null) return cachedUserId;
      if (lobbyId) {
        cachedUserId = await resolveUserIdFromQueryOrBody(req, prisma) || null;
      } else {
        cachedUserId = await resolveUserIdFromQueryOrBody(req, prisma) || null;
      }
      return cachedUserId;
    };
    
    // ОПТИМИЗАЦИЯ: Получаем gameSession один раз и кэшируем
    let cachedGameSession: any = null;
    const getGameSession = async () => {
      if (cachedGameSession !== null) return cachedGameSession;
      if (!gameId) return null;
      try {
        if (lobbyId) {
          cachedGameSession = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
        } else {
          const uid = await getUserId();
          if (uid) cachedGameSession = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
        }
      } catch {}
      return cachedGameSession;
    };
    
    // КРИТИЧЕСКИ ВАЖНО: НЕ используем прямой поиск по userText!
    // ВСЕГДА используем choiceIndex, определенный AI
    // Если AI не смог определить - есть fallback система для уточнения
    let forcedGameOver = false;
    let chosenExit: any = null; // Exit, выбранный по choiceIndex
    if (forcedGameOver && gameId) {
      const finalText = 'Сценарий завершён. Спасибо за игру!';
      if (lobbyId) {
        const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
        const history = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
        history.push({ from: 'bot', text: finalText });
        await prisma.chatSession.upsert({
          where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } },
          update: { history: history as any },
          create: { userId: 'lobby:' + lobbyId, gameId, history: history as any },
        });
        wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
        return res.json({ message: finalText, fallback: false, gameOver: true, audioStream: true });
      } else {
        const uid = await getUserId();
        if (uid) {
          const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
          const history = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
          history.push({ from: 'bot', text: finalText });
          await prisma.chatSession.upsert({
            where: { userId_gameId: { userId: uid, gameId } },
            update: { history: history as any },
            create: { userId: uid, gameId, history: history as any },
          });
        }
        return res.json({ message: finalText, fallback: false, gameOver: true, audioStream: true });
      }
    }
    let actingUserId: string | null = null;
    if (lobbyId) {
      const uid = await getUserId();
      if (!uid) return res.status(400).json({ error: 'user_required' });
      const t = lobbyTurns.get(lobbyId);
      if (t && t.order.length && t.order[t.idx] !== uid) return res.status(403).json({ error: 'not_your_turn' });
      actingUserId = uid;
    }
    // ОПТИМИЗАЦИЯ: Параллельно загружаем game и npcs
    const [game, npcs] = await Promise.all([
      gameId ? prisma.game.findUnique({ where: { id: gameId }, include: { characters: true, locations: { orderBy: { order: 'asc' } } } }) : Promise.resolve(null),
      gameId ? prisma.character.findMany({ where: { gameId, OR: [{ isPlayable: false }, { isPlayable: null }] }, take: 6 }).catch(() => []) : Promise.resolve([])
    ]);
    const playable = (game?.characters || []).filter((c: any) => c.isPlayable);
    
    // Получаем данные персонажа из БД, если передан characterId
    let finalCharacterName = characterName;
    let characterPersona = '';
    if (characterId && !finalCharacterName) {
      try {
        const char = await prisma.character.findUnique({ where: { id: characterId } });
        if (char) {
          finalCharacterName = char.name || undefined;
          characterPersona = char.persona || '';
        }
      } catch (e) {
        console.warn('[REPLY] Failed to fetch character:', e);
      }
    } else if (characterId && finalCharacterName) {
      // Если есть и ID и имя, получаем дополнительную информацию (persona, stats)
      try {
        const char = await prisma.character.findUnique({ where: { id: characterId } });
        if (char) {
          characterPersona = char.persona || '';
        }
      } catch (e) {
        console.warn('[REPLY] Failed to fetch character details:', e);
      }
    }
    
    const sys = getSysPrompt();
    // Добавляем информацию о персонаже игрока в системный промпт
    let characterInfo = '';
    if (finalCharacterName) {
      characterInfo = `\n\nКРИТИЧЕСКИ ВАЖНО: Игрок управляет персонажем по имени "${finalCharacterName}". Ты УЖЕ ЗНАЕШЬ имя персонажа из базы данных - НЕ спрашивай его! ВСЕГДА используй ПОЛНОЕ имя "${finalCharacterName}" целиком (все слова, не только первое!). Всегда обращайся к персонажу по его ПОЛНОМУ имени "${finalCharacterName}", когда описываешь его действия или обращаешься к нему. Например: "${finalCharacterName} делает...", "${finalCharacterName}, ты видишь...", "Обращаясь к ${finalCharacterName}, мастер говорит...". Используй имя персонажа "${finalCharacterName}" естественно в тексте, не только в начале предложения. НИКОГДА не сокращай имя до первого слова - всегда используй полное имя "${finalCharacterName}".${characterPersona ? ` Характер персонажа: ${characterPersona}` : ''}`;
    }
    const sysWithCharacter = sys + characterInfo +
      'КРИТИЧЕСКИ ВАЖНО ПРО ИМЕНА: Если в контексте указано имя персонажа (например, "Сара Конор Младшая"), ВСЕГДА используй ПОЛНОЕ имя целиком (все слова), НИКОГДА не сокращай до первого слова! Это правило применяется ко ВСЕМ именам персонажей в тексте. ' +
      'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
      'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
      'Играй от лица рассказчика, а не игрока: избегай фраз "вы решаете", "вы начинаете", "вы выбираете". ' +
      'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
      'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
      'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
      'КРИТИЧЕСКИ ВАЖНО: Если игрок задает прямой вопрос (например, "Знаешь ли ты мое имя?", "Что ты знаешь о...", "Расскажи о..."), ОБЯЗАТЕЛЬНО отвечай на него прямо и честно, используя информацию из контекста диалога и сцены. Не игнорируй прямые вопросы игрока. ' +
      'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
      'Если игрок пишет что-то вне кнопок (но это не прямой вопрос) — мягко возвращай его к выбору, но через атмосферное описание. ' +
      'После атмосферного описания всегда выводи чёткие варианты действий, опираясь на кнопки текущей сцены. ' +
      'Обязательно формулируй их коротко и ясно, чтобы игрок понял, что делать дальше. ' +
      'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
    const context: string[] = [];
    if (game) {
      context.push(`Игра: ${game.title}`);
      if (game.description) context.push(`Описание: ${game.description}`);
      // Используем полные версии правил для ИИ, если они есть, иначе краткие
      const worldRulesForAI = (game as any)?.worldRulesFull || game.worldRules || '';
      const gameplayRulesForAI = (game as any)?.gameplayRulesFull || game.gameplayRules || '';
      if (worldRulesForAI) context.push(`Правила мира (сопоставляй с текущей сценой, не обобщай): ${worldRulesForAI}`);
      if (gameplayRulesForAI) context.push(`Правила процесса (сопоставляй с текущей сценой, не обобщай): ${gameplayRulesForAI}`);
      if (game.author) context.push(`Автор: ${game.author}`);
      if ((game as any).promoDescription) context.push(`Промо: ${(game as any).promoDescription}`);
      if (game.ageRating) context.push(`Возрастной рейтинг: ${game.ageRating}`);
      if ((game as any).winCondition) context.push(`Условие победы: ${(game as any).winCondition}`);
      if ((game as any).loseCondition) context.push(`Условие поражения: ${(game as any).loseCondition}`);
      if ((game as any).deathCondition) context.push(`Условие смерти: ${(game as any).deathCondition}`);
      if ((game as any).introduction) context.push(`Введение: ${(game as any).introduction}`);
      if ((game as any).backstory) context.push(`Предыстория: ${(game as any).backstory}`);
      if ((game as any).adventureHooks) context.push(`Зацепки приключения: ${(game as any).adventureHooks}`);
      if (playable.length) {
        // Получаем актуальное состояние персонажей из gameSession (используем кэш)
        let characterStates: Record<string, any> = {};
        try {
          const sess = await getGameSession();
          if (sess?.state) {
            const state = sess.state as any;
            characterStates = state.characters || {};
          }
        } catch {}
        
        context.push('ИГРОВЫЕ ПЕРСОНАЖИ D&D 5e (ТЕКУЩЕЕ СОСТОЯНИЕ из базы данных):\nКРИТИЧЕСКИ ВАЖНО: Используй ЭТИ данные о персонажах! НЕ придумывай новых персонажей, оружие, классы или расы. Используй ТОЛЬКО имена, классы, расы, характеристики, способности и оружие, которые указаны ниже. Если персонаж - маг, используй его магические способности из abilities. Если воин - его оружие и боевые навыки из abilities. Подбирай оружие и экипировку согласно классу и расе персонажа.\n' + playable.map((p: any) => {
          const charState = characterStates[p.id] || {};
          // Используем состояние из сессии, если есть, иначе базовые значения
          const currentHp = typeof charState.hp === 'number' ? charState.hp : p.hp;
          const currentMaxHp = typeof charState.maxHp === 'number' ? charState.maxHp : p.maxHp;
          
          // Применяем модификаторы состояний к характеристикам
          const baseStr = typeof charState.str === 'number' ? charState.str : p.str;
          const baseDex = typeof charState.dex === 'number' ? charState.dex : p.dex;
          const baseCon = typeof charState.con === 'number' ? charState.con : p.con;
          const baseInt = typeof charState.int === 'number' ? charState.int : p.int;
          const baseWis = typeof charState.wis === 'number' ? charState.wis : p.wis;
          const baseCha = typeof charState.cha === 'number' ? charState.cha : p.cha;
          
          const statMods = charState.statModifiers || {};
          const currentStr = baseStr + (statMods.str || 0);
          const currentDex = baseDex + (statMods.dex || 0);
          const currentCon = baseCon + (statMods.con || 0);
          const currentInt = baseInt + (statMods.int || 0);
          const currentWis = baseWis + (statMods.wis || 0);
          const currentCha = baseCha + (statMods.cha || 0);
          
          const currentAc = typeof charState.ac === 'number' ? charState.ac : p.ac;
          
          const traits = [p.role, p.class, p.race, p.gender].filter(Boolean).join(', ');
          const stats = `HP: ${currentHp}/${currentMaxHp}, AC: ${currentAc}, STR:${currentStr}${statMods.str ? `(${statMods.str > 0 ? '+' : ''}${statMods.str})` : ''}, DEX:${currentDex}${statMods.dex ? `(${statMods.dex > 0 ? '+' : ''}${statMods.dex})` : ''}, CON:${currentCon}${statMods.con ? `(${statMods.con > 0 ? '+' : ''}${statMods.con})` : ''}, INT:${currentInt}${statMods.int ? `(${statMods.int > 0 ? '+' : ''}${statMods.int})` : ''}, WIS:${currentWis}${statMods.wis ? `(${statMods.wis > 0 ? '+' : ''}${statMods.wis})` : ''}, CHA:${currentCha}${statMods.cha ? `(${statMods.cha > 0 ? '+' : ''}${statMods.cha})` : ''}`;
          const extras = [p.persona, p.origin].filter(Boolean).join('. ');
          const abilities = p.abilities ? `; способности: ${String(p.abilities).slice(0, 200)}` : '';
          
          // Форматируем состояния с описанием эффектов
          let conditionsText = '';
          if (charState.conditions && Array.isArray(charState.conditions) && charState.conditions.length > 0) {
            const conditionDescriptions = charState.conditions.map((cond: string) => {
              const effect = CONDITION_EFFECTS[cond.toLowerCase()];
              if (effect) {
                let desc = effect.name;
                if (effect.blocksActions) desc += ' (блокирует действия)';
                if (effect.blocksMovement) desc += ' (блокирует движение)';
                if (effect.blocksVision) desc += ' (блокирует зрение)';
                if (effect.duration !== undefined && charState.conditionData?.[cond]?.duration) {
                  desc += ` (${charState.conditionData[cond].duration} ходов)`;
                }
                return desc;
              }
              return cond;
            });
            conditionsText = `; состояния: ${conditionDescriptions.join(', ')}`;
          }
          
          return `- ${p.name} (${traits}) — ${stats}. ${extras}${abilities}${conditionsText}`;
        }).join('\n'));
      }
      if (Array.isArray(npcs) && npcs.length) {
        context.push('NPC, доступные в мире (используй их в сценах):\n' + npcs.map((n) => {
          const traits = [n.role, n.race, n.gender].filter(Boolean).join(', ');
          const extras = [n.persona, n.origin].filter(Boolean).join('. ');
          return `- ${n.name}${traits ? ` (${traits})` : ''}${extras ? ` — ${extras}` : ''}`;
        }).join('\n'));
      }
      try {
        const editions = await getPrisma().edition.findMany({ where: { gameId: game.id }, take: 5 });
        if (Array.isArray(editions) && editions.length) {
          context.push('Издания:\n' + editions.map((e) => `- ${e.name}: ${e.description} (цена: ${e.price})`).join('\n'));
        }
      } catch {}
      if ((game.locations || []).length) context.push(`Текущие локации: ${(game.locations || []).map((l: any) => l.title).join(', ')}`);
    }

    const cleanedHistoryAll = history.filter((m) => {
      const t = String(m?.text || '').trim();
      if (!t) return false;
      const low = t.toLowerCase();
      if (low === 'голосовое сообщение') return false;
      if (/^voice(\s|$)/i.test(t)) return false;
      return true;
    });
    let baseHistory = cleanedHistoryAll;
    if (lobbyId) {
      const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } } });
      const h = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
      baseHistory = h.concat(cleanedHistoryAll.filter((m) => m.from === 'me')); 
    }
    const lastDiceLine = [...baseHistory].reverse().find((m) => (m?.from === 'bot' || m?.from === 'me') && typeof m?.text === 'string' && m.text.trim().startsWith('🎲 Бросок'));
    const diceContext = lastDiceLine ? (`Последний бросок:\n${lastDiceLine.text}`) : '';
    let lastDiceOutcome: 'crit_success' | 'success' | 'partial' | 'fail' | 'crit_fail' | '' = '';
    if (lastDiceLine) {
      const t = lastDiceLine.text;
      if (/Критический успех/i.test(t)) lastDiceOutcome = 'crit_success';
      else if (/Критический провал/i.test(t)) lastDiceOutcome = 'crit_fail';
      else if (/Итог:\s*Успех/i.test(t)) lastDiceOutcome = 'success';
      else if (/Итог:\s*Частичный/i.test(t)) lastDiceOutcome = 'partial';
      else if (/Итог:\s*Провал/i.test(t)) lastDiceOutcome = 'fail';
    }
    function suggestCheck(text: string): { need: boolean; dc: number; context: string; kind: string } {
      const low = text.toLowerCase();
      const keys = [
        'осмотр', 'осмотреть', 'ищ', 'поиск', 'подсказ', 'скрыт', 'внимател', 'перцеп', 'perception',
        'открыт', 'открыть', 'вскрыт', 'вскрыть', 'взлом', 'взломать', 'повернуть', 'поднять крышку', 'крышк',
        'сундук', 'урна', 'урны', 'дверь', 'замок',
        'пытат', 'попыт', 'попроб', 'пробоват'
      ];
      const socialKeys = ['убежд', 'убедить', 'переговор', 'договор', 'уговор', 'харизм', 'charisma', 'persuasion', 'торг', 'торговать', 'прос', 'просить', 'просим', 'говор', 'поговор', 'диалог'];
      if (socialKeys.some((k) => low.includes(k))) {
        const dc = 15;
        const context = text.slice(0, 160);
        return { need: true, dc, context, kind: 'persuasion' };
      }
      if (keys.some((k) => low.includes(k))) {
        const dc = 14;
        const context = text.slice(0, 160);
        return { need: true, dc, context, kind: 'check' };
      }
      return { need: false, dc: 0, context: '', kind: 'check' };
    }
    if (!lastDiceLine) {
      const s = suggestCheck(userText);
      // Разрешаем автозапрос броска только если сцена явно содержит указание на проверки (rulesPrompt с d20/DC/«провер»)
      let allowDice = false;
      try {
        if (gameId) {
          const sessCur = await getGameSession();
          if (sessCur?.currentLocationId) {
            const locCur = await prisma.location.findUnique({ where: { id: sessCur.currentLocationId } });
            const rp = String(locCur?.rulesPrompt || locCur?.description || '').toLowerCase();
            if (/(d20|dc|провер(ка|ить|ки|ок))/i.test(rp)) allowDice = true;
          }
        }
      } catch {}
      if (s.need && gameId && allowDice) {
        const promptMsg = `Чтобы выполнить действие, бросьте проверку (d20) · DC=${s.dc}.\nКонтекст: ${s.context}\nНажмите 🎲.`;
        if (lobbyId) {
          const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
          const h = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
          const recent = h.slice(-6);
          const hasRecentDice = recent.some((m) => typeof m?.text === 'string' && m.text.startsWith('🎲 Бросок'));
          const hasSamePrompt = recent.some((m) => typeof m?.text === 'string' && m.text.includes('Чтобы выполнить действие') && m.text.includes(s.context));
          if (!hasRecentDice && !hasSamePrompt) {
            h.push({ from: 'bot', text: promptMsg });
          }
          await prisma.chatSession.upsert({
            where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } },
            update: { history: h as any },
            create: { userId: 'lobby:' + lobbyId, gameId, history: h as any },
          });
          wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
          return res.json({ message: '', fallback: false, requestDice: { expr: 'd20', dc: s.dc, context: s.context, kind: s.kind } });
        } else {
          const uid = await getUserId();
          if (uid) {
            const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
            const h = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
            const recent = h.slice(-6);
            const hasRecentDice = recent.some((m) => typeof m?.text === 'string' && m.text.startsWith('🎲 Бросок'));
            const hasSamePrompt = recent.some((m) => typeof m?.text === 'string' && m.text.includes('Чтобы выполнить действие') && m.text.includes(s.context));
            if (!hasRecentDice && !hasSamePrompt) {
              h.push({ from: 'bot', text: promptMsg });
            }
            await prisma.chatSession.upsert({
              where: { userId_gameId: { userId: uid, gameId } },
              update: { history: h as any },
              create: { userId: uid, gameId, history: h as any },
            });
          }
          return res.json({ message: promptMsg, fallback: false, requestDice: { expr: 'd20', dc: s.dc, context: s.context, kind: s.kind } });
        }
      }
    }
    const fallbackBranch = async (): Promise<string> => {
      try {
        const sx = await getGameSession();
        const locCur = sx?.currentLocationId ? await prisma.location.findUnique({ where: { id: sx.currentLocationId } }) : null;
        const desc = String(locCur?.rulesPrompt || locCur?.description || 'Текущая сцена без описания.');
        return `Техническая ошибка. Описание текущей сцены:\n${desc}`;
      } catch {
        return 'Техническая ошибка. Продолжение будет доступно позже.';
      }
    };

    // КРИТИЧЕСКИ ВАЖНО: Проверяем, выбрал ли игрок реальный выход из локации ПЕРЕД генерацией ответа
    // Если да - переключаем локацию на targetLocationId выбранного выхода
    // Это нужно сделать ДО генерации ответа, чтобы использовать предыдущий ответ бота с вариантами
    if (gameId && userText) {
      try {
        const sess = await getGameSession();
        if (sess?.currentLocationId) {
          // Получаем последний ответ бота из истории (это ответ с вариантами выбора)
          let lastBotMessage = '';
          if (lobbyId) {
            const chatSess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
            const h = ((chatSess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
            const lastBot = [...h].reverse().find(m => m.from === 'bot');
            if (lastBot) lastBotMessage = lastBot.text || '';
          } else {
            const uid = await getUserId();
            if (uid) {
              const chatSess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
              const h = ((chatSess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
              const lastBot = [...h].reverse().find(m => m.from === 'bot');
              if (lastBot) lastBotMessage = lastBot.text || '';
            }
          }
          
          // КРИТИЧЕСКИ ВАЖНО: Сначала получаем реальные выходы из БД
          // Затем проверяем, соответствует ли текст игрока ТОЧНО одному из реальных выходов
          const allExits = await prisma.locationExit.findMany({ where: { locationId: sess.currentLocationId } });
          const realExits = allExits.filter((e: any) => e.type === 'BUTTON' && e.targetLocationId && !e.isGameOver);
          
          if (realExits.length > 0) {
            // Нормализуем текст игрока для сравнения
            const userTextNormalized = userText.trim().toLowerCase();
            
            // Парсим варианты выбора из последнего ответа бота
            const choices = parseChoiceOptions(lastBotMessage);
            
            // Проверяем, соответствует ли текст игрока реальному выходу из БД
            // НЕ используем includes - это слишком широко, проверяем только точное совпадение
            let selectedExit: any = null;
            for (const exit of realExits) {
              const exitText = (exit.buttonText || exit.triggerText || '').toLowerCase().trim();
              if (!exitText) continue;
              
              // Проверяем точное совпадение текста игрока с текстом реального выхода
              if (userTextNormalized === exitText || exitText === userTextNormalized) {
                // Дополнительная проверка: этот выход должен быть в вариантах выбора из последнего ответа бота
                if (choices.length > 0) {
                  const choiceIndex = choices.findIndex(choice => {
                    const choiceLower = choice.toLowerCase().trim();
                    return choiceLower === exitText || exitText === choiceLower;
                  });
                  
                  if (choiceIndex >= 0) {
                    selectedExit = exit;
                    break;
                  }
                } else {
                  // Если вариантов нет, но текст точно совпадает - это реальный выход
                  selectedExit = exit;
                  break;
                }
              }
              
              // Также проверяем номер варианта (если игрок написал "1", "2" и т.д.)
              if (choices.length > 0) {
                const exitIndex = realExits.indexOf(exit);
                if (userTextNormalized === String(exitIndex + 1) || 
                    userTextNormalized === `${exitIndex + 1}.` ||
                    userTextNormalized.startsWith(`${exitIndex + 1}. `)) {
                  // Проверяем, что этот вариант есть в списке вариантов и соответствует реальному выходу
                  if (exitIndex < choices.length) {
                    const choiceText = choices[exitIndex].toLowerCase().trim();
                    if (choiceText === exitText || exitText === choiceText) {
                      selectedExit = exit;
                      break;
                    }
                  }
                }
              }
            }
            
            if (selectedExit && selectedExit.targetLocationId) {
              const oldLocationId = sess.currentLocationId;
              
              // Переключаем локацию
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { currentLocationId: selectedExit.targetLocationId }
              });
              
              // Обновляем состояние: сбрасываем счетчик сцен без реальных выходов и порог
              const state = (sess.state as any) || {};
              state.scenesWithoutRealExit = 0;
              state.realExitThreshold = undefined; // Сбрасываем порог для нового цикла
              state.scenesInCurrentLocation = 0; // Сбрасываем счетчик сцен в новой локации
              state.lastAction = userText || '';
              state.visited = Array.isArray(state.visited) ? Array.from(new Set(state.visited.concat([oldLocationId, selectedExit.targetLocationId]))) : [oldLocationId, selectedExit.targetLocationId];
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { state }
              });
              
              console.log(`[REPLY] ✅ Location switched from ${oldLocationId} to ${selectedExit.targetLocationId} via real exit: "${exit.buttonText || exit.triggerText}"`);
              
              // Обновляем кэш сессии для последующего использования
              cachedGameSession = await prisma.gameSession.findUnique({ where: { id: sess.id } });
            }
          }
        }
      } catch (e) {
        console.warn('[REPLY] Failed to check location switch:', e);
      }
    }

    // ОПТИМИЗАЦИЯ: Передаем кэшированные данные в buildGptSceneContext
    // Используем finalCharacterName, если он был получен из БД выше
    const sc = await (async () => {
      try {
        if (gameId) {
          return await buildGptSceneContext(prisma, {
            gameId,
            lobbyId,
            userId: lobbyId ? undefined : (await getUserId()),
            history: baseHistory,
            cachedGameSession: cachedGameSession, // Передаем кэшированную сессию
            characterId, // Передаем ID персонажа
            characterName: finalCharacterName || characterName, // Используем имя из БД, если получено
          });
        }
      } catch {}
      return '';
    })();

    const dndOutcomeMap: Record<string, string> = {
      crit_success: 'Результат D&D: Критический успех! Опиши триумфальный исход, превосходящий ожидания. Учти бонусы и способности.',
      success: 'Результат D&D: Успех. Действие выполнено успешно. Опиши последствия согласно правилам 5e.',
      partial: 'Результат D&D: Частичный успех (Success at a cost). Действие удалось, но возникло осложнение или цена.',
      fail: 'Результат D&D: Провал. Действие не удалось. Опиши последствия, не блокируя сюжет.',
      crit_fail: 'Результат D&D: Критический провал! Опиши катастрофическое последствие или досадную помеху.',
    };


    const userPrompt = [
      'Контекст игры:\n' + context.filter(Boolean).join('\n\n'),
      sc ? 'Контекст сцены:\n' + sc : '',
      diceContext ? 'Результат броска:\n' + diceContext : '',
      lastDiceOutcome ? dndOutcomeMap[lastDiceOutcome] : '',
      `Действие игрока: ${userText || 'Продолжай.'}`
    ].filter(Boolean).join('\n\n');

    let text: string | null = null;
    
    // КРИТИЧЕСКИ ВАЖНО: Сначала проверяем прегенерированные материалы ПЕРЕД генерацией текста
    // Получаем контекст для поиска прегенерированных материалов
    let locationIdForPregen: string | undefined = undefined;
    let scenarioGameIdForPregen: string | undefined = undefined;
    let depthForPregen = 0;
    let choiceIndexForPregen: number | undefined = undefined;
    let parentHashForPregen: string | undefined = undefined;
    // Прегенерация удалена
    
    if (gameId) {
      try {
        let sess: any = null;
        if (lobbyId) {
          sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
        } else {
          const uid = await resolveUserIdFromQueryOrBody(req, prisma);
          if (uid) sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
        }
        if (sess) {
          locationIdForPregen = sess.currentLocationId || undefined;
          scenarioGameIdForPregen = sess.scenarioGameId;
          
          // Определяем depth, choiceIndex и parentHash из истории
          if (baseHistory && baseHistory.length > 0) {
            // КРИТИЧЕСКИ ВАЖНО: Исключаем сообщения об ошибке из подсчета depth
            // Сообщения об ошибке не должны увеличивать depth, так как они не являются частью диалога
            const botMessages = baseHistory.filter(m => {
              if (m.from !== 'bot') return false;
              const text = m.text || '';
              // Исключаем сообщения об ошибке
              if (text.trim() === 'Не распознали ваш ответ, выберите вариант корректно!') return false;
              if (text.trim().startsWith('Техническая ошибка')) return false;
              return true;
            });
            depthForPregen = botMessages.length;
            
            // choiceIndex больше не определяется через AI - пользователь может писать свободно
            
            // parentHash - это хеш последнего сообщения бота (welcome сообщения или предыдущего ответа)
            if (botMessages.length > 0) {
              const lastBotMessage = botMessages[botMessages.length - 1];
              if (lastBotMessage && lastBotMessage.text) {
                // КРИТИЧЕСКИ ВАЖНО: parentHash создается БЕЗ locationId в хеше (для диалогов внутри локации)
                parentHashForPregen = createAudioHash(lastBotMessage.text, undefined, undefined, 'narrator', depthForPregen - 1);
                console.log('[REPLY] ✅ Created parentHash from last bot message, depth:', depthForPregen - 1, 'hash:', parentHashForPregen?.slice(0, 8));
              }
            }
      } else {
            // Если истории нет (первый ответ на welcome), depth=1
            depthForPregen = 1;
            // parentHash для первого ответа - это хеш welcome сообщения (depth=0)
            // КРИТИЧЕСКИ ВАЖНО: Используем welcomeKey вместо текста, чтобы parentHash был одинаковым для одной локации
            try {
              // Получаем первую локацию для создания welcomeKey
              const first = await prisma.location.findFirst({ where: { gameId: gameId || 'unknown' }, orderBy: { order: 'asc' } });
              if (first?.id) {
                const welcomeKey = `welcome_${first.id}_d0`; // welcome + locationId + depth=0
                // КРИТИЧЕСКИ ВАЖНО: parentHash создается БЕЗ locationId в хеше (для диалогов внутри локации)
                parentHashForPregen = createAudioHash(welcomeKey, undefined, undefined, 'narrator', 0);
                console.log('[REPLY] ✅ First reply: created parentHash from welcomeKey, hash:', parentHashForPregen?.slice(0, 8));
        }
      } catch (e) {
              console.warn('[REPLY] Failed to get first location for parentHash:', e);
            }
          }
      } else {
          scenarioGameIdForPregen = gameId;
        }
      } catch (e) {
        console.warn('[REPLY] Failed to get session context:', e);
        scenarioGameIdForPregen = gameId;
      }
    }
    
    // AI обработка выбора вариантов удалена - пользователь может писать свободно
    
    // Прегенерация удалена - генерируем в реальном времени
    // AI обработка выбора вариантов удалена - пользователь может писать свободно
    if (!text) {
      let enhancedUserPrompt = userPrompt;
      
      // КРИТИЧЕСКИ ВАЖНО: Получаем реальные exits из базы данных и передаем их AI
      // Это нужно, чтобы AI знал о реальных exits и не предлагал варианты, которых нет в базе данных
      // Но AI может генерировать диалоговые варианты, которые не являются exits
      let realExitsInfo = '';
      if (gameId) {
        try {
          const sess = await getGameSession();
          if (sess?.currentLocationId) {
            const exits = await prisma.locationExit.findMany({ where: { locationId: sess.currentLocationId } });
            const btns = exits.filter((e: any) => e.type === 'BUTTON');
            if (btns.length > 0) {
              // Фильтруем только реальные выходы (с targetLocationId, не GAMEOVER)
              const realBtns = btns.filter((e: any) => e.targetLocationId && !e.isGameOver);
              if (realBtns.length > 0) {
                const exitsList = realBtns.map((exit, idx) => {
                  const choiceText = exit.buttonText || exit.triggerText || `Вариант ${idx + 1}`;
                  return `${idx + 1}. ${choiceText}`;
                }).join('\n');
                
                // Получаем информацию о счетчике сцен без реальных выходов
                let scenesCount = 0;
                let threshold = 0;
                let shouldSuggestMore = false;
                try {
                  const sess = await getGameSession();
                  if (sess?.state) {
                    const state = sess.state as any;
                    scenesCount = state.scenesWithoutRealExit || 0;
                    threshold = state.realExitThreshold || 0;
                    shouldSuggestMore = scenesCount >= threshold && threshold > 0;
                  }
                } catch (e) {
                  console.warn('[REPLY] Failed to get scene counter:', e);
                }
                
                let rulesText = `\n\nПРАВИЛА ФОРМИРОВАНИЯ ВАРИАНТОВ:\n1. НЕ обязательно включать реальные выходы в КАЖДЫЙ ответ - можешь предлагать диалоговые/ситуативные варианты (например, "Спросить о чем-то", "Осмотреть детальнее", "Попробовать что-то сделать")\n2. НО важно, чтобы ветка диалога периодически (раз в 5-10 сцен) вела к реальному выходу из локации - включай реальные выходы естественным образом, когда это логично по сюжету\n3. НЕ предлагай варианты действий, которые выглядят как переходы в другие локации, но которых нет в списке реальных выходов выше`;
                
                if (shouldSuggestMore) {
                  rulesText += `\n\n⚠️ ВАЖНО: Прошло уже ${scenesCount} сцен без реальных выходов (порог: ${threshold}). СЕЙЧАС НУЖНО ЧАЩЕ предлагать реальные выходы из списка выше! Включай их в варианты выбора естественным образом, но чаще чем обычно. Реальные выходы могут быть в любом месте списка вариантов, не обязательно первыми.`;
                } else if (threshold > 0) {
                  rulesText += `\n\n📊 Прогресс: ${scenesCount}/${threshold} сцен без реальных выходов. Когда достигнешь порога - начни чаще предлагать реальные выходы.`;
                }
                
                rulesText += `\n4. Если включаешь реальные выходы - они могут быть в любом месте списка вариантов, не обязательно первыми`;
                
                realExitsInfo = `\n\nДОСТУПНЫЕ РЕАЛЬНЫЕ ВЫХОДЫ ИЗ ЛОКАЦИИ:\n${exitsList}${rulesText}`;
                console.log(`[REPLY] 📋 Added real exits context to AI prompt: ${realBtns.length} real exits${shouldSuggestMore ? ` (should suggest more often!)` : ''}`);
              }
            }
          }
        } catch (e) {
          console.warn('[REPLY] Failed to get real exits for AI prompt:', e);
        }
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Используем RAG через buildGptSceneContext (sc уже содержит RAG чанки)
      const hasRAGContext = sc && sc.includes('СЦЕНАРИЙ ИГРЫ') || sc?.includes('Правила мира') || sc?.includes('Правила процесса');
      console.log('[REPLY] 🔍 Generating text with RAG context:', hasRAGContext ? 'YES' : 'NO', 'context length:', sc?.length || 0);
      
      const { text: generatedText } = await generateChatCompletion({
        systemPrompt: sysWithCharacter,
        userPrompt: enhancedUserPrompt + realExitsInfo,
        history: baseHistory
      });
      text = generatedText;
    
      console.log('[REPLY] ✅ Text generated with RAG, length:', text?.length || 0);
      console.log('[REPLY] 🔊 This text will be sent to TTS streaming via /api/tts-stream endpoint');
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Fallback текст тоже должен пройти через блок TTS
    if (!text) {
      text = await fallbackBranch();
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Если текст все еще пустой после fallback, отправляем fallback ответ без TTS
    if (!text) {
      return res.json({ message: 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.', fallback: true });
    }

    // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
    // ВАЖНО: Применяем форматирование только если текст был сгенерирован, а не взят из файла
    // Если текст из файла - он уже должен быть отформатирован
    // Прегенерация удалена - всегда генерируем
    if (true) {
    text = formatChoiceOptions(text);
    } else {
      // Для прегенерированного текста проверяем, нужно ли форматирование
      const hasChoices = text.includes('**') || text.includes('*');
      if (hasChoices) {
        text = formatChoiceOptions(text);
      }
    }
    
    // НОВАЯ ЛОГИКА: ensureRealExitsInChoices удалена, используем текст как есть

    // Парсинг тега броска от ИИ
    let aiRequestDice: any = null;
    const diceTagRegex = /\[\[ROLL:\s*(.*?),\s*DC:\s*(\d+)\]\]/i;
    const match = text.match(diceTagRegex);
    if (match) {
      const kindRaw = match[1].trim();
      const dc = parseInt(match[2], 10);
      const kindNorm = normalizeRollKind(kindRaw);
      aiRequestDice = { expr: 'd20', dc, context: `Проверка: ${kindRaw}`, kind: kindNorm, skill: kindRaw };
      text = text.replace(diceTagRegex, '').trim();
      
      // КРИТИЧЕСКИ ВАЖНО: Если в тексте предлагается ТОЛЬКО бросок кубиков (1 действие) - удаляем варианты выбора
      // Если есть другие варианты - оставляем их
      const choices = parseChoiceOptions(text);
      if (choices.length === 1) {
        // Только один вариант - это бросок кубиков, удаляем варианты выбора
        text = text.replace(/\n\n\*\*.*[?]\s*\*\*\s*\n\n[\s\S]*?(\d+\.\s+[^\n]+(?:\n\d+\.\s+[^\n]+)*)/gi, '');
        text = text.replace(/\n\n(\d+\.\s+[^\n]+(?:\n\d+\.\s+[^\n]+)*)\s*$/g, '');
        text = text.replace(/\*\*.*[?]\s*\*\*/gi, '').trim();
        console.log('[REPLY] ✅ Removed choice options because only dice roll is required (1 action)');
      } else {
        // Больше одного варианта - оставляем варианты выбора
        console.log(`[REPLY] ✅ Keeping choice options (${choices.length} options, dice roll is one of them)`);
      }
    }

    // Парсинг изменений состояния персонажей из ответа ИИ
    if (gameId && playable.length) {
      try {
        const sess = await getGameSession();
        
        if (sess) {
          const state = (sess.state as any) || {};
          if (!state.characters) state.characters = {};
          
          // ПРИМЕНЯЕМ ЭФФЕКТЫ СОСТОЯНИЙ В НАЧАЛЕ ХОДА
          for (const char of playable) {
            const charState = state.characters[char.id] || { hp: char.hp, maxHp: char.maxHp };
            const baseChar = char;
            
            // Обновляем длительность состояний
            const { removed } = updateConditionDurations(charState);
            if (removed.length > 0) {
              console.log(`[CONDITIONS] Removed expired conditions for ${char.name}:`, removed);
            }
            
            // Применяем эффекты состояний
            const { hpChange, statChanges, messages } = applyConditionEffects(charState, baseChar);
            
            if (hpChange !== 0) {
              charState.hp = Math.max(0, Math.min(charState.maxHp || baseChar.maxHp, (charState.hp || baseChar.hp) + hpChange));
              console.log(`[CONDITIONS] ${char.name} HP changed by ${hpChange} due to conditions. New HP: ${charState.hp}/${charState.maxHp || baseChar.maxHp}`);
            }
            
            if (Object.keys(statChanges).length > 0) {
              if (!charState.statModifiers) charState.statModifiers = {};
              for (const [stat, change] of Object.entries(statChanges)) {
                charState.statModifiers[stat] = (charState.statModifiers[stat] || 0) + change;
              }
            }
            
            state.characters[char.id] = charState;
          }
          
          // Парсим изменения HP из текста ИИ
          // Форматы: "Персонаж теряет 5 HP", "HP уменьшается на 3", "Персонаж получает урон 10"
          // "Персонаж восстанавливает 5 HP", "HP увеличивается на 3", "Лечение: +5 HP"
          const hpChangeRegex = /(?:([А-Яа-яЁёA-Za-z\s]{2,30})\s*(?:теряет|получает|восстанавливает|теряет|получил|восстановил|получила|восстановила)\s*(?:урон|урон|HP|хит|хитов)?\s*(\d+)\s*(?:HP|хит|хитов|урона|урона)|HP\s*(?:уменьшается|увеличивается|изменяется)\s*(?:на|до)\s*([+-]?\d+)|(?:Урон|Лечение|Восстановление):\s*([+-]?\d+)\s*HP)/gi;
          const hpMatches = text.matchAll(hpChangeRegex);
          
          for (const hpMatch of hpMatches) {
            const charName = hpMatch[1]?.trim();
            const damage = hpMatch[2] ? parseInt(hpMatch[2], 10) : (hpMatch[3] ? parseInt(hpMatch[3], 10) : (hpMatch[4] ? parseInt(hpMatch[4], 10) : 0));
            
            if (charName && damage) {
              // Находим персонажа по имени
              const char = playable.find((p: any) => 
                p.name.toLowerCase().includes(charName.toLowerCase()) || 
                charName.toLowerCase().includes(p.name.toLowerCase())
              );
              
              if (char) {
                const charState = state.characters[char.id] || { hp: char.hp, maxHp: char.maxHp };
                const isHeal = hpMatch[0].toLowerCase().includes('восстанов') || hpMatch[0].toLowerCase().includes('лечение') || damage < 0;
                const isDamage = hpMatch[0].toLowerCase().includes('теряет') || hpMatch[0].toLowerCase().includes('урон') || damage > 0;
                
                if (isHeal) {
                  charState.hp = Math.min(charState.maxHp || char.maxHp, (charState.hp || char.hp) + Math.abs(damage));
                } else if (isDamage) {
                  charState.hp = Math.max(0, (charState.hp || char.hp) - Math.abs(damage));
                }
                
                state.characters[char.id] = charState;
              }
            }
          }
          
          // Парсим изменения характеристик (временные эффекты)
          // Формат: "STR уменьшается на 2", "DEX +1", "CON -1"
          const statChangeRegex = /(STR|DEX|CON|INT|WIS|CHA|Сила|Ловкость|Телосложение|Интеллект|Мудрость|Харизма)\s*(?:уменьшается|увеличивается|изменяется|становится)\s*(?:на|до)?\s*([+-]?\d+)/gi;
          const statMatches = text.matchAll(statChangeRegex);
          
          for (const statMatch of statMatches) {
            const statName = statMatch[1];
            const change = parseInt(statMatch[2], 10);
            
            if (statName && !isNaN(change)) {
              // Маппинг русских названий на английские
              const statMap: Record<string, string> = {
                'Сила': 'str', 'STR': 'str',
                'Ловкость': 'dex', 'DEX': 'dex',
                'Телосложение': 'con', 'CON': 'con',
                'Интеллект': 'int', 'INT': 'int',
                'Мудрость': 'wis', 'WIS': 'wis',
                'Харизма': 'cha', 'CHA': 'cha'
              };
              
              const statKey = statMap[statName] || statName.toLowerCase();
              
              // Применяем изменение ко всем персонажам (или можно указать конкретного)
              for (const char of playable) {
                const charState = state.characters[char.id] || {};
                if (!charState.statModifiers) charState.statModifiers = {};
                charState.statModifiers[statKey] = (charState.statModifiers[statKey] || 0) + change;
                state.characters[char.id] = charState;
              }
            }
          }
          
          // Парсим состояния (отравление, паралич и т.д.)
          // Формат: "Персонаж отравлен", "Применяется эффект: Паралич"
          // ВАЖНО: НЕ применяем состояния из описаний окружения (например, "отравленный воздух", "парализующий газ")
          
          // Функция проверки, является ли это описанием окружения/предмета, а не состоянием персонажа
          const isEnvironmentDescription = (condition: string, beforeMatch: string, fullMatch: string, afterMatch: string, charName: string | null): boolean => {
            const conditionLower = condition.toLowerCase();
            
            // Слова, которые могут указывать на описание окружения/предмета
            const environmentKeywords = [
              'воздух', 'вода', 'газ', 'туман', 'облако', 'облака', 'вещество', 'вещества',
              'среда', 'среды', 'атмосфера', 'атмосферы', 'окружение', 'окружения',
              'область', 'области', 'зона', 'зоны', 'место', 'места', 'помещение', 'помещения',
              'комната', 'комнаты', 'зал', 'залы', 'коридор', 'коридоры', 'туннель', 'туннели',
              'пещера', 'пещеры', 'подземелье', 'подземелья', 'оружие', 'оружия', 'стрела', 'стрелы',
              'клинок', 'клинки', 'лезвие', 'лезвия', 'яд', 'яды', 'токсин', 'токсины', 'магия',
              'заклинание', 'заклинания', 'эффект', 'эффекты', 'поле', 'поля', 'барьер', 'барьеры',
              'ловушка', 'ловушки', 'проклятие', 'проклятия', 'аура', 'ауры'
            ];
            
            // Паттерны для прилагательных (отравленный, парализующий, оглушающий и т.д.)
            const adjectivePatterns: Record<string, string[]> = {
              'отравлен': ['отравленн(?:ый|ая|ое|ые)', 'отравляющ(?:ий|ая|ее|ие)'],
              'парализован': ['парализованн(?:ый|ая|ое|ые)', 'парализующ(?:ий|ая|ее|ие)'],
              'оглушен': ['оглушенн(?:ый|ая|ое|ые)', 'оглушающ(?:ий|ая|ее|ие)'],
              'ослеплен': ['ослепленн(?:ый|ая|ое|ые)', 'ослепляющ(?:ий|ая|ее|ие)'],
              'очарован': ['очарованн(?:ый|ая|ое|ые)', 'очаровывающ(?:ий|ая|ее|ие)'],
              'испуган': ['испуганн(?:ый|ая|ое|ые)', 'пугающ(?:ий|ая|ее|ие)'],
              'невидим': ['невидим(?:ый|ая|ое|ые)', 'невидимо'],
              'болезнь': ['болезненн(?:ый|ая|ое|ые)', 'заболевш(?:ий|ая|ее|ие)'],
              'усталость': ['устал(?:ый|ая|ое|ые)', 'утомленн(?:ый|ая|ое|ые)'],
              'истощение': ['истощенн(?:ый|ая|ое|ые)', 'истощающ(?:ий|ая|ее|ие)']
            };
            
            const patterns = adjectivePatterns[conditionLower] || [];
            const context = (beforeMatch + fullMatch + afterMatch).toLowerCase();
            
            // Проверяем, есть ли прилагательное + слово окружения
            for (const pattern of patterns) {
              for (const keyword of environmentKeywords) {
                const regex = new RegExp(`${pattern}\\s+${keyword}`, 'i');
                if (regex.test(context)) {
                  return true;
                }
              }
            }
            
            // Проверяем, что после условия идет слово окружения (например, "отравлен воздух")
            for (const keyword of environmentKeywords) {
              const regex = new RegExp(`${conditionLower}\\s+${keyword}`, 'i');
              if (regex.test(context)) {
                return true;
              }
            }
            
            return false;
          };
          
          const conditionRegex = /(?:([А-Яа-яЁёA-Za-z\s]{2,30})\s*(?:получает|подвергается|подвержен|подвержена|становится|становятся|получил|получила|получили)\s*(?:эффекту|состоянию)?:?\s*)?(отравлен|парализован|оглушен|ослеплен|очарован|испуган|невидим|невидима|болезнь|болезни|усталость|усталости|истощение|истощения)/gi;
          const conditionMatches = text.matchAll(conditionRegex);
          
          for (const condMatch of conditionMatches) {
            const charName = condMatch[1]?.trim() || null;
            const condition = condMatch[2]?.toLowerCase();
            const fullMatch = condMatch[0];
            const matchIndex = condMatch.index || 0;
            
            // Проверяем контекст - если это описание окружения, пропускаем
            const beforeMatch = text.substring(Math.max(0, matchIndex - 50), matchIndex).toLowerCase();
            const afterMatch = text.substring(matchIndex + fullMatch.length, Math.min(text.length, matchIndex + fullMatch.length + 30)).toLowerCase();
            
            // Проверяем, является ли это описанием окружения/предмета
            if (isEnvironmentDescription(condition, beforeMatch, fullMatch, afterMatch, charName) && !charName) {
              console.log(`[CONDITIONS] Skipping condition "${condition}" - appears to be environment/object description, not character condition`);
              continue;
            }
            
            if (condition) {
              const chars = charName ? 
                playable.filter((p: any) => 
                  p.name.toLowerCase().includes(charName.toLowerCase()) || 
                  charName.toLowerCase().includes(p.name.toLowerCase())
                ) : playable;
              
              // Если нет имени персонажа, применяем только если есть явные глаголы применения состояния
              const hasActionVerb = /(?:получает|подвергается|подвержен|подвержена|становится|становятся|получил|получила|получили)/i.test(beforeMatch);
              
              // Также проверяем, что это не просто упоминание в описании (например, "в комнате отравленный воздух")
              const isJustMention = !charName && !hasActionVerb && !/(?:персонаж|игрок|герой|член|участник|член группы)/i.test(beforeMatch);
              
              if (isJustMention) {
                console.log(`[CONDITIONS] Skipping condition "${condition}" - appears to be just a mention in description, not application to character`);
                continue;
              }
              
              for (const char of chars) {
                const charState = state.characters[char.id] || {};
                if (!charState.conditions) charState.conditions = [];
                if (!charState.conditions.includes(condition)) {
                  charState.conditions.push(condition);
                  // Инициализируем данные состояния
                  const effect = CONDITION_EFFECTS[condition];
                  if (effect && effect.duration !== undefined) {
                    if (!charState.conditionData) charState.conditionData = {};
                    charState.conditionData[condition] = { duration: effect.duration };
                  }
                  console.log(`[CONDITIONS] Applied condition "${condition}" to ${char.name}`);
                }
                state.characters[char.id] = charState;
              }
            }
          }
          
          // Парсим снятие состояний (лечение, отдых)
          // Формат: "Состояние снято", "Отравление излечено", "Лечение снимает паралич"
          const removeConditionRegex = /(?:([А-Яа-яЁёA-Za-z\s]{2,30})\s*)?(?:излечен|излечена|вылечен|вылечена|снят|снята|снято|восстановлен|восстановлена|отдых|отдыхает|лечение|лечится)\s*(?:от|от)?\s*(отравлен|парализован|оглушен|ослеплен|очарован|испуган|невидим|невидима|болезнь|болезни|усталость|усталости|истощение|истощения|состояни[яе])/gi;
          const removeMatches = text.matchAll(removeConditionRegex);
          
          for (const removeMatch of removeMatches) {
            const charName = removeMatch[1]?.trim();
            const condition = removeMatch[2]?.toLowerCase();
            
            if (condition && condition !== 'состояни' && condition !== 'состояние') {
              const chars = charName ? 
                playable.filter((p: any) => 
                  p.name.toLowerCase().includes(charName.toLowerCase()) || 
                  charName.toLowerCase().includes(p.name.toLowerCase())
                ) : playable;
              
              for (const char of chars) {
                const charState = state.characters[char.id] || {};
                if (charState.conditions && charState.conditions.includes(condition)) {
                  charState.conditions = charState.conditions.filter((c: string) => c !== condition);
                  if (charState.conditionData && charState.conditionData[condition]) {
                    delete charState.conditionData[condition];
                  }
                  console.log(`[CONDITIONS] Removed condition "${condition}" from ${char.name}`);
                }
                state.characters[char.id] = charState;
              }
            }
          }
          
          // Сохраняем обновленное состояние
          await prisma.gameSession.update({
            where: { id: sess.id },
            data: { state }
          });
        }
      } catch (e) {
        console.error('[REPLY] Failed to parse character state changes:', e);
      }
    }

    // КРИТИЧЕСКИ ВАЖНО: Проверяем, выбрал ли игрок реальный выход из локации
    // Если да - переключаем локацию на targetLocationId выбранного выхода
    // Проверяем ПЕРЕД генерацией ответа, чтобы использовать предыдущий ответ бота с вариантами
    if (gameId && userText) {
      try {
        const sess = await getGameSession();
        if (sess?.currentLocationId) {
          // Получаем последний ответ бота из истории (это ответ с вариантами выбора)
          let lastBotMessage = '';
          if (lobbyId) {
            const chatSess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
            const h = ((chatSess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
            const lastBot = [...h].reverse().find(m => m.from === 'bot');
            if (lastBot) lastBotMessage = lastBot.text || '';
          } else {
            const uid = await getUserId();
            if (uid) {
              const chatSess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
              const h = ((chatSess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
              const lastBot = [...h].reverse().find(m => m.from === 'bot');
              if (lastBot) lastBotMessage = lastBot.text || '';
            }
          }
          
          // КРИТИЧЕСКИ ВАЖНО: Сначала получаем реальные выходы из БД
          // Затем проверяем, соответствует ли текст игрока ТОЧНО одному из реальных выходов
          const allExits = await prisma.locationExit.findMany({ where: { locationId: sess.currentLocationId } });
          const realExits = allExits.filter((e: any) => e.type === 'BUTTON' && e.targetLocationId && !e.isGameOver);
          
          if (realExits.length > 0) {
            // Нормализуем текст игрока для сравнения
            const userTextNormalized = userText.trim().toLowerCase();
            
            // Парсим варианты выбора из последнего ответа бота
            const choices = parseChoiceOptions(lastBotMessage);
            
            // Проверяем, соответствует ли текст игрока реальному выходу из БД
            // НЕ используем includes - это слишком широко, проверяем только точное совпадение
            let selectedExit: any = null;
            for (const exit of realExits) {
              const exitText = (exit.buttonText || exit.triggerText || '').toLowerCase().trim();
              if (!exitText) continue;
              
              // Проверяем точное совпадение текста игрока с текстом реального выхода
              if (userTextNormalized === exitText || exitText === userTextNormalized) {
                // Дополнительная проверка: этот выход должен быть в вариантах выбора из последнего ответа бота
                if (choices.length > 0) {
                  const choiceIndex = choices.findIndex(choice => {
                    const choiceLower = choice.toLowerCase().trim();
                    return choiceLower === exitText || exitText === choiceLower;
                  });
                  
                  if (choiceIndex >= 0) {
                    selectedExit = exit;
                    break;
                  }
                } else {
                  // Если вариантов нет, но текст точно совпадает - это реальный выход
                  selectedExit = exit;
                  break;
                }
              }
              
              // Также проверяем номер варианта (если игрок написал "1", "2" и т.д.)
              if (choices.length > 0) {
                const exitIndex = realExits.indexOf(exit);
                if (userTextNormalized === String(exitIndex + 1) || 
                    userTextNormalized === `${exitIndex + 1}.` ||
                    userTextNormalized.startsWith(`${exitIndex + 1}. `)) {
                  // Проверяем, что этот вариант есть в списке вариантов и соответствует реальному выходу
                  if (exitIndex < choices.length) {
                    const choiceText = choices[exitIndex].toLowerCase().trim();
                    if (choiceText === exitText || exitText === choiceText) {
                      selectedExit = exit;
                      break;
                    }
                  }
                }
              }
            }
            
            if (selectedExit && selectedExit.targetLocationId) {
              const oldLocationId = sess.currentLocationId;
              
              // Переключаем локацию
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { currentLocationId: selectedExit.targetLocationId }
              });
              
              // Обновляем состояние: сбрасываем счетчик сцен без реальных выходов и порог
              const state = (sess.state as any) || {};
              state.scenesWithoutRealExit = 0;
              state.realExitThreshold = undefined; // Сбрасываем порог для нового цикла
              state.scenesInCurrentLocation = 0; // Сбрасываем счетчик сцен в новой локации
              state.lastAction = userText || '';
              state.visited = Array.isArray(state.visited) ? Array.from(new Set(state.visited.concat([oldLocationId, selectedExit.targetLocationId]))) : [oldLocationId, selectedExit.targetLocationId];
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { state }
              });
              
              console.log(`[REPLY] ✅ Location switched from ${oldLocationId} to ${selectedExit.targetLocationId} via real exit: "${exit.buttonText || exit.triggerText}"`);
              
              // Обновляем кэш сессии для последующего использования
              cachedGameSession = await prisma.gameSession.findUnique({ where: { id: sess.id } });
            }
          }
        }
      } catch (e) {
        console.warn('[REPLY] Failed to check location switch:', e);
      }
    }

    // КРИТИЧЕСКИ ВАЖНО: НЕ ждем TTS - отправляем текст сразу
    // Аудио будет стримиться отдельно через /api/tts-stream на клиенте
    console.log('[REPLY] ✅ Text ready, sending response immediately (audio will stream separately)');

          if (lobbyId) {
      const sess = await prisma.chatSession.upsert({
        where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } },
        update: {},
        create: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown', history: [] as any },
      });
      const prev = ((sess.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
      
      // Не сохраняем "технические ошибки" и сообщения об ошибке распознавания в историю
      const shouldSaveBotMessage = !text || (!text.trim().startsWith('Техническая ошибка') && text.trim() !== 'Не распознали ваш ответ, выберите вариант корректно!');
      const newHist = prev.concat([
        (actingUserId ? ({ from: 'user', userId: actingUserId, text: userText } as any) : ({ from: 'me', text: userText } as any)), // ТОЛЬКО ТЕКСТ!
        ...(shouldSaveBotMessage ? [{ from: 'bot', text } as any] : []),
      ]);
      await prisma.chatSession.update({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } }, data: { history: newHist as any } });
      advanceTurn(lobbyId);
      wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
      
      // КРИТИЧЕСКИ ВАЖНО: Отправляем текст сгенерированный с RAG, клиент запросит TTS стриминг отдельно
      const response: any = { message: text, fallback: false, requestDice: aiRequestDice, audioStream: true };
      console.log('[REPLY] ✅ Text generated with RAG, sending response with audioStream=true');
      console.log('[REPLY] 🔊 Client should request /api/tts-stream with this text, length:', text?.length || 0);
      return res.json(response);
          } else {
            const uid = await resolveUserIdFromQueryOrBody(req, prisma);
      if (uid) {
        const sess = await prisma.chatSession.upsert({
          where: { userId_gameId: { userId: uid, gameId: gameId || 'unknown' } },
          update: {},
          create: { userId: uid, gameId: gameId || 'unknown', history: [] as any },
        });
        const prev = ((sess.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
        
        // Не сохраняем "технические ошибки" в историю
        const shouldSaveBotMessage = !text || !text.trim().startsWith('Техническая ошибка');
        const newHist = prev.concat([
          { from: 'me', text: userText } as any, // ТОЛЬКО ТЕКСТ!
          ...(shouldSaveBotMessage ? [{ from: 'bot', text } as any] : []),
        ]);
        await prisma.chatSession.update({ where: { userId_gameId: { userId: uid, gameId: gameId || 'unknown' } }, data: { history: newHist as any } });
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Отправляем текст сгенерированный с RAG, клиент запросит TTS стриминг отдельно
      const response: any = { message: text, fallback: false, requestDice: aiRequestDice, audioStream: true };
      console.log('[REPLY] ✅ Text generated with RAG, sending response with audioStream=true');
      console.log('[REPLY] 🔊 Client should request /api/tts-stream with this text, length:', text?.length || 0);
      return res.json(response);
          }
        } catch (e) {
    console.error('Reply handler error:', e);
    return res.status(200).json({ message: 'Связь с рассказчиком на мгновение прерывается. Но путь остаётся прежним.\n\n1) К реке.\n2) К волчьей тропе.\n3) В деревню.', fallback: true });
  }
});

// Потоковый endpoint для генерации текста с параллельной генерацией TTS
app.post('/api/chat/reply-stream', async (req, res) => {
  const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  let userText = typeof req.body?.userText === 'string' ? req.body.userText : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [] as Array<{ from: 'bot' | 'me'; text: string }>;
  
    // Настраиваем SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Отключает буферизацию Nginx
    if (res.flushHeaders) {
      res.flushHeaders();
    }
    
    const sendSSE = (event: string, data: any) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (res.flush && typeof res.flush === 'function') {
        res.flush();
      }
    };
  
  // КРИТИЧЕСКИ ВАЖНО: Проверяем, это текст или аудио (base64)
  // Если аудио - преобразуем через STT в текст (STT - это метод получения текста из аудио)
  if (userText && typeof userText === 'string') {
    // Проверяем, это base64 аудио или текст
    const isAudioBase64 = userText.startsWith('data:audio') || 
                          userText.startsWith('data:application/octet-stream') ||
                          (userText.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(userText.replace(/\s/g, '')));
    
    if (isAudioBase64) {
      console.log('[REPLY-STREAM] 🎤 Detected AUDIO in userText, converting to TEXT via STT...');
      sendSSE('status', { type: 'transcribing' });
      try {
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
        if (geminiKey) {
          // Извлекаем base64 данные (убираем префикс data:audio/webm;base64,)
          const base64Data = userText.includes(',') ? userText.split(',')[1] : userText;
          const audioBuffer = Buffer.from(base64Data, 'base64');
          
          // Преобразуем аудио в текст через STT (STT - это метод получения текста из аудио)
          const transcribedText = await transcribeViaGemini(audioBuffer, 'audio.webm', 'audio/webm', geminiKey);
          
          if (transcribedText && transcribedText.trim()) {
            userText = transcribedText.trim();
            console.log('[REPLY-STREAM] ✅ Converted AUDIO to TEXT via STT:', `"${userText.slice(0, 100)}${userText.length > 100 ? '...' : ''}"`);
            sendSSE('status', { type: 'transcribed', text: userText });
          } else {
            console.error('[REPLY-STREAM] ❌ STT returned empty text');
            sendSSE('error', { error: 'stt_failed', message: 'Не удалось распознать речь' });
            return;
          }
        } else {
          console.error('[REPLY-STREAM] ❌ No Gemini API key for STT');
          sendSSE('error', { error: 'stt_key_missing', message: 'Не настроен API ключ для распознавания речи' });
          return;
        }
      } catch (e: any) {
        console.error('[REPLY-STREAM] ❌ STT error:', e?.message || String(e));
        sendSSE('error', { error: 'stt_error', message: `Ошибка распознавания речи: ${e?.message || 'Неизвестная ошибка'}` });
        return;
      }
    } else {
      console.log('[REPLY-STREAM] ✅ Received TEXT (not audio):', `"${userText.slice(0, 100)}${userText.length > 100 ? '...' : ''}"`);
    }
  }
  
  // КРИТИЧЕСКИ ВАЖНО: Логируем историю (должна содержать только ТЕКСТ, расшифрованный через STT)
  console.log('[REPLY-STREAM] 📥 History items count:', history.length);
  
  try {
    const prisma = getPrisma();
    
    // КРИТИЧЕСКИ ВАЖНО: Проверяем, выбрал ли игрок реальный выход из локации ПЕРЕД генерацией ответа
    // Если да - переключаем локацию на targetLocationId выбранного выхода
    if (gameId && userText) {
      try {
        let sess: any = null;
        if (lobbyId) {
          sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
        } else {
          const uid = await resolveUserIdFromQueryOrBody(req, prisma);
          if (uid) {
            sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
          }
        }
        
        if (sess?.currentLocationId) {
          // Получаем последний ответ бота из истории (это ответ с вариантами выбора)
          let lastBotMessage = '';
          if (lobbyId) {
            const chatSess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
            const h = ((chatSess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
            const lastBot = [...h].reverse().find(m => m.from === 'bot');
            if (lastBot) lastBotMessage = lastBot.text || '';
          } else {
            const uid = await resolveUserIdFromQueryOrBody(req, prisma);
            if (uid) {
              const chatSess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
              const h = ((chatSess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
              const lastBot = [...h].reverse().find(m => m.from === 'bot');
              if (lastBot) lastBotMessage = lastBot.text || '';
            }
          }
          
          // КРИТИЧЕСКИ ВАЖНО: Сначала получаем реальные выходы из БД
          // Затем проверяем, соответствует ли текст игрока ТОЧНО одному из реальных выходов
          const allExits = await prisma.locationExit.findMany({ where: { locationId: sess.currentLocationId } });
          const realExits = allExits.filter((e: any) => e.type === 'BUTTON' && e.targetLocationId && !e.isGameOver);
          
          if (realExits.length > 0) {
            // Нормализуем текст игрока для сравнения
            const userTextNormalized = userText.trim().toLowerCase();
            
            // Парсим варианты выбора из последнего ответа бота
            const choices = parseChoiceOptions(lastBotMessage);
            
            // Проверяем, соответствует ли текст игрока реальному выходу из БД
            // НЕ используем includes - это слишком широко, проверяем только точное совпадение
            let selectedExit: any = null;
            for (const exit of realExits) {
              const exitText = (exit.buttonText || exit.triggerText || '').toLowerCase().trim();
              if (!exitText) continue;
              
              // Проверяем точное совпадение текста игрока с текстом реального выхода
              if (userTextNormalized === exitText || exitText === userTextNormalized) {
                // Дополнительная проверка: этот выход должен быть в вариантах выбора из последнего ответа бота
                if (choices.length > 0) {
                  const choiceIndex = choices.findIndex(choice => {
                    const choiceLower = choice.toLowerCase().trim();
                    return choiceLower === exitText || exitText === choiceLower;
                  });
                  
                  if (choiceIndex >= 0) {
                    selectedExit = exit;
                    break;
                  }
                } else {
                  // Если вариантов нет, но текст точно совпадает - это реальный выход
                  selectedExit = exit;
                  break;
                }
              }
              
              // Также проверяем номер варианта (если игрок написал "1", "2" и т.д.)
              if (choices.length > 0) {
                const exitIndex = realExits.indexOf(exit);
                if (userTextNormalized === String(exitIndex + 1) || 
                    userTextNormalized === `${exitIndex + 1}.` ||
                    userTextNormalized.startsWith(`${exitIndex + 1}. `)) {
                  // Проверяем, что этот вариант есть в списке вариантов и соответствует реальному выходу
                  if (exitIndex < choices.length) {
                    const choiceText = choices[exitIndex].toLowerCase().trim();
                    if (choiceText === exitText || exitText === choiceText) {
                      selectedExit = exit;
                      break;
                    }
                  }
                }
              }
            }
            
            if (selectedExit && selectedExit.targetLocationId) {
              const oldLocationId = sess.currentLocationId;
              
              // Переключаем локацию
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { currentLocationId: selectedExit.targetLocationId }
              });
              
              // Обновляем состояние: сбрасываем счетчик сцен без реальных выходов и порог
              const state = (sess.state as any) || {};
              state.scenesWithoutRealExit = 0;
              state.realExitThreshold = undefined; // Сбрасываем порог для нового цикла
              state.scenesInCurrentLocation = 0; // Сбрасываем счетчик сцен в новой локации
              state.lastAction = userText || '';
              state.visited = Array.isArray(state.visited) ? Array.from(new Set(state.visited.concat([oldLocationId, selectedExit.targetLocationId]))) : [oldLocationId, selectedExit.targetLocationId];
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { state }
              });
              
              console.log(`[REPLY-STREAM] ✅ Location switched from ${oldLocationId} to ${selectedExit.targetLocationId} via real exit: "${exit.buttonText || exit.triggerText}"`);
            }
          }
        }
      } catch (e) {
        console.warn('[REPLY-STREAM] Failed to check location switch:', e);
      }
    }
    
    // Получаем userId для buildGptSceneContext (RAG)
    let userId: string | null = null;
    if (!lobbyId && gameId) {
      userId = await resolveUserIdFromQueryOrBody(req, prisma);
    }
    
    // Получаем игру и настраиваем промпты
    const game = gameId ? await prisma.game.findUnique({ where: { id: gameId } }) : null;
    const sys = game?.systemPrompt || getSysPrompt();
    
    // КРИТИЧЕСКИ ВАЖНО: Используем buildGptSceneContext для получения контекста с RAG чанками
    let sceneContext = '';
    let realExitsInfo = '';
    if (gameId) {
      try {
        sceneContext = await buildGptSceneContext(prisma, {
          gameId,
          lobbyId,
          userId: userId || undefined,
          history: history
        });
        
        // Добавляем информацию о реальных выходах в промпт
        let locationId: string | undefined = undefined;
        if (lobbyId) {
          const sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
          locationId = sess?.currentLocationId || undefined;
        } else if (userId) {
          const sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId } });
          locationId = sess?.currentLocationId || undefined;
        }
        
        if (locationId) {
          const exits = await prisma.locationExit.findMany({ where: { locationId } });
          const btns = exits.filter((e: any) => e.type === 'BUTTON');
          const realBtns = btns.filter((e: any) => e.targetLocationId && !e.isGameOver);
          if (realBtns.length > 0) {
            const exitsList = realBtns.map((exit, idx) => {
              const choiceText = exit.buttonText || exit.triggerText || `Вариант ${idx + 1}`;
              return `${idx + 1}. ${choiceText}`;
            }).join('\n');
            
            // Получаем информацию о счетчике сцен без реальных выходов
            let scenesCount = 0;
            let threshold = 0;
            let shouldSuggestMore = false;
            try {
              const sess = lobbyId 
                ? await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } })
                : userId 
                  ? await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId } })
                  : null;
              if (sess?.state) {
                const state = sess.state as any;
                scenesCount = state.scenesWithoutRealExit || 0;
                threshold = state.realExitThreshold || 0;
                shouldSuggestMore = scenesCount >= threshold && threshold > 0;
              }
            } catch (e) {
              console.warn('[REPLY-STREAM] Failed to get scene counter:', e);
            }
            
            let rulesText = `\n\nПРАВИЛА ФОРМИРОВАНИЯ ВАРИАНТОВ:\n1. НЕ обязательно включать реальные выходы в КАЖДЫЙ ответ - можешь предлагать диалоговые/ситуативные варианты (например, "Спросить о чем-то", "Осмотреть детальнее", "Попробовать что-то сделать")\n2. НО важно, чтобы ветка диалога периодически (раз в 5-10 сцен) вела к реальному выходу из локации - включай реальные выходы естественным образом, когда это логично по сюжету\n3. НЕ предлагай варианты действий, которые выглядят как переходы в другие локации, но которых нет в списке реальных выходов выше`;
            
            if (shouldSuggestMore) {
              rulesText += `\n\n⚠️ ВАЖНО: Прошло уже ${scenesCount} сцен без реальных выходов (порог: ${threshold}). СЕЙЧАС НУЖНО ЧАЩЕ предлагать реальные выходы из списка выше! Включай их в варианты выбора естественным образом, но чаще чем обычно. Реальные выходы могут быть в любом месте списка вариантов, не обязательно первыми.`;
            } else if (threshold > 0) {
              rulesText += `\n\n📊 Прогресс: ${scenesCount}/${threshold} сцен без реальных выходов. Когда достигнешь порога - начни чаще предлагать реальные выходы.`;
            }
            
            rulesText += `\n4. Если включаешь реальные выходы - они могут быть в любом месте списка вариантов, не обязательно первыми`;
            
            realExitsInfo = `\n\nДОСТУПНЫЕ РЕАЛЬНЫЕ ВЫХОДЫ ИЗ ЛОКАЦИИ:\n${exitsList}${rulesText}`;
          }
        }
      } catch (e) {
        console.warn('[REPLY-STREAM] Failed to build scene context:', e);
      }
    }
    
    // Формируем финальный промпт с контекстом сцены, RAG чанками и реальными выходами
    const finalUserPrompt = sceneContext 
      ? `${sceneContext}${realExitsInfo}\n\nСообщение игрока: ${userText}`
      : userText;
    
    // КРИТИЧЕСКИ ВАЖНО: Логируем, что передаем ТЕКСТ в ИИ (должен быть расшифрован через STT)
    console.log('[REPLY-STREAM] ✅ Sending TEXT to AI (from STT):', typeof userText === 'string' ? `"${userText.slice(0, 100)}${userText.length > 100 ? '...' : ''}"` : `type: ${typeof userText}`);
    if (sceneContext) {
      console.log('[REPLY-STREAM] ✅ Using RAG context (length:', sceneContext.length, 'chars)');
    }
    
    // Генерируем текст через Gemini 2.5 Pro (используем generateChatCompletion, который уже использует gemini-2.5-pro)
    sendSSE('status', { type: 'generating_text' });
    const { text: generatedText } = await generateChatCompletion({
      systemPrompt: sys,
      userPrompt: finalUserPrompt, // Промпт с контекстом сцены и RAG чанками
      history: history // История тоже должна содержать только текст
    });
    let fullText = generatedText || '';
    
    // Постобработка: форматируем варианты выбора и добавляем реальные выходы
    fullText = formatChoiceOptions(fullText);
    
    // КРИТИЧЕСКИ ВАЖНО: Гарантируем наличие минимум одного реального выхода в вариантах
    let locationId: string | undefined = undefined;
    let session: any = null;
    if (gameId) {
      try {
        if (lobbyId) {
          session = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
          locationId = session?.currentLocationId || undefined;
        } else if (userId) {
          session = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId } });
          locationId = session?.currentLocationId || undefined;
        }
      } catch (e) {
        console.warn('[REPLY-STREAM] Failed to get location for adding choices:', e);
      }
    }
    
    // НОВАЯ ЛОГИКА: ensureRealExitsInChoices удалена, используем текст как есть
    console.log('[REPLY-STREAM] ✅ Text generated with RAG, length:', fullText?.length || 0);
    console.log('[REPLY-STREAM] 🔊 Starting TTS streaming for generated text');
    
    sendSSE('text_complete', { text: fullText });
    
    // КРИТИЧЕСКИ ВАЖНО: Параллельно запускаем генерацию TTS стриминга для текста сгенерированного с RAG
    sendSSE('status', { type: 'generating_audio' });
    console.log('[REPLY-STREAM] 🔊 Starting TTS streaming for RAG-generated text');
    console.log('[REPLY-STREAM] 🔊 Text for TTS (first 200 chars):', fullText?.slice(0, 200) || 'empty');
    
    // КРИТИЧЕСКИ ВАЖНО: Используем логику TTS стриминга напрямую из endpoint, стримим чанки через SSE сразу
    (async () => {
      try {
        const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
        if (!geminiApiKey) {
          throw new Error('GEMINI_API_KEY not found');
        }
        
        let finalModelName = 'gemini-2.5-flash-preview-tts';
        finalModelName = finalModelName.replace(/-tts$/, '');
        if (finalModelName.includes('2.5') || !finalModelName.includes('2.0-flash-exp')) {
          finalModelName = 'gemini-2.0-flash-exp';
        }
        const finalVoiceName = 'Kore';
        
        const proxies = parseGeminiProxies();
        const attempts = proxies.length ? proxies : ['__direct__'];
        
        let chunkCount = 0;
        let totalSize = 0;
        let hasAudio = false;
        let success = false;
        
        for (const p of attempts) {
          try {
            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${geminiApiKey}`;
            console.log('[REPLY-STREAM] 🔌 Connecting to Gemini WebSocket, proxy:', p === '__direct__' ? 'none' : p);
            
            const wsOptions: any = {};
            if (p !== '__direct__') {
              try {
                const { HttpsProxyAgent } = await import('https-proxy-agent');
                wsOptions.agent = new HttpsProxyAgent(p);
              } catch (e) {
                // Продолжаем без прокси
              }
            }
            
            const ws = new WebSocket(wsUrl, wsOptions);
            
            let isConnected = false;
            let isComplete = false;
            let textSent = false;
            let setupReceived = false;
            
            const isBufferValid = (buffer: Buffer): boolean => {
              return buffer && buffer.length > 0;
            };
            
            // Устанавливаем обработчики ДО открытия соединения
            ws.on('message', (data: Buffer) => {
              try {
                const messageStr = data.toString('utf-8');
                const message = JSON.parse(messageStr);
                
                // Логируем ВСЕ сообщения для отладки
                console.log('[REPLY-STREAM] 📨 Received message:', JSON.stringify(message).slice(0, 200));
                
                if (message.setupComplete) {
                  isConnected = true;
                  setupReceived = true;
                  console.log('[REPLY-STREAM] ✅ WebSocket setup complete, sending text...');
                  
                  if (!textSent) {
                    textSent = true;
                    console.log('[REPLY-STREAM] 📤 Sending text to Gemini, length:', fullText.length);
                    ws.send(JSON.stringify({
                      clientContent: {
                        turns: [{
                          role: "user",
                          parts: [{ text: fullText }]
                        }],
                        turnComplete: true
                      }
                    }));
                  }
                  return;
                }
                
                // Проверяем ошибки от Gemini
                if (message.error) {
                  console.error('[REPLY-STREAM] ❌ Gemini API error:', message.error);
                }
                
                if (!isConnected) return;
                
                if (message.serverContent) {
                  if (message.serverContent.modelTurn) {
                    const modelTurn = message.serverContent.modelTurn;
                    const parts = modelTurn.parts || [];
                    
                    for (const part of parts) {
                      if (part.inlineData && part.inlineData.data) {
                        let audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                        
                        if (audioBuffer.length % 2 !== 0) {
                          audioBuffer = audioBuffer.slice(0, audioBuffer.length - 1);
                        }
                        
                        if (isBufferValid(audioBuffer)) {
                          hasAudio = true;
                          chunkCount++;
                          totalSize += audioBuffer.length;
                          
                          // СТРИМИМ ЧАНКИ НАПРЯМУЮ ЧЕРЕЗ SSE БЕЗ НАКОПЛЕНИЯ
                          const chunkBase64 = audioBuffer.toString('base64');
                          sendSSE('audio_chunk', { 
                            chunk: chunkBase64,
                            chunkIndex: chunkCount,
                            format: 'pcm',
                            sampleRate: 24000,
                            channels: 1,
                            bitsPerSample: 16
                          });
                        }
                      }
                    }
                  }
                  
                  if (!hasAudio && message.serverContent.parts) {
                    const parts = Array.isArray(message.serverContent.parts) ? message.serverContent.parts : [];
                    for (const part of parts) {
                      if (part.inlineData && part.inlineData.data) {
                        let audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                        
                        if (audioBuffer.length % 2 !== 0) {
                          audioBuffer = audioBuffer.slice(0, audioBuffer.length - 1);
                        }
                        
                        if (isBufferValid(audioBuffer)) {
                          hasAudio = true;
                          chunkCount++;
                          totalSize += audioBuffer.length;
                          
                          // СТРИМИМ ЧАНКИ НАПРЯМУЮ ЧЕРЕЗ SSE БЕЗ НАКОПЛЕНИЯ
                          const chunkBase64 = audioBuffer.toString('base64');
                          sendSSE('audio_chunk', { 
                            chunk: chunkBase64,
                            chunkIndex: chunkCount,
                            format: 'pcm',
                            sampleRate: 24000,
                            channels: 1,
                            bitsPerSample: 16
                          });
                        }
                      }
                    }
                  }
                }
                
                if (message.serverContent && message.serverContent.turnComplete) {
                  isComplete = true;
                  ws.close();
                }
              } catch (e: any) {
                console.error('[REPLY-STREAM] ❌ Error parsing WebSocket message:', e?.message || String(e));
                console.error('[REPLY-STREAM] ❌ Raw message:', data.toString('utf-8').slice(0, 500));
              }
            });
            
            ws.on('error', (error) => {
              console.error('[REPLY-STREAM] ❌ WebSocket error:', error?.message || String(error));
              console.error('[REPLY-STREAM] ❌ WebSocket error details:', error);
              if (!isConnected && !hasAudio) {
                ws.close();
              }
            });
            
            ws.on('close', (code, reason) => {
              console.log('[REPLY-STREAM] 🔌 WebSocket closed, code:', code, 'reason:', reason?.toString() || 'none');
              console.log('[REPLY-STREAM] 🔌 State: connected=', isConnected, 'setupReceived=', setupReceived, 'textSent=', textSent, 'hasAudio=', hasAudio);
            });
            
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(() => {
                console.error('[REPLY-STREAM] ❌ WebSocket connection timeout after 10s');
                reject(new Error('WebSocket connection timeout'));
              }, 10000);
              
              ws.on('open', () => {
                console.log('[REPLY-STREAM] 🔗 WebSocket opened, sending setup...');
                ws.send(JSON.stringify({
                  setup: {
                    model: `models/${finalModelName}`,
                    generationConfig: {
                      responseModalities: ["AUDIO"],
                      speechConfig: {
                        voiceConfig: {
                          prebuiltVoiceConfig: {
                            voiceName: finalVoiceName
                          }
                        }
                      }
                    },
                    systemInstruction: {
                      parts: [{
                        text: "Ты — профессиональный актер озвучивания. Твоя ЕДИНСТВЕННАЯ задача — ПРОЧИТАТЬ ПРЕДОСТАВЛЕННЫЙ ТЕКСТ СЛОВО В СЛОВО на РУССКОМ ЯЗЫКЕ максимально естественно, как живой человек. НЕ анализируй текст, НЕ комментируй его, НЕ отвечай на вопросы в тексте. Просто ОЗВУЧИВАЙ текст слово в слово. КРИТИЧЕСКИ ВАЖНО: Все цифры и числа читай ТОЛЬКО на русском языке (например, 123 читай как 'сто двадцать три', 5 как 'пять', а не 'five' или 'one two three'). КРИТИЧЕСКИ ВАЖНО: Знаки препинания (запятые, тире, точки, звездочки, дефисы и т.д.) НЕ ОЗВУЧИВАЙ как слова — используй их только для создания естественных пауз в речи. Используй естественные интонации, паузы и ритм речи. Избегай монотонности. Передавай эмоции через голос: таинственность — тише и медленнее, опасность — напряженнее, триумф — громче и увереннее. Читай так, будто рассказываешь историю другу."
                      }]
                    }
                  }
                }));
                
                clearTimeout(timeout);
                resolve();
              });
              
              ws.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
              });
            });
            
            await new Promise<void>((resolve) => {
              const completionTimeout = setTimeout(() => {
                if (!isComplete) {
                  console.warn('[REPLY-STREAM] ⚠️ TTS generation timeout after 120s, closing WebSocket');
                  ws.close();
                }
                resolve();
              }, 120000);
              
              ws.on('close', () => {
                console.log('[REPLY-STREAM] 🔌 WebSocket closed, connected:', isConnected, 'hasAudio:', hasAudio, 'chunks:', chunkCount);
                clearTimeout(completionTimeout);
                resolve();
              });
            });
            
            if (hasAudio) {
              success = true;
              // Отправляем финальное событие о завершении стриминга
              sendSSE('audio_complete', { 
                totalChunks: chunkCount,
                totalSize: totalSize
              });
              console.log('[REPLY-STREAM] ✅ TTS streaming completed, streamed', chunkCount, 'chunks, total size:', totalSize);
              break; // Выходим из цикла прокси
            } else {
              console.warn('[REPLY-STREAM] ⚠️ No audio received, connected:', isConnected, 'setupReceived:', setupReceived, 'textSent:', textSent);
            }
            
          } catch (wsError: any) {
            console.error('[REPLY-STREAM] ❌ WebSocket attempt failed:', wsError?.message || String(wsError));
            // Пробуем следующий прокси
            continue;
          }
        }
        
        if (!success) {
          console.error('[REPLY-STREAM] ❌ All WebSocket attempts failed, no audio received');
          throw new Error('Failed to generate TTS stream - no audio chunks received');
        }
        
      } catch (ttsErr: any) {
        console.error('[REPLY-STREAM] ❌ TTS streaming error:', ttsErr?.message || String(ttsErr));
        sendSSE('audio_error', { error: ttsErr?.message || String(ttsErr) });
      }
    })();
    
    // Закрываем соединение после небольшой задержки
    setTimeout(() => {
      res.end();
    }, 100);
    
  } catch (e) {
    sendSSE('error', { error: String(e) });
    res.end();
  }
});

function advanceTurn(lobbyId: string) {
  const t = lobbyTurns.get(lobbyId);
  if (!t || !t.order.length) return;
  t.idx = (t.idx + 1) % t.order.length;
  lobbyTurns.set(lobbyId, t);
  wsNotifyLobby(lobbyId, { type: 'turn_changed', lobbyId, userId: t.order[t.idx] });
}

app.get('/api/chat/history', async (req, res) => {
  const gameId = typeof req.query.gameId === 'string' ? req.query.gameId : undefined;
  const lobbyId = typeof req.query.lobbyId === 'string' ? req.query.lobbyId : undefined;
  const userIdQ = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  const tgId = typeof req.query.tgId === 'string' ? req.query.tgId : undefined;
  const tgUsername = typeof req.query.tgUsername === 'string' ? req.query.tgUsername : undefined;
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
  if (!gameId) return res.status(400).json({ error: 'gameId_required' });
  try {
    const prisma = getPrisma();
    if (lobbyId) {
      const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
      return res.json({ history: (sess?.history as any) || [] });
    }
    let uid = userIdQ || '';
    if (!uid && (tgId || tgUsername)) {
      let u = tgId ? await prisma.user.findFirst({ where: { tgId } }) : null;
      if (!u && tgUsername) u = await prisma.user.findFirst({ where: { tgUsername } });
      if (!u && (tgId || tgUsername)) {
        u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: tgId || undefined, tgUsername: tgUsername || undefined, status: 'active' } });
      }
      uid = u?.id || '';
    }
    if (!uid && deviceId) uid = 'device:' + deviceId;
    if (!uid) return res.json({ history: [] });
    const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
    return res.json({ history: (sess?.history as any) || [] });
  } catch {
    return res.json({ history: [] });
  }
});

app.post('/api/chat/save', async (req, res) => {
  const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const userIdB = typeof req.body?.userId === 'string' ? req.body.userId : undefined;
  const tgId = typeof req.body?.tgId === 'string' ? req.body.tgId : undefined;
  const tgUsername = typeof req.body?.tgUsername === 'string' ? req.body.tgUsername : undefined;
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId : undefined;
  if (!gameId) return res.status(400).json({ error: 'gameId_required' });
  try {
    const prisma = getPrisma();
    if (lobbyId) {
      const saved = await prisma.chatSession.upsert({
        where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } },
        update: { history: history as any },
        create: { userId: 'lobby:' + lobbyId, gameId, history: history as any },
      });
      return res.json({ ok: true, updatedAt: saved.updatedAt });
    }
    let uid = userIdB || '';
    if (!uid && (tgId || tgUsername)) {
      let u = tgId ? await prisma.user.findFirst({ where: { tgId } }) : null;
      if (!u && tgUsername) u = await prisma.user.findFirst({ where: { tgUsername } });
      if (!u && (tgId || tgUsername)) {
        u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: tgId || undefined, tgUsername: tgUsername || undefined, status: 'active' } });
      }
      uid = u?.id || '';
    }
    if (!uid && deviceId) uid = 'device:' + deviceId;
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const saved = await prisma.chatSession.upsert({
      where: { userId_gameId: { userId: uid, gameId } },
      update: { history: history as any },
      create: { userId: uid, gameId, history: history as any },
    });
    return res.json({ ok: true, updatedAt: saved.updatedAt });
  } catch (e) {
    console.error('Chat save failed:', e);
    return res.status(500).json({ error: 'failed_to_save' });
  }
});

app.delete('/api/chat/history', async (req, res) => {
  const gameId = typeof req.query.gameId === 'string' ? req.query.gameId : undefined;
  const lobbyId = typeof req.query.lobbyId === 'string' ? req.query.lobbyId : undefined;
  const userIdQ = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  const tgId = typeof req.query.tgId === 'string' ? req.query.tgId : undefined;
  const tgUsername = typeof req.query.tgUsername === 'string' ? req.query.tgUsername : undefined;
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
  if (!gameId) return res.status(400).json({ error: 'gameId_required' });
  try {
    const prisma = getPrisma();
    if (lobbyId) {
      await prisma.chatSession.delete({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } }).catch(() => {});
      return res.status(204).end();
    }
    let uid = userIdQ || '';
    if (!uid && (tgId || tgUsername)) {
      let u = tgId ? await prisma.user.findFirst({ where: { tgId } }) : null;
      if (!u && tgUsername) u = await prisma.user.findFirst({ where: { tgUsername } });
      if (!u && (tgId || tgUsername)) {
        u = await prisma.user.create({ data: { firstName: 'User', lastName: '', tgId: tgId || undefined, tgUsername: tgUsername || undefined, status: 'active' } });
      }
      uid = u?.id || '';
    }
    if (!uid && deviceId) uid = 'device:' + deviceId;
    if (!uid) return res.status(400).json({ error: 'user_required' });
    await prisma.chatSession.delete({ where: { userId_gameId: { userId: uid, gameId } } }).catch(() => {});
    // Также сбрасываем gameSession как просили (начнём с первой сцены)
    await prisma.gameSession.deleteMany({ where: { scenarioGameId: gameId, userId: uid } }).catch(() => {});
    return res.status(204).end();
  } catch (e) {
    console.error('Chat reset failed:', e);
    return res.status(500).json({ error: 'failed_to_reset' });
  }
});

app.post('/api/engine/session/start', async (req, res) => {
  const gameId = String(req.body?.gameId || '');
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  try {
    if (!gameId) return res.status(400).json({ error: 'gameId_required' });
    const prisma = getPrisma();
    let uid: string | null = null;
    if (!lobbyId) {
      uid = await resolveUserIdFromQueryOrBody(req, prisma);
      if (!uid) return res.status(400).json({ error: 'user_required' });
    }
    
    // Проверка наличия игровых персонажей в игре
    const playableChars = await prisma.character.findMany({ 
      where: { gameId, isPlayable: true } 
    });
    if (playableChars.length === 0) {
      return res.status(400).json({ error: 'no_playable_characters', message: 'В игре нет игровых персонажей. Игра невозможна без персонажей.' });
    }
    
    const first = await prisma.location.findFirst({ where: { gameId }, orderBy: { order: 'asc' } });
    if (!first) return res.status(404).json({ error: 'no_locations' });
    let sess = await prisma.gameSession.findFirst({
      where: { scenarioGameId: gameId, lobbyId: lobbyId || null, userId: uid || null },
    });
    if (!sess) {
      sess = await prisma.gameSession.create({
        data: { scenarioGameId: gameId, lobbyId: lobbyId || null, userId: uid || null, currentLocationId: first.id, state: {} as any },
      });
      
      // Запускаем планирование прогрессии в фоне (не блокируем старт сессии)
      setImmediate(async () => {
        try {
          await analyzeAndPlanGameProgression(prisma, gameId, sess.id);
        } catch (e) {
          console.error('[SESSION-START] Ошибка планирования прогрессии:', e);
        }
      });
    } else {
      // КРИТИЧЕСКИ ВАЖНО: НЕ сбрасываем currentLocationId - он должен сохраняться между запросами
      // currentLocationId меняется только при реальном переходе через locationExit (в /api/chat/reply)
      // УБРАНО: Сброс currentLocationId на first.id - это ломало сохранение прогресса игрока
      
      // Проверяем, есть ли уже план прогрессии, если нет - создаем
      const state = (sess.state as any) || {};
      if (!state.gameProgressionPlan) {
        setImmediate(async () => {
          try {
            await analyzeAndPlanGameProgression(prisma, gameId, sess.id);
          } catch (e) {
            console.error('[SESSION-START] Ошибка планирования прогрессии:', e);
          }
        });
      }
    }
    return res.json({ id: sess.id, currentLocationId: sess.currentLocationId });
  } catch (e) {
    return res.status(500).json({ error: 'engine_start_failed' });
  }
});
app.get('/api/engine/session/:id', async (req, res) => {
  try {
    const prisma = getPrisma();
    const sess = await prisma.gameSession.findUnique({ where: { id: req.params.id } });
    if (!sess) return res.status(404).json({ error: 'not_found' });
    const loc = await prisma.location.findUnique({ where: { id: sess.currentLocationId } });
    const exits = await prisma.locationExit.findMany({ where: { locationId: sess.currentLocationId } });
    return res.json({ id: sess.id, gameId: sess.scenarioGameId, location: loc, exits });
  } catch (e) {
    return res.status(500).json({ error: 'engine_get_failed' });
  }
});
app.post('/api/engine/session/:id/describe', async (req, res) => {
  try {
    const prisma = getPrisma();
    const sess = await prisma.gameSession.findUnique({ where: { id: req.params.id } });
    if (!sess) return res.status(404).json({ error: 'not_found' });
    const loc = await prisma.location.findUnique({ where: { id: sess.currentLocationId } });
    const game = await prisma.game.findUnique({ where: { id: sess.scenarioGameId } });
    const chars = await prisma.character.findMany({ where: { gameId: sess.scenarioGameId }, take: 6 });
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    const base = loc?.description || '';
    const offlineText = ([
      `Сцена: ${loc?.title || 'Локация'}`,
      base,
      game?.worldRules ? `Правила мира (сопоставляй с текущей сценой, не обобщай): ${game.worldRules}` : '',
      game?.gameplayRules ? `Правила процесса (сопоставляй с текущей сценой, не обобщай): ${game.gameplayRules}` : '',
      (game as any)?.introduction ? `Введение: ${(game as any).introduction}` : '',
      (game as any)?.backstory ? `Предыстория: ${(game as any).backstory}` : '',
      (game as any)?.adventureHooks ? `Зацепки приключения: ${(game as any).adventureHooks}` : '',
    ].filter(Boolean).join('\n\n')).trim();
    const sys = getSysPrompt();
    const visual = [
      loc?.backgroundUrl ? `Фон (изображение): ${loc.backgroundUrl}` : '',
      loc?.musicUrl ? `Музыка (URL): ${loc.musicUrl}` : '',
    ].filter(Boolean).join('\n');
    const rules = [
      game?.worldRules ? `Правила мира (сопоставляй с текущей сценой, не обобщай): ${game.worldRules}` : '',
      game?.gameplayRules ? `Правила процесса (сопоставляй с текущей сценой, не обобщай): ${game.gameplayRules}` : '',
      (game as any)?.introduction ? `Введение: ${(game as any).introduction}` : '',
      (game as any)?.backstory ? `Предыстория: ${(game as any).backstory}` : '',
      (game as any)?.adventureHooks ? `Зацепки приключения: ${(game as any).adventureHooks}` : '',
      (game as any)?.author ? `Автор: ${(game as any).author}` : '',
      game?.ageRating ? `Возрастной рейтинг: ${game.ageRating}` : '',
      // Используем полные правила для ИИ
      (game as any)?.worldRulesFull || (game as any)?.worldRules ? `Правила мира (сопоставляй с текущей сценой, не обобщай): ${(game as any)?.worldRulesFull || (game as any)?.worldRules}` : '',
      (game as any)?.gameplayRulesFull || (game as any)?.gameplayRules ? `Правила процесса (сопоставляй с текущей сценой, не обобщай): ${(game as any)?.gameplayRulesFull || (game as any)?.gameplayRules}` : '',
      (game as any)?.winCondition ? `Условие победы: ${(game as any).winCondition}` : '',
      (game as any)?.loseCondition ? `Условие поражения: ${(game as any).loseCondition}` : '',
      (game as any)?.deathCondition ? `Условие смерти: ${(game as any).deathCondition}` : '',
    ].filter(Boolean).join('\n');
    const npcs = chars && chars.length ? (
      'Персонажи (D&D 5e):\n' + chars.map((c) => {
        const traits = [c.role, c.class, c.race, c.gender].filter(Boolean).join(', ');
        const stats = c.isPlayable ? ` (HP: ${c.hp}/${c.maxHp}, AC: ${c.ac}, STR:${c.str}, DEX:${c.dex}, CON:${c.con}, INT:${c.int}, WIS:${c.wis}, CHA:${c.cha})` : '';
        const extras = [c.persona, c.origin].filter(Boolean).join('. ');
        return `- ${c.name} (${traits})${stats}. ${extras}`;
      }).join('\n')
    ) : '';
    const user = [
      `Сцена: ${loc?.title}`,
      visual,
      base ? `Описание сцены: ${base}` : '',
      rules,
      npcs,
    ].filter(Boolean).join('\n\n');
    let text = '';
    let usedAi = false;
    try {
      const { text: generatedText } = await generateChatCompletion({
        systemPrompt: sys,
        userPrompt: user,
        history: []
      });
      text = generatedText;
      if (text) {
        text = text.trim();
        // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
        text = formatChoiceOptions(text);
        
        // Проверяем, есть ли варианты выбора в тексте
        const choices = parseChoiceOptions(text);
        if (choices.length === 0 && sess.currentLocationId) {
          // Если вариантов нет, добавляем их из кнопок локации
          const exits = await prisma.locationExit.findMany({ where: { locationId: sess.currentLocationId } });
          if (exits.length > 0) {
            const choiceLines = exits
              .map((exit, idx) => {
                const choiceText = exit.buttonText || exit.triggerText || `Вариант ${idx + 1}`;
                return `${idx + 1}. ${choiceText}`;
              })
              .join('\n');
            // Добавляем варианты после текста, если там есть "Что вы делаете?" или подобное
            if (text.match(/\*\*.*[?]\s*\*\*/i) || text.match(/Что вы делаете/i) || text.match(/Что делать/i)) {
              text = text.replace(/\*\*.*[?]\s*\*\*/gi, '').trim();
              text = text + '\n\n**Что вы делаете?**\n\n' + choiceLines;
            } else {
              text = text + '\n\n**Что вы делаете?**\n\n' + choiceLines;
            }
          }
        }
      }
      usedAi = Boolean(text);
    } catch (err) {
      text = offlineText || (base || 'Здесь начинается ваше приключение.');
    }
    if (!text) text = offlineText || (base || 'Здесь начинается ваше приключение.');
    try {
      const state = (await prisma.gameSession.findUnique({ where: { id: sess.id }, select: { state: true } }))?.state as any || {};
      state.lastDescribeAt = new Date().toISOString();
      state.lastLocationId = sess.currentLocationId;
      await prisma.gameSession.update({ where: { id: sess.id }, data: { state } });
    } catch {}
    // Возвращаем метаданные о голосе для TTS
    const locationId = sess.currentLocationId;
    return res.json({ 
      text, 
      fallback: !usedAi,
      ttsContext: {
        locationId,
        isNarrator: true, // Описание локации - это рассказчик
      }
    });
  } catch {
    return res.status(500).json({ error: 'engine_describe_failed' });
  }
});
app.post('/api/engine/session/:id/act', async (req, res) => {
  try {
    const prisma = getPrisma();
    const sess = await prisma.gameSession.findUnique({ where: { id: req.params.id } });
    if (!sess) return res.status(404).json({ error: 'not_found' });
    const locId = sess.currentLocationId;
    const exits = await prisma.locationExit.findMany({ where: { locationId: locId } });
    const loc = await prisma.location.findUnique({ where: { id: locId } });
    const pickedId = typeof req.body?.exitId === 'string' ? req.body.exitId : undefined;
    const userText = typeof req.body?.text === 'string' ? req.body.text : '';
    let chosen: any = pickedId ? exits.find((e: any) => e.id === pickedId) : null;
    const low = userText.toLowerCase().trim();
    // Улучшенный матчинг: цифры → кнопки, текст кнопки/варианта, триггеры со сплитом
    function matchTrigger(user: string, raw: string): boolean {
      const u = user.toLowerCase();
      const variants = String(raw || '')
        .toLowerCase()
        .split(/[,/;]| или /g)
        .map((s) => s.trim())
        .filter(Boolean);
      return variants.some((v) => v && u.includes(v));
    }
    function matchButton(user: string, btnText: string): boolean {
      const u = user.toLowerCase();
      const b = String(btnText || '').toLowerCase();
      if (!b) return false;
      const first = u.split(' ').filter(Boolean)[0] || '';
      return u.includes(b) || (first && b.includes(first));
    }
    if (!chosen && userText) {
      const btns = exits.filter((e: any) => e.type === 'BUTTON');
      const num = low.match(/^([1-9])$/);
      if (num && btns.length) {
        const idx = Math.min(btns.length, Math.max(1, parseInt(num[1], 10))) - 1;
        chosen = btns[idx] || null;
      }
      if (!chosen && btns.length) {
        chosen = btns.find((b: any) => matchButton(low, b.buttonText || '')) || null;
      }
      if (!chosen) {
        chosen = exits.find((e: any) => matchTrigger(low, e.triggerText || '')) || null;
      }
    }
    if (!chosen && userText) {
      if (exits.length) {
        try {
          const prompt = [
            'Ты помощник Директора игры. Тебе дано сообщение игрока и список возможных выходов из сцены.',
            'Если доступны "Правила Локации" — учитывай их. Твоя задача: выбрать уместный выход (или вернуть none).',
            'Возвращай строго JSON: {"exitId":"..."} или {"exitId":"none"}.',
            `Сообщение игрока: "${userText}"`,
            loc?.rulesPrompt ? `Правила Локации:\n${loc.rulesPrompt}` : '',
            'Возможные выходы:',
            ...exits.map((e: any, i: number) => {
              const label = e.type === 'TRIGGER' ? (e.triggerText || '') : (e.buttonText || '');
              return `- id=${e.id} [${e.type}] ${label}`;
            }),
          ].join('\n');
          const { text } = await generateChatCompletion({
            systemPrompt: 'Отвечай только валидным JSON.',
            userPrompt: prompt,
            history: []
          });
          const content = text || '{}';
          let parsed: { exitId?: string } = {};
          try {
            // Пытаемся извлечь JSON из ответа
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[0]) as { exitId?: string };
            }
          } catch (e) {
            console.error('[ACT] Failed to parse AI response:', e);
          }
          const picked = parsed.exitId && parsed.exitId !== 'none' ? exits.find((e: any) => e.id === parsed.exitId) : null;
          if (picked) chosen = picked;
        } catch {}
      }
    }
    if (!chosen) return res.status(200).json({ ok: false, reason: 'no_match' });
    if (chosen.isGameOver || chosen.type === 'GAMEOVER') {
      try {
        const state = (await prisma.gameSession.findUnique({ where: { id: sess.id }, select: { state: true } }))?.state as any || {};
        state.finishedAt = new Date().toISOString();
        state.finishReason = 'game_over';
        await prisma.gameSession.update({ where: { id: sess.id }, data: { state } });
      } catch {}
      return res.json({ ok: true, gameOver: true });
    }
    const nextId = chosen.targetLocationId as string | null;
    if (!nextId) return res.status(200).json({ ok: false, reason: 'no_target' });
    await prisma.gameSession.update({ where: { id: sess.id }, data: { currentLocationId: nextId } });
    const nextLoc = await prisma.location.findUnique({ where: { id: nextId } });
    const nextExits = await prisma.locationExit.findMany({ where: { locationId: nextId } });
    try {
      const state = (await prisma.gameSession.findUnique({ where: { id: sess.id }, select: { state: true } }))?.state as any || {};
      state.lastAction = userText || '';
      state.visited = Array.isArray(state.visited) ? Array.from(new Set(state.visited.concat([locId, nextId]))) : [locId, nextId];
      // КРИТИЧЕСКИ ВАЖНО: Сбрасываем счетчик сцен без реальных выходов и порог при переходе в другую локацию
      state.scenesWithoutRealExit = 0;
      state.realExitThreshold = undefined; // Сбрасываем порог для нового цикла
      await prisma.gameSession.update({ where: { id: sess.id }, data: { state } });
    } catch {}
    return res.json({ ok: true, location: nextLoc, exits: nextExits });
  } catch (e) {
    return res.status(500).json({ error: 'engine_act_failed' });
  }
});

// Сбросить игру (стереть состояние сессии/историю)
app.post('/api/engine/reset', async (req, res) => {
  const gameId = String(req.body?.gameId || '');
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  try {
    if (!gameId) return res.status(400).json({ error: 'gameId_required' });
    const prisma = getPrisma();
    if (lobbyId) {
      await prisma.chatSession.delete({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } }).catch(() => {});
      const s = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
      if (s) await prisma.gameSession.delete({ where: { id: s.id } }).catch(() => {});
      return res.json({ ok: true });
    }
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    await prisma.chatSession.delete({ where: { userId_gameId: { userId: uid, gameId } } }).catch(() => {});
    const s = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
    if (s) await prisma.gameSession.delete({ where: { id: s.id } }).catch(() => {});
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'engine_reset_failed' });
  }
});

app.post('/api/chat/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      console.error('[TRANSCRIBE] ❌ No audio file received');
      return res.status(200).json({ text: '', error: 'no_audio' });
    }
    
    console.log('[TRANSCRIBE] 📥 Received audio:', {
      size: req.file.buffer.length,
      mime: req.file.mimetype,
      originalname: req.file.originalname
    });
    
    // Используем только Gemini STT
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    if (!geminiKey) {
      console.error('[TRANSCRIBE] ❌ Gemini API key not found');
      return res.status(200).json({ text: '', error: 'no_gemini_key' });
    }
    
    console.log('[TRANSCRIBE] 🔄 Using Gemini STT...');
    try {
      const gtext = await transcribeViaGemini(req.file.buffer as Buffer, req.file.originalname || 'audio', req.file.mimetype || 'audio/webm', geminiKey);
      
      // КРИТИЧЕСКИ ВАЖНО: Гарантируем, что возвращаем ТОЛЬКО ТЕКСТ, а не аудио
      if (gtext && typeof gtext === 'string' && gtext.trim()) {
        // Финальная проверка - это должен быть текст, а не base64 аудио
        const finalText = gtext.trim();
        if (finalText.startsWith('data:audio') || finalText.startsWith('data:application/octet-stream')) {
          console.error('[TRANSCRIBE] ❌ STT returned audio data instead of text! This should never happen.');
          return res.status(200).json({ text: '', error: 'stt_returned_audio' });
        }
        
        console.log('[TRANSCRIBE] ✅ Gemini STT succeeded, returning TEXT (not audio):', finalText.length, 'chars');
        return res.json({ text: finalText }); // ГАРАНТИРОВАННО ТОЛЬКО ТЕКСТ
      } else {
        console.warn('[TRANSCRIBE] ⚠️ Gemini STT returned empty text');
        return res.status(200).json({ text: '', error: 'empty_transcription' });
      }
    } catch (e: any) {
      console.error('[TRANSCRIBE] ❌ Gemini STT failed:', e?.message || String(e));
      if (e?.stack) console.error('[TRANSCRIBE] Stack:', e.stack);
      return res.status(200).json({ text: '', error: 'transcribe_failed', detail: e?.message || String(e) });
    }
  } catch (e) {
    console.error('Transcribe failed:', e);
    return res.status(200).json({ text: '', error: 'transcribe_failed' });
  }
});

async function transcribeViaHttp(buffer: Buffer, filename: string, mime: string, apiKey: string): Promise<string> {
  const proxies = parseProxies();
  const attempts = proxies.length ? proxies : ['__direct__'];
  const endpoint = 'https://api.openai.com/v1/audio/transcriptions';
  let lastErr: unknown = null;
  for (const p of attempts) {
    try {
      const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
      const form = new FormData();
      form.append('model', 'whisper-1');
      const file = new File([buffer], filename || 'audio', { type: mime || 'audio/webm' });
      form.append('file', file);
      const res = await undiciFetch(endpoint, {
        method: 'POST',
        dispatcher,
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form as any,
      });
      const data = await res.json() as any;
      const text = typeof data?.text === 'string' ? data.text : '';
      if (res.ok && text && text.trim()) return text;
      lastErr = data || await res.text().catch(() => 'bad_response');
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('HTTP fallback transcription failed:', lastErr);
  return '';
}

async function transcribeViaGemini(buffer: Buffer, filename: string, mime: string, apiKey: string): Promise<string> {
  try {
    console.log('[GEMINI-STT] Starting transcription, buffer size:', buffer.length, 'mime:', mime);
    
    // Проверяем размер файла (Gemini имеет лимиты)
    if (buffer.length > 20 * 1024 * 1024) { // 20MB лимит для Gemini
      console.warn('[GEMINI-STT] ⚠️ Audio file too large:', buffer.length, 'bytes');
      throw new Error('Audio file too large for Gemini API');
    }
    
    // Конвертируем аудио в base64
    const base64Audio = buffer.toString('base64');
    
    // Определяем MIME тип для Gemini (Gemini поддерживает: audio/mpeg, audio/mp3, audio/wav, audio/webm, audio/ogg)
    let geminiMime = 'audio/webm';
    if (mime.includes('mp4') || mime.includes('m4a')) geminiMime = 'audio/mp4';
    else if (mime.includes('ogg')) geminiMime = 'audio/ogg';
    else if (mime.includes('wav')) geminiMime = 'audio/wav';
    else if (mime.includes('mpeg') || mime.includes('mp3')) geminiMime = 'audio/mpeg';
    
    console.log('[GEMINI-STT] Using MIME type:', geminiMime);
    
    // Используем тот же подход что и для TTS: прокси, v1beta, retry логика
    const proxies = parseGeminiProxies();
    const attempts = proxies.length ? proxies : ['__direct__'];
    const timeoutMs = 60000; // 60 секунд для распознавания речи
    const maxRetries = 3;
    const retryableStatuses = [503, 429, 500, 502]; // Перегружен, слишком много запросов, внутренняя ошибка
    
    // Используем ту же модель что и для текста (gemini-2.5-pro) или можно выбрать через переменную окружения
    const modelName = process.env.GEMINI_STT_MODEL || 'gemini-2.5-pro';
    const apiVersion = 'v1beta'; // Используем v1beta как в TTS
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent`;
    
    const body = {
      contents: [{
        parts: [{
          inlineData: {
            mimeType: geminiMime,
            data: base64Audio
          }
        }, {
          text: 'Распознай речь на русском языке из этого аудио. Верни только распознанный текст без дополнительных комментариев или объяснений.'
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1024,
      }
    };
    
    let lastErr: unknown = null;
    
    for (const p of attempts) {
      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          if (retry > 0) {
            const delay = Math.min(1000 * Math.pow(2, retry - 1), 10000); // Экспоненциальная задержка: 1s, 2s, 4s (макс 10s)
            console.log(`[GEMINI-STT] Retry ${retry}/${maxRetries - 1} for ${p === '__direct__' ? 'direct' : 'proxy'} after ${delay}ms delay`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
          
          console.log(`[GEMINI-STT] Trying ${p === '__direct__' ? 'direct' : 'proxy'} (attempt ${retry + 1}/${maxRetries})`);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.max(60000, timeoutMs));
          const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
          
          const r = await undiciFetch(url, {
            method: 'POST',
            dispatcher,
            signal: controller.signal,
            headers: { 
              'Content-Type': 'application/json', 
              'X-Goog-Api-Key': apiKey 
            },
            body: JSON.stringify(body),
          });
          clearTimeout(timer);
          
          if (!r.ok) {
            const errorText = await r.text().catch(() => '');
            let errorData: any = {};
            try {
              if (errorText) errorData = JSON.parse(errorText) || {};
            } catch {}
            
            const status = r.status;
            console.error('[GEMINI-STT] HTTP', status, errorText.slice(0, 200));
            
            // Если это retryable ошибка и есть попытки - повторяем
            if (retryableStatuses.includes(status) && retry < maxRetries - 1) {
              lastErr = errorData.error || errorText || r.statusText;
              continue; // Продолжаем retry
            }
            
            // Если не retryable или закончились попытки - переходим к следующему прокси
            lastErr = errorData.error || errorText || r.statusText;
            break; // Выходим из retry цикла, переходим к следующему прокси
          }
          
          const data = await r.json() as any;
          console.log('[GEMINI-STT] Response structure:', {
            hasCandidates: !!data?.candidates,
            candidatesCount: data?.candidates?.length || 0,
            hasContent: !!data?.candidates?.[0]?.content,
            partsCount: data?.candidates?.[0]?.content?.parts?.length || 0
          });
          
          // Проверяем на ошибки в ответе
          if (data?.promptFeedback?.blockReason) {
            console.error('[GEMINI-STT] ❌ Content blocked:', data.promptFeedback.blockReason);
            throw new Error(`Content blocked: ${data.promptFeedback.blockReason}`);
          }
          
          const parts = data?.candidates?.[0]?.content?.parts || [];
          
          // КРИТИЧЕСКИ ВАЖНО: Извлекаем ТОЛЬКО ТЕКСТ из ответа, игнорируем любые аудио данные
          let text = '';
          for (const part of parts) {
            // Берем ТОЛЬКО текстовые части, игнорируем inlineData (аудио)
            if (part.text && typeof part.text === 'string') {
              text += part.text + '\n';
            }
            // ЯВНО игнорируем inlineData - это не текст!
            if (part.inlineData) {
              console.warn('[GEMINI-STT] ⚠️ Ignoring inlineData in response (this is audio, not text)');
            }
          }
          text = text.trim();
          
          // КРИТИЧЕСКИ ВАЖНО: Проверяем, что получили ТЕКСТ, а не base64 аудио
          if (text && (text.startsWith('data:audio') || text.startsWith('data:application/octet-stream') || 
              (text.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(text.replace(/\s/g, ''))))) {
            console.error('[GEMINI-STT] ❌ Gemini returned AUDIO instead of TEXT! This should never happen.');
            throw new Error('Gemini STT returned audio instead of text. This is a bug.');
          }
          
          if (text) {
            console.log('[GEMINI-STT] ✅ Transcribed successfully, returning TEXT (not audio):', text.length, 'chars, preview:', text.slice(0, 100));
            return text; // ГАРАНТИРОВАННО ТОЛЬКО ТЕКСТ
          }
          
          lastErr = 'empty_text';
          break; // Успешно получили ответ, но он пустой - не retry
        } catch (e: any) {
          lastErr = e;
          console.error('[GEMINI-STT] Error:', e?.message || String(e));
          // Если это не последняя попытка и ошибка может быть временной - retry
          if (retry < maxRetries - 1 && (e instanceof Error && (e.message.includes('aborted') || e.message.includes('timeout')))) {
            continue; // Retry для таймаутов
          }
          break; // Выходим из retry цикла
        }
      }
    }
    
    throw lastErr || new Error('gemini_stt_failed');
  } catch (e: any) {
    console.error('[GEMINI-STT] ❌ Fatal error:', e?.message || String(e));
    if (e?.stack) console.error('[GEMINI-STT] Stack:', e.stack);
    throw e; // Пробрасываем ошибку, чтобы fallback мог сработать
  }
}

async function transcribeYandex(buffer: Buffer, filename: string, mime: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append('lang', 'ru-RU');
  form.append('topic', 'general');
  const file = new File([buffer], filename || 'audio', { type: mime || 'audio/ogg' });
  form.append('file', file);
  const resp = await undiciFetch('https://stt.api.cloud.yandex.net/speech/v1/stt:recognize', {
    method: 'POST',
    headers: { Authorization: `Api-Key ${apiKey}` },
    body: form as any,
  });
  const ct = resp.headers.get('content-type') || '';
  if (!resp.ok) throw new Error(await resp.text().catch(() => 'yandex_stt_failed'));
  if (ct.includes('application/json')) {
    const data = await resp.json() as any;
    const text = (data && (data.result || data.text)) ? String(data.result || data.text) : '';
    return text;
  }
  const raw = await resp.text();
  const m = /result\s*=\s*(.*)/i.exec(raw);
  return m ? m[1] : raw;
}

// Функция для создания хеша строки (для стабильного выбора голоса)
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// Функция для создания хеша аудио (для отслеживания цепочек диалогов)
// Используется для parentHash - отслеживания связи между сообщениями
function createAudioHash(
  text: string,
  locationId: string | undefined,
  characterId: string | undefined,
  role: string,
  depth: number
): string {
  // Создаем ключ из параметров (БЕЗ locationId для диалогов внутри локации)
  const parts: string[] = [];
  parts.push(text || '');
  // locationId НЕ включаем в хеш (для диалогов внутри локации)
  if (characterId) parts.push(`char:${characterId}`);
  parts.push(`role:${role}`);
  parts.push(`depth:${depth}`);
  
  const key = parts.join('|');
  
  // Создаем SHA-256 хеш
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Расширенный тип персонажа для анализа
type CharacterForAnalysis = {
  id: string;
  name: string;
  gender: string | null;
  race?: string | null;
  class?: string | null;
  level?: number | null;
  persona?: string | null;
  origin?: string | null;
  description?: string | null;
  abilities?: string | null;
  role?: string | null;
  cha?: number | null; // Харизма для влияния на голос
  int?: number | null; // Интеллект для влияния на речь
  wis?: number | null; // Мудрость для влияния на интонацию
};

// Функция разбиения текста на сегменты (рассказчик и реплики)
async function parseTextIntoSegments(params: {
  text: string;
  gameId?: string;
  availableCharacters?: Array<CharacterForAnalysis>;
}): Promise<Array<{
  text: string;
  isNarrator: boolean;
  characterId?: string;
  characterName?: string;
  gender?: string | null;
  emotion: string;
  intensity: number;
}>> {
  const { text, gameId, availableCharacters = [] } = params;
  
  // Если текст очень короткий или нет явных признаков реплик, возвращаем как один сегмент рассказчика
  const hasQuotes = text.includes('"') || text.includes('«') || text.includes('»') || text.includes('„') || text.includes('"');
  const hasNamePattern = /^([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)[:"]/.test(text);
  
  if (text.length < 100 || (!hasQuotes && !hasNamePattern)) {
    // Если текст короткий или нет явных реплик, возвращаем как один сегмент рассказчика
    const quickEmotion = detectEmotion(text);
    return [{
      text: text.trim(),
      isNarrator: true,
      emotion: quickEmotion.emotion,
      intensity: quickEmotion.intensity
    }];
  }
  
  try {
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY || 
                   process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    
    if (!apiKey) {
      // Fallback: простое разбиение по кавычкам
      return parseTextIntoSegmentsSimple(text, availableCharacters);
    }
    
    // Формируем детальный список доступных персонажей для контекста
    const charactersList = availableCharacters.length > 0
      ? availableCharacters.map(c => {
          const parts: string[] = [];
          parts.push(`Имя: ${c.name}`);
          if (c.gender) parts.push(`Пол: ${c.gender}`);
          if (c.race) parts.push(`Раса: ${c.race}`);
          if (c.class) parts.push(`Класс: ${c.class}${c.level ? ` (${c.level} уровень)` : ''}`);
          if (c.role) parts.push(`Роль: ${c.role}`);
          if (c.persona) parts.push(`Характер: ${c.persona}`);
          if (c.origin) parts.push(`Происхождение: ${c.origin}`);
          if (c.description) parts.push(`Описание: ${c.description}`);
          if (c.abilities) parts.push(`Способности: ${c.abilities}`);
          if (c.cha !== null && c.cha !== undefined) parts.push(`Харизма: ${c.cha}`);
          if (c.int !== null && c.int !== undefined) parts.push(`Интеллект: ${c.int}`);
          if (c.wis !== null && c.wis !== undefined) parts.push(`Мудрость: ${c.wis}`);
          return `- ${parts.join(', ')}`;
        }).join('\n')
      : 'Персонажи не указаны';
    
    const systemPrompt = `Ты анализируешь текст из настольной ролевой игры D&D 5e и разбиваешь его на сегменты с ПОЛНЫМ пониманием семантического смысла.

КРИТИЧЕСКИ ВАЖНО - Ты должен понимать СЕМАНТИКУ текста:
- Понимай контекст каждого предложения и абзаца
- Определяй главную мысль и подтекст
- Распознавай эмоциональную окраску каждого фрагмента
- Понимай логические связи между частями текста
- Определяй, где заканчивается одна мысль и начинается другая
- Распознавай персонажей по ИМЕНАМ, описаниям, характеристикам и манере речи

Текст может содержать:
1. Текст рассказчика (мастера) - описания действий, окружения, событий
2. Реплики персонажей - прямая речь в кавычках или после указания имени

ВАЖНО: Учитывай характеристики персонажей из D&D 5e:
- Класс персонажа влияет на манеру речи (маг говорит интеллигентно, воин - прямо, друид - мудро, плут - хитро)
- Раса влияет на акцент и особенности речи
- Харизма (CHA) влияет на убедительность и красноречие
- Интеллект (INT) влияет на сложность речи и словарный запас
- Мудрость (WIS) влияет на интонацию и размеренность речи
- Persona (характер) описывает манеру общения персонажа
- Способности и магия могут влиять на голос (например, заклинания могут изменять голос)

Твоя задача:
1. Разбить текст на сегменты (части) с пониманием СЕМАНТИЧЕСКОЙ структуры
2. Для каждого сегмента определить:
   - Является ли он текстом рассказчика или репликой персонажа
   - Если это реплика - какой персонаж говорит:
     * КРИТИЧЕСКИ ВАЖНО: Используй ИМЕНА ПЕРСОНАЖЕЙ из текста ПОЛНОСТЬЮ (например, "Сара Конор Младшая", "БАЛДУР", "Балдур" - все слова имени, не только первое!)
     * Если в тексте упоминается имя персонажа (в любом регистре), это ОБЯЗАТЕЛЬНО его реплика
     * ИЗВЛЕКАЙ ПОЛНОЕ ИМЯ целиком - если имя "Сара Конор Младшая", используй все три слова, а не только "Сара"
     * Используй характеристики для точного определения (класс, раса, персона)
     * Учитывай описание персонажа и его способности
   - Эмоцию в сегменте (учитывай класс и характер персонажа, а также СЕМАНТИЧЕСКИЙ СМЫСЛ текста)
   - Пол говорящего персонажа (если это реплика) - используй информацию о персонаже из списка
   - Учитывай класс, расу, persona и способности персонажа при определении
   - Понимай СЕМАНТИЧЕСКИЙ КОНТЕКСТ - разбивай по смысловым блокам, а не механически

Доступные персонажи:
${charactersList}

Верни ТОЛЬКО JSON в следующем формате (без дополнительного текста, только JSON):
{
  "segments": [
    {
      "text": "текст сегмента",
      "isNarrator": true/false,
      "characterName": "ПОЛНОЕ имя персонажа (все слова, например 'Сара Конор Младшая', не только первое слово) или null",
      "gender": "мужской/женский/null",
      "emotion": "neutral/joy/sadness/fear/anger/surprise",
      "intensity": 0.0-1.0
    }
  ]
}

Правила разбиения:
- Разбивай текст ТОЛЬКО когда есть реплики персонажей - выделяй реплики отдельными сегментами
- Если весь текст - это рассказчик (нет реплик), верни ОДИН сегмент с isNarrator: true
- НЕ разбивай текст рассказчика на мелкие части - объединяй весь текст рассказчика в один сегмент
- Разбивай только когда есть явные реплики персонажей (в кавычках или после имени)
- КРИТИЧЕСКИ ВАЖНО: Распознавай персонажей по имени точно - если в тексте упоминается имя персонажа (например, "Сара Конор Младшая говорит:", "БАЛДУР:", "балдур сказал"), это ОБЯЗАТЕЛЬНО реплика этого персонажа
- ИЗВЛЕКАЙ ПОЛНОЕ ИМЯ целиком - если имя состоит из нескольких слов (например, "Сара Конор Младшая"), используй ВСЕ слова, а не только первое
- Имена персонажей могут быть в любом регистре - учитывай это при сопоставлении
- Сохраняй порядок сегментов как в оригинальном тексте
- Не теряй текст - каждый символ должен быть в каком-то сегменте
- Учитывай характеристики персонажей при определении, кто говорит
- Минимизируй количество сегментов - объединяй текст рассказчика`;

    const userPrompt = `Разбей следующий текст на сегменты и проанализируй каждый:

"${text}"

Верни JSON с сегментами.`;

    const { text: aiResponse } = await generateChatCompletion({
      systemPrompt,
      userPrompt,
      history: []
    });
    
    if (aiResponse) {
      // Пытаемся извлечь JSON из ответа
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          
          if (parsed.segments && Array.isArray(parsed.segments)) {
            // Обрабатываем сегменты и находим characterId для каждого
            const segments = parsed.segments.map((seg: any) => {
              let foundCharacterId: string | undefined;
              if (seg.characterName && availableCharacters.length > 0) {
                // Улучшенное распознавание персонажей по имени (например, БАЛДУР)
                const searchName = seg.characterName.toLowerCase().trim();
                const found = availableCharacters.find(c => {
                  const charName = c.name.toLowerCase().trim();
                  // Точное совпадение или частичное (БАЛДУР найдет "Балдур", "БАЛДУР" и т.д.)
                  return charName === searchName || 
                         charName.includes(searchName) || 
                         searchName.includes(charName) ||
                         // Также проверяем без учета регистра и пробелов
                         charName.replace(/\s+/g, '') === searchName.replace(/\s+/g, '');
                });
                if (found) {
                  foundCharacterId = found.id;
                  seg.gender = found.gender || seg.gender;
                }
              }
              
              return {
                text: seg.text || '',
                isNarrator: seg.isNarrator !== false,
                characterId: foundCharacterId,
                characterName: seg.characterName || undefined,
                gender: seg.gender || null,
                emotion: seg.emotion || 'neutral',
                intensity: Math.max(0, Math.min(1, seg.intensity || 0))
              };
            }).filter((seg: any) => seg.text.trim().length > 0);
            
            // Проверяем, что все сегменты покрывают весь текст (приблизительно)
            const totalSegmentsLength = segments.reduce((sum: number, seg: any) => sum + seg.text.length, 0);
            if (totalSegmentsLength >= text.length * 0.8) { // Допускаем небольшую потерю
              return segments;
            }
          }
        } catch (e) {
          console.error('[TTS-SEGMENTS] Failed to parse AI response:', e);
        }
      }
    }
  } catch (e) {
    console.error('[TTS-SEGMENTS] AI parsing failed:', e);
  }
  
  // Fallback на простое разбиение
  return parseTextIntoSegmentsSimple(text, availableCharacters);
}

// Простое разбиение текста на сегменты (fallback)
function parseTextIntoSegmentsSimple(
  text: string, 
  availableCharacters: Array<CharacterForAnalysis>
): Array<{
  text: string;
  isNarrator: boolean;
  characterId?: string;
  characterName?: string;
  gender?: string | null;
  emotion: string;
  intensity: number;
}> {
  const segments: Array<{
    text: string;
    isNarrator: boolean;
    characterId?: string;
    characterName?: string;
    gender?: string | null;
    emotion: string;
    intensity: number;
  }> = [];
  
  // Разбиваем по кавычкам и паттернам "Имя: текст"
  const quotePattern = /(["«»„"])([^"«»„"]+)\1/g;
  const namePattern = /([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)\s*(?:говорит|сказал|сказала|произнес|произнесла|воскликнул|воскликнула|шепчет|кричит):\s*([^.!?]+[.!?])/gi;
  
  let lastIndex = 0;
  const matches: Array<{ start: number; end: number; text: string; isQuote: boolean; characterName?: string }> = [];
  
  // Находим все реплики в кавычках
  let match;
  while ((match = quotePattern.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[2],
      isQuote: true
    });
  }
  
  // Находим все реплики с именами
  while ((match = namePattern.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      text: match[2],
      isQuote: false,
      characterName: match[1]
    });
  }
  
  // Сортируем по позиции
  matches.sort((a, b) => a.start - b.start);
  
  // Создаем сегменты
  for (const m of matches) {
    // Текст перед репликой (рассказчик)
    if (m.start > lastIndex) {
      const narratorText = text.slice(lastIndex, m.start).trim();
      if (narratorText) {
        const emotion = detectEmotion(narratorText);
        segments.push({
          text: narratorText,
          isNarrator: true,
          emotion: emotion.emotion,
          intensity: emotion.intensity
        });
      }
    }
    
    // Реплика персонажа
    const emotion = detectEmotion(m.text);
    let characterId: string | undefined;
    let gender: string | null = null;
    
    if (m.characterName) {
      const found = availableCharacters.find(c => 
        c.name.toLowerCase().includes(m.characterName!.toLowerCase()) ||
        m.characterName!.toLowerCase().includes(c.name.toLowerCase())
      );
      if (found) {
        characterId = found.id;
        gender = found.gender;
      }
    }
    
    segments.push({
      text: m.text.trim(),
      isNarrator: false,
      characterId,
      characterName: m.characterName,
      gender,
      emotion: emotion.emotion,
      intensity: emotion.intensity
    });
    
    lastIndex = m.end;
  }
  
  // Текст после последней реплики (рассказчик)
  if (lastIndex < text.length) {
    const narratorText = text.slice(lastIndex).trim();
    if (narratorText) {
      const emotion = detectEmotion(narratorText);
      segments.push({
        text: narratorText,
        isNarrator: true,
        emotion: emotion.emotion,
        intensity: emotion.intensity
      });
    }
  }
  
  // Если не нашли реплик, возвращаем весь текст как один сегмент рассказчика
  if (segments.length === 0) {
    const emotion = detectEmotion(text);
    segments.push({
      text: text.trim(),
      isNarrator: true,
      emotion: emotion.emotion,
      intensity: emotion.intensity
    });
  }
  
  return segments;
}

// Функция динамического анализа текста через LLM для определения контекста речи
async function analyzeSpeechContext(params: {
  text: string;
  gameId?: string;
  availableCharacters?: Array<{ id: string; name: string; gender: string | null }>;
}): Promise<{
  isNarrator: boolean;
  characterId?: string;
  characterName?: string;
  gender?: string | null;
  emotion: string;
  intensity: number;
}> {
  const { text, gameId, availableCharacters = [] } = params;
  
  // Если текст очень короткий, используем быстрое определение без LLM
  if (text.length < 20) {
    const quickEmotion = detectEmotion(text);
    return {
      isNarrator: true,
      emotion: quickEmotion.emotion,
      intensity: quickEmotion.intensity
    };
  }
  
  try {
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY || 
                   process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    
    if (!apiKey) {
      // Fallback на паттерн-бейзированное определение
      const quickEmotion = detectEmotion(text);
      return {
        isNarrator: !text.includes('"') && !text.includes('«') && !text.includes('»'),
        emotion: quickEmotion.emotion,
        intensity: quickEmotion.intensity
      };
    }
    
    // Формируем список доступных персонажей для контекста
    const charactersList = availableCharacters.length > 0
      ? availableCharacters.map(c => `- ${c.name}${c.gender ? ` (${c.gender})` : ''}`).join('\n')
      : 'Персонажи не указаны';
    
    const systemPrompt = `Ты анализируешь текст из настольной ролевой игры D&D 5e для определения контекста речи с ПОЛНЫМ пониманием СЕМАНТИЧЕСКОГО СМЫСЛА.

КРИТИЧЕСКИ ВАЖНО - Ты должен понимать СЕМАНТИКУ:
- Понимай контекст и подтекст текста
- Определяй главную мысль и эмоциональную окраску
- Распознавай иронию, сарказм, метафоры
- Понимай логические связи и структуру текста
- Распознавай персонажей по ИМЕНАМ, описаниям, характеристикам и манере речи

Твоя задача:
1. Определить, является ли текст репликой персонажа или текстом рассказчика (мастера) - на основе СЕМАНТИКИ, а не только формальных признаков
2. Если это реплика персонажа - определить, какой персонаж говорит:
   - ИСПОЛЬЗУЙ ИМЕНА ПЕРСОНАЖЕЙ из текста ПОЛНОСТЬЮ (например, "Сара Конор Младшая", "БАЛДУР", "Балдур" - все слова имени, не только первое!)
   - ИЗВЛЕКАЙ ПОЛНОЕ ИМЯ целиком - если имя "Сара Конор Младшая", используй все три слова, а не только "Сара"
   - Используй СЕМАНТИЧЕСКИЙ анализ - кто по смыслу может так говорить
   - Учитывай описание персонажа, его класс, расу, персону при определении
   - Если в тексте упоминается имя персонажа (в любом регистре), это ОБЯЗАТЕЛЬНО его реплика
3. Определить эмоцию в тексте с учетом СЕМАНТИЧЕСКОГО СМЫСЛА (не только поверхностных признаков)
4. Определить пол говорящего персонажа (если это реплика) - используй информацию о персонаже из списка

Доступные персонажи:
${charactersList}

Верни ТОЛЬКО JSON в следующем формате (без дополнительного текста, только JSON):
{
  "isNarrator": true/false,
  "characterName": "ПОЛНОЕ имя персонажа (все слова, например 'Сара Конор Младшая', не только первое слово) или null",
  "gender": "мужской/женский/null",
  "emotion": "neutral/joy/sadness/fear/anger/surprise",
  "intensity": 0.0-1.0
}

Правила определения:
- Реплики персонажей обычно в кавычках или начинаются с имени персонажа, НО анализируй СЕМАНТИКУ
- Текст рассказчика описывает действия, окружение, события - понимай это по СМЫСЛУ
- КРИТИЧЕСКИ ВАЖНО: Если в тексте упоминается имя персонажа (например, "Сара Конор Младшая говорит:", "БАЛДУР:", "балдур сказал"), это ОБЯЗАТЕЛЬНО реплика этого персонажа
- ИЗВЛЕКАЙ ПОЛНОЕ ИМЯ целиком - если имя состоит из нескольких слов (например, "Сара Конор Младшая"), используй ВСЕ слова, а не только первое
- Имена персонажей могут быть в любом регистре - учитывай это при сопоставлении
- Если персонаж не найден в списке, но текст явно реплика по СЕМАНТИКЕ - используй characterName из текста
- Эмоция должна отражать ГЛУБОКИЙ ТОН и НАСТРОЕНИЕ текста, учитывая СЕМАНТИЧЕСКИЙ СМЫСЛ
- Анализируй не только слова, но и ПОДТЕКСТ и КОНТЕКСТ
- Учитывай характеристики персонажа (класс, раса, персона) при определении, кто говорит`;

    const userPrompt = `Проанализируй следующий текст:

"${text}"

Определи контекст речи и верни JSON.`;

    const { text: aiResponse } = await generateChatCompletion({
      systemPrompt,
      userPrompt,
      history: []
    });
    
    if (aiResponse) {
      // Пытаемся извлечь JSON из ответа
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          
          // Находим characterId по имени, если персонаж найден
          let foundCharacterId: string | undefined;
          if (parsed.characterName && availableCharacters.length > 0) {
            const found = availableCharacters.find(c => 
              c.name.toLowerCase().includes(parsed.characterName.toLowerCase()) ||
              parsed.characterName.toLowerCase().includes(c.name.toLowerCase())
            );
            if (found) {
              foundCharacterId = found.id;
              parsed.gender = found.gender || parsed.gender;
            }
          }
          
          return {
            isNarrator: parsed.isNarrator !== false, // По умолчанию рассказчик
            characterId: foundCharacterId,
            characterName: parsed.characterName || undefined,
            gender: parsed.gender || null,
            emotion: parsed.emotion || 'neutral',
            intensity: Math.max(0, Math.min(1, parsed.intensity || 0))
          };
        } catch (e) {
          console.error('[TTS-ANALYSIS] Failed to parse AI response:', e);
        }
      }
    }
  } catch (e) {
    console.error('[TTS-ANALYSIS] AI analysis failed:', e);
  }
  
  // Fallback на паттерн-бейзированное определение
  const quickEmotion = detectEmotion(text);
  const hasQuotes = text.includes('"') || text.includes('«') || text.includes('»');
  const hasNamePattern = /^([А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)?)[:"]/.test(text);
  
  return {
    isNarrator: !hasQuotes && !hasNamePattern,
    emotion: quickEmotion.emotion,
    intensity: quickEmotion.intensity
  };
}

// Функция парсинга эмоций из текста (fallback)
// Функция глубокого семантического анализа текста
async function analyzeTextSemantics(text: string): Promise<{
  mainTheme: string;
  emotionalTone: string;
  keyWords: string[];
  sentenceTypes: Array<'question' | 'exclamation' | 'statement' | 'command'>;
  semanticStructure: Array<{ text: string; importance: 'high' | 'medium' | 'low'; emotion: string }>;
} | null> {
  try {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    if (!geminiKey) {
      return null;
    }
    
    const systemPrompt = `Ты эксперт по лингвистике и семантическому анализу текста. Твоя задача - провести глубокий семантический анализ текста.

Проанализируй:
1. Главную тему и подтекст текста
2. Эмоциональную окраску (радость, печаль, страх, гнев, удивление, нейтральность)
3. Ключевые слова и фразы, несущие основной смысл
4. Типы предложений (вопрос, восклицание, утверждение, команда)
5. Семантическую структуру - разбей текст на смысловые блоки с указанием важности и эмоции каждого

Верни ТОЛЬКО JSON в следующем формате:
{
  "mainTheme": "главная тема текста",
  "emotionalTone": "основная эмоциональная окраска",
  "keyWords": ["ключевое слово 1", "ключевое слово 2"],
  "sentenceTypes": ["question", "exclamation", "statement"],
  "semanticStructure": [
    {
      "text": "фрагмент текста",
      "importance": "high/medium/low",
      "emotion": "эмоция фрагмента"
    }
  ]
}`;

    const userPrompt = `Проведи глубокий семантический анализ следующего текста:

"${text}"

Верни JSON с анализом.`;

    const { text: analysisResponse } = await generateChatCompletion({
      systemPrompt,
      userPrompt,
      history: []
    });
    
    if (analysisResponse) {
      const jsonMatch = analysisResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e) {
          console.error('[TTS-SEMANTICS] Failed to parse semantic analysis:', e);
        }
      }
    }
  } catch (e) {
    console.error('[TTS-SEMANTICS] Semantic analysis failed:', e);
  }
  
  return null;
}

// Функция генерации SSML с интонациями через Gemini
async function generateSSMLWithIntonation(params: {
  text: string;
  isNarrator: boolean;
  characterName?: string;
  characterClass?: string | null;
  characterRace?: string | null;
  characterPersona?: string | null;
  characterCha?: number | null;
  characterInt?: number | null;
  characterWis?: number | null;
  emotion?: string;
  intensity?: number;
  basePitch?: number;
  baseRate?: number;
}): Promise<string | null> {
  const { 
    text, 
    isNarrator, 
    characterName,
    characterClass,
    characterRace,
    characterPersona,
    characterCha,
    characterInt,
    characterWis,
    emotion = 'neutral',
    intensity = 0.5,
    basePitch = 0,
    baseRate = 1.0
  } = params;
  
  try {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    if (!geminiKey) {
      console.warn('[TTS-SSML] Gemini API key not found, falling back to standard SSML');
      return null; // Fallback на обычный SSML
    }
    
    // Генерация SSML через Gemini (логи убраны для уменьшения шума)
    
    const characterInfo: string[] = [];
    if (characterName) characterInfo.push(`Имя: ${characterName}`);
    if (characterClass) characterInfo.push(`Класс: ${characterClass}`);
    if (characterRace) characterInfo.push(`Раса: ${characterRace}`);
    if (characterPersona) characterInfo.push(`Характер: ${characterPersona}`);
    if (characterCha !== null) characterInfo.push(`Харизма: ${characterCha}`);
    if (characterInt !== null) characterInfo.push(`Интеллект: ${characterInt}`);
    if (characterWis !== null) characterInfo.push(`Мудрость: ${characterWis}`);
    
    // Упрощенный промпт для быстрой генерации SSML
    const systemPrompt = `Создай SSML разметку для синтеза речи.

${isNarrator ? 'Текст рассказчика - мягкий, с интонацией.' : `Реплика персонажа${characterName ? ` ${characterName}` : ''}.`}
${characterInfo.length > 0 ? `Характеристики: ${characterInfo.join(', ')}` : ''}
Эмоция: ${emotion}, интенсивность: ${intensity}

Правила:
- Паузы <break time="100ms"/> после запятых, точек
- Акценты <emphasis level="moderate"> на ключевых словах
- Интонации <prosody pitch="+2st"> для вопросов/восклицаний
- Естественный ритм

Верни ТОЛЬКО SSML:
<speak><prosody rate="${baseRate}" pitch="${basePitch >= 0 ? '+' : ''}${basePitch}st">текст</prosody></speak>`;

    const userPrompt = `Создай SSML для: "${text}"

БЫСТРО: паузы, акценты, интонации. ТОЛЬКО SSML.`;

    const startTime = Date.now();
    
    try {
      // Динамический таймаут в зависимости от длины текста (минимум 20 секунд, максимум 60 секунд)
      const timeoutMs = Math.min(60000, Math.max(20000, text.length * 50));
      
      const ssmlPromise = generateChatCompletion({
        systemPrompt,
        userPrompt,
        history: []
      });
      
      const timeoutPromise = new Promise<{ text: string }>((_, reject) => {
        setTimeout(() => reject(new Error('SSML generation timeout')), timeoutMs);
      });
      
      const { text: ssmlResponse } = await Promise.race([ssmlPromise, timeoutPromise]);
    
      if (ssmlResponse) {
        // Извлекаем SSML из ответа
        const ssmlMatch = ssmlResponse.match(/<speak>[\s\S]*<\/speak>/i);
        if (ssmlMatch) {
          return ssmlMatch[0];
        }
        // Если SSML не найден, но есть теги speak, используем весь ответ
        if (ssmlResponse.includes('<speak>')) {
          return ssmlResponse;
        }
      }
    } catch (e) {
      // Продолжаем с fallback
    }
  } catch (e) {
    // Продолжаем с fallback
  }
  return null; // Fallback на обычный SSML
}

function detectEmotion(text: string): { emotion: string; intensity: number } {
  const lowerText = text.toLowerCase();
  
  // Радость
  const joyPatterns = [
    /\b(рад|радост|счастлив|весел|улыб|смех|лику|торжеств|праздн|восторг|восхищ|отличн|прекрасн|замечательн)\b/gi,
    /[!]{2,}/g, // Множественные восклицательные знаки
    /\b(да!|ура!|отлично!|прекрасно!)\b/gi
  ];
  const joyMatches = joyPatterns.reduce((sum, pattern) => sum + (lowerText.match(pattern)?.length || 0), 0);
  
  // Грусть
  const sadnessPatterns = [
    /\b(груст|печал|тоск|скорб|плач|слез|уныл|отчаян|безнадежн|разочарован)\b/gi,
    /\.{3,}/g, // Многоточие
    /\b(увы|жаль|к сожалению)\b/gi
  ];
  const sadnessMatches = sadnessPatterns.reduce((sum, pattern) => sum + (lowerText.match(pattern)?.length || 0), 0);
  
  // Страх
  const fearPatterns = [
    /\b(страх|боюсь|боязн|ужас|испуг|паник|тревог|опасн|жутк|жутко)\b/gi,
    /\b(что если|вдруг|не дай бог)\b/gi
  ];
  const fearMatches = fearPatterns.reduce((sum, pattern) => sum + (lowerText.match(pattern)?.length || 0), 0);
  
  // Злость
  const angerPatterns = [
    /\b(зло|зли|ярост|гнев|ненавист|проклят|черт|дьявол|бесит|разозл|раздражен)\b/gi,
    /\b(как же|как можно|не могу|достало)\b/gi
  ];
  const angerMatches = angerPatterns.reduce((sum, pattern) => sum + (lowerText.match(pattern)?.length || 0), 0);
  
  // Удивление
  const surprisePatterns = [
    /\b(удивл|невероятн|неожиданн|внезапн|ошеломл|поразительн|не может быть|неужели)\b/gi,
    /\?{2,}/g // Множественные вопросительные знаки
  ];
  const surpriseMatches = surprisePatterns.reduce((sum, pattern) => sum + (lowerText.match(pattern)?.length || 0), 0);
  
  // Определяем доминирующую эмоцию
  const emotions = [
    { name: 'joy', score: joyMatches },
    { name: 'sadness', score: sadnessMatches },
    { name: 'fear', score: fearMatches },
    { name: 'anger', score: angerMatches },
    { name: 'surprise', score: surpriseMatches }
  ];
  
  emotions.sort((a, b) => b.score - a.score);
  const dominant = emotions[0];
  
  // Интенсивность на основе количества совпадений
  const intensity = Math.min(1.0, dominant.score / 3.0);
  
  return {
    emotion: dominant.score > 0 ? dominant.name : 'neutral',
    intensity: dominant.score > 0 ? intensity : 0
  };
}

// Функция выбора параметров голоса (pitch, rate) для Gemini TTS на основе персонажа/локации с поддержкой многоголосости
function selectVoiceForContext(params: {
  characterId?: string;
  characterName?: string;
  locationId?: string;
  gender?: string | null;
  characterGender?: string | null;
  isNarrator?: boolean;
  locationType?: string | null;
  characterClass?: string | null;
  characterRace?: string | null;
  characterPersona?: string | null;
  characterCha?: number | null;
  characterInt?: number | null;
  characterWis?: number | null;
  characterLevel?: number | null;
}): { voice: string; pitch: number; rate: number } {
  const { 
    characterId, 
    characterName, 
    locationId, 
    gender, 
    characterGender, 
    isNarrator, 
    locationType,
    characterClass,
    characterRace,
    characterPersona,
    characterCha,
    characterInt,
    characterWis,
    characterLevel
  } = params;
  
  // Определяем пол для выбора голоса
  const finalGender = characterGender || gender || null;
  const isFemale = finalGender && (finalGender.toLowerCase().includes('жен') || finalGender.toLowerCase().includes('female') || finalGender.toLowerCase().includes('f'));
  const isMale = finalGender && (finalGender.toLowerCase().includes('муж') || finalGender.toLowerCase().includes('male') || finalGender.toLowerCase().includes('m'));
  
  // Параметры голоса для Gemini TTS (voice используется только для совместимости, реально используется pitch и rate)
  // Эти значения используются для настройки параметров Gemini TTS
  
  let voice = 'default'; // По умолчанию - используется для совместимости
  let pitch = 0.0; // Нейтральная интонация
  let rate = 1.0; // Нормальный темп
  
  // Выбор голоса на основе персонажа с уникальностью для каждого персонажа
  if (characterId && !isNarrator) {
    // Создаем уникальный голос для каждого персонажа на основе его ID
    const charHash = simpleHash(characterId);
    const voiceIndex = charHash % 5; // 5 доступных голосов
    
    // Базовые настройки на основе пола
    if (isFemale) {
      voice = 'female'; // Для совместимости (не используется в Gemini TTS)
      pitch = 1.5 + (charHash % 3) * 0.5; // От 1.5 до 3.0
      rate = 0.95 + (charHash % 5) * 0.05; // От 0.95 до 1.15
    } else if (isMale) {
      voice = 'male'; // Для совместимости (не используется в Gemini TTS)
      pitch = -2.0 + (charHash % 3) * 0.5; // От -2.0 до -0.5
      rate = 0.9 + (charHash % 5) * 0.05; // От 0.9 до 1.1
    } else {
      voice = 'neutral'; // Для совместимости (не используется в Gemini TTS)
      pitch = -0.5 + (charHash % 3) * 0.5; // От -0.5 до 1.0
      rate = 0.95 + (charHash % 5) * 0.05; // От 0.95 до 1.15
    }
    
    // Корректировки на основе класса персонажа
    if (characterClass) {
      const classLower = characterClass.toLowerCase();
      if (classLower.includes('маг') || classLower.includes('wizard') || classLower.includes('чародей') || classLower.includes('sorcerer')) {
        // Маги говорят более интеллигентно, размеренно
        rate = Math.max(0.85, rate - 0.1);
        pitch += 0.5; // Немного выше для интеллектуальности
      } else if (classLower.includes('воин') || classLower.includes('fighter') || classLower.includes('варвар') || classLower.includes('barbarian')) {
        // Воины говорят прямо, уверенно
        rate = Math.min(1.15, rate + 0.1);
        pitch -= 0.3; // Немного ниже для уверенности
      } else if (classLower.includes('друид') || classLower.includes('druid') || classLower.includes('жрец') || classLower.includes('cleric')) {
        // Друиды и жрецы говорят мудро, размеренно
        rate = Math.max(0.88, rate - 0.08);
        pitch += 0.2; // Немного выше для мудрости
      } else if (classLower.includes('плут') || classLower.includes('rogue') || classLower.includes('бард') || classLower.includes('bard')) {
        // Плуты и барды говорят быстро, хитро
        rate = Math.min(1.2, rate + 0.15);
        pitch += 0.3; // Выше для хитрости
      } else if (classLower.includes('паладин') || classLower.includes('paladin')) {
        // Паладины говорят уверенно, благородно
        rate = Math.max(0.9, rate - 0.05);
        pitch -= 0.2; // Немного ниже для благородства
      }
    }
    
    // Корректировки на основе расы
    if (characterRace) {
      const raceLower = characterRace.toLowerCase();
      if (raceLower.includes('эльф') || raceLower.includes('elf')) {
        // Эльфы говорят изысканно, мелодично
        pitch += 0.4;
        rate = Math.max(0.9, rate - 0.05);
      } else if (raceLower.includes('дварф') || raceLower.includes('dwarf')) {
        // Дварфы говорят грубовато, низко
        pitch -= 0.5;
        rate = Math.min(1.1, rate + 0.05);
      } else if (raceLower.includes('гном') || raceLower.includes('gnome')) {
        // Гномы говорят быстро, высоко
        pitch += 0.6;
        rate = Math.min(1.15, rate + 0.1);
      } else if (raceLower.includes('орк') || raceLower.includes('orc') || raceLower.includes('полуорк')) {
        // Орки говорят грубо, низко
        pitch -= 0.7;
        rate = Math.min(1.1, rate + 0.08);
      }
    }
    
    // Корректировки на основе характеристик
    if (characterCha !== null && characterCha !== undefined) {
      // Высокая харизма = более убедительная, красноречивая речь
      const chaMod = (characterCha - 10) / 2; // Модификатор харизмы
      rate += chaMod * 0.02; // Более высокая харизма = более быстрая, уверенная речь
      pitch += chaMod * 0.1; // Более высокая харизма = более выразительная интонация
    }
    
    if (characterInt !== null && characterInt !== undefined) {
      // Высокий интеллект = более размеренная, продуманная речь
      const intMod = (characterInt - 10) / 2;
      rate = Math.max(0.85, rate - intMod * 0.015); // Более высокий интеллект = более медленная, продуманная речь
    }
    
    if (characterWis !== null && characterWis !== undefined) {
      // Высокая мудрость = более спокойная, размеренная речь
      const wisMod = (characterWis - 10) / 2;
      rate = Math.max(0.88, rate - wisMod * 0.01);
      pitch += wisMod * 0.05; // Более высокая мудрость = более спокойная интонация
    }
    
    // Корректировки на основе уровня
    if (characterLevel !== null && characterLevel !== undefined) {
      // Более высокий уровень = более уверенная, опытная речь
      if (characterLevel >= 10) {
        rate = Math.max(0.9, rate - 0.05); // Опытные персонажи говорят размереннее
        pitch -= 0.2; // Более низкий, уверенный голос
      }
    }
    
    // Ограничиваем значения
    pitch = Math.max(-5.0, Math.min(5.0, pitch));
    rate = Math.max(0.75, Math.min(1.25, rate));
  } else if (isNarrator) {
    // Для рассказчика используем женский мягкий голос
    // Всегда один и тот же голос для рассказчика для консистентности
    voice = 'ru-RU-Wavenet-E'; // Женский мягкий голос
    pitch = 1.5; // Немного выше для мягкости
    rate = 1.0; // Нормальный темп для естественной речи
  } else if (locationType) {
    // Выбор голоса на основе типа локации
    const locType = locationType.toLowerCase();
    if (locType.includes('темн') || locType.includes('подзем') || locType.includes('пещер')) {
      voice = 'male-deep'; // Мужской, более глубокий для мрачных локаций (для совместимости)
      pitch = -1.5;
      rate = 0.9; // Медленнее для атмосферы
    } else if (locType.includes('светл') || locType.includes('лес') || locType.includes('природ')) {
      voice = 'female-soft'; // Женский, мягкий для светлых локаций (для совместимости)
      pitch = 1.5;
      rate = 1.05; // Немного быстрее
    } else {
      voice = 'neutral'; // Нейтральный (для совместимости)
    }
  }
  
  return { voice, pitch, rate };
}

// Endpoint для анализа текста и разбиения на сегменты
app.post('/api/tts/analyze', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
    
    if (!text.trim()) {
      return res.status(400).json({ error: 'text_required' });
    }
    
    // Получаем список персонажей для контекста с полной информацией
    let availableCharacters: Array<CharacterForAnalysis> = [];
    if (gameId) {
      try {
        const prisma = getPrisma();
        const game = await prisma.game.findUnique({
          where: { id: gameId },
          include: { 
            characters: { 
              select: { 
                id: true, 
                name: true, 
                gender: true,
                race: true,
                class: true,
                level: true,
                persona: true,
                origin: true,
                description: true,
                abilities: true,
                role: true,
                cha: true,
                int: true,
                wis: true
              } 
            } 
          }
        }).catch(() => null);
        if (game?.characters) {
          availableCharacters = game.characters.map(c => ({
            id: c.id,
            name: c.name,
            gender: c.gender,
            race: c.race,
            class: c.class,
            level: c.level,
            persona: c.persona,
            origin: c.origin,
            description: c.description,
            abilities: c.abilities,
            role: c.role,
            cha: c.cha,
            int: c.int,
            wis: c.wis
          }));
        }
      } catch (e) {
        console.error('[TTS-ANALYZE] Failed to fetch characters:', e);
      }
    }
    
    // Разбиваем текст на сегменты
    const segments = await parseTextIntoSegments({
      text,
      gameId,
      availableCharacters
    });
    
    return res.json({ segments });
  } catch (e) {
    console.error('[TTS-ANALYZE] Error:', e);
    return res.status(500).json({ error: 'analysis_failed', details: String(e) });
  }
});

app.post('/api/tts', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const voiceReq = typeof req.body?.voice === 'string' ? req.body.voice : undefined;
    const format = typeof req.body?.format === 'string' ? req.body.format : 'mp3';
    const speedReq = typeof req.body?.speed === 'string' ? parseFloat(req.body.speed) : undefined;
    const pitchReq = typeof req.body?.pitch === 'string' ? parseFloat(req.body.pitch) : undefined;
    const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'ru-RU';
    const segmentMode = typeof req.body?.segmentMode === 'boolean' ? req.body.segmentMode : false; // Режим сегментированного текста
    
    // Контекст для выбора голоса
    const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
    const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : undefined;
    const locationId = typeof req.body?.locationId === 'string' ? req.body.locationId : undefined;
    const gender = typeof req.body?.gender === 'string' ? req.body.gender : undefined;
    const isNarrator = typeof req.body?.isNarrator === 'boolean' ? req.body.isNarrator : undefined; // undefined = автоопределение
    
    // Параметры для цепочек диалогов (depth, choiceIndex, parentHash)
    const depth = typeof req.body?.depth === 'number' ? req.body.depth : undefined;
    const choiceIndex = typeof req.body?.choiceIndex === 'number' ? req.body.choiceIndex : undefined;
    const parentHash = typeof req.body?.parentHash === 'string' ? req.body.parentHash : undefined;
    
    // Логируем только важную информацию
    if (text.length > 500) {
      console.log(`[TTS] Request: ${text.length} chars, format=${format}`);
    }
    
    if (!text.trim()) {
      console.warn('[TTS] Empty text received');
      return res.status(400).json({ error: 'text_required' });
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Не генерируем TTS для системных сообщений об ошибке распознавания
    if (text.trim() === 'Не распознали ваш ответ, выберите вариант корректно!') {
      console.log('[TTS] Skipping TTS generation for clarification message');
      return res.status(200).json({ error: 'tts_not_needed', message: 'This message should not be voiced' });
    }
    
    // Streaming TTS - прегенерация удалена
    // Используем streaming логику из /api/tts-stream, но собираем все чанки и возвращаем полный файл
    
    // Если включен режим сегментов, разбиваем текст и обрабатываем каждый сегмент
    if (segmentMode) {
      // Получаем список персонажей для контекста с полной информацией
      let availableCharacters: Array<CharacterForAnalysis> = [];
      if (gameId) {
        try {
          const prisma = getPrisma();
          const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: { 
              characters: { 
                select: { 
                  id: true, 
                  name: true, 
                  gender: true,
                  race: true,
                  class: true,
                  level: true,
                  persona: true,
                  origin: true,
                  description: true,
                  abilities: true,
                  role: true,
                  cha: true,
                  int: true,
                  wis: true
                } 
              } 
            }
          }).catch(() => null);
          if (game?.characters) {
            availableCharacters = game.characters.map(c => ({
              id: c.id,
              name: c.name,
              gender: c.gender,
              race: c.race,
              class: c.class,
              level: c.level,
              persona: c.persona,
              origin: c.origin,
              description: c.description,
              abilities: c.abilities,
              role: c.role,
              cha: c.cha,
              int: c.int,
              wis: c.wis
            }));
          }
        } catch (e) {
          console.error('[TTS] Failed to fetch characters for segments:', e);
        }
      }
      
      const segments = await parseTextIntoSegments({
        text,
        gameId,
        availableCharacters
      });
      
      // Возвращаем сегменты для последовательной обработки на клиенте
      return res.json({ 
        segments: segments.map(seg => ({
          text: seg.text,
          isNarrator: seg.isNarrator,
          characterId: seg.characterId,
          characterName: seg.characterName,
          gender: seg.gender,
          emotion: seg.emotion,
          intensity: seg.intensity
        }))
      });
    }
    
    // Получаем информацию о персонаже/локации из базы данных для выбора голоса
    let characterGender: string | null = null;
    let characterName: string | null = null;
    let characterClass: string | null = null;
    let characterRace: string | null = null;
    let characterPersona: string | null = null;
    let characterCha: number | null = null;
    let characterInt: number | null = null;
    let characterWis: number | null = null;
    let characterLevel: number | null = null;
    let locationType: string | null = null;
    
    if (characterId || locationId) {
      try {
        const prisma = getPrisma();
        if (characterId) {
          const char = await prisma.character.findUnique({ 
            where: { id: characterId }, 
            select: { 
              gender: true, 
              name: true,
              race: true,
              class: true,
              level: true,
              persona: true,
              cha: true,
              int: true,
              wis: true
            } 
          });
          if (char) {
            characterGender = char.gender;
            characterName = char.name;
            characterClass = char.class;
            characterRace = char.race;
            characterPersona = char.persona;
            characterCha = char.cha;
            characterInt = char.int;
            characterWis = char.wis;
            characterLevel = char.level;
          }
        }
        if (locationId) {
          const loc = await prisma.location.findUnique({ where: { id: locationId }, select: { title: true, description: true } });
          if (loc) {
            // Определяем тип локации из названия/описания
            const locText = ((loc.title || '') + ' ' + (loc.description || '')).toLowerCase();
            if (locText.includes('темн') || locText.includes('подзем') || locText.includes('пещер') || locText.includes('тюрьм')) {
              locationType = 'dark';
            } else if (locText.includes('светл') || locText.includes('лес') || locText.includes('природ') || locText.includes('сад')) {
              locationType = 'light';
            }
          }
        }
      } catch (e) {
        console.error('[TTS] Failed to fetch character/location context:', e);
      }
    }
    
    // Динамический анализ текста через LLM для определения контекста
    let speechContext: {
      isNarrator: boolean;
      characterId?: string;
      characterName?: string;
      gender?: string | null;
      emotion: string;
      intensity: number;
    };
    
    // Получаем список персонажей для контекста анализа с полной информацией
    let availableCharacters: Array<CharacterForAnalysis> = [];
    if (gameId) {
      try {
        const prisma = getPrisma();
        const game = await prisma.game.findUnique({
          where: { id: gameId },
          include: { 
            characters: { 
              select: { 
                id: true, 
                name: true, 
                gender: true,
                race: true,
                class: true,
                level: true,
                persona: true,
                origin: true,
                description: true,
                abilities: true,
                role: true,
                cha: true,
                int: true,
                wis: true
              } 
            } 
          }
        }).catch(() => null);
        if (game?.characters) {
          availableCharacters = game.characters.map(c => ({
            id: c.id,
            name: c.name,
            gender: c.gender,
            race: c.race,
            class: c.class,
            level: c.level,
            persona: c.persona,
            origin: c.origin,
            description: c.description,
            abilities: c.abilities,
            role: c.role,
            cha: c.cha,
            int: c.int,
            wis: c.wis
          }));
        }
      } catch (e) {
        console.error('[TTS] Failed to fetch characters for analysis:', e);
      }
    }
    
    // Если characterId передан явно, добавляем его в список с полной информацией
    if (characterId && characterName && !availableCharacters.find(c => c.id === characterId)) {
      availableCharacters.push({
        id: characterId,
        name: characterName,
        gender: characterGender,
        race: characterRace,
        class: characterClass,
        level: characterLevel,
        persona: characterPersona,
        cha: characterCha,
        int: characterInt,
        wis: characterWis
      });
    }
    
    // Оптимизация: используем AI анализ только если параметры не переданы явно
    // Если параметры переданы - используем их напрямую для ускорения
    if (isNarrator !== undefined || characterId || characterName || gender) {
      // Параметры переданы явно - используем их без AI анализа
      const emotion = detectEmotion(text);
      speechContext = {
        isNarrator: isNarrator !== undefined ? isNarrator : true,
        characterId: characterId,
        characterName: characterName || undefined,
        gender: gender || characterGender,
        emotion: emotion.emotion,
        intensity: emotion.intensity
      };
    } else {
      // Параметры не переданы - используем быстрый анализ только для коротких текстов
      if (text.length < 50) {
        const emotion = detectEmotion(text);
        const hasQuotes = text.includes('"') || text.includes('«') || text.includes('»');
        speechContext = {
          isNarrator: !hasQuotes,
          characterId: characterId,
          characterName: characterName || undefined,
          gender: gender || characterGender,
          emotion: emotion.emotion,
          intensity: emotion.intensity
        };
      } else {
        // Для длинных текстов - используем AI анализ
    try {
      speechContext = await analyzeSpeechContext({
        text,
        gameId,
        availableCharacters
      });
    } catch (e) {
          // Fallback на паттерн-бейзированное определение
      const emotion = detectEmotion(text);
          const hasQuotes = text.includes('"') || text.includes('«') || text.includes('»');
      speechContext = {
            isNarrator: !hasQuotes,
        characterId: characterId,
        characterName: characterName || undefined,
        gender: gender || characterGender,
        emotion: emotion.emotion,
        intensity: emotion.intensity
      };
        }
      }
    }
    
    // Используем результат анализа для выбора голоса
    // Если isNarrator передан явно, используем его, иначе - результат анализа
    const finalIsNarrator = isNarrator !== undefined ? isNarrator : speechContext.isNarrator;
    const finalCharacterId = speechContext.characterId || characterId;
    const finalCharacterName = speechContext.characterName || characterName;
    const finalGender = speechContext.gender || gender || characterGender;
    
    // Прегенерация удалена - используем только streaming
    // Находим полную информацию о персонаже для выбора голоса
    let finalCharacterClass = characterClass;
    let finalCharacterRace = characterRace;
    let finalCharacterPersona = characterPersona;
    let finalCharacterCha = characterCha;
    let finalCharacterInt = characterInt;
    let finalCharacterWis = characterWis;
    let finalCharacterLevel = characterLevel;
    
    if (finalCharacterId && availableCharacters.length > 0) {
      const foundChar = availableCharacters.find(c => c.id === finalCharacterId);
      if (foundChar) {
        finalCharacterClass = foundChar.class || finalCharacterClass;
        finalCharacterRace = foundChar.race || finalCharacterRace;
        finalCharacterPersona = foundChar.persona || finalCharacterPersona;
        finalCharacterCha = foundChar.cha !== null && foundChar.cha !== undefined ? foundChar.cha : finalCharacterCha;
        finalCharacterInt = foundChar.int !== null && foundChar.int !== undefined ? foundChar.int : finalCharacterInt;
        finalCharacterWis = foundChar.wis !== null && foundChar.wis !== undefined ? foundChar.wis : finalCharacterWis;
        finalCharacterLevel = foundChar.level !== null && foundChar.level !== undefined ? foundChar.level : finalCharacterLevel;
      }
    }
    
    // Выбираем голос на основе контекста с учетом всех характеристик персонажа
    const voiceContext = selectVoiceForContext({
      characterId: finalCharacterId,
      characterName: finalCharacterName,
      locationId,
      gender: finalGender,
      characterGender: finalGender,
      isNarrator: finalIsNarrator,
      locationType,
      characterClass: finalCharacterClass,
      characterRace: finalCharacterRace,
      characterPersona: finalCharacterPersona,
      characterCha: finalCharacterCha,
      characterInt: finalCharacterInt,
      characterWis: finalCharacterWis,
      characterLevel: finalCharacterLevel,
    });
    
    // Используем эмоцию из анализа
    const emotion = {
      emotion: speechContext.emotion,
      intensity: speechContext.intensity
    };
    console.log('[TTS] Final context:', {
      isNarrator: finalIsNarrator,
      characterId: finalCharacterId,
      characterName: finalCharacterName,
      emotion: emotion.emotion,
      intensity: emotion.intensity
    });
    
    // Используем выбранный голос или переданный явно
    const finalVoice = voiceReq || voiceContext.voice;
    let finalSpeed = speedReq !== undefined ? speedReq : voiceContext.rate;
    let finalPitch = pitchReq !== undefined ? pitchReq : voiceContext.pitch;
    
    // Корректируем pitch и rate на основе эмоций
    if (emotion.emotion !== 'neutral' && emotion.intensity > 0) {
      const intensity = emotion.intensity;
      switch (emotion.emotion) {
        case 'joy':
          // Радость: выше pitch, быстрее rate
          finalPitch += 1.5 * intensity;
          finalSpeed += 0.1 * intensity;
          break;
        case 'sadness':
          // Грусть: ниже pitch, медленнее rate
          finalPitch -= 1.0 * intensity;
          finalSpeed -= 0.1 * intensity;
          break;
        case 'fear':
          // Страх: выше pitch, быстрее rate (нервность)
          finalPitch += 1.0 * intensity;
          finalSpeed += 0.15 * intensity;
          break;
        case 'anger':
          // Злость: ниже pitch, быстрее rate
          finalPitch -= 0.5 * intensity;
          finalSpeed += 0.1 * intensity;
          break;
        case 'surprise':
          // Удивление: выше pitch, быстрее rate
          finalPitch += 2.0 * intensity;
          finalSpeed += 0.2 * intensity;
          break;
      }
      // Ограничиваем значения
      finalPitch = Math.max(-5.0, Math.min(5.0, finalPitch));
      finalSpeed = Math.max(0.75, Math.min(1.25, finalSpeed));
    }
    
    console.log('[TTS] Voice context:', {
      finalVoice,
      finalSpeed,
      finalPitch,
      characterGender,
      locationType,
      isNarrator,
    });
    
    // ПОЛНОЦЕННАЯ ГЕНЕРАЦИЯ ЧЕРЕЗ GEMINI - AI сам распознает контекст и озвучивает
    // Используем Gemini 2.5 Pro для прямой генерации аудио с полным пониманием контекста
    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    
    if (!geminiApiKey) {
      console.error('[TTS] Gemini API key not configured');
      return res.status(500).json({ 
        error: 'tts_key_missing', 
        message: 'Необходимо настроить GEMINI_API_KEY для генерации речи через Gemini.'
      });
    }
    
    // Находим информацию о персонаже для использования в TTS
    const characterInfo = finalCharacterId && availableCharacters.length > 0
      ? availableCharacters.find(c => c.id === finalCharacterId)
      : null;
    
    // Функция для генерации через Google TTS (используется как fallback)
    const generateGoogleTTS = async (): Promise<Buffer | null> => {
      try {
        const googleKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;
        
        if (!googleKey) {
          console.warn('[GOOGLE-TTS] API key not configured');
          return null;
        }
        
        // Генерируем SSML для интонации
        const ssmlText = await generateSSMLWithIntonation({
          text,
          isNarrator: finalIsNarrator,
          characterName: finalCharacterName,
          characterClass: characterInfo?.class || null,
          characterRace: characterInfo?.race || null,
          characterPersona: characterInfo?.persona || null,
          characterCha: finalCharacterCha,
          characterInt: finalCharacterInt,
          characterWis: finalCharacterWis,
          emotion: emotion.emotion,
          intensity: emotion.intensity,
          basePitch: finalPitch,
          baseRate: finalSpeed
        }).catch(() => null);
        
        // Выбираем голос для Google TTS
        const isFemale = finalIsNarrator || (finalGender?.toLowerCase().includes('жен') || finalGender?.toLowerCase().includes('female') || finalGender?.toLowerCase().includes('f'));
        const isMale = !finalIsNarrator && (finalGender?.toLowerCase().includes('муж') || finalGender?.toLowerCase().includes('male') || finalGender?.toLowerCase().includes('m'));
        
        // Лучшие голоса Google TTS для русского языка с интонацией
        let voiceName = 'ru-RU-Wavenet-D'; // Мужской голос по умолчанию
        if (finalIsNarrator || isFemale) {
          voiceName = 'ru-RU-Wavenet-A'; // Женский голос для рассказчика
        } else if (isMale) {
          voiceName = 'ru-RU-Wavenet-D'; // Мужской голос
        }
        
        // Используем Google Cloud TTS REST API
        const googleTtsUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleKey}`;
        
        // Функция для разбиения SSML на части по 4500 байт (с запасом от лимита 5000)
        const splitSSMLIntoChunks = (ssml: string, maxBytes: number = 4500): string[] => {
          const ssmlBytes = Buffer.from(ssml, 'utf-8');
          if (ssmlBytes.length <= maxBytes) {
            return [ssml];
          }
          
          // Извлекаем содержимое из <speak>...</speak> если есть
          const speakMatch = ssml.match(/<speak[^>]*>(.*?)<\/speak>/s);
          const content = speakMatch ? speakMatch[1] : ssml;
          const speakOpen = speakMatch ? ssml.match(/<speak[^>]*>/)?.[0] || '<speak>' : '<speak>';
          const speakClose = '</speak>';
          
          // Разбиваем содержимое по предложениям (точка, восклицательный, вопросительный знак)
          // Учитываем, что могут быть теги внутри
          const sentences: string[] = [];
          let currentSentence = '';
          let inTag = false;
          
          for (let i = 0; i < content.length; i++) {
            const char = content[i];
            currentSentence += char;
            
            if (char === '<') inTag = true;
            if (char === '>') inTag = false;
            
            // Разбиваем по знакам препинания только вне тегов
            if (!inTag && (char === '.' || char === '!' || char === '?')) {
              // Проверяем, что это конец предложения (следующий символ пробел, перенос или конец)
              if (i === content.length - 1 || /[\s\n\r]/.test(content[i + 1])) {
                sentences.push(currentSentence.trim());
                currentSentence = '';
              }
            }
          }
          
          if (currentSentence.trim()) {
            sentences.push(currentSentence.trim());
          }
          
          if (sentences.length === 0) {
            sentences.push(content);
          }
          
          // Группируем предложения в чанки
          const chunks: string[] = [];
          let currentChunk = '';
          
          for (const sentence of sentences) {
            const testChunk = currentChunk + (currentChunk ? ' ' : '') + sentence;
            const wrappedChunk = speakOpen + testChunk + speakClose;
            const testBytes = Buffer.from(wrappedChunk, 'utf-8').length;
            
            if (testBytes <= maxBytes) {
              currentChunk = testChunk;
            } else {
              if (currentChunk) {
                chunks.push(speakOpen + currentChunk + speakClose);
              }
              // Если одно предложение больше лимита - разбиваем по словам
              const wrappedSentence = speakOpen + sentence + speakClose;
              const sentenceBytes = Buffer.from(wrappedSentence, 'utf-8').length;
              if (sentenceBytes > maxBytes) {
                // Разбиваем по словам, но сохраняем теги
                const parts = sentence.split(/(\s+)/);
                let wordChunk = '';
                for (const part of parts) {
                  const testWordChunk = wordChunk + part;
                  const wrappedWordChunk = speakOpen + testWordChunk + speakClose;
                  const testWordBytes = Buffer.from(wrappedWordChunk, 'utf-8').length;
                  if (testWordBytes <= maxBytes) {
                    wordChunk = testWordChunk;
                  } else {
                    if (wordChunk) {
                      chunks.push(speakOpen + wordChunk + speakClose);
                    }
                    wordChunk = part;
                  }
                }
                currentChunk = wordChunk;
              } else {
                currentChunk = sentence;
              }
            }
          }
          
          if (currentChunk) {
            chunks.push(speakOpen + currentChunk + speakClose);
          }
          
          return chunks.length > 0 ? chunks : [ssml];
        };
        
        // Функция для генерации одной части аудио
        const generateChunk = async (chunkText: string): Promise<Buffer | null> => {
        const requestBody = {
          input: {
              ssml: chunkText
          },
          voice: {
            languageCode: 'ru-RU',
            name: voiceName,
            ssmlGender: finalIsNarrator || isFemale ? 'FEMALE' : 'MALE'
          },
          audioConfig: {
            audioEncoding: format === 'wav' ? 'LINEAR16' : 'MP3',
            sampleRateHertz: 24000,
            speakingRate: finalSpeed,
            pitch: finalPitch,
            volumeGainDb: 0.0,
              effectsProfileId: ['headphone-class-device']
          }
        };
        
        const googleResponse = await undiciFetch(googleTtsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(20000)
        });
        
        if (googleResponse.ok) {
          const googleData = await googleResponse.json() as any;
            
          if (googleData.audioContent) {
              try {
            const audioBuffer = Buffer.from(googleData.audioContent, 'base64');
                
                // Для отдельных чанков НЕ проверяем минимальный размер - проверяем только финальное объединенное аудио
                // Короткие чанки (например, последний из нескольких) могут быть меньше 1 МБ, это нормально
            return audioBuffer;
              } catch (decodeErr) {
                console.error('[GOOGLE-TTS] ⚠️ Failed to decode base64 audioContent:', decodeErr);
                return null;
              }
            } else {
              console.error('[GOOGLE-TTS] ⚠️ No audioContent in response');
          }
        } else {
          const errorText = await googleResponse.text().catch(() => '');
            console.error('[GOOGLE-TTS] Chunk failed:', googleResponse.status, errorText.slice(0, 200));
          }
          return null;
        };
        
        // Подготавливаем финальный SSML или простой текст
        const finalInput = ssmlText || `<speak><prosody rate="${finalSpeed}" pitch="${finalPitch >= 0 ? '+' : ''}${finalPitch}st">${text}</prosody></speak>`;
        
        // Проверяем размер в байтах
        const inputBytes = Buffer.from(finalInput, 'utf-8').length;
        console.log('[GOOGLE-TTS] Input size:', inputBytes, 'bytes, voice:', voiceName);
        
        if (inputBytes <= 4500) {
          // Текст помещается в один запрос
          const audioBuffer = await generateChunk(finalInput);
          if (audioBuffer) {
            console.log('[GOOGLE-TTS] ✅ Successfully generated audio, size:', audioBuffer.length, 'bytes');
            return audioBuffer;
          } else {
            console.error('[GOOGLE-TTS] ❌ generateChunk returned null/undefined for single chunk');
          }
        } else {
          // Нужно разбить на части
          console.log('[GOOGLE-TTS] Text too long, splitting into chunks...');
          const chunks = splitSSMLIntoChunks(finalInput, 4500);
          console.log('[GOOGLE-TTS] Split into', chunks.length, 'chunks');
          
          const audioBuffers: Buffer[] = [];
          for (let i = 0; i < chunks.length; i++) {
            console.log(`[GOOGLE-TTS] Generating chunk ${i + 1}/${chunks.length}...`);
            const chunkAudio = await generateChunk(chunks[i]);
            if (chunkAudio) {
              audioBuffers.push(chunkAudio);
            } else {
              console.error(`[GOOGLE-TTS] Failed to generate chunk ${i + 1}`);
              return null; // Если одна часть не сгенерировалась - возвращаем ошибку
            }
          }
          
          // Объединяем все части
          const combinedBuffer = Buffer.concat(audioBuffers);
          
          console.log('[GOOGLE-TTS] ✅ Successfully generated and combined audio, total size:', combinedBuffer.length, 'bytes');
          return combinedBuffer;
        }
      } catch (googleErr) {
        console.error('[GOOGLE-TTS] Error:', googleErr);
      }
      return null;
    };
    
    try {
      // Используем только специализированные TTS модели
      // Остальные модели не поддерживают TTS или возвращают текст вместо аудио
      const modelsToTry = [
        'gemini-2.5-pro-preview-tts'        // Лучшее качество, более естественное произношение
      ];
      
      const proxies = parseGeminiProxies();
      const attempts = proxies.length ? proxies : ['__direct__'];
      
      // ПРОВЕРКА КВОТЫ: Делаем БЫСТРЫЙ минимальный TTS запрос с очень коротким текстом
      // Это быстрее, чем полная генерация, но проверяет именно TTS модель
      let geminiQuotaAvailable = true;
      try {
        const testModelName = modelsToTry[0];
        const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModelName}:generateContent`;
        const testDispatcher = attempts[0] !== '__direct__' ? new ProxyAgent(attempts[0]) : undefined;
        
        // Быстрая проверка доступности Gemini TTS (логи убраны)
        const testResponse = await undiciFetch(testUrl, {
          method: 'POST',
          dispatcher: testDispatcher,
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': geminiApiKey
          },
          body: JSON.stringify({
          contents: [{
            role: 'user',
              parts: [{ text: 'Проверка' }] // Тестовое слово на русском
          }],
          systemInstruction: {
            parts: [{ text: "Ты — TTS система. Озвучь текст на русском." }]
          },
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Kore'
                }
              }
            }
          }
          }),
          signal: AbortSignal.timeout(5000) // Быстрая проверка - 5 секунд (увеличено для прокси)
        });
        
        if (testResponse.status === 429) {
          const errorText = await testResponse.text().catch(() => '');
          const isQuotaError = errorText.includes('quota') || errorText.includes('Quota exceeded') || errorText.includes('generate_requests_per_model_per_day');
          if (isQuotaError) {
            console.warn('[GEMINI-TTS] ⚠️ Quota exceeded (429) - skipping Gemini, using Google TTS directly');
            geminiQuotaAvailable = false;
          }
        } else if (testResponse.ok) {
          console.log('[GEMINI-TTS] ✅ TTS quota available, proceeding with Gemini TTS');
        }
      } catch (testErr: any) {
        // Игнорируем ошибки тестового запроса, продолжаем с обычной логикой
        const isTimeout = testErr?.name === 'TimeoutError' || testErr?.message?.includes('timeout') || testErr?.message?.includes('aborted');
        if (isTimeout) {
          console.log('[GEMINI-TTS] Quick TTS check timed out (this is normal), proceeding with normal flow');
        } else {
          console.log('[GEMINI-TTS] Quick TTS check failed, proceeding with normal flow:', testErr?.message || String(testErr));
        }
      }
      
      // Если квота недоступна - сразу используем Google TTS
      if (!geminiQuotaAvailable) {
        const googleAudio = await generateGoogleTTS();
        if (googleAudio) {
          console.log('[TTS] ✅ Returning Google TTS audio to client, size:', googleAudio.length, 'bytes');
          // Прегенерация удалена
          res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
          res.setHeader('Content-Length', googleAudio.length.toString());
          return res.send(googleAudio);
        } else {
          console.warn('[TTS] ⚠️ Google TTS returned null/undefined, continuing with Gemini fallback');
        }
      }
      
      // Формируем директорские заметки на основе полного контекста персонажа
      // characterInfo уже определен выше
      let directorsNotes = '';
      
      if (finalIsNarrator) {
        // ВСЕГДА женский мягкий голос для рассказчика
        directorsNotes = `### DIRECTORS NOTES
Style: Soft, warm, female narrator voice. Gentle and inviting tone. Natural, non-robotic speech with full emotional understanding and semantic meaning.
Pacing: Calm and measured, with natural rhythm variations based on content meaning.
Accent: Natural Russian, clear pronunciation.
Emotion: ${emotion.emotion}, intensity: ${emotion.intensity}
Voice: Female, soft, warm, gentle
Tone: Always warm and inviting, never harsh or robotic
`;
      } else {
        // Для персонажей - детальные директорские заметки на основе всех характеристик
        const emotionDesc = emotion.emotion === 'joy' ? 'joyful and enthusiastic' :
                          emotion.emotion === 'sadness' ? 'sad and melancholic' :
                          emotion.emotion === 'anger' ? 'angry and intense' :
                          emotion.emotion === 'fear' ? 'fearful and anxious' :
                          emotion.emotion === 'surprise' ? 'surprised and excited' :
                          'neutral';
        
        // Определяем пол для голоса
        const isFemale = finalGender?.toLowerCase().includes('жен') || finalGender?.toLowerCase().includes('female') || finalGender?.toLowerCase().includes('f');
        const isMale = finalGender?.toLowerCase().includes('муж') || finalGender?.toLowerCase().includes('male') || finalGender?.toLowerCase().includes('m');
        const voiceGender = isFemale ? 'female' : isMale ? 'male' : 'neutral';
        
        // Описание класса и его влияния на голос
        let classVoiceDesc = '';
        if (characterInfo?.class) {
          const classLower = characterInfo.class.toLowerCase();
          if (classLower.includes('маг') || classLower.includes('wizard') || classLower.includes('чародей') || classLower.includes('sorcerer')) {
            classVoiceDesc = 'Intelligent, articulate, measured speech. Sophisticated vocabulary.';
          } else if (classLower.includes('воин') || classLower.includes('fighter') || classLower.includes('варвар') || classLower.includes('barbarian')) {
            classVoiceDesc = 'Direct, confident, strong speech. Clear and decisive.';
          } else if (classLower.includes('друид') || classLower.includes('druid') || classLower.includes('жрец') || classLower.includes('cleric')) {
            classVoiceDesc = 'Wise, calm, measured speech. Thoughtful and contemplative.';
          } else if (classLower.includes('плут') || classLower.includes('rogue') || classLower.includes('бард') || classLower.includes('bard')) {
            classVoiceDesc = 'Quick, clever, witty speech. Fast-paced and cunning.';
          } else if (classLower.includes('паладин') || classLower.includes('paladin')) {
            classVoiceDesc = 'Noble, confident, righteous speech. Strong and honorable.';
          }
        }
        
        // Описание расы и её влияния на голос
        let raceVoiceDesc = '';
        if (characterInfo?.race) {
          const raceLower = characterInfo.race.toLowerCase();
          if (raceLower.includes('эльф') || raceLower.includes('elf')) {
            raceVoiceDesc = 'Elegant, melodic, refined accent.';
          } else if (raceLower.includes('дварф') || raceLower.includes('dwarf')) {
            raceVoiceDesc = 'Rough, deep, gruff accent.';
          } else if (raceLower.includes('гном') || raceLower.includes('gnome')) {
            raceVoiceDesc = 'Quick, high-pitched, energetic accent.';
          } else if (raceLower.includes('орк') || raceLower.includes('orc') || raceLower.includes('полуорк')) {
            raceVoiceDesc = 'Harsh, deep, guttural accent.';
          }
        }
        
        // Влияние характеристик на голос
        let statsVoiceDesc = '';
        if (characterInfo) {
          const cha = characterInfo.cha || finalCharacterCha || 10;
          const int = characterInfo.int || finalCharacterInt || 10;
          const wis = characterInfo.wis || finalCharacterWis || 10;
          
          if (cha >= 16) statsVoiceDesc += 'Highly charismatic, persuasive, eloquent. ';
          if (int >= 16) statsVoiceDesc += 'Intelligent, articulate, sophisticated vocabulary. ';
          if (wis >= 16) statsVoiceDesc += 'Wise, thoughtful, measured pace. ';
          if (cha < 8) statsVoiceDesc += 'Less confident, hesitant speech. ';
          if (int < 8) statsVoiceDesc += 'Simpler vocabulary, straightforward. ';
        }
        
        const classDesc = characterInfo?.class ? `Class: ${characterInfo.class}. ` : '';
        const raceDesc = characterInfo?.race ? `Race: ${characterInfo.race}. ` : '';
        const personaDesc = characterInfo?.persona ? `Personality: ${characterInfo.persona}. ` : '';
        const nameDesc = finalCharacterName ? `Character name: ${finalCharacterName}. ` : '';
        
        directorsNotes = `### DIRECTORS NOTES
Character: ${nameDesc}${classDesc}${raceDesc}${personaDesc}
Style: ${emotionDesc}, natural and expressive. ${classVoiceDesc}${raceVoiceDesc}${statsVoiceDesc}
Pacing: ${finalSpeed > 1.0 ? 'faster, energetic' : finalSpeed < 1.0 ? 'slower, thoughtful' : 'normal, natural rhythm'}.
Accent: Natural Russian, ${raceVoiceDesc || 'character-appropriate'}.
Emotion: ${emotion.emotion}, intensity: ${emotion.intensity}
Voice: ${voiceGender}, pitch: ${finalPitch > 0 ? 'higher' : finalPitch < 0 ? 'lower' : 'neutral'}, rate: ${finalSpeed}
Tone: Character-appropriate based on class, race, personality, and stats. Real voice variation based on all character traits.
`;
      }
      
      // Для TTS передаем ТОЛЬКО чистый текст без директорских заметок
      // Директорские заметки используются только для понимания контекста, но не передаются в TTS
      // Используем generateContent с speechConfig для прямой генерации аудио через Gemini
      // Согласно документации: https://ai.google.dev/gemini-api/docs/speech-generation
      
      // Функция для создания тела запроса в зависимости от типа модели
      const createRequestBody = (modelName: string) => {
        const isTTSModel = modelName.includes('-tts');
        
        if (isTTSModel) {
          // Для специализированных TTS моделей нужен responseModalities: ['AUDIO']
          return {
            contents: [{
              role: 'user',
              parts: [{ text: text }]
            }],
            systemInstruction: {
              parts: [{
                text: "Ты — профессиональный актер озвучивания. Твоя ЕДИНСТВЕННАЯ задача — ПРОЧИТАТЬ ПРЕДОСТАВЛЕННЫЙ ТЕКСТ СЛОВО В СЛОВО на РУССКОМ ЯЗЫКЕ максимально естественно, как живой человек. НЕ анализируй текст, НЕ комментируй его, НЕ отвечай на вопросы в тексте. Просто ОЗВУЧИВАЙ текст слово в слово. КРИТИЧЕСКИ ВАЖНО: Все цифры и числа читай ТОЛЬКО на русском языке (например, 123 читай как 'сто двадцать три', 5 как 'пять', а не 'five' или 'one two three'). КРИТИЧЕСКИ ВАЖНО: Знаки препинания (запятые, тире, точки, звездочки, дефисы и т.д.) НЕ ОЗВУЧИВАЙ как слова — используй их только для создания естественных пауз в речи. Используй естественные интонации, паузы и ритм речи. Избегай монотонности. Передавай эмоции через голос: таинственность — тише и медленнее, опасность — напряженнее, триумф — громче и увереннее. Читай так, будто рассказываешь историю другу."
              }]
            },
            generationConfig: {
              responseModalities: ['AUDIO'], // КРИТИЧЕСКИ ВАЖНО: указываем, что хотим получить AUDIO, а не TEXT
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    // ВСЕГДА женский мягкий голос для рассказчика (Aoede)
                    // Для персонажей - в зависимости от пола (Kore для женских, Charon для мужских)
                    voiceName: finalIsNarrator ? 'Kore' : 
                              (finalGender?.toLowerCase().includes('жен') || finalGender?.toLowerCase().includes('female') || finalGender?.toLowerCase().includes('f')) ? 'Kore' : 
                              (finalGender?.toLowerCase().includes('муж') || finalGender?.toLowerCase().includes('male') || finalGender?.toLowerCase().includes('m')) ? 'Charon' : 
                              'Charon' // По умолчанию мужской голос
                  }
                }
              }
            }
          };
        } else {
          // Для обычных моделей используем speechConfig
          return {
            contents: [{
              role: 'user',
              parts: [{ text: text }]
            }],
            generationConfig: {
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    // ВСЕГДА женский мягкий голос для рассказчика (Aoede)
                    // Для персонажей - в зависимости от пола (Kore для женских, Charon для мужских)
                    voiceName: finalIsNarrator ? 'Kore' : 
                              (finalGender?.toLowerCase().includes('жен') || finalGender?.toLowerCase().includes('female') || finalGender?.toLowerCase().includes('f')) ? 'Kore' : 
                              (finalGender?.toLowerCase().includes('муж') || finalGender?.toLowerCase().includes('male') || finalGender?.toLowerCase().includes('m')) ? 'Charon' : 
                              'Charon' // По умолчанию мужской голос
                  }
                }
              }
            }
          };
        }
      };
      
      // Используем streaming TTS через SSE endpoint (как в /api/tts-stream)
      // Собираем все чанки в буфер и возвращаем полный файл для обратной совместимости
      const finalModelName = 'gemini-2.5-flash-preview-tts';
      const finalVoiceName = finalIsNarrator ? 'Kore' : 
                            (finalGender?.toLowerCase().includes('жен') || finalGender?.toLowerCase().includes('female') || finalGender?.toLowerCase().includes('f')) ? 'Kore' : 
                            (finalGender?.toLowerCase().includes('муж') || finalGender?.toLowerCase().includes('male') || finalGender?.toLowerCase().includes('m')) ? 'Charon' : 
                            'Charon';
      
      const requestBody = {
        contents: [{
          role: 'user',
          parts: [{ text }]
        }],
        systemInstruction: {
          parts: [{
            text: "Ты — профессиональный актер озвучивания и мастер игры (Dungeon Master). Читай текст СЛОВО В СЛОВО на РУССКОМ ЯЗЫКЕ максимально естественно, как живой человек, а не робот. КРИТИЧЕСКИ ВАЖНО: Все цифры и числа читай ТОЛЬКО на русском языке (например, 123 читай как 'сто двадцать три', 5 как 'пять', а не 'five' или 'one two three'). КРИТИЧЕСКИ ВАЖНО: Знаки препинания (запятые, тире, точки, звездочки, дефисы и т.д.) НЕ ОЗВУЧИВАЙ как слова — используй их только для создания естественных пауз в речи. Используй естественные интонации, паузы и ритм речи. Избегай монотонности и роботического звучания. Передавай эмоции и настроение сцены через голос: таинственность — тише и медленнее, опасность — напряженнее, триумф — громче и увереннее. Читай так, будто рассказываешь историю другу. Не отвечай на вопросы, не комментируй, просто озвучивай его естественным человеческим голосом."
          }]
        },
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: finalVoiceName
              }
            }
          }
        }
      };
      
      console.log(`[GEMINI-TTS] 🎤 Attempting streaming TTS generation via ${finalModelName}...`);
      
      // Пробуем каждый прокси
        for (const p of attempts) {
          try {
            const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${finalModelName}:streamGenerateContent?alt=sse`;
          
          console.log(`[GEMINI-TTS] 🎤 Attempting streaming via ${finalModelName} (${p === '__direct__' ? 'direct' : 'proxy'})`);
            
            const response = await undiciFetch(url, {
            method: 'POST',
              dispatcher,
              headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': geminiApiKey
              },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(120000)
          });
          
          if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.warn(`[GEMINI-TTS] ${finalModelName} returned ${response.status}:`, errorText.slice(0, 500));
            if (response.status === 400 && errorText.includes('location is not supported')) {
              console.warn(`[GEMINI-TTS] ⚠️ Location not supported for ${p === '__direct__' ? 'direct' : 'proxy'}, trying next...`);
              continue;
            }
            continue;
          }
          
          console.log(`[GEMINI-TTS] ✅ Response OK, Content-Type: ${response.headers.get('content-type')}`);
          
          const reader = response.body;
          if (!reader) {
            console.warn('[GEMINI-TTS] ⚠️ No response body');
                continue;
              }
              
          // Устанавливаем заголовки для streaming (PCM audio)
          res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/pcm');
          res.setHeader('Transfer-Encoding', 'chunked');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Audio-Sample-Rate', '24000');
          res.setHeader('X-Audio-Channels', '1');
          res.setHeader('X-Audio-Bits-Per-Sample', '16');
          res.setHeader('X-Accel-Buffering', 'no'); // Отключает буферизацию Nginx
          if (res.flushHeaders) {
            res.flushHeaders();
          }
          
          // Для WAV формата нужно сначала собрать все чанки для заголовка
          // Для PCM формата можем отправлять сразу (настоящий streaming)
          const audioChunks: Buffer[] = [];
          let buffer = '';
          let hasAudio = false;
          let chunkCount = 0;
          let totalAudioSize = 0;
          
          console.log('[GEMINI-TTS] 📡 Reading SSE stream and streaming chunks in real-time...');
          
          // Парсим SSE stream и отправляем аудио чанки сразу (streaming в реальном времени)
          for await (const chunk of reader) {
            let chunkStr: string;
            if (Buffer.isBuffer(chunk)) {
              chunkStr = chunk.toString('utf-8');
            } else if (chunk instanceof Uint8Array) {
              chunkStr = Buffer.from(chunk).toString('utf-8');
            } else if (chunk instanceof ArrayBuffer) {
              chunkStr = Buffer.from(chunk).toString('utf-8');
            } else if (typeof chunk === 'string') {
              chunkStr = chunk;
            } else {
              chunkStr = String(chunk);
            }
            
            buffer += chunkStr;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (trimmedLine === '') continue;
              
              if (trimmedLine.startsWith('data: ')) {
                try {
                  const jsonData = trimmedLine.slice(6);
                  const data = JSON.parse(jsonData);
                  
                  const candidates = data.candidates;
                  if (candidates && candidates.length > 0) {
                    const content = candidates[0].content;
                    if (content && content.parts) {
                      for (const part of content.parts) {
                        if (part.inlineData) {
                          const mimeType = part.inlineData.mimeType || '';
                          const data = part.inlineData.data;
                  
                  if (mimeType.includes('audio') && data) {
                            const audioBuffer = Buffer.from(data, 'base64');
                            hasAudio = true;
                            totalAudioSize += audioBuffer.length;
                            chunkCount++;
                            
                            if (format === 'wav') {
                              // Для WAV собираем чанки (нужен заголовок с размером)
                              audioChunks.push(audioBuffer);
                            } else {
                              // Для PCM отправляем сразу (настоящий streaming)
                              res.write(audioBuffer);
                              if (res.flush && typeof res.flush === 'function') {
                                res.flush();
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                } catch (e) {
                  console.warn(`[GEMINI-TTS] ⚠️ Error parsing SSE line:`, e?.message || String(e));
                }
              }
            }
          }
          
          // Обрабатываем остаток буфера
          if (buffer.trim().length > 0) {
            const trimmedLine = buffer.trim();
            if (trimmedLine.startsWith('data: ')) {
              try {
                const jsonData = trimmedLine.slice(6);
                const data = JSON.parse(jsonData);
                const candidates = data.candidates;
                if (candidates && candidates.length > 0) {
                  const content = candidates[0].content;
                  if (content && content.parts) {
                    for (const part of content.parts) {
                      if (part.inlineData) {
                        const mimeType = part.inlineData.mimeType || '';
                        const data = part.inlineData.data;
                        if (mimeType.includes('audio') && data) {
                          const audioBuffer = Buffer.from(data, 'base64');
                          totalAudioSize += audioBuffer.length;
                          chunkCount++;
                          
                          if (format === 'wav') {
                            audioChunks.push(audioBuffer);
                          } else {
                            res.write(audioBuffer);
                            if (res.flush && typeof res.flush === 'function') {
                              res.flush();
                            }
                          }
                        }
                      }
                    }
                  }
                }
              } catch (e) {
                console.warn(`[GEMINI-TTS] ⚠️ Error parsing final buffer:`, e?.message || String(e));
              }
            }
          }
          
          if (!hasAudio || (format === 'wav' && audioChunks.length === 0)) {
            console.warn('[GEMINI-TTS] ⚠️ No audio chunks received');
            continue;
          }
          
          if (format === 'wav') {
            // Для WAV объединяем все чанки и добавляем заголовок
            const combinedAudio = Buffer.concat(audioChunks);
            const sampleRate = 24000;
            const channels = 1;
                      const bitsPerSample = 16;
                      const byteRate = sampleRate * channels * (bitsPerSample / 8);
                      const blockAlign = channels * (bitsPerSample / 8);
            const dataSize = combinedAudio.length;
                      const fileSize = 36 + dataSize;
                      
                      const wavHeader = Buffer.alloc(44);
                      wavHeader.write('RIFF', 0);
                      wavHeader.writeUInt32LE(fileSize, 4);
                      wavHeader.write('WAVE', 8);
                      wavHeader.write('fmt ', 12);
            wavHeader.writeUInt32LE(16, 16);
            wavHeader.writeUInt16LE(1, 20);
                      wavHeader.writeUInt16LE(channels, 22);
                      wavHeader.writeUInt32LE(sampleRate, 24);
                      wavHeader.writeUInt32LE(byteRate, 28);
                      wavHeader.writeUInt16LE(blockAlign, 32);
                      wavHeader.writeUInt16LE(bitsPerSample, 34);
                      wavHeader.write('data', 36);
                      wavHeader.writeUInt32LE(dataSize, 40);
                      
            const finalAudio = Buffer.concat([wavHeader, combinedAudio]);
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', String(finalAudio.length));
            console.log(`[GEMINI-TTS] ✅ Collected ${chunkCount} chunks, total size: ${finalAudio.length} bytes, sending WAV`);
            return res.send(finalAudio);
            } else {
            // Для PCM уже отправили все чанки через res.write()
            console.log(`[GEMINI-TTS] ✅ Streaming complete: ${chunkCount} chunks, ${totalAudioSize} bytes total`);
            res.end();
            return;
          }
          
        } catch (streamError: any) {
          const errorMsg = streamError?.message || String(streamError);
          console.warn(`[GEMINI-TTS] ${finalModelName} error (${p === '__direct__' ? 'direct' : 'proxy'}):`, errorMsg);
                continue;
        }
      }
      
      console.error('[GEMINI-TTS] All models failed - Gemini audio generation not available');
    } catch (geminiErr) {
      console.error('[TTS] Gemini audio generation failed:', geminiErr);
    }
    
    // FALLBACK: Если Gemini не сработал (любая ошибка), используем Google TTS с интонацией
    // Это работает для ВСЕХ запросов: прегенерация, welcome, reply, и обычные TTS запросы
    console.log('[TTS] Falling back to Google TTS (works for all requests: welcome, reply, regular)...');
    const googleAudio = await generateGoogleTTS();
    if (googleAudio) {
      console.log('[TTS] ✅ Returning Google TTS fallback audio to client, size:', googleAudio.length, 'bytes');
      res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
      res.setHeader('Content-Length', googleAudio.length.toString());
      // Прегенерация удалена
      return res.send(googleAudio);
    } else {
      console.error('[TTS] ❌ Google TTS fallback also returned null/undefined!');
    }
    
    return res.status(502).json({ 
      error: 'tts_failed', 
      message: 'Не удалось сгенерировать аудио через Gemini и Google TTS. Проверьте настройки API ключей.'
    });
  } catch (e) {
    console.error('[TTS] TTS endpoint error:', e);
    return res.status(500).json({ error: 'tts_error', details: String(e) });
  }
});

// Защита от дублирования подключений (race condition)
const activeTtsStreams = new Map<string, boolean>();

// Streaming TTS endpoint через прямой REST API (как обычный TTS, но с SSE парсингом)
app.post('/api/tts-stream', async (req, res) => {
  // Создаем уникальный ключ для этого запроса (на основе текста и времени)
  const streamKey = `${req.body?.text?.slice(0, 50)}_${Date.now()}`;
  
  // Проверяем, не обрабатывается ли уже такой запрос
  if (activeTtsStreams.has(streamKey)) {
    console.warn('[GEMINI-TTS-LIVE] ⚠️ Duplicate request detected, ignoring');
    return res.status(429).json({ error: 'duplicate_request', message: 'Запрос уже обрабатывается' });
  }
  
  // Помечаем запрос как обрабатываемый
  activeTtsStreams.set(streamKey, true);
  
  // Очищаем ключ после завершения (с таймаутом на случай зависания)
  const cleanup = () => {
    setTimeout(() => {
      activeTtsStreams.delete(streamKey);
    }, 60000); // 60 секунд
  };
  
  try {
    const { text, voiceName, modelName } = req.body;
    
    // КРИТИЧЕСКИ ВАЖНО: Проверяем, что text - это ТЕКСТ, а не аудио
    if (!text || typeof text !== 'string') {
      cleanup();
      console.error('[GEMINI-TTS-LIVE] ❌ text is not a string:', typeof text);
      return res.status(400).json({ error: 'text_required', message: 'Текст для синтеза обязателен' });
    }
    
    // Проверяем, что это не base64 аудио
    if (text.startsWith('data:audio') || text.startsWith('data:application/octet-stream') || 
        (text.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(text.replace(/\s/g, '')))) {
      cleanup();
      console.error('[GEMINI-TTS-LIVE] ❌ Received AUDIO instead of TEXT!');
      return res.status(400).json({ error: 'audio_received', message: 'Received audio instead of text. TTS requires text input.' });
    }
    
    // Минимальная длина текста
    if (text.length < 5) {
      cleanup();
      return res.status(400).json({ error: 'text_too_short', message: 'Текст должен быть не менее 5 символов' });
    }
    
    const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    if (!geminiApiKey) {
      cleanup();
      return res.status(500).json({ 
        error: 'tts_key_missing', 
        message: 'Необходимо настроить GEMINI_API_KEY для генерации речи через Gemini.' 
      });
    }
    
    // Для Live API используем модель 2.0 (Live API требует актуальные модели 2.0)
    // ВАЖНО: gemini-2.5-flash-preview не существует для Live API, строго используем gemini-2.0-flash-exp
    // Модели 1.5 не всегда стабильны в Live-режиме через чистые сокеты
    let finalModelName = modelName ? modelName.replace(/-tts$/, '') : 'gemini-2.0-flash-exp';
    // Принудительно заменяем любые модели 2.5 на 2.0, и любые другие на 2.0-flash-exp
    if (finalModelName.includes('2.5') || !finalModelName.includes('2.0-flash-exp')) {
      finalModelName = 'gemini-2.0-flash-exp';
    }
    const finalVoiceName = voiceName || 'Kore';
    
    // Устанавливаем заголовки для streaming (PCM audio) ДО начала чтения потока
    res.setHeader('Content-Type', 'audio/pcm');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Audio-Sample-Rate', '24000');
    res.setHeader('X-Audio-Channels', '1');
    res.setHeader('X-Audio-Bits-Per-Sample', '16');
    
    // КРИТИЧЕСКИ ВАЖНО: Отключаем буферизацию Express для настоящего real-time streaming
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) {
      res.flushHeaders();
    }
    
    // Получаем прокси для Gemini
    const proxies = parseGeminiProxies();
    const attempts = proxies.length ? proxies : ['__direct__'];
    
    // Пробуем каждый прокси
    for (const p of attempts) {
      try {
        // ПРИМЕЧАНИЕ: Gemini Live API использует WebSocket через специальный endpoint
        
        // Правильный URL для Gemini Live API через WebSocket (v1alpha)
        // ВАЖНО: Модель НЕ передается в URL, только в JSON-сообщении setup
        // Используется полное имя сервиса: google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent
        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${geminiApiKey}`;
        
        // Создаем WebSocket соединение
        // Используем уже импортированный WebSocket из 'ws'
        // ПРИМЕЧАНИЕ: Прокси для WebSocket требует специальной обработки (http-proxy-agent или socks-proxy-agent)
        // Пока используем прямое соединение, если прокси нужен - добавим позже
        const wsOptions: any = {};
        
        // Если есть прокси, пытаемся использовать его (требует установки http-proxy-agent)
        if (p !== '__direct__') {
          try {
            // Пробуем использовать http-proxy-agent для WebSocket прокси
            const { HttpsProxyAgent } = await import('https-proxy-agent');
            wsOptions.agent = new HttpsProxyAgent(p);
          } catch (e) {
            // Продолжаем без прокси
          }
        }
        
        const ws = new WebSocket(wsUrl, wsOptions);
        
        let totalAudioSize = 0;
        let chunkCount = 0;
        let hasAudio = false;
        let isConnected = false;
        let isComplete = false;
        let textSent = false; // Флаг, что текст уже отправлен
        
        // Функция проверки, что буфер не пустой
        // ВАЖНО: Gemini 2.0 не генерирует мусорную тишину, поэтому фильтр не нужен
        // Убрали всю логику isSilence и skippedBytes - она обрезала начало речи
        const isBufferValid = (buffer: Buffer): boolean => {
          if (!buffer || buffer.length === 0) return false;
          // Просто проверяем, что буфер не пустой
          return buffer.length > 0;
        };
        
        // Обработка сообщений от Gemini
        ws.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString('utf-8'));
            
            // ШАГ 2: Ожидание подтверждения настройки (setupComplete)
            // КРИТИЧЕСКИ ВАЖНО: НЕ отправляем данные до получения setupComplete
            if (message.setupComplete) {
              isConnected = true;
              
              // Отправляем текст ТОЛЬКО один раз после получения setupComplete
              if (!textSent) {
                textSent = true;
                
                // Отправляем текст для генерации в правильном формате Live API
                // КРИТИЧЕСКИ ВАЖНО: turnComplete: true ОБЯЗАТЕЛЕН для TTS - без него модель ждет и начинает генерацию с задержкой
                // КРИТИЧЕСКИ ВАЖНО: Google Gemini Realtime API требует camelCase, не snake_case!
                ws.send(JSON.stringify({
                  clientContent: {
                    turns: [{
                      role: "user",
                      parts: [{ text }]
                    }],
                    turnComplete: true // ОБЯЗАТЕЛЬНО для TTS - сигнализирует модели, что текст завершен и можно начинать генерацию
                  }
                }));
              }
              
              return;
            }
            
            // ШАГ 3: Получение аудио-чанков из serverContent.modelTurn
            // КРИТИЧЕСКИ ВАЖНО: Обрабатываем аудио ТОЛЬКО после получения setupComplete
            if (!isConnected) {
              return;
            }
            
            // ВАЖНО: Проверяем все возможные пути к аудио-данным
            if (message.serverContent) {
              // Проверяем modelTurn (основной путь)
              if (message.serverContent.modelTurn) {
                const modelTurn = message.serverContent.modelTurn;
                const parts = modelTurn.parts || [];
                
                for (const part of parts) {
                  if (part.inlineData && part.inlineData.data) {
                    // Это сырой Base64 аудио (обычно PCM 16кГц или 24кГц)
                    let audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                    
                    // ВАЖНО: Если количество байт нечетное, обрезаем последний байт
                    // readInt16LE требует четное количество байт (16-bit = 2 байта)
                    if (audioBuffer.length % 2 !== 0) {
                      audioBuffer = audioBuffer.slice(0, audioBuffer.length - 1);
                    }
                    
                    // Проверяем, что буфер не пустой
                    if (!isBufferValid(audioBuffer)) {
                      continue; // Пропускаем пустые буферы
                    }
                    
                    hasAudio = true;
                    totalAudioSize += audioBuffer.length;
                    chunkCount++;
                    
                    // Отправляем чанк сразу клиенту (настоящий real-time streaming)
                    res.write(audioBuffer);
                    
                    // Принудительно сбрасываем буфер
                    if (res.flush && typeof res.flush === 'function') {
                      res.flush();
                    }
                  }
                }
              }
              
              // Проверяем другие возможные пути к аудио (на случай, если формат изменился)
              // ВАЖНО: Проверяем только если еще не получили аудио через modelTurn
              if (!hasAudio && message.serverContent.parts) {
                const parts = Array.isArray(message.serverContent.parts) ? message.serverContent.parts : [];
                for (const part of parts) {
                  if (part.inlineData && part.inlineData.data) {
                    let audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                    
                    // ВАЖНО: Если количество байт нечетное, обрезаем последний байт
                    // readInt16LE требует четное количество байт (16-bit = 2 байта)
                    if (audioBuffer.length % 2 !== 0) {
                      audioBuffer = audioBuffer.slice(0, audioBuffer.length - 1);
                    }
                    
                    // Проверяем валидность буфера
                    if (!isBufferValid(audioBuffer)) {
                      continue;
                    }
                    
                    hasAudio = true;
                    totalAudioSize += audioBuffer.length;
                    chunkCount++;
                    res.write(audioBuffer);
                    if (res.flush && typeof res.flush === 'function') {
                      res.flush();
                    }
                  }
                }
              }
            }
            
            // Проверяем, завершен ли turn (завершение определяется через turnComplete)
            if (message.serverContent && message.serverContent.turnComplete) {
              isComplete = true;
              ws.close();
            }
    
  } catch (e) {
            // Игнорируем ошибки парсинга
          }
        });
        
        // Обработка ошибок WebSocket
        ws.on('error', (error) => {
          if (!isConnected && !hasAudio) {
            // Если еще не подключились и нет аудио, пробуем следующий прокси
            ws.close();
          }
        });
        
        // Обработка закрытия соединения
        ws.on('close', (code, reason) => {
          cleanup(); // Очищаем ключ из activeTtsStreams
          if (hasAudio) {
            res.end();
          }
        });
        
        // Ждем открытия соединения и отправляем setup
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket connection timeout'));
          }, 10000);
          
          ws.on('open', () => {
            // ШАГ 1: Отправка конфигурации (setup) для Live API
            // КРИТИЧЕСКИ ВАЖНО: Google Gemini Realtime API требует camelCase, не snake_case!
            ws.send(JSON.stringify({
              setup: {
                model: `models/${finalModelName}`,
                generationConfig: {
                  responseModalities: ["AUDIO"], // Указываем, что хотим аудио на выходе
                  speechConfig: {
                    voiceConfig: {
                      prebuiltVoiceConfig: {
                        voiceName: finalVoiceName // Puck, Charon, Kore, Fenrir, Aoede
                      }
                    }
                  }
                },
                systemInstruction: {
                  parts: [{
                    text: "Ты — профессиональный актер озвучивания. Твоя ЕДИНСТВЕННАЯ задача — ПРОЧИТАТЬ ПРЕДОСТАВЛЕННЫЙ ТЕКСТ СЛОВО В СЛОВО на РУССКОМ ЯЗЫКЕ максимально естественно, как живой человек. НЕ анализируй текст, НЕ комментируй его, НЕ отвечай на вопросы в тексте. Просто ОЗВУЧИВАЙ текст слово в слово. КРИТИЧЕСКИ ВАЖНО: Все цифры и числа читай ТОЛЬКО на русском языке (например, 123 читай как 'сто двадцать три', 5 как 'пять', а не 'five' или 'one two three'). КРИТИЧЕСКИ ВАЖНО: Знаки препинания (запятые, тире, точки, звездочки, дефисы и т.д.) НЕ ОЗВУЧИВАЙ как слова — используй их только для создания естественных пауз в речи. Используй естественные интонации, паузы и ритм речи. Избегай монотонности. Передавай эмоции через голос: таинственность — тише и медленнее, опасность — напряженнее, триумф — громче и увереннее. Читай так, будто рассказываешь историю другу."
                  }]
                }
              }
            }));
            
            clearTimeout(timeout);
            resolve();
          });
          
          ws.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        
        // Ждем завершения генерации (setupResponse и текст отправляются в обработчике message)
        await new Promise<void>((resolve) => {
          const completionTimeout = setTimeout(() => {
            if (!isComplete) {
              ws.close();
            }
            resolve();
          }, 120000); // 2 минуты таймаут
          
          // Сохраняем resolve для вызова в обработчиках
          const originalResolve = resolve;
          const checkComplete = () => {
            if (isComplete || !ws.readyState) {
              clearTimeout(completionTimeout);
              originalResolve();
            }
          };
          
          ws.on('close', () => {
            clearTimeout(completionTimeout);
            originalResolve();
          });
        });
        
        if (hasAudio) {
          cleanup(); // Очищаем ключ из activeTtsStreams
          return; // Успешно завершили
        }
        
      } catch (wsError: any) {
        cleanup(); // Очищаем ключ при ошибке
        // Пробуем следующий прокси
        continue;
      }
    }
    
    // Если WebSocket не сработал
    cleanup(); // Очищаем ключ из activeTtsStreams
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'stream_error', 
        message: 'Не удалось сгенерировать streaming аудио. Проверьте настройки API ключа.' 
      });
    }
    res.end();
    
  } catch (e) {
    cleanup(); // Очищаем ключ при ошибке
    console.error('[TTS-STREAM] TTS streaming endpoint error:', e);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'tts_error', details: String(e) });
    }
    res.end();
  }
});

// Тестовый эндпоинт для проверки работоспособности Gemini/Imagen API
app.get('/api/image/test-gemini', async (req, res) => {
  try {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    if (!geminiKey) {
      return res.status(400).json({ error: 'GEMINI_API_KEY not found in environment variables' });
    }
    
    const testPrompt = 'A simple test image: a red circle on white background';
    const testSize = '1024x1024';
    
    console.log('[IMG-TEST] Testing Gemini/Imagen API endpoints...');
    const result = await generateViaGemini(testPrompt, testSize, geminiKey);
    
    if (result) {
      return res.json({ 
        success: true, 
        message: 'Gemini/Imagen API работает! Изображение успешно сгенерировано.',
        imageSize: Math.round(result.length * 0.75),
        dataUrl: `data:image/png;base64,${result.slice(0, 100)}...` // Показываем только начало для проверки
      });
    } else {
      return res.status(502).json({ 
        success: false, 
        error: 'Все эндпоинты Gemini/Imagen вернули ошибку. Проверьте логи сервера для деталей.',
        hint: 'Убедитесь, что API ключ имеет права на генерацию изображений и что эндпоинты доступны.'
      });
    }
  } catch (e: any) {
    console.error('[IMG-TEST] Error:', e);
    return res.status(500).json({ error: 'test_failed', details: e?.message || String(e) });
  }
});

app.post('/api/image/generate', async (req, res) => {
  try {
    const promptRaw = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
    const width = Math.max(1, Number(req.body?.width || 1280));
    const height = Math.max(1, Number(req.body?.height || 720));
    const provider = typeof req.body?.provider === 'string' ? String(req.body.provider).toLowerCase() : '';
    if (!promptRaw.trim()) return res.status(400).json({ error: 'prompt_required' });

    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    if (!apiKey) {
      console.warn('[IMG] no OPENAI_API_KEY, skip generation');
      return res.status(200).json({ dataUrl: '' });
    }

    const client = createOpenAIClient(apiKey);
    let size = '1536x1024';
    if (width === height) size = '1024x1024';
    else if (width > height) size = '1536x1024';
    else size = '1024x1536';
    const guidance = 'Сгенерируй атмосферный реалистичный фон по описанию сцены для приключенческой ролевой игры. Без текста, без надписей, без людей крупным планом, без UI. Киношный свет, глубокая перспектива.';
    const fullPrompt = `${guidance}\n\nСцена: ${promptRaw}`.slice(0, 1800);
    console.log('[IMG] request', { size, providerReq: provider || 'auto', promptLen: fullPrompt.length, promptHead: fullPrompt.slice(0, 120) });
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    if (geminiKey && (provider === 'gemini' || !provider)) {
      try {
        console.log('[IMG] gemini try');
        const gB64 = await generateViaGemini(fullPrompt, size, geminiKey);
        if (gB64) {
          console.log('[IMG] gemini success', { bytes: Math.round(gB64.length * 0.75), size });
          return res.json({ dataUrl: `data:image/png;base64,${gB64}` });
        }
        if (provider === 'gemini') {
          console.warn('[IMG] gemini returned empty');
          return res.status(200).json({ dataUrl: '' });
        }
      } catch (e) {
        console.error('[IMG] gemini failed:', e);
        if (provider === 'gemini') return res.status(200).json({ dataUrl: '' });
      }
    }
    if (provider === 'gemini' && !geminiKey) {
      console.warn('[IMG] gemini key missing');
      return res.status(200).json({ dataUrl: '' });
    }
    try {
      const img = await client.images.generate({
        model: 'gpt-image-1',
        prompt: fullPrompt,
        size,
        quality: 'high',
      } as any);
      let b64 = img?.data?.[0]?.b64_json || '';
      const url = img?.data?.[0]?.url || '';
      if (!b64 && url) {
        try {
          const r = await undiciFetch(url);
          const buf = Buffer.from(await r.arrayBuffer());
          b64 = buf.toString('base64');
        } catch {}
      }
      if (!b64) return res.status(200).json({ dataUrl: '' });
      console.log('[IMG] success', { bytes: Math.round(b64.length * 0.75), size });
      return res.json({ dataUrl: `data:image/png;base64,${b64}` });
    } catch (e) {
      console.error('[IMG] failed:', e);
      const stabKey = process.env.STABILITY_API_KEY || process.env.STABILITY_KEY;
      if (stabKey) {
        try {
          let w = 1024; let h = 1024;
          if (size === '1536x1024') { w = 1024; h = 704; }
          else if (size === '1024x1536') { w = 704; h = 1024; }
          const b64 = await generateViaStability(fullPrompt, w, h, stabKey);
          if (b64) {
            console.log('[IMG] stability success', { bytes: Math.round(b64.length * 0.75), w, h });
            return res.json({ dataUrl: `data:image/png;base64,${b64}` });
          }
        } catch (e2) {
          console.error('[IMG] stability failed:', e2);
        }
      }
      return res.status(200).json({ dataUrl: '' });
    }
  } catch (e) {
    console.error('[IMG] error:', e);
    return res.status(500).json({ error: 'image_error' });
  }
});

async function generateViaStability(prompt: string, width: number, height: number, apiKey: string): Promise<string> {
  const endpoint = 'https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image';
  const body = {
    width,
    height,
    steps: 30,
    cfg_scale: 7,
    samples: 1,
    text_prompts: [
      { text: 'high quality, atmospheric, cinematic lighting, detailed environment, no text, no watermark, background only' },
      { text: prompt },
    ],
  } as any;
  const r = await undiciFetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'image/png',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`stability_bad_status_${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString('base64');
}

async function generateViaGemini(prompt: string, size: string, apiKey: string): Promise<string> {
  const geminiProxies = parseGeminiProxies();
  const openaiProxies = parseProxies();
  const attempts = geminiProxies.length ? geminiProxies : (openaiProxies.length ? openaiProxies : ['__direct__']);
  const [wStr, hStr] = size.split('x');
  const w = Number(wStr); const h = Number(hStr);

  // Список эндпоинтов для проверки (в порядке приоритета)
  // Примечание: Google Imagen через generativelanguage API может быть недоступен через API ключ
  // Пробуем разные варианты, включая альтернативные подходы
  const endpoints = [
    // Вариант 1: Imagen 3.0 через generativelanguage API (если доступен)
    {
      name: 'imagen-3.0-generate-001',
      url: 'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:generateImages',
      body: {
        prompt: { text: prompt },
        imageGenerationConfig: {
          numberOfImages: 1,
          aspectRatio: `${w}:${h}`,
          imageFormat: 'PNG'
        }
      },
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      extractBase64: (data: any) => {
        const gi = Array.isArray(data?.generatedImages) ? data.generatedImages[0] : null;
        return gi?.image?.base64 || gi?.image?.bytesBase64Encoded || gi?.bytesBase64Encoded || gi?.base64 || null;
      },
    },
    // Вариант 2: Старый эндпоинт images:generate (для обратной совместимости)
    {
      name: 'images:generate',
      url: 'https://generativelanguage.googleapis.com/v1beta/images:generate',
      body: {
        prompt: { text: prompt },
        imageGenerationConfig: {
          numberOfImages: 1,
          imageFormat: 'PNG'
        }
      },
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      extractBase64: (data: any) => {
        const gi = Array.isArray(data?.generatedImages) ? data.generatedImages[0] : null;
        return gi?.image?.base64 || gi?.image?.bytesBase64Encoded || gi?.bytesBase64Encoded || gi?.base64 || null;
      },
    },
    // Вариант 3: Попытка через Gemini API с другим форматом (если поддерживается)
    {
      name: 'gemini-pro-vision-generate',
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent?key=${apiKey}`,
      body: {
        contents: [{
          parts: [{
            text: `Generate an image: ${prompt}. Size: ${size}`
          }]
        }]
      },
      headers: { 'Content-Type': 'application/json' },
      extractBase64: (data: any) => {
        // Если Gemini вернет изображение в ответе
        const parts = data?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            return part.inlineData.data;
          }
        }
        return null;
      },
    },
  ];

  // Пробуем каждый эндпоинт
  for (const endpoint of endpoints) {
    if (!endpoint.url) continue; // Пропускаем если URL не определен
    
    for (const p of attempts) {
      try {
        const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
        console.log(`[IMG] gemini trying endpoint: ${endpoint.name} (proxy: ${p === '__direct__' ? 'direct' : 'proxy'})`);
        
        const r = await undiciFetch(endpoint.url, {
          method: 'POST',
          dispatcher,
          headers: endpoint.headers,
          body: JSON.stringify(endpoint.body),
        });
        
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          let errorBody: any = { error: 'Unknown error' };
          if (t) {
            try {
              errorBody = JSON.parse(t);
            } catch {
              errorBody = { error: t.slice(0, 200) };
            }
          }
          
          if (r.status === 404) {
            console.warn(`[IMG] gemini endpoint ${endpoint.name} returned 404 - эндпоинт не найден, пробуем следующий...`);
          } else if (r.status === 403) {
            console.warn(`[IMG] gemini endpoint ${endpoint.name} returned 403 - доступ запрещен, проверьте API ключ и права доступа`);
          } else if (r.status === 401) {
            console.warn(`[IMG] gemini endpoint ${endpoint.name} returned 401 - неверный API ключ`);
          } else {
            console.warn(`[IMG] gemini endpoint ${endpoint.name} returned ${r.status}:`, errorBody);
          }
          continue; // Пробуем следующий прокси или эндпоинт
        }
        
        const data = await r.json() as any;
        const b64a = endpoint.extractBase64(data);
        if (b64a) {
          console.log(`[IMG] gemini success via ${endpoint.name}, image size: ${Math.round(b64a.length * 0.75)} bytes`);
          return b64a;
        } else {
          console.warn(`[IMG] gemini endpoint ${endpoint.name} returned data but no base64 found. Response structure:`, JSON.stringify(data).slice(0, 300));
        }
      } catch (e: any) {
        console.warn(`[IMG] gemini endpoint ${endpoint.name} failed:`, e?.message || String(e));
      }
    }
  }
  
  console.warn('[IMG] gemini all endpoints failed');
  return '';
}

/**
 * УДАЛЕНО: Gemini API не предоставляет прямой синтез речи через generateSpeech endpoint
 * Все endpoint'ы возвращают 404, так как они не существуют
 * УДАЛЕНО: Теперь используется только Gemini для прямой генерации аудио
 * Эта функция больше не используется
 */
async function generateSpeechViaGemini_DEPRECATED(params: {
  text: string;
  apiKey: string;
  voice?: string;
  language?: string;
  emotion?: string;
  speed?: number;
}): Promise<Buffer | null> {
  const { text, apiKey, voice = 'default', language = 'ru-RU', emotion = 'neutral', speed = 1.0 } = params;
  
  try {
    // Используем стандартный формат Gemini API (как в generateContent)
    // Пробуем разные варианты endpoint'ов на основе официальной документации
    const proxies = parseGeminiProxies();
    const attempts = proxies.length ? proxies : ['__direct__'];
    const maxRetries = 2;
    
    // Пробуем реальные модели Gemini, которые могут поддерживать TTS
    // Согласно документации, TTS - это функция API, а не отдельная модель
    // Пробуем разные варианты endpoint'ов для реальных моделей
    const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
    
    const endpoints = [
      // Пробуем 1.5 Pro (как запросил пользователь)
      {
        name: 'gemini-1.5-pro-generateSpeech',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateSpeech',
        body: {
          input: { text },
          voiceConfig: {
            languageCode: language,
            name: voice,
            emotion: emotion,
            speed: speed
          },
          audioConfig: {
            audioEncoding: 'OGG_OPUS',
            sampleRateHertz: 24000
          }
        }
      },
      {
        name: 'gemini-1.5-flash-generateSpeech',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateSpeech',
        body: {
          input: { text },
          voiceConfig: {
            languageCode: language,
            name: voice,
            emotion: emotion,
            speed: speed
          },
          audioConfig: {
            audioEncoding: 'OGG_OPUS',
            sampleRateHertz: 24000
          }
        }
      },
      // Пробуем 2.5 Pro (текущая модель проекта)
      {
        name: 'gemini-2.5-pro-generateSpeech',
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateSpeech`,
        body: {
          input: { text },
          voiceConfig: {
            languageCode: language,
            name: voice,
            emotion: emotion,
            speed: speed
          },
          audioConfig: {
            audioEncoding: 'OGG_OPUS',
            sampleRateHertz: 24000
          }
        }
      },
      {
        name: 'gemini-2.5-flash-generateSpeech',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateSpeech',
        body: {
          input: { text },
          voiceConfig: {
            languageCode: language,
            name: voice,
            emotion: emotion,
            speed: speed
          },
          audioConfig: {
            audioEncoding: 'OGG_OPUS',
            sampleRateHertz: 24000
          }
        }
      },
      // Пробуем 2.0 Flash
      {
        name: 'gemini-2.0-flash-generateSpeech',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateSpeech',
        body: {
          input: { text },
          voiceConfig: {
            languageCode: language,
            name: voice,
            emotion: emotion,
            speed: speed
          },
          audioConfig: {
            audioEncoding: 'OGG_OPUS',
            sampleRateHertz: 24000
          }
        }
      }
    ];
    
    for (const endpoint of endpoints) {
      for (const p of attempts) {
        for (let retry = 0; retry < maxRetries; retry++) {
          try {
            if (retry > 0) {
              const delay = Math.min(1000 * Math.pow(2, retry - 1), 5000);
              console.log(`[GEMINI-TTS] Retry ${retry}/${maxRetries - 1} for ${endpoint.name} after ${delay}ms`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
            
            console.log(`[GEMINI-TTS] Trying ${endpoint.name} via ${p === '__direct__' ? 'direct' : 'proxy'}`);
            
            const response = await undiciFetch(endpoint.url, {
              method: 'POST',
              dispatcher,
              signal: controller.signal,
              headers: { 
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey
              },
              body: JSON.stringify(endpoint.body),
            });
            
            clearTimeout(timer);
            
            if (!response.ok) {
              const errorText = await response.text().catch(() => '');
              console.warn(`[GEMINI-TTS] ${endpoint.name} returned ${response.status}:`, errorText.slice(0, 200));
              
              // Если 404 или 400 - endpoint не существует, пробуем следующий
              if (response.status === 404 || response.status === 400) {
                break; // Переходим к следующему endpoint
              }
              
              // Для других ошибок - retry
              if (retry < maxRetries - 1) {
                continue;
              }
              break; // Переходим к следующему прокси
            }
            
            // Проверяем тип ответа
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('audio')) {
              // Прямой аудио ответ
              const audioBuffer = Buffer.from(await response.arrayBuffer());
              console.log(`[GEMINI-TTS] ✅ Success via ${endpoint.name}, audio size: ${audioBuffer.length} bytes`);
              return audioBuffer;
            } else {
              // JSON ответ от generateSpeech endpoint
              const json = await response.json().catch(() => null);
              
              // Проверяем стандартные поля для generateSpeech
              if (json?.audioContent) {
                const audioBuffer = Buffer.from(json.audioContent, 'base64');
                console.log(`[GEMINI-TTS] ✅ Success via ${endpoint.name}, audio size: ${audioBuffer.length} bytes`);
                return audioBuffer;
              }
              if (json?.audio) {
                const audioBuffer = Buffer.from(json.audio, 'base64');
                console.log(`[GEMINI-TTS] ✅ Success via ${endpoint.name}, audio size: ${audioBuffer.length} bytes`);
                return audioBuffer;
              }
              if (json?.data) {
                const audioBuffer = Buffer.from(json.data, 'base64');
                console.log(`[GEMINI-TTS] ✅ Success via ${endpoint.name}, audio size: ${audioBuffer.length} bytes`);
                return audioBuffer;
              }
              
              console.warn(`[GEMINI-TTS] ${endpoint.name} returned JSON but no audio field found. Response structure:`, JSON.stringify(json).slice(0, 500));
            }
          } catch (e: any) {
            if (e.name === 'AbortError' || e.message?.includes('timeout')) {
              console.warn(`[GEMINI-TTS] ${endpoint.name} timeout`);
              if (retry < maxRetries - 1) continue;
            } else {
              console.warn(`[GEMINI-TTS] ${endpoint.name} error:`, e?.message || String(e));
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[GEMINI-TTS] Fatal error:', e);
  }
  
  console.log('[GEMINI-TTS] All endpoints failed - no fallback available');
  return null;
}

/**
 * Генерирует текстовый ответ через Google Gemini (1.5 Pro/Flash или 2.0).
 * Адаптировано под ТЗ: расширенное окно контекста и D&D логика.
 */
async function generateViaGeminiText(params: {
  systemPrompt?: string;
  userPrompt: string;
  history?: Array<{ role: 'user' | 'model' | 'assistant'; content: string }>;
  apiKey: string;
  modelName?: string;
}): Promise<string> {
  const { systemPrompt, userPrompt, history = [], apiKey, modelName = 'gemini-2.5-pro' } = params; // ВСЕГДА используем gemini-2.5-pro
  
  const proxies = parseGeminiProxies();
  const attempts = proxies.length ? proxies : ['__direct__'];
  // Для импорта нужен больший таймаут, так как обрабатываются большие файлы (до 10 минут)
  const timeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 600000);
  const contents = history.map(h => ({
    role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
    parts: [{ text: h.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: userPrompt }] });

  const body: any = {
    contents,
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 32768,
    },
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  let lastErr: unknown = null;
  const maxRetries = 3;
  const retryableStatuses = [503, 429, 500, 502]; // Перегружен, слишком много запросов, внутренняя ошибка
  
  for (const p of attempts) {
    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        if (retry > 0) {
          const delay = Math.min(1000 * Math.pow(2, retry - 1), 10000); // Экспоненциальная задержка: 1s, 2s, 4s (макс 10s)
          console.log(`[GEMINI-TEXT] Retry ${retry}/${maxRetries - 1} after ${delay}ms delay`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(60000, timeoutMs));
        const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
        const r = await undiciFetch(url, {
          method: 'POST',
          dispatcher,
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
          body: JSON.stringify(body),
        });
        clearTimeout(timer);
        
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          let errorData: any = {};
          try {
            if (t) errorData = JSON.parse(t) || {};
          } catch {}
          const status = r.status;
          
          console.error('[GEMINI-TEXT] HTTP', status, t.slice(0, 200));
          
          // Если это retryable ошибка и есть попытки - повторяем
          if (retryableStatuses.includes(status) && retry < maxRetries - 1) {
            lastErr = errorData.error || t || r.statusText;
            continue; // Продолжаем retry
          }
          
          // Если не retryable или закончились попытки - переходим к следующему прокси
          lastErr = errorData.error || t || r.statusText;
          break; // Выходим из retry цикла, переходим к следующему прокси
        }
        
        const data = await r.json() as any;
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.map((p: any) => p?.text).filter(Boolean).join('\n').trim();
        if (text) return text;
        lastErr = 'empty_text';
        break; // Успешно получили ответ, но он пустой - не retry
      } catch (e) {
        lastErr = e;
        console.error('[GEMINI-TEXT] Error:', e);
        // Если это не последняя попытка и ошибка может быть временной - retry
        if (retry < maxRetries - 1 && (e instanceof Error && (e.message.includes('aborted') || e.message.includes('timeout')))) {
          continue; // Retry для таймаутов
        }
        break; // Выходим из retry цикла
      }
    }
  }
  throw lastErr || new Error('gemini_text_failed');
}

/**
 * Универсальная функция генерации ответа (Gemini -> OpenAI -> Fallback).
 * Реализует ТЗ по расширенной памяти для Gemini.
 */
async function generateChatCompletion(params: {
  systemPrompt: string;
  userPrompt: string;
  history?: Array<{ from: string; text: string }>;
}): Promise<{ text: string; provider: string }> {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
  const openaiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
  
  // ВСЕГДА используем Gemini 2.5 Pro для генерации текста (кроме случаев, когда явно указан OpenAI)
  // Прегенерация удалена - используем стандартный провайдер
  const preferOpenAI = false;

  // Сначала пробуем Gemini 2.5 Pro (если не указан явно OpenAI)
  if (geminiKey && !preferOpenAI) {
    try {
      // Для Gemini используем расширенную историю без обрезки (или с минимальной)
      const chatHistory = (params.history || []).map(h => ({
        role: (h.from === 'bot' ? 'model' : 'user') as any,
        content: h.text
      }));

      const text = await generateViaGeminiText({
        apiKey: geminiKey,
        systemPrompt: params.systemPrompt,
        userPrompt: params.userPrompt,
        history: chatHistory,
        modelName: 'gemini-2.5-pro' // ВСЕГДА используем gemini-2.5-pro
      });
      if (text) return { text, provider: 'gemini' };
    } catch (e: any) {
      const errorMsg = e?.error?.message || e?.message || String(e);
      const isOverloaded = errorMsg.includes('overloaded') || errorMsg.includes('503') || errorMsg.includes('UNAVAILABLE');
      const isQuotaError = errorMsg.includes('quota') || errorMsg.includes('Quota exceeded') || errorMsg.includes('generate_requests_per_model_per_day');
      console.error('[COMPLETION] Gemini failed:', errorMsg);
      
      // Если Gemini перегружен или квота превышена - переключаемся на OpenAI
      if ((isOverloaded || isQuotaError) && openaiKey) {
        console.log('[COMPLETION] Gemini overloaded/quota exceeded, switching to OpenAI');
      } else {
        if (openaiKey) {
          console.log('[COMPLETION] Trying OpenAI as fallback');
        }
      }
    }
  }

  // Если указано использовать OpenAI для прегенерации и есть ключ - используем его
  if (preferOpenAI && openaiKey) {
    try {
      const client = createOpenAIClient(openaiKey);
      const messages = [
        { role: 'system', content: params.systemPrompt },
        ...(params.history || []).slice(-15).map(h => ({
          role: h.from === 'bot' ? 'assistant' : 'user',
          content: h.text
        })),
        { role: 'user', content: params.userPrompt }
      ];
      const r = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.4,
        messages: messages as any,
      });
      const text = r.choices?.[0]?.message?.content || '';
      if (text) return { text, provider: 'openai' };
    } catch (e) {
      console.error('[COMPLETION] OpenAI failed:', e);
    }
  }

  // OpenAI используется только как fallback, если Gemini не сработал или явно указан preferOpenAI
  if (openaiKey && (preferOpenAI || !geminiKey)) {
    try {
      const client = createOpenAIClient(openaiKey);
      // Для OpenAI оставляем обрезку или стандартное поведение
      const messages = [
        { role: 'system', content: params.systemPrompt },
        ...(params.history || []).slice(-15).map(h => ({
          role: h.from === 'bot' ? 'assistant' : 'user',
          content: h.text
        })),
        { role: 'user', content: params.userPrompt }
      ];
      const r = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.4,
        messages: messages as any,
      });
      const text = r.choices?.[0]?.message?.content || '';
      if (text) return { text, provider: 'openai' };
    } catch (e) {
      console.error('[COMPLETION] OpenAI failed:', e);
    }
  }

  return { text: '', provider: 'none' };
}


async function generateDiceNarrative(prisma: ReturnType<typeof getPrisma>, gameId: string, context: string, outcomeText: string, rollValue?: number): Promise<{ text: string; fallback: boolean }> {
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { characters: true } }).catch(() => null);
  const playable = (game?.characters || []).filter((c: any) => c.isPlayable);
  const baseLines: string[] = [];
  if (game) {
    baseLines.push(`Игра: ${game.title}`);
    if (game.worldRules) baseLines.push(`Правила мира (сопоставляй с текущей сценой, не обобщай): ${game.worldRules}`);
    if (game.gameplayRules) baseLines.push(`Правила процесса (сопоставляй с текущей сценой, не обобщай): ${game.gameplayRules}`);
  }
  if (playable.length) {
    baseLines.push('Игровые персонажи D&D 5e:\n' + playable.map((p: any) => {
      const stats = `HP: ${p.hp}/${p.maxHp}, AC: ${p.ac}, STR:${p.str}, DEX:${p.dex}, CON:${p.con}, INT:${p.int}, WIS:${p.wis}, CHA:${p.cha}`;
      return `- ${p.name} (Ур.${p.level} ${p.class || 'Путешественник'}, ${p.race || 'Человек'}) — ${stats}. ${p.persona ? `Характер: ${p.persona}` : ''}`;
    }).join('\n'));
  }
  const sys = 'Ты — мастер (DM) приключения D&D 5e. Пиши атмосферно и кратко: 2–4 абзаца. ' +
      'Опирайся на правила 5-й редакции, характеристики персонажей и контекст сцены. ' +
      'Не добавляй новых объектов, если их нет в сценарии. ' +
      'Учитывай исход проверки d20: модификаторы, бонусы мастерства и сложность (DC). ' +
      'Если в сцене есть NPC — отыгрывай их согласно их persona. ' +
      'В конце каждого ответа дай 2–3 действия (1) ..., 2) ...). ' +
      'КРИТИЧЕСКИ ВАЖНО: НИКОГДА не упоминай конкретные значения бросков кубиков в тексте (например, "ваша инициатива (13)", "вы выбросили 9"). ' +
      'Описывай результат качественно (высокий/низкий, успех/неудача), но без конкретных чисел. ' +
      'Отвечай только текстом.';
  const user = [
    baseLines.length ? ('Контекст игры:\n' + baseLines.join('\n')) : '',
    context ? `Действие игрока: ${context}` : '',
    outcomeText ? `Исход проверки: ${outcomeText}` : '',
    rollValue !== undefined ? `КРИТИЧЕСКИ ВАЖНО: Результат броска кубика = ${rollValue}. Учитывай это значение для определения успеха/неудачи, но НЕ упоминай конкретное число в тексте. Описывай результат качественно (высокий/низкий, успех/неудача), без указания чисел.` : '',
    'Продолжи сцену согласно исходу. Опиши обнаруженное/последствия/альтернативы. В конце задай, что герой делает дальше.'
  ].filter(Boolean).join('\n\n');

  try {
    const { text } = await generateChatCompletion({
      systemPrompt: sys,
      userPrompt: user,
      history: []
    });
    if (text && text.trim()) return { text: text.trim(), fallback: false };
  } catch (e) {
    console.error('[NARRATIVE] AI generation failed:', e);
  }

  // Fallback на захардкоженные ответы
  const low = outcomeText.toLowerCase();
  const successText = 'Вы замечаете важную деталь: в стене едва виден шов, холодный поток воздуха указывает направление. За каменной плитой скрывается узкий проход. Что вы сделаете дальше?';
  const critSuccessText = 'Ваши действия идеальны: скрытый механизм щёлкает, плита мягко отъезжает, открывая проход с еле заметной голубой подсветкой. Внутри слышится дальний шёпот. Куда направитесь?';
  const partialText = 'Вы находите следы старого механизма, но он заедает. Дверь приоткрывается лишь на ладонь, из щели веет сыростью. Можно попытаться расширить проход или поискать иной способ. Что выберете?';
  const failText = 'Несмотря на усилия, стена кажется монолитной, а следы уходят в темноту. Где-то рядом скрипит камень — возможно, сработала ловушка, но вы успели отпрянуть. Как поступите?';
  const critFailText = 'Механизм срабатывает грубо: камни осыпаются, воздух свистит, где-то щёлкают зубцы. Вы едва избегаете травмы. Путь закрывается. Попробуете обойти или искать другой подход?';
  const pick = low.includes('критический успех') ? critSuccessText
    : low.includes('успех') ? successText
    : low.includes('частичный') ? partialText
    : low.includes('критический провал') ? critFailText
    : failText;
  return { text: pick, fallback: true };
}

/**
 * Читает текст из PDF файла
 */
async function readPdfText(pdfPath: string | null): Promise<string | null> {
  if (!pdfPath) {
    console.log(`[RAG] readPdfText: pdfPath is null`);
    return null;
  }
  
  try {
    // Если путь относительный (начинается с /uploads), преобразуем в абсолютный
    let absolutePath: string;
    if (pdfPath.startsWith('/uploads/pdfs/')) {
      // Путь вида /uploads/pdfs/filename.pdf
      absolutePath = path.join(PDF_DIR, pdfPath.replace('/uploads/pdfs/', ''));
    } else if (pdfPath.startsWith('/uploads/')) {
      // Путь вида /uploads/filename.pdf
      absolutePath = path.join(UPLOAD_DIR, pdfPath.replace('/uploads/', ''));
    } else {
      // Абсолютный путь
      absolutePath = pdfPath;
    }
    
    console.log(`[RAG] readPdfText: исходный путь=${pdfPath}, абсолютный путь=${absolutePath}`);
    
    if (!fs.existsSync(absolutePath)) {
      console.warn(`[RAG] PDF file not found: ${absolutePath} (исходный путь: ${pdfPath})`);
      return null;
    }
    
    const buffer = fs.readFileSync(absolutePath);
    console.log(`[RAG] readPdfText: файл найден, размер=${buffer.length} байт`);
    const parsed = await pdfParse(buffer).catch(() => null);
    if (parsed && parsed.text) {
      const textLength = (parsed.text || '').replace(/\r/g, '\n').length;
      console.log(`[RAG] readPdfText: PDF распарсен, текст=${textLength} символов`);
      return (parsed.text || '').replace(/\r/g, '\n');
    }
    console.warn(`[RAG] readPdfText: PDF распарсен, но текст пустой`);
    return null;
  } catch (e) {
    console.error(`[RAG] Failed to read PDF ${pdfPath}:`, e);
    return null;
  }
}

/**
 * Разбивает правила на чанки и индексирует их для RAG
 * Теперь читает из PDF файлов, а не из БД
 * ДВА ФАЙЛА: rulesPdfPath (правила игры) и scenarioPdfPath (сценарий)
 */
async function indexRulesForRAG(prisma: ReturnType<typeof getPrisma>, gameId: string, rulesPdfPath: string | null, scenarioPdfPath: string | null = null): Promise<void> {
  const startTime = Date.now(); // Время начала индексации для подсчета общего времени
  try {
    console.log(`[RAG-INDEX] 🚀 Начало индексации RAG для игры ${gameId}`);
    console.log(`[RAG-INDEX] 📄 Файлы: rules=${rulesPdfPath ? 'да' : 'нет'}, scenario=${scenarioPdfPath ? 'да' : 'нет'}`);
    
    // Удаляем старые чанки для этой игры
    const deletedCount = await prisma.ruleChunk.deleteMany({ where: { gameId } });
    if (deletedCount.count > 0) {
      console.log(`[RAG-INDEX] 🗑️ Удалено старых чанков: ${deletedCount.count}`);
    }
    
    // Читаем текст из PDF файлов (ПРИОРИТЕТ: сначала сценарий!)
    const scenarioFull = await readPdfText(scenarioPdfPath);
    
    // УПРОЩЕНО: Один файл правил читаем один раз и используем для обоих типов чанков (worldRules и gameplayRules)
    const rulesFull = await readPdfText(rulesPdfPath);
    const worldRulesFull = rulesFull;
    const gameplayRulesFull = rulesFull;
    
    if (scenarioFull) {
      console.log(`[RAG-INDEX] 📖 СЦЕНАРИЙ (приоритет): ${scenarioFull.length.toLocaleString()} символов`);
    }
    if (worldRulesFull) {
      console.log(`[RAG-INDEX] 📖 Правила мира: ${worldRulesFull.length.toLocaleString()} символов`);
    }
    if (gameplayRulesFull) {
      console.log(`[RAG-INDEX] 📖 Правила процесса: ${gameplayRulesFull.length.toLocaleString()} символов`);
    }
    
    const chunkSize = 10000; // Размер чанка: ~10K символов (оптимально для семантического поиска)
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    
    // ОЦЕНКА ВРЕМЕНИ ИНДЕКСАЦИИ
    const estimatedScenarioChunks = scenarioFull ? Math.ceil(scenarioFull.length / chunkSize) : 0;
    const estimatedWorldChunks = worldRulesFull ? Math.ceil(worldRulesFull.length / chunkSize) : 0;
    const estimatedGameplayChunks = gameplayRulesFull ? Math.ceil(gameplayRulesFull.length / chunkSize) : 0;
    const totalEstimatedChunks = estimatedScenarioChunks + estimatedWorldChunks + estimatedGameplayChunks;
    
    // Средняя скорость: ~300-500мс на чанк (включая создание резюме через Gemini API)
    const avgTimePerChunk = geminiKey ? 400 : 50; // Если есть Gemini API - медленнее из-за создания резюме
    const estimatedTimeMs = totalEstimatedChunks * avgTimePerChunk;
    const estimatedTimeSec = Math.ceil(estimatedTimeMs / 1000);
    const estimatedTimeMin = Math.floor(estimatedTimeSec / 60);
    const estimatedTimeSecRemainder = estimatedTimeSec % 60;
    
    console.log(`[RAG-INDEX] ⏱️ ========== ОЦЕНКА ВРЕМЕНИ ==========`);
    console.log(`[RAG-INDEX] 📊 Ожидаемое количество чанков: ${totalEstimatedChunks} (scenario: ${estimatedScenarioChunks}, worldRules: ${estimatedWorldChunks}, gameplayRules: ${estimatedGameplayChunks})`);
    if (geminiKey) {
      console.log(`[RAG-INDEX] 🤖 Режим: с Gemini API (создание резюме для каждого чанка)`);
      console.log(`[RAG-INDEX] ⏱️ ОЦЕНОЧНОЕ ВРЕМЯ: ~${estimatedTimeMin > 0 ? `${estimatedTimeMin}мин ${estimatedTimeSecRemainder}сек` : `${estimatedTimeSec}сек`} (${estimatedTimeMs.toLocaleString()}мс)`);
      console.log(`[RAG-INDEX] 💡 Скорость: ~${avgTimePerChunk}мс/чанк (зависит от скорости Gemini API)`);
    } else {
      console.log(`[RAG-INDEX] ⚡ Режим: без Gemini API (только ключевые слова, без резюме)`);
      console.log(`[RAG-INDEX] ⏱️ ОЦЕНОЧНОЕ ВРЕМЯ: ~${estimatedTimeSec}сек (${estimatedTimeMs.toLocaleString()}мс)`);
      console.log(`[RAG-INDEX] 💡 Скорость: ~${avgTimePerChunk}мс/чанк`);
    }
    console.log(`[RAG-INDEX] ⏱️ ====================================`);
    
    let totalChunksCreated = 0;
    let scenarioChunksCount = 0;
    let worldChunksCount = 0;
    let gameplayChunksCount = 0;
    
    // КРИТИЧЕСКИ ВАЖНО: Сначала индексируем СЦЕНАРИЙ (приоритет!)
    if (scenarioFull && scenarioFull.length > 0) {
      const chunks: string[] = [];
      for (let i = 0; i < scenarioFull.length; i += chunkSize) {
        chunks.push(scenarioFull.slice(i, i + chunkSize));
      }
      
      console.log(`[RAG-INDEX] 📦 СЦЕНАРИЙ (приоритет): разбито на ${chunks.length} чанков по ~${chunkSize.toLocaleString()} символов`);
      const scenarioIndexStart = Date.now();
      
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunkStart = Date.now();
        const chunk = chunks[idx];
        const keywords = extractKeywords(chunk);
        let summary = chunk.slice(0, 500);
        
        if (geminiKey && chunk.length > 200) {
          try {
            const summaryStart = Date.now();
            const summaryResult = await generateChatCompletion({
              systemPrompt: 'Ты помощник, который создает краткие резюме частей сценария игры для семантического поиска.',
              userPrompt: `Создай краткое резюме (максимум 200 символов) этого фрагмента СЦЕНАРИЯ:\n\n${chunk.slice(0, 5000)}`,
              history: []
            });
            const summaryTime = Date.now() - summaryStart;
            if (summaryResult?.text) {
              summary = summaryResult.text.trim().slice(0, 500);
            }
            if ((idx + 1) % 5 === 0) {
              console.log(`[RAG-INDEX] ⏳ СЦЕНАРИЙ: обработано ${idx + 1}/${chunks.length} чанков (резюме: ${summaryTime}мс)`);
            }
          } catch (e) {
            console.warn(`[RAG-INDEX] ⚠️ Ошибка создания резюме для чанка сценария ${idx + 1}:`, e);
          }
        }
        
        await prisma.ruleChunk.create({
          data: {
            gameId,
            chunkType: 'scenario',
            chunkIndex: idx,
            content: chunk,
            keywords,
            summary
          }
        });
        totalChunksCreated++;
        scenarioChunksCount++;
        const chunkTime = Date.now() - chunkStart;
        const elapsed = Date.now() - scenarioIndexStart;
        const avgTime = Math.round(elapsed / (idx + 1));
        const remaining = Math.max(0, chunks.length - (idx + 1));
        const estimatedRemaining = Math.round(remaining * avgTime);
        const progressPercent = Math.round(((idx + 1) / chunks.length) * 100);
        
        if ((idx + 1) % 10 === 0 || idx === chunks.length - 1) {
          const remainingSec = Math.ceil(estimatedRemaining / 1000);
          const remainingMin = Math.floor(remainingSec / 60);
          const remainingSecRemainder = remainingSec % 60;
          const remainingStr = remainingMin > 0 ? `${remainingMin}мин ${remainingSecRemainder}сек` : `${remainingSec}сек`;
          console.log(`[RAG-INDEX] ✅ СЦЕНАРИЙ: ${idx + 1}/${chunks.length} (${progressPercent}%) | Средняя скорость: ${avgTime}мс/чанк | Осталось: ~${remainingStr}`);
        }
      }
      const scenarioIndexTime = Date.now() - scenarioIndexStart;
      console.log(`[RAG-INDEX] ✅ СЦЕНАРИЙ: создано ${chunks.length} чанков за ${scenarioIndexTime}мс (${Math.round(scenarioIndexTime / chunks.length)}мс/чанк)`);
    }
    
    // Обрабатываем правила мира (вспомогательный контекст)
    if (worldRulesFull && worldRulesFull.length > 0) {
      const chunks: string[] = [];
      for (let i = 0; i < worldRulesFull.length; i += chunkSize) {
        chunks.push(worldRulesFull.slice(i, i + chunkSize));
      }
      
      console.log(`[RAG-INDEX] 📦 Правила мира: разбито на ${chunks.length} чанков по ~${chunkSize.toLocaleString()} символов`);
      const worldIndexStart = Date.now();
      
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunkStart = Date.now();
        const chunk = chunks[idx];
        // Извлекаем ключевые слова из чанка (локации, персонажи, механики)
        const keywords = extractKeywords(chunk);
        // Создаем краткое резюме для семантического поиска
        let summary = chunk.slice(0, 500); // Fallback: первые 500 символов
        
        if (geminiKey && chunk.length > 200) {
          try {
            const summaryStart = Date.now();
            const summaryResult = await generateChatCompletion({
              systemPrompt: 'Ты помощник, который создает краткие резюме частей правил игры для семантического поиска.',
              userPrompt: `Создай краткое резюме (максимум 200 символов) этого фрагмента правил мира:\n\n${chunk.slice(0, 5000)}`,
              history: []
            });
            const summaryTime = Date.now() - summaryStart;
            if (summaryResult?.text) {
              summary = summaryResult.text.trim().slice(0, 500);
            }
            if ((idx + 1) % 5 === 0) {
              console.log(`[RAG-INDEX] ⏳ Правила мира: обработано ${idx + 1}/${chunks.length} чанков (резюме: ${summaryTime}мс)`);
            }
          } catch (e) {
            console.warn(`[RAG-INDEX] ⚠️ Ошибка создания резюме для чанка ${idx + 1}:`, e);
          }
        }
        
        await prisma.ruleChunk.create({
          data: {
            gameId,
            chunkType: 'worldRules',
            chunkIndex: idx,
            content: chunk,
            keywords,
            summary
          }
        });
        totalChunksCreated++;
        worldChunksCount++;
        const chunkTime = Date.now() - chunkStart;
        const elapsed = Date.now() - worldIndexStart;
        const avgTime = Math.round(elapsed / (idx + 1));
        const remaining = Math.max(0, chunks.length - (idx + 1));
        const estimatedRemaining = Math.round(remaining * avgTime);
        const progressPercent = Math.round(((idx + 1) / chunks.length) * 100);
        
        if ((idx + 1) % 10 === 0 || idx === chunks.length - 1) {
          const remainingSec = Math.ceil(estimatedRemaining / 1000);
          const remainingMin = Math.floor(remainingSec / 60);
          const remainingSecRemainder = remainingSec % 60;
          const remainingStr = remainingMin > 0 ? `${remainingMin}мин ${remainingSecRemainder}сек` : `${remainingSec}сек`;
          console.log(`[RAG-INDEX] ✅ Правила мира: ${idx + 1}/${chunks.length} (${progressPercent}%) | Средняя скорость: ${avgTime}мс/чанк | Осталось: ~${remainingStr}`);
        }
      }
      const worldIndexTime = Date.now() - worldIndexStart;
      console.log(`[RAG-INDEX] ✅ Правила мира: создано ${chunks.length} чанков за ${worldIndexTime}мс (${Math.round(worldIndexTime / chunks.length)}мс/чанк)`);
    }
    
    // Обрабатываем правила игрового процесса
    if (gameplayRulesFull && gameplayRulesFull.length > 0) {
      const chunks: string[] = [];
      for (let i = 0; i < gameplayRulesFull.length; i += chunkSize) {
        chunks.push(gameplayRulesFull.slice(i, i + chunkSize));
      }
      
      console.log(`[RAG-INDEX] 📦 Правила процесса: разбито на ${chunks.length} чанков по ~${chunkSize.toLocaleString()} символов`);
      const gameplayIndexStart = Date.now();
      
      for (let idx = 0; idx < chunks.length; idx++) {
        const chunkStart = Date.now();
        const chunk = chunks[idx];
        const keywords = extractKeywords(chunk);
        let summary = chunk.slice(0, 500);
        
        if (geminiKey && chunk.length > 200) {
          try {
            const summaryStart = Date.now();
            const summaryResult = await generateChatCompletion({
              systemPrompt: 'Ты помощник, который создает краткие резюме частей правил игры для семантического поиска.',
              userPrompt: `Создай краткое резюме (максимум 200 символов) этого фрагмента правил игрового процесса:\n\n${chunk.slice(0, 5000)}`,
              history: []
            });
            const summaryTime = Date.now() - summaryStart;
            if (summaryResult?.text) {
              summary = summaryResult.text.trim().slice(0, 500);
            }
            if ((idx + 1) % 5 === 0) {
              console.log(`[RAG-INDEX] ⏳ Правила процесса: обработано ${idx + 1}/${chunks.length} чанков (резюме: ${summaryTime}мс)`);
            }
          } catch (e) {
            console.warn(`[RAG-INDEX] ⚠️ Ошибка создания резюме для чанка ${idx + 1}:`, e);
          }
        }
        
        await prisma.ruleChunk.create({
          data: {
            gameId,
            chunkType: 'gameplayRules',
            chunkIndex: idx,
            content: chunk,
            keywords,
            summary
          }
        });
        totalChunksCreated++;
        gameplayChunksCount++;
        const chunkTime = Date.now() - chunkStart;
        const elapsed = Date.now() - gameplayIndexStart;
        const avgTime = Math.round(elapsed / (idx + 1));
        const remaining = Math.max(0, chunks.length - (idx + 1));
        const estimatedRemaining = Math.round(remaining * avgTime);
        const progressPercent = Math.round(((idx + 1) / chunks.length) * 100);
        
        if ((idx + 1) % 10 === 0 || idx === chunks.length - 1) {
          const remainingSec = Math.ceil(estimatedRemaining / 1000);
          const remainingMin = Math.floor(remainingSec / 60);
          const remainingSecRemainder = remainingSec % 60;
          const remainingStr = remainingMin > 0 ? `${remainingMin}мин ${remainingSecRemainder}сек` : `${remainingSec}сек`;
          console.log(`[RAG-INDEX] ✅ Правила процесса: ${idx + 1}/${chunks.length} (${progressPercent}%) | Средняя скорость: ${avgTime}мс/чанк | Осталось: ~${remainingStr}`);
        }
      }
      const gameplayIndexTime = Date.now() - gameplayIndexStart;
      console.log(`[RAG-INDEX] ✅ Правила процесса: создано ${chunks.length} чанков за ${gameplayIndexTime}мс (${Math.round(gameplayIndexTime / chunks.length)}мс/чанк)`);
    }
    
    const totalTime = Date.now() - startTime;
    const finalCount = await prisma.ruleChunk.count({ where: { gameId } });
    console.log(`[RAG-INDEX] 🎉 ========== ИНДЕКСАЦИЯ ЗАВЕРШЕНА ==========`);
    console.log(`[RAG-INDEX] 📊 Итого: ${finalCount} чанков (scenario: ${scenarioChunksCount}, worldRules: ${worldChunksCount}, gameplayRules: ${gameplayChunksCount})`);
    console.log(`[RAG-INDEX] ⏱️ Время индексации: ${totalTime}мс (${(totalTime / 1000).toFixed(1)}сек)`);
    console.log(`[RAG-INDEX] 📈 Скорость: ${finalCount > 0 ? Math.round(totalTime / finalCount) : 0}мс/чанк`);
  } catch (e) {
    console.error('[RAG] Failed to index rules:', e);
  }
}

/**
 * Извлекает ключевые слова из текста (локации, персонажи, механики)
 */
function extractKeywords(text: string): string[] {
  const keywords: Set<string> = new Set();
  const lowerText = text.toLowerCase();
  
  // Паттерны для извлечения ключевых слов
  const patterns = [
    // Локации (после слов "в", "на", "под", "над")
    /\b(?:в|на|под|над|около|возле|у)\s+([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+)*)/g,
    // Персонажи (после слов "персонаж", "NPC", "враг", "союзник")
    /\b(?:персонаж|NPC|враг|союзник|маг|воин|жрец|вор|бард|друид|паладин|рейнджер|монах|колдун|волшебник|жрец|варвар|боец|мастер|игрок)\s+([А-ЯЁ][а-яё]+)/g,
    // Механики (проверки, броски, урон)
    /\b(?:проверка|бросок|урон|лечение|состояние|эффект|способность|заклинание|оружие|броня|AC|HP|STR|DEX|CON|INT|WIS|CHA|d20|d4|d6|d8|d10|d12|d100)\b/gi,
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(lowerText)) !== null) {
      const keyword = match[1] || match[0];
      if (keyword && keyword.length > 2 && keyword.length < 50) {
        keywords.add(keyword.toLowerCase());
      }
    }
  }
  
  return Array.from(keywords).slice(0, 20); // Максимум 20 ключевых слов
}

/**
 * Анализирует структуру игры и планирует прогрессию через локации на основе сценария
 */
async function analyzeAndPlanGameProgression(
  prisma: ReturnType<typeof getPrisma>,
  gameId: string,
  sessionId: string
): Promise<void> {
  try {
    console.log(`[GAME-PLAN] 🎯 Начало анализа и планирования прогрессии для игры ${gameId}`);
    
    // Получаем все локации игры с их выходами
    const locations = await prisma.location.findMany({
      where: { gameId },
      orderBy: { order: 'asc' },
      include: { exits: true }
    });
    
    if (locations.length === 0) {
      console.log(`[GAME-PLAN] ⚠️ Нет локаций для планирования`);
      return;
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Получаем scenarioPdfPath из игры для чтения сценария напрямую
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { scenarioPdfPath: true }
    });
    
    let scenarioText = '';
    
    // Сначала пытаемся получить чанки из RAG
    let scenarioChunks = await prisma.ruleChunk.findMany({
      where: { gameId, chunkType: 'scenario' },
      orderBy: { chunkIndex: 'asc' }
    });
    
    if (scenarioChunks.length > 0) {
      // Используем чанки из RAG
      scenarioText = scenarioChunks.map(c => c.content).join('\n\n');
      console.log(`[GAME-PLAN] ✅ Используем чанки сценария из RAG: ${scenarioChunks.length} чанков`);
    } else if (game?.scenarioPdfPath) {
      // Если чанков нет, но есть scenarioPdfPath - читаем напрямую из PDF
      console.log(`[GAME-PLAN] ⏳ Чанки сценария еще не готовы, читаем напрямую из PDF: ${game.scenarioPdfPath}`);
      const pdfText = await readPdfText(game.scenarioPdfPath);
      if (pdfText) {
        scenarioText = pdfText;
        console.log(`[GAME-PLAN] ✅ Сценарий прочитан из PDF: ${scenarioText.length.toLocaleString()} символов`);
      } else {
        console.log(`[GAME-PLAN] ⚠️ Не удалось прочитать сценарий из PDF: ${game.scenarioPdfPath}`);
        // Ждем завершения индексации RAG (если она еще идет)
        const maxWaitTime = 30000; // 30 секунд
        const checkInterval = 2000; // 2 секунды
        const startWait = Date.now();
        
        while (scenarioChunks.length === 0 && (Date.now() - startWait) < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          scenarioChunks = await prisma.ruleChunk.findMany({
            where: { gameId, chunkType: 'scenario' },
            orderBy: { chunkIndex: 'asc' }
          });
          
          if (scenarioChunks.length > 0) {
            scenarioText = scenarioChunks.map(c => c.content).join('\n\n');
            console.log(`[GAME-PLAN] ✅ Чанки сценария готовы: ${scenarioChunks.length} чанков найдено`);
            break;
          }
        }
      }
    } else {
      // Нет ни чанков, ни PDF - ждем индексации
      console.log(`[GAME-PLAN] ⏳ Чанки сценария еще не готовы, ждем завершения индексации RAG...`);
      
      const maxWaitTime = 30000; // 30 секунд
      const checkInterval = 2000; // 2 секунды
      const startWait = Date.now();
      
      while (scenarioChunks.length === 0 && (Date.now() - startWait) < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        scenarioChunks = await prisma.ruleChunk.findMany({
          where: { gameId, chunkType: 'scenario' },
          orderBy: { chunkIndex: 'asc' }
        });
        
        if (scenarioChunks.length > 0) {
          scenarioText = scenarioChunks.map(c => c.content).join('\n\n');
          console.log(`[GAME-PLAN] ✅ Чанки сценария готовы: ${scenarioChunks.length} чанков найдено`);
          break;
        }
      }
    }
    
    if (!scenarioText || scenarioText.length === 0) {
      console.log(`[GAME-PLAN] ⚠️ Нет чанков сценария для анализа (возможно, индексация еще не завершена или сценарий не был загружен)`);
      console.log(`[GAME-PLAN] 💡 Планирование будет запущено автоматически после завершения индексации RAG`);
      return;
    }
    
    // Формируем структуру локаций для анализа
    const locationsStructure = locations.map(loc => ({
      id: loc.id,
      order: loc.order,
      title: loc.title,
      description: loc.description || '',
      rulesPrompt: loc.rulesPrompt || '',
      exits: loc.exits.map(exit => ({
        id: exit.id,
        type: exit.type,
        buttonText: exit.buttonText || '',
        triggerText: exit.triggerText || '',
        targetLocationId: exit.targetLocationId || null,
        isGameOver: exit.isGameOver
      }))
    }));
    
    // Создаем карту переходов между локациями
    const locationMap = new Map<string, typeof locationsStructure[0]>();
    locationsStructure.forEach(loc => locationMap.set(loc.id, loc));
    
    // Формируем промпт для анализа и планирования
    const analysisPrompt = `Проанализируй структуру игры и создай план прогрессии через локации на основе сценария.

СТРУКТУРА ЛОКАЦИЙ:
${locationsStructure.map((loc, idx) => {
  const targetLocations = loc.exits
    .filter(e => e.targetLocationId && !e.isGameOver)
    .map(e => {
      const target = locationMap.get(e.targetLocationId!);
      return target ? `→ "${target.title}" (ID: ${e.targetLocationId})` : null;
    })
    .filter(Boolean)
    .join(', ');
  
  return `${idx + 1}. "${loc.title}" (ID: ${loc.id}, порядок: ${loc.order})
   Описание: ${loc.description || loc.rulesPrompt || 'Нет описания'}
   Выходы: ${targetLocations || 'Нет выходов'}
   Типы выходов: ${loc.exits.map(e => `${e.type}${e.buttonText ? ` ("${e.buttonText}")` : ''}${e.triggerText ? ` ("${e.triggerText}")` : ''}`).join(', ') || 'Нет'}`;
}).join('\n\n')}

СЦЕНАРИЙ ИГРЫ:
${scenarioText.slice(0, 50000)}${scenarioText.length > 50000 ? '\n\n[... остальной текст сценария ...]' : ''}

ЗАДАЧА:
Проанализируй сценарий и создай детальный план прогрессии для каждой локации. Для каждой локации определи:
1. Количество сцен, которые должны произойти в этой локации (на основе сценария)
2. Цели и задачи, которые должны быть выполнены в этой локации
3. Варианты выбора и их влияние на прогрессию
4. Последовательность переходов между локациями
5. Ключевые события и моменты, которые должны произойти

Верни результат в формате JSON:
{
  "locations": [
    {
      "locationId": "ID локации",
      "locationTitle": "Название локации",
      "estimatedScenes": число, // примерное количество сцен в локации
      "goals": ["цель 1", "цель 2"], // цели и задачи локации
      "keyEvents": ["событие 1", "событие 2"], // ключевые события
      "sceneProgression": [
        {
          "sceneNumber": 1,
          "description": "описание сцены",
          "expectedChoices": ["вариант 1", "вариант 2"], // ожидаемые варианты выбора
          "leadsToLocationId": "ID следующей локации или null"
        }
      ],
      "transitions": [
        {
          "fromExitId": "ID выхода",
          "toLocationId": "ID целевой локации",
          "toLocationTitle": "Название целевой локации",
          "requiredProgress": "описание прогресса для перехода"
        }
      ]
    }
  ],
  "overallProgression": {
    "startLocationId": "ID стартовой локации",
    "endLocationIds": ["ID финальных локаций"],
    "criticalPath": ["ID локации 1", "ID локации 2"], // критический путь прохождения
    "optionalLocations": ["ID опциональных локаций"] // опциональные локации
  }
}`;

    // Вызываем Gemini для анализа и планирования
    const planResult = await generateChatCompletion({
      systemPrompt: 'Ты опытный мастер D&D, который анализирует структуру игры и планирует прогрессию через локации на основе сценария. Твоя задача - создать детальный план прогрессии, который поможет ИИ вести игру точно по сценарию.',
      userPrompt: analysisPrompt,
      history: []
    });
    
    // Парсим результат
    let plan: any = null;
    try {
      // Извлекаем JSON из ответа
      const jsonMatch = planResult.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        plan = JSON.parse(jsonMatch[0]);
      } else {
        console.error('[GAME-PLAN] ❌ Не удалось найти JSON в ответе Gemini');
        return;
      }
    } catch (e) {
      console.error('[GAME-PLAN] ❌ Ошибка парсинга плана:', e);
      console.error('[GAME-PLAN] Ответ Gemini:', planResult.text.slice(0, 500));
      return;
    }
    
    // Сохраняем план в состояние сессии
    const session = await prisma.gameSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      console.error(`[GAME-PLAN] ❌ Сессия ${sessionId} не найдена`);
      return;
    }
    
    const state = (session.state as any) || {};
    state.gameProgressionPlan = plan;
    state.gameProgressionPlanGeneratedAt = new Date().toISOString();
    
    await prisma.gameSession.update({
      where: { id: sessionId },
      data: { state }
    });
    
    console.log(`[GAME-PLAN] ✅ План прогрессии создан и сохранен для сессии ${sessionId}`);
    console.log(`[GAME-PLAN] 📊 Локаций в плане: ${plan?.locations?.length || 0}`);
    
  } catch (e) {
    console.error('[GAME-PLAN] ❌ Ошибка анализа и планирования прогрессии:', e);
  }
}

/**
 * Находит релевантные чанки правил на основе текущей сцены (RAG)
 */
async function findRelevantRuleChunks(
  prisma: ReturnType<typeof getPrisma>,
  gameId: string,
  sceneContext: { locationTitle?: string; locationDescription?: string; npcNames?: string[]; characterNames?: string[] }
): Promise<{ scenario: string; worldRules: string; gameplayRules: string }> {
  const searchStart = Date.now();
  try {
    const searchTerms: string[] = [];
    
    // Добавляем ключевые слова из контекста сцены
    if (sceneContext.locationTitle) {
      searchTerms.push(sceneContext.locationTitle.toLowerCase());
      // Извлекаем отдельные слова из названия локации
      sceneContext.locationTitle.split(/\s+/).forEach(word => {
        if (word.length > 3) searchTerms.push(word.toLowerCase());
      });
    }
    
    if (sceneContext.locationDescription) {
      // Извлекаем ключевые слова из описания локации
      const descKeywords = extractKeywords(sceneContext.locationDescription);
      searchTerms.push(...descKeywords.slice(0, 10));
    }
    
    if (sceneContext.npcNames) {
      sceneContext.npcNames.forEach(name => {
        searchTerms.push(name.toLowerCase());
        name.split(/\s+/).forEach(word => {
          if (word.length > 2) searchTerms.push(word.toLowerCase());
        });
      });
    }
    
    if (sceneContext.characterNames) {
      sceneContext.characterNames.forEach(name => {
        searchTerms.push(name.toLowerCase());
      });
    }
    
    // Ищем релевантные чанки по ключевым словам
    const dbStart = Date.now();
    const allChunks = await prisma.ruleChunk.findMany({
      where: { gameId },
      orderBy: { chunkIndex: 'asc' }
    });
    const dbTime = Date.now() - dbStart;
    
    if (allChunks.length === 0) {
      return { scenario: '', worldRules: '', gameplayRules: '' };
    }
    
    const scenarioChunks = allChunks.filter(c => c.chunkType === 'scenario');
    const worldChunks = allChunks.filter(c => c.chunkType === 'worldRules');
    const gameplayChunks = allChunks.filter(c => c.chunkType === 'gameplayRules');
    
    // Оцениваем релевантность каждого чанка
    const scoreStart = Date.now();
    const scoredChunks = allChunks.map(chunk => {
      let score = 0;
      const chunkText = (chunk.content + ' ' + (chunk.summary || '') + ' ' + chunk.keywords.join(' ')).toLowerCase();
      
      // Подсчитываем совпадения ключевых слов
      for (const term of searchTerms) {
        if (chunkText.includes(term)) {
          score += term.length; // Более длинные совпадения дают больше очков
        }
      }
      
      // Бонус за совпадения в keywords
      for (const keyword of chunk.keywords) {
        if (searchTerms.includes(keyword)) {
          score += 10;
        }
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Сценарий имеет ПРИОРИТЕТ - добавляем бонус к очкам
      if (chunk.chunkType === 'scenario') {
        score += 50; // Большой бонус для сценария
      }
      
      return { chunk, score };
    });
    
    // Сортируем по релевантности и берем топ-10 чанков сценария (приоритет!), топ-5 правил
    scoredChunks.sort((a, b) => b.score - a.score);
    
    // СЦЕНАРИЙ - ПРИОРИТЕТ! Берем больше чанков
    const topScenarioChunks = scoredChunks
      .filter(sc => sc.chunk.chunkType === 'scenario')
      .slice(0, 10) // Больше чанков сценария
      .map(sc => sc.chunk.content);
    
    const topWorldChunks = scoredChunks
      .filter(sc => sc.chunk.chunkType === 'worldRules')
      .slice(0, 5)
      .map(sc => sc.chunk.content);
    
    const topGameplayChunks = scoredChunks
      .filter(sc => sc.chunk.chunkType === 'gameplayRules')
      .slice(0, 5)
      .map(sc => sc.chunk.content);
    
    // Если релевантных чанков сценария мало, добавляем первые чанки
    if (topScenarioChunks.length < 3) {
      const firstScenarioChunks = allChunks
        .filter(c => c.chunkType === 'scenario')
        .slice(0, 3)
        .map(c => c.content);
      topScenarioChunks.push(...firstScenarioChunks);
    }
    
    // Если релевантных чанков правил мало, добавляем первые чанки (общие правила)
    if (topWorldChunks.length < 2) {
      const firstWorldChunks = allChunks
        .filter(c => c.chunkType === 'worldRules')
        .slice(0, 2)
        .map(c => c.content);
      topWorldChunks.push(...firstWorldChunks);
    }
    
    if (topGameplayChunks.length < 2) {
      const firstGameplayChunks = allChunks
        .filter(c => c.chunkType === 'gameplayRules')
        .slice(0, 2)
        .map(c => c.content);
      topGameplayChunks.push(...firstGameplayChunks);
    }
    
    return {
      scenario: topScenarioChunks.join('\n\n'),
      worldRules: topWorldChunks.join('\n\n'),
      gameplayRules: topGameplayChunks.join('\n\n')
    };
  } catch (e) {
    console.error('[RAG] Failed to find relevant chunks:', e);
    // Fallback: возвращаем пустые строки, будет использован обычный метод
    return { scenario: '', worldRules: '', gameplayRules: '' };
  }
}

async function buildGptSceneContext(prisma: ReturnType<typeof getPrisma>, params: {
  gameId: string;
  lobbyId?: string;
  userId?: string | null;
  history?: Array<{ from?: string; text?: string }>;
  cachedGameSession?: any; // ОПТИМИЗАЦИЯ: Передаем кэшированную сессию
  characterId?: string; // ID персонажа игрока
  characterName?: string; // Имя персонажа игрока
}): Promise<string> {
  const { gameId, lobbyId, userId, cachedGameSession } = params;
  let sess: any = cachedGameSession;
  
  // Если сессия не передана, получаем её
  if (!sess) {
    try {
      if (lobbyId) {
        sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
      } else if (userId) {
        sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId } });
      }
    } catch {}
  }
  
  // Получаем данные персонажа игрока из БД, если передан characterId
  let playerCharacterData: { id?: string; name?: string; persona?: string; stats?: string } | null = null;
  if (params.characterId) {
    try {
      const char = await prisma.character.findUnique({ where: { id: params.characterId } });
      if (char) {
        playerCharacterData = {
          id: char.id,
          name: char.name || params.characterName,
          persona: char.persona || undefined,
          stats: char.isPlayable ? `HP: ${char.hp}/${char.maxHp}, AC: ${char.ac}, STR:${char.str}, DEX:${char.dex}, CON:${char.con}, INT:${char.int}, WIS:${char.wis}, CHA:${char.cha}` : undefined
        };
      }
    } catch (e) {
      console.warn('[buildGptSceneContext] Failed to fetch character:', e);
    }
  }
  // Если characterName передан, но данных из БД нет, используем переданное имя
  if (!playerCharacterData && params.characterName) {
    playerCharacterData = { name: params.characterName, id: params.characterId };
  }
  
  // ОПТИМИЗАЦИЯ: Параллельно получаем game, location, npcs и игровых персонажей
  let game: any = null;
  let loc: any = null;
  let npcs: any[] = [];
  let playableCharacters: any[] = [];
  
  const [gameResult, locationResult, npcsResult, playableResult] = await Promise.all([
    prisma.game.findUnique({ where: { id: gameId } }).catch(() => null),
    (async () => {
      try {
        if (sess?.currentLocationId) {
          return await prisma.location.findUnique({ where: { id: sess.currentLocationId } });
        } else {
          return await prisma.location.findFirst({ where: { gameId }, orderBy: { order: 'asc' } });
        }
      } catch {
        return null;
      }
    })(),
    prisma.character.findMany({ where: { gameId, OR: [{ isPlayable: false }, { isPlayable: null }] }, take: 50 }).catch(() => []),
    prisma.character.findMany({ where: { gameId, isPlayable: true }, take: 20 }).catch(() => [])
  ]);
  
  game = gameResult;
  loc = locationResult;
  npcs = npcsResult;
  playableCharacters = playableResult;
  
  // ОПТИМИЗАЦИЯ: Параллельно получаем exits и targets (targets зависит от exits, но можем начать после получения targetIds)
  let exits: any[] = [];
  let targets: any[] = [];
  
  if (loc?.id) {
    try {
      exits = await prisma.locationExit.findMany({ where: { locationId: loc.id } });
      const targetIds = Array.from(new Set((exits || []).map((e) => e.targetLocationId).filter(Boolean))) as string[];
      if (targetIds.length) {
        targets = await prisma.location.findMany({ where: { id: { in: targetIds } } });
      }
    } catch {}
  }
  
  const targetTitleById = new Map<string, string>();
  for (const t of targets) targetTitleById.set(t.id, t.title || '');
  // Фильтрация NPC по упоминанию в mini‑prompt/description
  const sceneText = String((loc?.rulesPrompt || '') + '\n' + (loc?.description || '')).toLowerCase();
  const sceneNpcs = npcs.filter((n) => sceneText.includes(String(n?.name || '').toLowerCase()));
  const npcBlock = sceneNpcs.length ? sceneNpcs.map((n) => `${n.name}: ${(n.persona || n.role || n.origin || '').toString().slice(0, 160)}`).join('\n') : '';
  const buttons = (exits || []).filter((e) => e.type === 'BUTTON').map((e) => {
    const label = (e.buttonText || '').trim();
    return { text: label, target: e.targetLocationId || null, target_title: e.targetLocationId ? (targetTitleById.get(e.targetLocationId) || '') : '' };
  }).filter((b) => b.text);
  const triggers = (exits || []).filter((e) => e.type === 'TRIGGER').map((e) => {
    const label = (e.triggerText || '').trim();
    return { phrase: label, target: e.targetLocationId || null, target_title: e.targetLocationId ? (targetTitleById.get(e.targetLocationId) || '') : '' };
  }).filter((t) => t.phrase);
  const isGameOver = Boolean((exits || []).some((e) => e.isGameOver || e.type === 'GAMEOVER'));
  const historyLines = (params.history || []).map((m) => {
    const from = (m?.from === 'bot' ? 'BOT' : (m?.from === 'me' ? 'ME' : (m?.from || 'USER'))).toString();
    const text = String(m?.text || '').replace(/\s+/g, ' ');
    return `${from}: ${text}`;
  }).join('\n');
  // slug: берём из loc.slug или формируем из title
  const slug = String((loc?.slug || '') || String(loc?.title || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-а-яё]/gi, ''));
  // Соберём JSON‑контекст сцены
  const sceneJson = {
    scene_slug: slug || '',
    scene_name: loc?.title || '',
    description: (loc?.rulesPrompt || loc?.description || '').toString(),
    npc: sceneNpcs.map((n) => ({ name: n.name, persona: n.persona || '' })),
    buttons,
    triggers,
    isGameOver,
    playerCharacter: playerCharacterData ? {
      name: playerCharacterData.name,
      id: playerCharacterData.id,
      persona: playerCharacterData.persona,
      stats: playerCharacterData.stats
    } : undefined,
  };
  
  // Добавляем явную информацию о персонаже игрока в контекст
  let playerCharacterInfo = '';
  if (playerCharacterData?.name) {
    playerCharacterInfo = `\n\nИГРОК УПРАВЛЯЕТ ПЕРСОНАЖЕМ:\nИмя: ${playerCharacterData.name}${playerCharacterData.persona ? `\nХарактер/Персона: ${playerCharacterData.persona}` : ''}${playerCharacterData.stats ? `\nХарактеристики D&D 5e: ${playerCharacterData.stats}` : ''}\n\nКРИТИЧЕСКИ ВАЖНО: Всегда используй ПОЛНОЕ имя персонажа "${playerCharacterData.name}" целиком (все слова, не только первое!) когда обращаешься к игроку или описываешь его действия. НЕ спрашивай имя персонажа - ты его уже знаешь! НИКОГДА не сокращай имя до первого слова - всегда используй полное имя "${playerCharacterData.name}". Обращайся напрямую: "${playerCharacterData.name}, ты видишь...", "Обращаясь к ${playerCharacterData.name}, мастер говорит...", "${playerCharacterData.name} делает..." и т.д.`;
  }
  
  // Добавляем информацию о ВСЕХ игровых персонажах (isPlayable: true)
  let playableCharactersInfo = '';
  if (playableCharacters.length > 0) {
    playableCharactersInfo = '\n\nИГРОВЫЕ ПЕРСОНАЖИ (из базы данных сценария):\n' + playableCharacters.map((p: any) => {
      const traits = [p.class, p.race, p.gender].filter(Boolean).join(', ');
      const stats = `HP: ${p.hp}/${p.maxHp}, AC: ${p.ac}, STR:${p.str}, DEX:${p.dex}, CON:${p.con}, INT:${p.int}, WIS:${p.wis}, CHA:${p.cha}`;
      const extras = [p.persona, p.origin, p.role].filter(Boolean).join('. ');
      const abilities = p.abilities ? `\n  Способности/Оружие: ${String(p.abilities).slice(0, 300)}` : '';
      return `- ${p.name} (Ур.${p.level || 1} ${traits || 'Персонаж'}) — ${stats}. ${extras ? `Характер: ${extras}` : ''}${abilities}`;
    }).join('\n') + '\n\nКРИТИЧЕСКИ ВАЖНО: Используй ЭТИ данные о персонажах из базы данных! НЕ придумывай новых персонажей, оружие, классы или расы. Используй ТОЛЬКО имена, классы, расы, характеристики, способности и оружие, которые указаны выше. Если персонаж - маг, используй его магические способности. Если воин - его оружие и боевые навыки. Если персонаж имеет способности в abilities - используй их при описании действий.';
  }
  
  // Добавляем план прогрессии игры (если есть)
  let progressionPlanInfo = '';
  if (sess?.state) {
    const state = sess.state as any;
    const plan = state.gameProgressionPlan;
    if (plan && loc?.id) {
      // Находим план для текущей локации
      const locationPlan = plan.locations?.find((lp: any) => lp.locationId === loc.id);
      if (locationPlan) {
        const currentSceneNumber = (state.scenesInCurrentLocation || 0) + 1;
        const scenePlan = locationPlan.sceneProgression?.find((sp: any) => sp.sceneNumber === currentSceneNumber);
        
        progressionPlanInfo = `\n\nПЛАН ПРОГРЕССИИ ДЛЯ ЛОКАЦИИ "${locationPlan.locationTitle}":\n`;
        progressionPlanInfo += `- Оценка сцен: ${locationPlan.estimatedScenes || 'не указано'}\n`;
        progressionPlanInfo += `- Текущая сцена: ${currentSceneNumber}\n`;
        
        if (locationPlan.goals && locationPlan.goals.length > 0) {
          progressionPlanInfo += `- Цели локации: ${locationPlan.goals.join(', ')}\n`;
        }
        
        if (locationPlan.keyEvents && locationPlan.keyEvents.length > 0) {
          progressionPlanInfo += `- Ключевые события: ${locationPlan.keyEvents.join(', ')}\n`;
        }
        
        if (scenePlan) {
          progressionPlanInfo += `\nПЛАН ТЕКУЩЕЙ СЦЕНЫ (${scenePlan.sceneNumber}):\n`;
          progressionPlanInfo += `- Описание: ${scenePlan.description || 'не указано'}\n`;
          if (scenePlan.expectedChoices && scenePlan.expectedChoices.length > 0) {
            progressionPlanInfo += `- Ожидаемые варианты выбора: ${scenePlan.expectedChoices.join(', ')}\n`;
          }
          if (scenePlan.leadsToLocationId) {
            const targetLoc = await prisma.location.findUnique({ where: { id: scenePlan.leadsToLocationId } }).catch(() => null);
            if (targetLoc) {
              progressionPlanInfo += `- Ведет к локации: "${targetLoc.title}"\n`;
            }
          }
        }
        
        if (locationPlan.transitions && locationPlan.transitions.length > 0) {
          progressionPlanInfo += `\nПЕРЕХОДЫ ИЗ ЛОКАЦИИ:\n`;
          for (const trans of locationPlan.transitions) {
            progressionPlanInfo += `- ${trans.toLocationTitle || trans.toLocationId}: ${trans.requiredProgress || 'без условий'}\n`;
          }
        }
        
        progressionPlanInfo += `\nКРИТИЧЕСКИ ВАЖНО: Следуй плану прогрессии! Игра должна развиваться согласно сценарию с точными целями, событиями и переходами между локациями.`;
      }
    }
  }
  
  // Добавляем правила игры через RAG (Retrieval Augmented Generation)
  let gameRulesInfo = '';
  if (game) {
    // Проверяем, есть ли индексированные чанки для RAG
    const chunkCount = await prisma.ruleChunk.count({ where: { gameId: game.id } }).catch(() => 0);
    console.log(`[RAG] 📊 Chunk count for game ${game.id}: ${chunkCount}`);
    
    if (chunkCount > 0) {
      // Используем RAG: ищем релевантные чанки на основе текущей сцены
      const sceneContext = {
        locationTitle: loc?.title,
        locationDescription: loc?.description || loc?.rulesPrompt,
        npcNames: sceneNpcs.map(n => n.name),
        characterNames: playableCharacters.map(c => c.name)
      };
      
      console.log(`[RAG] 🔍 Searching relevant chunks for location: ${loc?.title || 'unknown'}`);
      const relevantChunks = await findRelevantRuleChunks(prisma, game.id, sceneContext);
      
      // КРИТИЧЕСКИ ВАЖНО: Сначала добавляем СЦЕНАРИЙ (приоритет!), потом правила как вспомогательный контекст
      const contextParts: string[] = [];
      
      if (relevantChunks.scenario) {
        contextParts.push(`СЦЕНАРИЙ ИГРЫ (ОСНОВНОЙ ИСТОЧНИК - играй строго по сценарию!):\n${relevantChunks.scenario}`);
        console.log(`[RAG] ✅ Found scenario chunks, length: ${relevantChunks.scenario.length}`);
      }
      
      if (relevantChunks.worldRules) {
        contextParts.push(`Правила мира (вспомогательный контекст для понимания механик):\n${relevantChunks.worldRules}`);
        console.log(`[RAG] ✅ Found world rules chunks, length: ${relevantChunks.worldRules.length}`);
      }
      
      if (relevantChunks.gameplayRules) {
        contextParts.push(`Правила процесса (вспомогательный контекст для понимания механик):\n${relevantChunks.gameplayRules}`);
        console.log(`[RAG] ✅ Found gameplay rules chunks, length: ${relevantChunks.gameplayRules.length}`);
      }
      
      if (contextParts.length > 0) {
        gameRulesInfo = '\n\n' + contextParts.join('\n\n');
        console.log(`[RAG] ✅ RAG context added to prompt, total length: ${gameRulesInfo.length}`);
      } else {
        console.log(`[RAG] ⚠️ No relevant chunks found for scene context`);
      }
    } else {
      // Fallback: читаем из PDF файлов (если RAG еще не настроен)
      // КРИТИЧЕСКИ ВАЖНО: Сначала читаем СЦЕНАРИЙ (приоритет!), потом правила как вспомогательную информацию
      const scenarioPdfPath = (game as any)?.scenarioPdfPath;
      const rulesPdfPath = (game as any)?.rulesPdfPath;
      
      const contextParts: string[] = [];
      
      // ПРИОРИТЕТ: Сначала сценарий
      const scenarioText = await readPdfText(scenarioPdfPath || null);
      if (scenarioText) {
        contextParts.push(`СЦЕНАРИЙ ИГРЫ (ОСНОВНОЙ ИСТОЧНИК - играй строго по сценарию!):\n${scenarioText.slice(0, 50000)}`); // Ограничиваем до 50K символов
      }
      
      // Вспомогательная информация: правила
      const rulesText = await readPdfText(rulesPdfPath || null);
      if (rulesText) {
        contextParts.push(`Правила игры (вспомогательный контекст для понимания механик):\n${rulesText.slice(0, 50000)}`); // Ограничиваем до 50K символов
      }
      
      // Если PDF нет, используем краткие версии из БД
      if (contextParts.length === 0) {
        const combinedRules = [game.worldRules, game.gameplayRules].filter(Boolean).join('\n\n');
        if (combinedRules) contextParts.push(`Правила игры: ${combinedRules}`);
      }
      
      if (contextParts.length > 0) gameRulesInfo = '\n\n' + contextParts.join('\n\n');
    }
  }
  
  const gptContext = [
    `SCENE_JSON:\n${JSON.stringify(sceneJson, null, 2)}`,
    playableCharactersInfo,
    playerCharacterInfo,
    playerCharacterData?.name ? `\nКРИТИЧЕСКИ ВАЖНО: В SCENE_JSON выше указано полное имя персонажа игрока "${playerCharacterData.name}". ВСЕГДА используй это ПОЛНОЕ имя целиком (все слова) из JSON, не сокращай до первого слова!` : '',
    progressionPlanInfo, // План прогрессии добавляется ПЕРЕД правилами для приоритета
    gameRulesInfo,
    historyLines ? `История:\n${historyLines}` : '',
  ].filter(Boolean).join('\n\n');
  return gptContext;
}

function trimToNiceLimit(text: string, limit = 700): string {
  try {
    const t = String(text || '');
    if (t.length <= limit) return t;
    const slice = t.slice(0, limit);
    // ищем последнее "завершение мысли"
    const punct = ['. ', '…', '!', '?', '."', '!"', '?"', '.»', '!"»', '?"»', '.”', '!”', '?”', '»', '\n'];
    let cut = -1;
    for (const p of punct) {
      const i = slice.lastIndexOf(p);
      if (i > cut) cut = i + (p.trimEnd() === '\n' ? 0 : p.length - 1);
    }
    if (cut >= 0 && cut <= limit && cut > Math.floor(limit * 0.6)) {
      return slice.slice(0, cut + 1).trimEnd();
    }
    // иначе — по последнему пробелу
    const sp = slice.lastIndexOf(' ');
    if (sp > Math.floor(limit * 0.5)) {
      return (slice.slice(0, sp).trimEnd() + '…');
    }
    // жёсткое усечение с многоточием
    return slice.trimEnd() + '…';
  } catch {
    return String(text || '').slice(0, limit);
  }
}


function rollSingleDie(sides: number): number {
  const s = Math.max(2, Math.floor(sides));
  try {
    if (typeof (crypto as any).randomInt === 'function') {
      return (crypto as any).randomInt(1, s + 1);
    }
  } catch {  }
  return Math.floor(Math.random() * s) + 1;
}

function getDndModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// СИСТЕМА СОСТОЯНИЙ D&D 5e С РЕАЛЬНОЙ ЛОГИКОЙ
// ═══════════════════════════════════════════════════════════════════════════════

type ConditionEffect = {
  name: string;
  duration?: number; // в ходах, undefined = до снятия
  onTurnStart?: (charState: any, baseChar: any) => { hpChange?: number; statChanges?: Record<string, number>; message?: string };
  onCheck?: (stat: string, baseValue: number, modifier: number) => { advantage?: boolean; disadvantage?: boolean; blocked?: boolean; modifierChange?: number };
  onSave?: (stat: string, baseValue: number, modifier: number) => { advantage?: boolean; disadvantage?: boolean; modifierChange?: number };
  onAttack?: (baseModifier: number) => { advantage?: boolean; disadvantage?: boolean; modifierChange?: number; blocked?: boolean };
  blocksActions?: boolean;
  blocksMovement?: boolean;
  blocksVision?: boolean;
};

const CONDITION_EFFECTS: Record<string, ConditionEffect> = {
  'отравлен': {
    name: 'Отравлен',
    duration: undefined, // до снятия
    onTurnStart: (charState, baseChar) => {
      // Отравление: урон 1d4 каждый ход (упрощенно - 2 HP)
      const damage = 2;
      return {
        hpChange: -damage,
        message: `Отравление причиняет ${damage} урона.`
      };
    },
    onCheck: (stat, baseValue, modifier) => {
      // Отравление: помеха на проверки характеристик
      if (stat === 'con' || stat === 'dex') {
        return { disadvantage: true };
      }
      return {};
    },
    onSave: (stat, baseValue, modifier) => {
      // Отравление: помеха на спасброски
      return { disadvantage: true };
    }
  },
  'парализован': {
    name: 'Парализован',
    duration: undefined,
    blocksActions: true,
    blocksMovement: true,
    onCheck: () => ({ blocked: true }),
    onAttack: () => ({ blocked: true }),
    onSave: (stat) => {
      // Паралич: автоматический провал спасбросков STR и DEX
      if (stat === 'str' || stat === 'dex') {
        return { blocked: true };
      }
      return {};
    }
  },
  'оглушен': {
    name: 'Оглушен',
    duration: undefined,
    blocksActions: true,
    blocksMovement: true,
    onCheck: () => ({ disadvantage: true, blocked: true }),
    onAttack: () => ({ disadvantage: true, blocked: true }),
    onSave: () => ({ disadvantage: true })
  },
  'ослеплен': {
    name: 'Ослеплен',
    duration: undefined,
    blocksVision: true,
    onCheck: (stat) => {
      // Ослепление: помеха на проверки, требующие зрения
      if (stat === 'wis' || stat === 'int') {
        return { disadvantage: true };
      }
      return {};
    },
    onAttack: () => ({ disadvantage: true })
  },
  'очарован': {
    name: 'Очарован',
    duration: undefined,
    blocksActions: true, // не может атаковать очаровавшего
    onCheck: (stat) => {
      if (stat === 'cha') {
        return { disadvantage: true };
      }
      return {};
    }
  },
  'испуган': {
    name: 'Испуган',
    duration: undefined,
    blocksMovement: true, // не может добровольно приближаться к источнику страха
    onCheck: (stat) => {
      if (stat === 'wis' || stat === 'cha') {
        return { disadvantage: true };
      }
      return {};
    },
    onAttack: () => ({ disadvantage: true })
  },
  'невидим': {
    name: 'Невидим',
    duration: undefined,
    onAttack: () => ({ advantage: true }),
    onCheck: () => ({ advantage: true }) // преимущество на скрытность
  },
  'невидима': {
    name: 'Невидима',
    duration: undefined,
    onAttack: () => ({ advantage: true }),
    onCheck: () => ({ advantage: true })
  },
  'истощение': {
    name: 'Истощение',
    duration: undefined,
    onTurnStart: (charState, baseChar) => {
      // Истощение: -1 к проверкам характеристик за каждый уровень
      const exhaustionLevel = charState.exhaustionLevel || 1;
      return {
        statChanges: {
          str: -exhaustionLevel,
          dex: -exhaustionLevel,
          con: -exhaustionLevel,
          int: -exhaustionLevel,
          wis: -exhaustionLevel,
          cha: -exhaustionLevel
        }
      };
    },
    onCheck: () => ({ modifierChange: -1 }),
    onSave: () => ({ modifierChange: -1 })
  },
  'усталость': {
    name: 'Усталость',
    duration: 1, // 1 ход
    onCheck: () => ({ disadvantage: true }),
    onAttack: () => ({ disadvantage: true })
  },
  'болезнь': {
    name: 'Болезнь',
    duration: undefined,
    onTurnStart: (charState, baseChar) => {
      // Болезнь: урон 1 HP каждый ход
      return {
        hpChange: -1,
        message: 'Болезнь причиняет урон.'
      };
    },
    onCheck: () => ({ disadvantage: true }),
    onSave: () => ({ disadvantage: true })
  }
};

/**
 * Применяет эффекты состояний к персонажу в начале хода
 */
function applyConditionEffects(charState: any, baseChar: any): { hpChange: number; statChanges: Record<string, number>; messages: string[] } {
  const conditions = charState.conditions || [];
  let totalHpChange = 0;
  const statChanges: Record<string, number> = {};
  const messages: string[] = [];
  
  for (const condition of conditions) {
    const effect = CONDITION_EFFECTS[condition.toLowerCase()];
    if (effect && effect.onTurnStart) {
      const result = effect.onTurnStart(charState, baseChar);
      if (result.hpChange) {
        totalHpChange += result.hpChange;
      }
      if (result.statChanges) {
        for (const [stat, change] of Object.entries(result.statChanges)) {
          statChanges[stat] = (statChanges[stat] || 0) + change;
        }
      }
      if (result.message) {
        messages.push(result.message);
      }
    }
  }
  
  return { hpChange: totalHpChange, statChanges, messages };
}

/**
 * Получает модификаторы для проверки характеристики с учетом состояний
 */
function getCheckModifiersWithConditions(charState: any, stat: string, baseValue: number, baseModifier: number): { 
  modifier: number; 
  advantage: boolean; 
  disadvantage: boolean; 
  blocked: boolean 
} {
  const conditions = charState.conditions || [];
  let modifier = baseModifier;
  let advantage = false;
  let disadvantage = false;
  let blocked = false;
  
  for (const condition of conditions) {
    const effect = CONDITION_EFFECTS[condition.toLowerCase()];
    if (effect && effect.onCheck) {
      const result = effect.onCheck(stat, baseValue, modifier);
      if (result.blocked) blocked = true;
      if (result.advantage) advantage = true;
      if (result.disadvantage) disadvantage = true;
      if (result.modifierChange) modifier += result.modifierChange;
    }
  }
  
  return { modifier, advantage, disadvantage, blocked };
}

/**
 * Получает модификаторы для спасброска с учетом состояний
 */
function getSaveModifiersWithConditions(charState: any, stat: string, baseValue: number, baseModifier: number): { 
  modifier: number; 
  advantage: boolean; 
  disadvantage: boolean; 
  blocked: boolean 
} {
  const conditions = charState.conditions || [];
  let modifier = baseModifier;
  let advantage = false;
  let disadvantage = false;
  let blocked = false;
  
  for (const condition of conditions) {
    const effect = CONDITION_EFFECTS[condition.toLowerCase()];
    if (effect && effect.onSave) {
      const result = effect.onSave(stat, baseValue, modifier);
      if (result.blocked) blocked = true;
      if (result.advantage) advantage = true;
      if (result.disadvantage) disadvantage = true;
      if (result.modifierChange) modifier += result.modifierChange;
    }
  }
  
  return { modifier, advantage, disadvantage, blocked };
}

/**
 * Проверяет, может ли персонаж выполнить действие с учетом состояний
 */
function canPerformAction(charState: any): { can: boolean; reason?: string } {
  const conditions = charState.conditions || [];
  
  for (const condition of conditions) {
    const effect = CONDITION_EFFECTS[condition.toLowerCase()];
    if (effect && effect.blocksActions) {
      return { can: false, reason: `Персонаж ${effect.name.toLowerCase()} и не может действовать.` };
    }
  }
  
  return { can: true };
}

/**
 * Обновляет длительность состояний и удаляет истекшие
 */
function updateConditionDurations(charState: any): { removed: string[] } {
  const conditions = charState.conditions || [];
  const removed: string[] = [];
  const updated: string[] = [];
  
  for (const condition of conditions) {
    const effect = CONDITION_EFFECTS[condition.toLowerCase()];
    if (effect && effect.duration !== undefined) {
      // Уменьшаем длительность
      const conditionData = charState.conditionData || {};
      const conditionKey = condition.toLowerCase();
      const currentDuration = conditionData[conditionKey]?.duration ?? effect.duration;
      
      if (currentDuration <= 1) {
        removed.push(condition);
      } else {
        updated.push(condition);
        if (!conditionData[conditionKey]) conditionData[conditionKey] = {};
        conditionData[conditionKey].duration = currentDuration - 1;
        charState.conditionData = conditionData;
      }
    } else {
      updated.push(condition);
    }
  }
  
  charState.conditions = updated;
  return { removed };
}
function rollMultiple(count: number, sides: number): number[] {
  const rolls: number[] = [];
  const c = Math.max(1, Math.floor(count));
  const s = Math.max(2, Math.floor(sides));
  for (let i = 0; i < c; i++) rolls.push(rollSingleDie(s));
  return rolls;
}
function parseDiceExpression(exprRaw: string): { count: number; sides: number; mod: number; adv: boolean; dis: boolean } | null {
  const expr = String(exprRaw || '').toLowerCase().replace(/\s+/g, '');
  if (!expr) return null;

  const m = expr.match(/^(\d*)d(\d+|%)((?:\+|-)\d+)?(adv|dis)?$/);
  if (!m) return null;
  const count = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
  const sides = m[2] === '%' ? 100 : Math.max(2, parseInt(m[2], 10));
  const mod = m[3] ? parseInt(m[3], 10) : 0;
  const adv = m[4] === 'adv';
  const dis = m[4] === 'dis';
  return { count, sides, mod, adv, dis };
}
function rollDiceDnd(params: { expr?: string; count?: number; sides?: number; mod?: number; adv?: boolean; dis?: boolean }) {
  const byExpr = params.expr ? parseDiceExpression(params.expr) : null;
  const count = byExpr ? byExpr.count : Math.max(1, Math.floor(Number(params.count || 1)));
  const sides = byExpr ? byExpr.sides : Math.max(2, Math.floor(Number(params.sides || 20)));
  const mod = byExpr ? byExpr.mod : Math.floor(Number(params.mod || 0));
  const adv = byExpr ? byExpr.adv : Boolean(params.adv);
  const dis = byExpr ? byExpr.dis : Boolean(params.dis);

  if ((adv || dis) && sides === 20) {
    const a = rollSingleDie(20);
    const b = rollSingleDie(20);
    const picked = adv ? Math.max(a, b) : Math.min(a, b);
    const total = picked + mod;
    return {
      notation: `${adv ? 'adv' : 'dis'} d20${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}`,
      sides: 20,
      adv,
      dis,
      rolls: [a, b],
      picked,
      natural: picked,
      mod,
      total,
    };
  }
  const rolls = rollMultiple(count, sides);
  const sum = rolls.reduce((acc, n) => acc + n, 0);
  const total = sum + mod;
  const notation = `${count}d${sides}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}`;
  const natural = sides === 20 ? (rolls[0] || 0) : undefined;
  return { notation, sides, adv: false, dis: false, rolls, sum, mod, total, natural };
}

function normalizeRollKind(raw: string): 'attack' | 'save' | 'damage' | 'check' {
  const low = String(raw || '').toLowerCase();
  if (/(attack|atk|hit|атака|атак|удар|strike)/.test(low)) return 'attack';
  if (/(save|saving|сейв|спас|спасбросок|saving throw|спасброс)/.test(low)) return 'save';
  if (/(damage|dmg|урон)/.test(low)) return 'damage';
  return 'check';
}

function getNaturalD20(r: any): number | null {
  if (!r || r.sides !== 20) return null;
  if (typeof r.natural === 'number') return r.natural;
  if ('picked' in r) return r.picked;
  const first = Array.isArray(r.rolls) ? r.rolls[0] : null;
  return typeof first === 'number' ? first : null;
}

function evaluateDndOutcome(params: { roll: any; dc?: number; kind?: string }): { outcome: string; outcomeCode: '' | 'crit_success' | 'crit_fail' | 'success' | 'partial' | 'fail' } {
  const kind = normalizeRollKind(params.kind || '');
  const dc = typeof params.dc === 'number' ? params.dc : undefined;
  if (kind === 'damage') return { outcome: '', outcomeCode: '' };
  if (typeof dc !== 'number' && params.roll?.sides !== 20) return { outcome: '', outcomeCode: '' };
  const nat = getNaturalD20(params.roll);
  if (nat === 20) return { outcome: 'Критический успех', outcomeCode: 'crit_success' };
  if (nat === 1) return { outcome: 'Критический провал', outcomeCode: 'crit_fail' };
  if (typeof dc === 'number') {
    const total = Number(params.roll?.total || 0);
    if (total >= dc) return { outcome: 'Успех', outcomeCode: 'success' };
    if (total >= dc - 2) return { outcome: 'Частичный успех / с риском', outcomeCode: 'partial' };
    return { outcome: 'Провал', outcomeCode: 'fail' };
  }
  return { outcome: '', outcomeCode: '' };
}

function formatKindLabel(kind: string): string {
  const k = normalizeRollKind(kind);
  if (k === 'attack') return 'Атака';
  if (k === 'save') return 'Спасбросок';
  if (k === 'damage') return 'Урон';
  return 'Проверка';
}
app.post('/api/dice/roll', async (req, res) => {
  try {
    const expr = typeof req.body?.expr === 'string' ? req.body.expr : '';
    const count = req.body?.count;
    const sides = req.body?.sides;
    const mod = req.body?.mod;
    const adv = req.body?.adv === true;
    const dis = req.body?.dis === true;
    const manual = Array.isArray(req.body?.manualResults) ? (req.body.manualResults as any[]).map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
    const times = Math.max(1, Math.min(100, Number(req.body?.times || 1)));
    const results: any[] = [];
    for (let i = 0; i < times; i++) {
      if (manual.length) {
        const nCount = Number(count || (expr ? (Number(expr.split('d')[0]) || 1) : manual.length));
        const nSides = Number(sides || (expr.includes('d') ? Number(expr.split('d')[1]) || 20 : 20));
        const rolls = manual.slice(0, nCount);
        const sum = rolls.reduce((a, b) => a + b, 0);
        const total = sum + (Number(mod) || 0);
        const notation = `${nCount}d${nSides}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}`;
        results.push({ notation, sides: nSides, adv: false, dis: false, rolls, sum, mod: Number(mod) || 0, total });
      } else {
        results.push(rollDiceDnd({ expr, count, sides, mod, adv, dis }));
      }
    }
    return res.json({ ok: true, results });
  } catch {
    return res.status(400).json({ ok: false, error: 'dice_error' });
  }
});


app.post('/api/lobbies/:id/dice', async (req, res) => {
  try {
    const lobbyId = String(req.params.id);
    const prisma = getPrisma();
    const lob = await prisma.gameLobby.findUnique({ where: { id: lobbyId } });
    if (!lob) return res.status(404).json({ error: 'lobby_not_found' });
    const gameId = lob.gameId || String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'game_required' });
    const expr = typeof req.body?.expr === 'string' ? req.body.expr : '';
    const count = req.body?.count;
    const sides = req.body?.sides;
    const mod = req.body?.mod;
    const adv = req.body?.adv === true;
    const dis = req.body?.dis === true;
    const dc = Number.isFinite(req.body?.dc) ? Number(req.body.dc) : undefined;
    const context = typeof req.body?.context === 'string' ? String(req.body.context).slice(0, 200) : '';
    const kind = typeof req.body?.kind === 'string' ? String(req.body.kind) : '';
    const manual = Array.isArray(req.body?.manualResults) ? (req.body.manualResults as any[]).map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
    const r = (manual.length
      ? (() => {
          const nCount = Number(count || (expr ? (Number(expr.split('d')[0]) || 1) : manual.length));
          const nSides = Number(sides || (expr.includes('d') ? Number(expr.split('d')[1]) || 20 : 20));
          const rolls = manual.slice(0, nCount);
          const sum = rolls.reduce((a, b) => a + b, 0);
          const total = sum + (Number(mod) || 0);
          const notation = `${nCount}d${nSides}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}`;
          const natural = nSides === 20 ? (rolls[0] || 0) : undefined;
          return { notation, sides: nSides, adv: false, dis: false, rolls, sum, mod: Number(mod) || 0, total, natural };
        })()
      : rollDiceDnd({ expr, count, sides, mod, adv, dis }));
    const kindNorm = normalizeRollKind(kind);
    const kindLabel = formatKindLabel(kind);
    const dcLabel = kindNorm === 'attack' ? 'AC' : 'DC';
    const { outcome } = evaluateDndOutcome({ roll: r, dc, kind });
    const fmt = (() => {
      const headLines = [
        kindLabel ? `Тип: ${kindLabel}` : '',
        context ? `Контекст: ${context}` : '',
      ].filter(Boolean);
      const head = headLines.length ? `${headLines.join('\n')}\n` : '';
      const dcStr = typeof dc === 'number' ? ` · ${dcLabel}=${dc}` : '';
      if ('picked' in r) {
        return `🎲 Бросок\n${head}${r.notation}${dcStr} → (${r.rolls[0]}, ${r.rolls[1]}) ⇒ ${r.picked}${r.mod ? (r.mod > 0 ? ` +${r.mod}` : ` ${r.mod}`) : ''} = ${r.total}${outcome ? ` · Итог: ${outcome}` : ''}`;
      }
      return `🎲 Бросок\n${head}${r.notation}${dcStr} → [${r.rolls.join(', ')}]${r.mod ? (r.mod > 0 ? ` +${r.mod}` : ` ${r.mod}`) : ''} = ${r.total}${outcome ? ` · Итог: ${outcome}` : ''}`;
    })();

    const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } } });
    const history = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
    history.push({ from: 'me', text: fmt });

    const gptContext = await buildGptSceneContext(prisma, { gameId, lobbyId, history });
    const narr = await generateDiceNarrative(prisma, gameId, gptContext || (context || ''), outcome || fmt, r.total);
    history.push({ from: 'bot', text: narr.text });
    await prisma.chatSession.upsert({
      where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } },
      update: { history: history as any },
      create: { userId: 'lobby:' + lobbyId, gameId, history: history as any },
    });
    wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
    return res.json({ ok: true, messages: [fmt, narr.text] });
  } catch {
    return res.status(400).json({ ok: false, error: 'dice_lobby_error' });
  }
});


app.post('/api/chat/dice', async (req, res) => {
  try {
    const prisma = getPrisma();
    const gameId = String(req.body?.gameId || '');
    if (!gameId) return res.status(400).json({ error: 'game_required' });
    const uid = await resolveUserIdFromQueryOrBody(req, prisma);
    if (!uid) return res.status(400).json({ error: 'user_required' });
    const expr = typeof req.body?.expr === 'string' ? req.body.expr : '';
    const count = req.body?.count;
    const sides = req.body?.sides;
    let mod = req.body?.mod;
    let adv = req.body?.adv === true;
    let dis = req.body?.dis === true;
    const dc = Number.isFinite(req.body?.dc) ? Number(req.body.dc) : undefined;
    const context = typeof req.body?.context === 'string' ? String(req.body.context).slice(0, 200) : '';
    const kind = typeof req.body?.kind === 'string' ? String(req.body.kind) : '';
    const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : undefined;
    const stat = typeof req.body?.stat === 'string' ? req.body.stat.toLowerCase() : undefined;
    const manual = Array.isArray(req.body?.manualResults) ? (req.body.manualResults as any[]).map((n) => Number(n)).filter((n) => Number.isFinite(n)) : [];
    
    // Определяем тип броска ДО применения эффектов
    const kindNorm = normalizeRollKind(kind);
    
    // Применяем эффекты состояний к броску
    if (characterId && gameId && stat) {
      try {
        let sess: any = null;
        const uidForSession = await resolveUserIdFromQueryOrBody(req, prisma);
        if (uidForSession) sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uidForSession } });
        
        if (sess?.state) {
          const state = sess.state as any;
          const charState = state.characters?.[characterId];
          if (charState) {
            const baseChar = await prisma.character.findUnique({ where: { id: characterId } });
            if (baseChar) {
              const baseStat = (baseChar as any)[stat] || 10;
              const baseMod = getDndModifier(baseStat);
              const statMods = charState.statModifiers || {};
              const statMod = statMods[stat] || 0;
              const finalMod = baseMod + statMod;
              
              // Применяем эффекты состояний
              if (kindNorm === 'save') {
                const saveMods = getSaveModifiersWithConditions(charState, stat, baseStat, finalMod);
                if (saveMods.blocked) {
                  return res.json({ 
                    ok: true, 
                    blocked: true, 
                    message: `Персонаж не может выполнить спасбросок из-за состояния.`,
                    roll: { notation: 'N/A', total: 0, natural: 1 }
                  });
                }
                if (saveMods.advantage) adv = true;
                if (saveMods.disadvantage) dis = true;
                mod = (mod || 0) + (saveMods.modifier - finalMod);
              } else if (kindNorm === 'check' || kindNorm === 'attack') {
                const checkMods = getCheckModifiersWithConditions(charState, stat, baseStat, finalMod);
                if (checkMods.blocked) {
                  return res.json({ 
                    ok: true, 
                    blocked: true, 
                    message: `Персонаж не может выполнить действие из-за состояния.`,
                    roll: { notation: 'N/A', total: 0, natural: 1 }
                  });
                }
                if (checkMods.advantage) adv = true;
                if (checkMods.disadvantage) dis = true;
                mod = (mod || 0) + (checkMods.modifier - finalMod);
              }
            }
          }
        }
      } catch (e) {
        console.error('[DICE] Failed to apply condition effects:', e);
      }
    }
    
    const r = (manual.length
      ? (() => {
          const nCount = Number(count || (expr ? (Number(expr.split('d')[0]) || 1) : manual.length));
          const nSides = Number(sides || (expr.includes('d') ? Number(expr.split('d')[1]) || 20 : 20));
          const rolls = manual.slice(0, nCount);
          const sum = rolls.reduce((a, b) => a + b, 0);
          const total = sum + (Number(mod) || 0);
          const notation = `${nCount}d${nSides}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}`;
          const natural = nSides === 20 ? (rolls[0] || 0) : undefined;
          return { notation, sides: nSides, adv: false, dis: false, rolls, sum, mod: Number(mod) || 0, total, natural };
        })()
      : rollDiceDnd({ expr, count, sides, mod, adv, dis }));
    const kindLabel = formatKindLabel(kind);
    const dcLabel = kindNorm === 'attack' ? 'AC' : 'DC';
    const { outcome, outcomeCode } = evaluateDndOutcome({ roll: r, dc, kind });
    const fmt = (() => {
      const headLines = [
        kindLabel ? `Тип: ${kindLabel}` : '',
        context ? `Контекст: ${context}` : '',
      ].filter(Boolean);
      const head = headLines.length ? `${headLines.join('\n')}\n` : '';
      const dcStr = typeof dc === 'number' ? ` · ${dcLabel}=${dc}` : '';
      if ('picked' in r) {
        return `🎲 Бросок\n${head}${r.notation}${dcStr} → (${r.rolls[0]}, ${r.rolls[1]}) ⇒ ${r.picked}${r.mod ? (r.mod > 0 ? ` +${r.mod}` : ` ${r.mod}`) : ''} = ${r.total}${outcome ? ` · Итог: ${outcome}` : ''}`;
      }
      return `🎲 Бросок\n${head}${r.notation}${dcStr} → [${r.rolls.join(', ')}]${r.mod ? (r.mod > 0 ? ` +${r.mod}` : ` ${r.mod}`) : ''} = ${r.total}${outcome ? ` · Итог: ${outcome}` : ''}`;
    })();
    const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
    const history = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
    
    history.push({ from: 'me', text: fmt });
    const gptContext = await buildGptSceneContext(prisma, { gameId, userId: uid, history });
    const narr = await generateDiceNarrative(prisma, gameId, gptContext || (context || ''), outcome || fmt, r.total);
    
    // КРИТИЧЕСКИ ВАЖНО: Проверяем, есть ли в нарративе варианты выбора, соответствующие реальным выходам
    // Если игрок потом выберет один из них, локация переключится автоматически
    // Но здесь мы также можем проверить и переключить, если вариант уже выбран
    let narrText = narr.text;
    if (gameId && narrText) {
      try {
        const sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
        if (sess?.currentLocationId) {
          // Форматируем варианты выбора и добавляем реальные выходы
          narrText = formatChoiceOptions(narrText);
          
          // НОВАЯ ЛОГИКА: ensureRealExitsInChoices удалена, используем текст как есть
          
          // Обновляем состояние сессии (если нужно)
          if (sess) {
            try {
              const state = (sess.state as any) || {};
              // Увеличиваем счетчик сцен в текущей локации
              state.scenesInCurrentLocation = (state.scenesInCurrentLocation || 0) + 1;
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { state }
              });
            } catch (e) {
              console.warn('[DICE] Failed to update session state:', e);
            }
          } else if (sess) {
            // Даже если не обновляем счетчик реальных выходов, увеличиваем счетчик сцен в локации
            try {
              const state = (sess.state as any) || {};
              state.scenesInCurrentLocation = (state.scenesInCurrentLocation || 0) + 1;
              await prisma.gameSession.update({
                where: { id: sess.id },
                data: { state }
              });
            } catch (e) {
              console.warn('[DICE] Failed to update scene counter:', e);
            }
          }
        }
      } catch (e) {
        console.warn('[DICE] Failed to process location exits:', e);
      }
    }
    
    history.push({ from: 'bot', text: narrText });
    await prisma.chatSession.upsert({
      where: { userId_gameId: { userId: uid, gameId } },
      update: { history: history as any },
      create: { userId: uid, gameId, history: history as any },
    });
    const response: any = { ok: true, messages: [fmt, narrText] };
    return res.json(response);
  } catch {
    return res.status(400).json({ ok: false, error: 'dice_chat_error' });
  }
});


