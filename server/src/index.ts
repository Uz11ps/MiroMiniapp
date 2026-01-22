// @ts-nocheck
import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { games, createGame, updateGame, deleteGame, profile, friends, users, createUser, updateUser, deleteUser, feedbacks, subscriptionPlans, characters, createCharacter, updateCharacter, deleteCharacter } from './db.js';
import OpenAI from 'openai';
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

function createProxiedFetchForOpenAI(proxies: string[], timeoutMs: number) {
  return (async (input: RequestInfo, init?: RequestInit) => {
    const controllers: Array<AbortController> = [];
    const attempts = proxies.length ? proxies : ['__direct__'];
    let lastErr: unknown = null;
    for (const p of attempts) {
      try {
        const controller = new AbortController();
        controllers.push(controller);
        const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
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

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { 
    fileSize: 100 * 1024 * 1024, // 100MB per file (достаточно для больших PDF)
    files: 10 // max 10 files
  } 
});
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/server/uploads';
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch {}
app.use('/uploads', express.static(UPLOAD_DIR));

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
  '2. ПРАВИЛА: Строго соблюдай правила D&D 5e. Используй характеристики персонажей (STR, DEX, CON, INT, WIS, CHA), классы и навыки. ' +
  '3. ПРОВЕРКИ: Для любых действий, исход которых не очевиден, запрашивай проверки характеристик (d20 + модификатор). Модификатор = (характеристика-10)/2. ' +
  '4. СПАСБРОСКИ: При опасностях запрашивай спасброски (STR/DEX/CON/INT/WIS/CHA) и учитывай их результат. ' +
  '5. ПРЕИМУЩЕСТВО/ПОМЕХА: Если условия дают преимущество или помеху, явно указывай это при броске d20. ' +
  '6. БОЙ: В случае конфликта инициируй бросок инициативы, рассчитывай попадания (бросок атаки против AC цели) и урон (согласно оружию/заклинанию). Учитывай крит на нат.20. ' +
  '7. ПАМЯТЬ: Ты работаешь с расширенным контекстом Gemini — помни всё состояние мира, инвентарь, HP и предысторию персонажей. ' +
  '8. СТИЛЬ: Пиши атмосферно, кинематографично и живо. Описывай звуки, запахи и ощущения. ' +
  '9. ОГРАНИЧЕНИЯ: Не создавай новые ключевые локации, если их нет в сценарии, но можешь описывать путь между ними. ' +
  '10. ФОРМАТ: Отвечай короткими абзацами (3-7 строк). В конце выводи доступные действия.\n' +
  '11. ПРОВЕРКИ: Если ситуация требует броска кубиков, добавь в самый конец сообщения скрытый тег формата: [[ROLL: skill_or_attack_or_save, DC: 15]]. Это вызовет окно броска у игрока (для атаки DC=AC).\n' +
  '12. ГРУППА: В игре всегда 5 персонажей. Если живых игроков меньше, ты сам управляешь остальными персонажами как союзными NPC, делая за них ходы, броски и принимая решения в бою.';
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
  try {
    const prisma = getPrisma();
    await prisma.game.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch {
    const ok = deleteGame(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
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
    const text = stripTocAndLeaders(rawText).slice(0, 200000);
    if (!text.trim()) return res.status(400).json({ error: 'pdf_empty' });
    const fast = String(req.query.fast || req.body?.fast || '') === '1';
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    let scenario: any = null;
    if ((geminiKey || apiKey) && !fast) {
      try {
        const sys = 'Ты помощник-редактор настольных приключений (D&D). Верни строго JSON-схему полного сценария для нашей игры без комментариев и лишнего текста.';
        const shape = '{ "game": {"title":"...","description":"...","author":"...","worldRules":"...","gameplayRules":"...","introduction":"...","backstory":"...","adventureHooks":"...","promoDescription":"...","ageRating":"G16","winCondition":"...","loseCondition":"...","deathCondition":"..."}, "locations":[{"key":"loc1","order":1,"title":"...","description":"...","rulesPrompt":"...","backgroundUrl":null,"musicUrl":null}], "exits":[{"fromKey":"loc1","type":"BUTTON","buttonText":"Дальше","triggerText":null,"toKey":"loc2","isGameOver":false}], "characters":[{"name":"...","isPlayable":true,"race":"...","gender":"...","avatarUrl":null,"voiceId":null,"persona":null,"origin":null,"role":null,"abilities":null,"level":1,"class":"...","hp":10,"maxHp":10,"ac":10,"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}], "editions":[{"name":"Стандарт","description":"...","price":990,"badge":null}] }';
        const prompt = `Исходный текст PDF:\n---\n${text.slice(0, 150000)}\n---\nВерни только JSON без комментариев, строго формы:\n${shape}\nТребования: 8-14 локаций, связанный граф переходов, осмысленные названия сцен и короткие (2-3 предложения) описания. Опирайся на D&D 5e и единый мир. Обязательно извлеки условия финала (winCondition, loseCondition, deathCondition) если они есть в тексте.`;
        
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
      const pickBlock = (labelRe: RegExp, labelName?: 'intro' | 'back' | 'hooks'): string | null => {
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
          if (acc.join('\n').length > 6000) break;
        }
        const s = acc.join('\n').trim();
        return s ? s.slice(0, 6000) : null;
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
      const worldRules = pickBlock(/Правила мира/i) || pickBlock(/Особенности местности/i) || '—';
      const gameplayRules = pickBlock(/Правила игрового процесса/i) || pickBlock(/Дальнейшие события/i) || '—';
      const locations = sections.length ? sections.map((s, i) => ({ key: `loc${i + 1}`, order: i + 1, title: s.title, description: s.body, backgroundUrl: null, musicUrl: null })) :
        [{ key: 'start', order: 1, title: 'Стартовая локация', description: srcText.split('\n').slice(0, 8).join('\n'), backgroundUrl: null, musicUrl: null }];
      const exits = locations.length > 1 ? locations.slice(0, -1).map((_, i) => ({ fromKey: `loc${i + 1}`, type: 'BUTTON', buttonText: 'Дальше', triggerText: null, toKey: `loc${i + 2}`, isGameOver: false })) : [];
      const characters = parseCharacterCards(srcText);
      return {
        game: { title: fixLatin1(req.file.originalname.replace(/\.pdf$/i, '')), description: 'Импортировано из PDF', author: 'GM', worldRules, gameplayRules, introduction, backstory, adventureHooks, winCondition, loseCondition, deathCondition },
        locations, exits, characters,
      };
    };
    if (!scenario || !scenario.locations || !scenario.locations.length) {
      scenario = buildScenarioFromText(text);
    } else {
      if (!scenario.game) scenario.game = {};
      if (!scenario.game.worldRules) scenario.game.worldRules = ((): string | null => {
        const blk = (text.match(/Правила мира[\s\S]{0,2000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 1800) : null;
      })();
      if (!scenario.game.gameplayRules) scenario.game.gameplayRules = ((): string | null => {
        const blk = (text.match(/Правила игрового процесса[\s\S]{0,2000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 1800) : null;
      })();
      if (!scenario.game.winCondition) scenario.game.winCondition = ((): string | null => {
        const blk = (text.match(/(?:Услови[ея]\s+побед[ыы]|Побед[аы])[\s\S]{0,2000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 1800) : null;
      })();
      if (!scenario.game.loseCondition) scenario.game.loseCondition = ((): string | null => {
        const blk = (text.match(/(?:Услови[ея]\s+поражени[яя]|Поражени[ея])[\s\S]{0,2000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 1800) : null;
      })();
      if (!scenario.game.deathCondition) scenario.game.deathCondition = ((): string | null => {
        const blk = (text.match(/(?:Услови[ея]\s+смерти|Смерть)[\s\S]{0,2000}/i)?.[0] || '').trim();
        return blk ? blk.slice(0, 1800) : null;
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

app.post('/api/admin/ingest-import', (req, res, next) => {
  upload.array('files', 10)(req, res, (err: any) => {
    if (err) {
      console.error('[INGEST-IMPORT] Multer error:', err);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large', message: 'Файл слишком большой. Максимальный размер: 100MB' });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.status(400).json({ error: 'too_many_files', message: 'Слишком много файлов. Максимум: 10' });
      }
      return res.status(500).json({ error: 'upload_error', details: String(err) });
    }
    next();
  });
}, async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    console.log('[INGEST-IMPORT] Received request, files:', files ? files.length : 0, 'req.files type:', Array.isArray(req.files) ? 'array' : typeof req.files);
    
    if (!files || files.length === 0) {
      console.error('[INGEST-IMPORT] No files received');
      return res.status(400).json({ error: 'file_required' });
    }
    
    // Проверяем, что все файлы - PDF
    for (const file of files) {
      const fileName = file.originalname || '';
      console.log('[INGEST-IMPORT] Checking file:', fileName, 'mimetype:', file.mimetype, 'size:', file.size);
      
      const ext = fileName.toLowerCase().split('.').pop() || '';
      if (!['pdf', 'txt'].includes(ext)) {
        console.error('[INGEST-IMPORT] Invalid file type:', fileName);
        return res.status(400).json({ error: 'invalid_file_type', expected: 'PDF or TXT', file: fileName });
      }
      // Не проверяем строго mimetype, так как браузер может отправлять неправильный тип
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
        set({ status: 'running', progress: `Reading ${files.length} PDF file(s)...` });
        
        // ═══════════════════════════════════════════════════════════════════════════════
        // ОБРАБОТКА ТОЛЬКО ФАЙЛА СЦЕНАРИЯ
        // ═══════════════════════════════════════════════════════════════════════════════
        
        // Обрабатываем все загруженные файлы как сценарии (объединяем их текст)
        let gameText = '';
        
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fileName = file.originalname || 'file';
          const ext = fileName.toLowerCase().split('.').pop() || '';
          const fileType = ext === 'txt' ? 'TXT' : 'PDF';
          set({ progress: `Reading ${fileType} ${i + 1}/${files.length}: СЦЕНАРИЙ - ${fileName}` });
          
          try {
            const fileName = file.originalname || '';
            const ext = fileName.toLowerCase().split('.').pop() || '';
            
            let rawText = '';
            if (ext === 'txt') {
              // Для TXT файлов просто читаем как текст
              rawText = file.buffer.toString('utf-8').replace(/\r/g, '\n');
            } else {
              // Для PDF файлов используем парсер
              const parsed = await pdfParse(file.buffer).catch(() => null);
              if (parsed && parsed.text) {
                rawText = (parsed.text || '').replace(/\r/g, '\n');
              }
            }
            
            if (rawText) {
              // Объединяем текст всех файлов
              if (gameText) gameText += '\n\n';
              gameText += rawText;
            }
          } catch (e) {
            console.error(`[INGEST-IMPORT] Error parsing file ${i + 1}:`, e);
            // Продолжаем с другими файлами
          }
        }
        
        if (!gameText || !gameText.trim()) {
          set({ status: 'error', error: 'Не удалось извлечь текст из загруженных файлов' });
          return;
        }
        
        // Очистка текста от оглавления и лишних символов
        // ВАЖНО: Страницы с оглавлением НЕ УЧИТЫВАЮТСЯ!
        const stripTocAndLeaders = (src: string): string => {
          let t = src;
          
          // Ищем начало оглавления (слово "Оглавление" в начале строки)
          const tocStartMatch = t.match(/^\s*Оглавлени[ея]\b/im);
          if (tocStartMatch && typeof tocStartMatch.index === 'number') {
            const tocStart = tocStartMatch.index;
            
            // Ищем конец оглавления - первый реальный раздел после оглавления
            // Согласно структуре: после оглавления идет "Введение", "Предыстория", "Зацепки приключения", "Часть 1", и т.д.
            const restAfterToc = t.slice(tocStart);
            
            // Ищем конец оглавления по следующим признакам:
            // 1. Заголовок "Введение" (первый раздел после оглавления)
            // 2. Заголовок "Предыстория"
            // 3. Заголовок "Зацепки приключения"
            // 4. Заголовок "Часть 1" или "Глава 1"
            // 5. Нумерованный список (1., 2., 3.)
            const tocEndPattern = /(^|\n)\s*(Введение|Предыстория|Зацепк[аи][^\n]*приключ|Часть\s+[0-9IVX]+|Глава\s+[0-9IVX]+|Сцена\s+[0-9IVX]+|Локация\s+[0-9IVX]+|^\s*\d+[\.\)]\s+[А-ЯA-Z])/im;
            const tocEndMatch = tocEndPattern.exec(restAfterToc);
            
            if (tocEndMatch && typeof tocEndMatch.index === 'number' && tocEndMatch.index > 0) {
              // Нашли конец оглавления - удаляем весь блок от начала до конца
              const tocEnd = tocStart + tocEndMatch.index;
              t = t.slice(0, tocStart) + t.slice(tocEnd);
              console.log('[INGEST-IMPORT] Removed table of contents:', tocEnd - tocStart, 'characters');
            } else {
              // Если не нашли конец по паттерну, удаляем первые 5000 символов после "Оглавление"
              // (обычно оглавление не превышает 2-3 страниц)
              const estimatedTocEnd = tocStart + Math.min(restAfterToc.length, 5000);
              t = t.slice(0, tocStart) + t.slice(estimatedTocEnd);
              console.log('[INGEST-IMPORT] Removed table of contents (estimated):', estimatedTocEnd - tocStart, 'characters');
            }
          }
          
          // Удаляем строки с точками-лидерами (например: "Введение ................ 3")
          const limit = 20000; // Увеличил лимит для лучшей обработки
          let head = t.slice(0, limit);
          const tail = t.slice(limit);
          head = head.split('\n').filter((ln) => {
            // Удаляем строки вида: "Текст ................ 3" (оглавление)
            return !/^\s*\S.{0,120}\.{3,}\s*\d+\s*$/.test(ln);
          }).join('\n');
          return head + tail;
        };
        const text = stripTocAndLeaders(gameText);
        
        set({ progress: 'AI analyzing: СЦЕНАРИЙ' });
        const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
        let scenario: any = { game: {}, locations: [], exits: [], characters: [], editions: [] };
        
        // ═══════════════════════════════════════════════════════════════════════════════
        // АНАЛИЗ СЦЕНАРИЯ: AI анализирует файл сценария
        // ═══════════════════════════════════════════════════════════════════════════════
        
        // Анализ СЦЕНАРИЯ
        if (gameText && gameText.trim()) {
          set({ progress: 'AI analyzing: ИГРА И СЦЕНАРИЙ' });
          try {
            const sys = `Ты интеллектуальный ассистент для анализа сценариев настольных ролевых игр D&D 5e. 

Твоя задача - понять СМЫСЛОВОЕ значение каждого элемента документа и правильно сопоставить его с полями на фронтенде.

На фронтенде есть следующие разделы и поля:
1. "Описание и промо" - содержит промо описание (краткое привлекательное описание для маркетинга)
2. "Введение / Предыстория / Зацепки приключения" - три отдельных поля:
   - Введение: начало игры, где находятся персонажи, описание начальной сцены
   - Предыстория: история мира/событий до начала игры
   - Зацепки приключения: способы начать приключение, мотивация персонажей
3. "Локации" - игровые локации с описаниями, правилами, фонами, музыкой
4. "Персонажи" - NPC с полной статистикой D&D 5e
5. "Условия финала" - условия победы, поражения, смерти

Ты должен РАСПОЗНАТЬ смысл каждого элемента в документе и правильно сопоставить его с нужным полем, понимая КОНТЕКСТ и НАЗНАЧЕНИЕ каждого поля.`;

            const shape = '{ "game": {"title":"...","description":"...","author":"...","introduction":"...","backstory":"...","adventureHooks":"...","promoDescription":"...","winCondition":"...","loseCondition":"...","deathCondition":"..."}, "locations":[{"key":"loc1","order":1,"title":"...","description":"...","rulesPrompt":"..."}], "exits":[{"fromKey":"loc1","type":"BUTTON","buttonText":"Дальше","triggerText":null,"toKey":"loc2","isGameOver":false}], "characters":[{"name":"...","isPlayable":false,"race":"...","gender":"...","level":1,"class":"...","hp":10,"maxHp":10,"ac":10,"str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10}] }';
            
            const prompt = `Ты анализируешь документ сценария для настольной ролевой игры D&D 5e.

Текст документа (оглавление уже удалено):
---
${text.slice(0, 100000)}
---

Верни только JSON без комментариев, строго формы:
${shape}

═══════════════════════════════════════════════════════════════════════════════
СЕМАНТИЧЕСКОЕ ОПИСАНИЕ ПОЛЕЙ И ИНСТРУКЦИИ ПО РАСПОЗНАВАНИЮ
═══════════════════════════════════════════════════════════════════════════════

1. ПРОМО ОПИСАНИЕ (game.promoDescription)
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: Краткое привлекательное описание игры для маркетинга,
   отображается в разделе "Описание и промо". Это "крючок" для привлечения игроков.
   
   ЧТО ИСКАТЬ:
   - Текст ПЕРЕД первым разделом "Введение" (обычно в самом начале документа)
   - Краткое описание (2-4 предложения), которое создает атмосферу и интригует
   - Может начинаться с большой декоративной буквы (drop cap)
   - Обычно описывает сеттинг, ключевой конфликт, или атмосферу приключения
   - Пример: "Люмерия, недавно пережившая великое предательство от главы храма
     Мистры епископа Элиона, погружается в новые тайны..."
   
   КАК РАСПОЗНАТЬ:
   - Это НЕ метаинформация (не про уровень персонажей)
   - Это НЕ техническое описание
   - Это художественный текст, который "продает" игру
   - Ищи текст от начала документа до первого заголовка "Введение"
   - Извлеки весь текст, БЕЗ заголовка "Введение"

2. ВВЕДЕНИЕ (game.introduction)
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: Описание начальной сцены игры, где находятся персонажи
   в момент начала приключения. Это то, что видит/слышит игрок в начале игры.
   
   ЧТО ИСКАТЬ:
   - РЕАЛЬНОЕ введение к игре - описание начальной локации/сцены
   - Текст, который описывает, где находятся персонажи и что они видят
   - Обычно начинается с "Вы прибываете...", "Вы оказываетесь...", 
     "Приключение начинается, когда герои прибывают..."
   - Описывает конкретную сцену, локацию, окружение, атмосферу
   - Пример: "Вы прибываете в большое каменное здание с синей крышей, фасад
     которого украшен резьбой и лепниной. Помещение разделено на два этажа..."
   
   ЧТО НЕ ПОДХОДИТ (МЕТА-ВВЕДЕНИЕ):
   - "Приключение рассчитано на персонажей 2-3-го уровня..."
   - "Является продолжением истории..."
   - "Если игроки не проходили указанное выше приключение..."
   - Любая информация об уровне персонажей, связи с другими приключениями
   
   КАК РАСПОЗНАТЬ:
   - В документе может быть НЕСКОЛЬКО разделов "Введение"
   - Игнорируй мета-введения (техническая информация для мастера)
   - Ищи введение, которое описывает НАЧАЛЬНУЮ СЦЕНУ для игроков
   - Обычно идет ПОСЛЕ "Зацепки приключения" и ПЕРЕД "Часть 1"
   - Извлеки ВСЁ содержимое раздела (весь текст после заголовка до следующего
     раздела), БЕЗ заголовка

3. ПРЕДЫСТОРИЯ (game.backstory)
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: История мира/событий ДО начала игры. Это контекст,
   который помогает понять, что происходило раньше, почему ситуация сложилась
   именно так. Используется для понимания мира и мотивации персонажей.
   
   ЧТО ИСКАТЬ:
   - Раздел "Предыстория" или "ПРЕДЫСТОРИЯ"
   - Текст, описывающий события, которые произошли ДО начала приключения
   - История мира, конфликты, события, которые привели к текущей ситуации
   - Может описывать политическую ситуацию, исторические события, конфликты
   
   КАК РАСПОЗНАТЬ:
   - Обычно это отдельный раздел с заголовком "Предыстория"
   - Текст описывает ПРОШЛОЕ, а не текущую ситуацию
   - Может быть довольно длинным (несколько абзацев)
   - Извлеки ВСЁ содержимое раздела (весь текст после заголовка до следующего
     раздела), БЕЗ заголовка

4. ЗАЦЕПКИ ПРИКЛЮЧЕНИЯ (game.adventureHooks)
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: Способы начать приключение, мотивация персонажей.
   Это различные варианты того, как персонажи могут попасть в приключение.
   Помогает мастеру адаптировать начало под разных персонажей.
   
   ЧТО ИСКАТЬ:
   - Раздел "Зацепки приключения" или "ЗАЦЕПКИ ПРИКЛЮЧЕНИЯ"
   - Обычно содержит несколько вариантов (нумерованный список или абзацы)
   - Каждый вариант описывает, как персонажи могут начать приключение
   - Может быть привязан к предыдущим приключениям или быть независимым
   - Пример: "Зацепка 1: Персонажи получили письмо от...", 
     "Зацепка 2: Персонажи случайно наткнулись на..."
   
   КАК РАСПОЗНАТЬ:
   - Обычно это отдельный раздел с заголовком "Зацепки приключения"
   - Содержит несколько вариантов начала (обычно 2-4 варианта)
   - Может быть нумерованным списком или отдельными абзацами
   - Извлеки ВСЁ содержимое раздела (весь текст после заголовка до следующего
     раздела), БЕЗ заголовка

5. ЛОКАЦИИ (locations[])
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: Игровые локации, где происходят события. Каждая
   локация имеет описание, фон, музыку, правила для интерпретации действий.
   Игроки перемещаются между локациями в процессе игры.
   
   ЧТО ИСКАТЬ:
   - Разделы "Часть 1", "Часть 2", "Часть 3", "Глава", нумерованные подразделы
   - Каждый раздел/подраздел = отдельная локация
   - Примеры: "Часть 1. Гильдия Магов", "1. Помещение с урнами", 
     "2. Коридор с фальшивой дверью"
   
   ДЛЯ КАЖДОЙ ЛОКАЦИИ ИЗВЛЕКИ:
   - title: название раздела/подраздела (например, "Помещение с урнами")
   - description: описание локации (2-5 предложений) - что видит игрок,
     атмосфера, ключевые объекты
   - rulesPrompt: правила для этой локации (если есть) - проверки навыков,
     условия для переходов, интерактивные элементы
     Пример: "Проверка Мудрости (Восприятие) Сл 10 (осмотр урн)"
   
   КАК РАСПОЗНАТЬ:
   - Ищи все разделы с заголовками "Часть", "Глава", нумерованные списки
   - Каждый раздел описывает отдельное место/сцену в приключении
   - Подразделы внутри частей тоже могут быть отдельными локациями
   - Извлеки название, описание и правила для каждой локации

6. ПЕРСОНАЖИ (characters[])
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: NPC (неигровые персонажи), с которыми взаимодействуют
   игроки. Каждый NPC имеет полную статистику D&D 5e для боевых сцен и
   взаимодействия. Используется AI для ролевой игры от лица NPC.
   
   ЧТО ИСКАТЬ:
   - Раздел "Приложение В. Статистика НИП" или похожий
   - Статистика NPC в формате D&D 5e
   - Может быть в формате "Long Story Short" или стандартном D&D формате
   
   ДЛЯ КАЖДОГО NPC ИЗВЛЕКИ:
   - name: имя персонажа
   - race: раса (человек, эльф, дварф и т.д.)
   - gender: пол
   - level: уровень
   - class: класс (воин, маг, жрец и т.д.)
   - hp, maxHp: текущее и максимальное здоровье
   - ac: класс брони
   - str, dex, con, int, wis, cha: характеристики (Сила, Ловкость, Телосложение,
     Интеллект, Мудрость, Харизма)
   - isPlayable: false (все NPC неиграбельные)
   
   КАК РАСПОЗНАТЬ:
   - Ищи раздел со статистикой NPC (обычно в конце документа)
   - Может быть в таблице или текстовом формате
   - Извлеки ВСЕХ NPC с полной статистикой

7. УСЛОВИЯ ФИНАЛА
   ────────────────────────────────────────────────────────────────────────────
   НАЗНАЧЕНИЕ НА ФРОНТЕ: Условия завершения игры - победа, поражение, смерть.
   Используется для определения финала игры и перехода к экрану результатов.
   
   ЧТО ИСКАТЬ:
   - winCondition: "Условия победы" или "Победа" - что нужно сделать для победы
   - loseCondition: "Условия поражения" или "Поражение" - что приводит к поражению
   - deathCondition: "Условия смерти" или "Смерть" - что приводит к смерти
   
   КАК РАСПОЗНАТЬ:
   - Обычно это отдельные разделы в конце документа
   - Могут быть в разделе "Финал" или "Условия завершения"
   - Извлеки описание каждого условия

═══════════════════════════════════════════════════════════════════════════════
КРИТИЧЕСКИ ВАЖНО:
═══════════════════════════════════════════════════════════════════════════════

1. ПОНИМАЙ СМЫСЛ: Не просто ищи по ключевым словам, а ПОНИМАЙ, что означает
   каждый элемент и для чего он нужен на фронте.

2. РАСПОЗНАВАЙ КОНТЕКСТ: Один и тот же заголовок может означать разное в
   разных контекстах. Анализируй СОДЕРЖИМОЕ, а не только заголовки.

3. ИЗВЛЕКАЙ ВСЁ: Не обрезай текст. Извлекай ВСЁ содержимое разделов, чтобы
   на фронте была полная информация.

4. НЕ ПРИДУМЫВАЙ: Извлекай ТОЛЬКО реальные данные из документа. Если раздела
   нет - верни null, не придумывай содержимое.

5. ПРАВИЛЬНО СОПОСТАВЛЯЙ: Каждый элемент должен попасть в правильное поле,
   понимая его назначение на фронте.

Верни ТОЛЬКО JSON, никаких комментариев!`;
            
            const { text: content } = await generateChatCompletion({
              systemPrompt: sys,
              userPrompt: prompt,
              history: []
            });
            
            if (content && content.trim().includes('{')) {
              const startIdx = content.indexOf('{');
              const endIdx = content.lastIndexOf('}');
              const cleaned = content.slice(startIdx, endIdx + 1);
              const gameData = JSON.parse(cleaned);
              
              // Объединяем данные игры
              if (gameData.game) {
                Object.assign(scenario.game, gameData.game);
              }
              if (Array.isArray(gameData.locations) && gameData.locations.length > 0) {
                scenario.locations = gameData.locations;
              }
              if (Array.isArray(gameData.exits) && gameData.exits.length > 0) {
                scenario.exits = gameData.exits;
              }
              // Добавляем персонажей из игры (обычно NPC)
              if (Array.isArray(gameData.characters) && gameData.characters.length > 0) {
                scenario.characters.push(...gameData.characters);
                console.log('[INGEST-IMPORT] NPCs extracted from game:', gameData.characters.length);
              }
              console.log('[INGEST-IMPORT] Game extracted:', { 
                hasTitle: !!gameData.game?.title, 
                locationsCount: gameData.locations?.length || 0,
                exitsCount: gameData.exits?.length || 0,
                charactersCount: gameData.characters?.length || 0
              });
            }
          } catch (e) {
            console.error('[INGEST-IMPORT] Game analysis failed:', e);
          }
        }
        
        const ensureScenario = (sc: any, gameText: string) => {
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
          const firstFileName = files[0]?.originalname || 'Scenario';
          out.game = out.game || { title: firstFileName.replace(/\.pdf$/i, ''), description: `Импортировано из ${files.length} PDF файл(ов)`, author: 'GM', worldRules: '—', gameplayRules: '—' };
          
          // НЕТ FALLBACK - если AI не извлек данные, поля остаются пустыми
          // Все данные должны быть извлечены AI из промпта
          if (!Array.isArray(out.exits) || !out.exits.length) {
            out.exits = [];
            for (let i = 1; i < out.locations.length; i++) {
              out.exits.push({ fromKey: `loc${i}`, type: 'BUTTON', buttonText: 'Дальше', triggerText: null, toKey: `loc${i + 1}`, isGameOver: false });
            }
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
        scenario = ensureScenario(scenario, gameText);
        set({ progress: 'Import scenario' });
        const prisma = getPrisma();
        const g = scenario.game || {};
        const firstFileName = files[0]?.originalname || 'Scenario';
        const game = await prisma.game.create({
          data: {
            title: g.title || firstFileName.replace(/\.pdf$/i, ''),
            description: g.description || `Импортировано из ${files.length} PDF файл(ов)`,
            author: g.author || 'GM',
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
            winCondition: g.winCondition || null,
            loseCondition: g.loseCondition || null,
            deathCondition: g.deathCondition || null,
          },
        });
        const keyToId = new Map<string, string>();
        for (let i = 0; i < scenario.locations.length; i++) {
          const l = scenario.locations[i] || {};
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
        let createdExits = 0;
        for (const e of scenario.exits) {
          const fromId = keyToId.get(String(e.fromKey || ''));
          const toId = e.toKey ? keyToId.get(String(e.toKey)) : null;
          if (!fromId) continue;
          await prisma.locationExit.create({
            data: {
              locationId: fromId,
              type: (e.type || 'BUTTON') as any,
              buttonText: e.buttonText || null,
              triggerText: e.triggerText || null,
              targetLocationId: toId || null,
              isGameOver: Boolean(e.isGameOver),
            },
          });
          createdExits++;
        }
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
        
        // Валидация: проверка наличия игровых персонажей
        const playableChars = await prisma.character.findMany({ 
          where: { gameId: game.id, isPlayable: true } 
        });
        if (playableChars.length === 0) {
          // Удаляем игру, если нет игровых персонажей
          await prisma.game.delete({ where: { id: game.id } });
          set({ 
            status: 'error', 
            error: 'Игра должна содержать хотя бы одного игрового персонажа. Добавьте персонажей с флагом isPlayable: true.' 
          });
          return;
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
          const prompt = [guidance, `Сцена: ${loc.title}`, (loc.description || ''), (g.worldRules || ''), (g.gameplayRules || '')].filter(Boolean).join('\n\n').slice(0, 1600);
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
    const prompt = [guidance, `Сцена: ${loc.title}`, (loc.description || ''), (game.worldRules || ''), (game.gameplayRules || '')]
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
      await prisma.locationExit.create({
        data: {
          locationId: fromId,
          type: (e.type || 'BUTTON') as any,
          buttonText: e.buttonText || null,
          triggerText: e.triggerText || null,
          targetLocationId: toId || null,
          isGameOver: Boolean(e.isGameOver),
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
            const prompt = [guidance, `Сцена: ${loc.title}`, (loc.description || ''), (game.worldRules || ''), (game.gameplayRules || '')].filter(Boolean).join('\n\n').slice(0, 1600);
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
            'Играй от лица рассказчика, а не игрока: избегай фраз “вы решаете”, “вы начинаете”, “вы выбираете”. ' +
            'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
            'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
            'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
            'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
            'Если игрок пишет что-то вне кнопок — мягко возвращай его к выбору, но через атмосферное описание. ' +
            'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
          const sc = await buildGptSceneContext(prisma, { gameId: lob.gameId, lobbyId: lob.id, history: [] });
          const { text: generatedText } = await generateChatCompletion({
            systemPrompt: sys,
            userPrompt: 'Контекст сцены:\n' + sc,
            history: []
          });
          let text = generatedText;
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
          await prisma.chatSession.upsert({
            where: { userId_gameId: { userId: 'lobby:' + lob.id, gameId: lob.gameId } },
            update: { history: ([{ from: 'bot', text }] as any) },
            create: { userId: 'lobby:' + lob.id, gameId: lob.gameId, history: ([{ from: 'bot', text }] as any) },
          });
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
        gsess = await prisma.gameSession.create({ data: { scenarioGameId: gameId, lobbyId, userId: null, currentLocationId: first.id, state: {} as any } });
      } else if (gsess.currentLocationId !== first.id) {
        gsess = await prisma.gameSession.update({ where: { id: gsess.id }, data: { currentLocationId: first.id, state: {} as any } });
      }
      const loc = await prisma.location.findUnique({ where: { id: first.id } });
      const game = await prisma.game.findUnique({ where: { id: gameId } });
      const chars = await prisma.character.findMany({ where: { gameId }, take: 6 });
      const base = loc?.description || '';
      const offlineText = ([
        `Сцена: ${loc?.title || 'Локация'}`,
        base,
        game?.worldRules ? `Правила мира: ${game.worldRules}` : '',
        game?.gameplayRules ? `Правила процесса: ${game.gameplayRules}` : '',
      ].filter(Boolean).join('\n\n')).trim();
      let text = offlineText;
      if (apiKey) {
        try {
          const client = createOpenAIClient(apiKey);
          const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
          const sys = getSysPrompt();
            'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
            'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
            'Играй от лица рассказчика, а не игрока: избегай фраз “вы решаете”, “вы начинаете”, “вы выбираете”. ' +
            'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
            'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
            'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
            'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
            'Если игрок пишет что-то вне кнопок — мягко возвращай его к выбору, но через атмосферное описание. ' +
            'После атмосферного описания всегда выводи чёткие варианты действий, опираясь на кнопки текущей сцены. ' +
            'Обязательно формулируй их коротко и ясно, чтобы игрок понял, что делать дальше. ' +
            'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
          const visual = loc?.backgroundUrl ? `Фон (изображение): ${loc.backgroundUrl}` : '';
          const rules = [
            game?.worldRules ? `Правила мира: ${game.worldRules}` : '',
            game?.gameplayRules ? `Правила процесса: ${game.gameplayRules}` : '',
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
            `Сцена: ${loc?.title}`,
            visual,
            base ? `Описание сцены: ${base}` : '',
            rules,
            npcs,
          ].filter(Boolean).join('\n\n');
          const { text: generatedText } = await generateChatCompletion({
            systemPrompt: sys,
            userPrompt: userMsg,
            history: []
          });
          text = generatedText || offlineText;
          if (text) text = (text || '').trim();
        } catch {
          text = offlineText;
        }
      }
      await prisma.chatSession.upsert({
        where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId } },
        update: { history: ([{ from: 'bot', text }] as any) },
        create: { userId: 'lobby:' + lobbyId, gameId, history: ([{ from: 'bot', text }] as any) },
      });
      wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
      return res.json({ message: '', fallback: !Boolean(apiKey) });
    }
    // SOLO: стартуем/возобновляем движок c первой локации и даём описание с действиями из сцены
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    const client = apiKey ? createOpenAIClient(apiKey) : null;
    const sys = getSysPrompt();
      'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
      'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
      'Играй от лица рассказчика, а не игрока: избегай фраз “вы решаете”, “вы начинаете”, “вы выбираете”. ' +
      'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
      'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
      'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
      'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
      'Если игрок пишет что-то вне кнопок — мягко возвращай его к выбору, но через атмосферное описание. ' +
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
      sess = await prisma.gameSession.create({ data: { scenarioGameId: gameId, userId: uid, currentLocationId: first.id, state: {} as any } });
    } else if (!sess.currentLocationId) {
      sess = await prisma.gameSession.update({ where: { id: sess.id }, data: { currentLocationId: first.id } });
    }
    const sc = await buildGptSceneContext(prisma, { gameId, userId: uid, history: [] });
    const { text: generatedText } = await generateChatCompletion({
      systemPrompt: sys,
      userPrompt: 'Контекст сцены:\n' + sc,
      history: []
    });
    let text = generatedText;
    if (!text) {
      // Сформируем атмосферное вступление из данных сцены
      try {
        const first = await prisma.location.findFirst({ where: { gameId }, orderBy: { order: 'asc' } });
        const intro = [
          first?.title ? `Сцена: ${first.title}` : '',
          first?.description || '',
          'Тусклый свет дрожит на камне. Мир ждёт вашего шага.',
        ].filter(Boolean).join('\n\n');
        text = intro || 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.';
      } catch {
        text = 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.';
      }
    }
    text = (text || '').trim();
    await prisma.chatSession.upsert({
      where: { userId_gameId: { userId: uid, gameId } },
      update: { history: ([{ from: 'bot', text }] as any) },
      create: { userId: uid, gameId, history: ([{ from: 'bot', text }] as any) },
    });
    return res.json({ message: text, fallback: !Boolean(client) });
  } catch (e) {
    console.error('Welcome handler error:', e);
    return res.json({ message: 'Тусклый свет дрожит на стенах. Мир ждёт вашего шага. Осмотритесь или выберите направление.', fallback: true });
  }
});

app.post('/api/chat/reply', async (req, res) => {
  const gameId = typeof req.body?.gameId === 'string' ? req.body.gameId : undefined;
  const lobbyId = typeof req.body?.lobbyId === 'string' ? req.body.lobbyId : undefined;
  const userText = typeof req.body?.userText === 'string' ? req.body.userText : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [] as Array<{ from: 'bot' | 'me'; text: string }>;
  const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
  try {
    const prisma = getPrisma();
    // СНАЧАЛА пытаемся смэпить ввод игрока к кнопке/триггеру и сменить сцену (если есть активная сессия)
    let forcedGameOver = false;
    if (gameId) {
      try {
        let sess: any = null;
        if (lobbyId) {
          sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
        } else {
          const uid = await resolveUserIdFromQueryOrBody(req, prisma);
          if (uid) sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
        }
        if (sess?.currentLocationId) {
          const curLocId = sess.currentLocationId;
          const exits = await prisma.locationExit.findMany({ where: { locationId: curLocId } });
          const low = userText.toLowerCase().trim();
          let chosen: any = null;
          // цифрой 1..N по порядку кнопок
          const btns = exits.filter((e: any) => e.type === 'BUTTON');
          const num = low.match(/^([1-9])$/);
          if (num && btns.length) {
            const idx = Math.min(btns.length, Math.max(1, parseInt(num[1], 10))) - 1;
            chosen = btns[idx] || null;
          }
          // текст кнопки
          if (!chosen && btns.length && low) {
            chosen = btns.find((b: any) => (b.buttonText || '').toLowerCase() && low.includes((b.buttonText || '').toLowerCase())) || null;
          }
          // триггер
          if (!chosen && low) {
            chosen = exits.find((e: any) => (e.triggerText || '').toLowerCase() && low.includes((e.triggerText || '').toLowerCase())) || null;
          }
          if (chosen) {
            if (chosen.isGameOver || chosen.type === 'GAMEOVER') {
              try {
                const state = (await prisma.gameSession.findUnique({ where: { id: sess.id }, select: { state: true } }))?.state as any || {};
                state.finishedAt = new Date().toISOString();
                state.finishReason = 'game_over';
                await prisma.gameSession.update({ where: { id: sess.id }, data: { state } });
                forcedGameOver = true;
              } catch {}
            } else if (chosen.targetLocationId) {
              await prisma.gameSession.update({ where: { id: sess.id }, data: { currentLocationId: chosen.targetLocationId } });
            }
          }
        }
      } catch {}
    }
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
        return res.json({ message: finalText, fallback: false, gameOver: true });
      } else {
        const uid = await resolveUserIdFromQueryOrBody(req, prisma);
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
        return res.json({ message: finalText, fallback: false, gameOver: true });
      }
    }
    let actingUserId: string | null = null;
    if (lobbyId) {
      const uid = await resolveUserIdFromQueryOrBody(req, prisma);
      if (!uid) return res.status(400).json({ error: 'user_required' });
      const t = lobbyTurns.get(lobbyId);
      if (t && t.order.length && t.order[t.idx] !== uid) return res.status(403).json({ error: 'not_your_turn' });
      actingUserId = uid;
    }
    const game = gameId ? await prisma.game.findUnique({ where: { id: gameId }, include: { characters: true, locations: { orderBy: { order: 'asc' } } } }) : null;
    const playable = (game?.characters || []).filter((c: any) => c.isPlayable);
    let npcs: any[] = [];
    try {
      if (gameId) {
        npcs = await prisma.character.findMany({ where: { gameId, OR: [{ isPlayable: false }, { isPlayable: null }] }, take: 6 });
      }
    } catch {}
    const sys = getSysPrompt();
      'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
      'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
      'Играй от лица рассказчика, а не игрока: избегай фраз “вы решаете”, “вы начинаете”, “вы выбираете”. ' +
      'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
      'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
      'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
      'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
      'Если игрок пишет что-то вне кнопок — мягко возвращай его к выбору, но через атмосферное описание. ' +
      'После атмосферного описания всегда выводи чёткие варианты действий, опираясь на кнопки текущей сцены. ' +
      'Обязательно формулируй их коротко и ясно, чтобы игрок понял, что делать дальше. ' +
      'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
    const context: string[] = [];
    if (game) {
      context.push(`Игра: ${game.title}`);
      if (game.description) context.push(`Описание: ${game.description}`);
      if (game.worldRules) context.push(`Правила мира: ${game.worldRules}`);
      if (game.gameplayRules) context.push(`Правила процесса: ${game.gameplayRules}`);
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
        context.push('Игровые персонажи D&D 5e:\n' + playable.map((p: any) => {
          const traits = [p.role, p.class, p.race, p.gender].filter(Boolean).join(', ');
          const stats = `HP: ${p.hp}/${p.maxHp}, AC: ${p.ac}, STR:${p.str}, DEX:${p.dex}, CON:${p.con}, INT:${p.int}, WIS:${p.wis}, CHA:${p.cha}`;
          const extras = [p.persona, p.origin].filter(Boolean).join('. ');
          const abilities = p.abilities ? `; способности: ${String(p.abilities).slice(0, 200)}` : '';
          return `- ${p.name} (${traits}) — ${stats}. ${extras}${abilities}`;
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
          let sessCur: any = null;
          if (lobbyId) {
            sessCur = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
          } else {
            const uidTmp = await resolveUserIdFromQueryOrBody(req, prisma);
            if (uidTmp) sessCur = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uidTmp } });
          }
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
          const uid = await resolveUserIdFromQueryOrBody(req, prisma);
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
        const s = lobbyId
          ? await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } })
          : (async () => {
              const uid = await resolveUserIdFromQueryOrBody(req, prisma);
              if (!uid) return null;
              return prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId: uid } });
            })();
        const sx = (await s) as any;
        const locCur = sx?.currentLocationId ? await prisma.location.findUnique({ where: { id: sx.currentLocationId } }) : null;
        const desc = String(locCur?.rulesPrompt || locCur?.description || 'Текущая сцена без описания.');
        return `Техническая ошибка. Описание текущей сцены:\n${desc}`;
      } catch {
        return 'Техническая ошибка. Продолжение будет доступно позже.';
      }
    };

    const sc = await (async () => {
      try {
        if (gameId) {
          return await buildGptSceneContext(prisma, {
            gameId,
            lobbyId,
            userId: lobbyId ? undefined : (await resolveUserIdFromQueryOrBody(req, prisma)),
            history: baseHistory,
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

    const { text: generatedText } = await generateChatCompletion({
      systemPrompt: sys,
      userPrompt: userPrompt,
      history: baseHistory
    });

    let text = generatedText;
    if (!text) {
      text = await fallbackBranch();
      return res.json({ message: text, fallback: true });
    }

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
    }

    if (lobbyId) {
      const sess = await prisma.chatSession.upsert({
        where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } },
        update: {},
        create: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown', history: [] as any },
      });
      const prev = ((sess.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
      const newHist = prev.concat([
        (actingUserId ? ({ from: 'user', userId: actingUserId, text: userText } as any) : ({ from: 'me', text: userText } as any)),
        { from: 'bot', text } as any,
      ]);
      await prisma.chatSession.update({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } }, data: { history: newHist as any } });
      advanceTurn(lobbyId);
      wsNotifyLobby(lobbyId, { type: 'chat_updated', lobbyId });
      return res.json({ message: text, fallback: false, requestDice: aiRequestDice });
    } else {
      const uid = await resolveUserIdFromQueryOrBody(req, prisma);
      if (uid) {
        const sess = await prisma.chatSession.upsert({
          where: { userId_gameId: { userId: uid, gameId: gameId || 'unknown' } },
          update: {},
          create: { userId: uid, gameId: gameId || 'unknown', history: [] as any },
        });
        const prev = ((sess.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
        const newHist = prev.concat([
          { from: 'me', text: userText } as any,
          { from: 'bot', text } as any,
        ]);
        await prisma.chatSession.update({ where: { userId_gameId: { userId: uid, gameId: gameId || 'unknown' } }, data: { history: newHist as any } });
      }
      return res.json({ message: text, fallback: false, requestDice: aiRequestDice });
    }
  } catch (e) {
    console.error('Reply handler error:', e);
    return res.status(200).json({ message: 'Связь с рассказчиком на мгновение прерывается. Но путь остаётся прежним.\n\n1) К реке.\n2) К волчьей тропе.\n3) В деревню.', fallback: true });
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
    } else {
      const preserve = req.body?.preserve === true;
      if (!preserve && sess.currentLocationId !== first.id) {
        sess = await prisma.gameSession.update({
          where: { id: sess.id },
          data: { currentLocationId: first.id, state: {} as any },
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
      game?.worldRules ? `Правила мира: ${game.worldRules}` : '',
      game?.gameplayRules ? `Правила процесса: ${game.gameplayRules}` : '',
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
      game?.worldRules ? `Правила мира: ${game.worldRules}` : '',
      game?.gameplayRules ? `Правила процесса: ${game.gameplayRules}` : '',
      (game as any)?.introduction ? `Введение: ${(game as any).introduction}` : '',
      (game as any)?.backstory ? `Предыстория: ${(game as any).backstory}` : '',
      (game as any)?.adventureHooks ? `Зацепки приключения: ${(game as any).adventureHooks}` : '',
      (game as any)?.author ? `Автор: ${(game as any).author}` : '',
      game?.ageRating ? `Возрастной рейтинг: ${game.ageRating}` : '',
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
      if (text) text = text.trim();
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
      const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
      if (apiKey && exits.length) {
        try {
          const client = createOpenAIClient(apiKey);
          const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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
          const r = await client.chat.completions.create({
            model,
            temperature: 0.0,
            max_tokens: 50,
            response_format: { type: 'json_object' } as any,
            messages: [
              { role: 'system', content: 'Отвечай только валидным JSON.' },
              { role: 'user', content: prompt },
            ],
          });
          const content = r.choices?.[0]?.message?.content || '{}';
          const parsed = JSON.parse(content) as { exitId?: string };
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
    const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
    if (!req.file || !req.file.buffer) return res.status(200).json({ text: '', error: 'no_audio' });
    const yandexKey = process.env.YANDEX_TTS_API_KEY || process.env.YC_TTS_API_KEY || process.env.YC_API_KEY || process.env.YANDEX_API_KEY;
    if (yandexKey) {
      try {
        const ytext = await transcribeYandex(req.file.buffer as Buffer, req.file.originalname || 'audio', req.file.mimetype || 'audio/ogg', yandexKey);
        if (ytext && ytext.trim()) return res.json({ text: ytext });
      } catch (e) {
        console.error('Yandex STT failed:', e);
      }
    }
    if (!apiKey) return res.status(200).json({ text: '', error: 'no_api_key' });
    const client = createOpenAIClient(apiKey);
    const tryModels = [
      'whisper-1',
      process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe',
      'gpt-4o-transcribe',
    ];
    const file = await toFile(req.file.buffer, req.file.originalname || 'audio', { type: req.file.mimetype || 'audio/webm' });
    let lastErr: unknown = null;
    for (const model of tryModels) {
      try {
        const r = await client.audio.transcriptions.create({ model, file, language: 'ru', response_format: 'json' as any });
        const text = (r as any)?.text || '';
        if (text && String(text).trim()) return res.json({ text });
      } catch (e) {
        lastErr = e;
        console.error('Transcribe attempt failed:', model, e);
      }
    }
    try {
      const raw = await transcribeViaHttp(req.file.buffer as Buffer, req.file.originalname || 'audio', req.file.mimetype || 'audio/webm', apiKey);
      if (raw && raw.trim()) return res.json({ text: raw });
    } catch {}
    console.error('Transcribe failed (all models):', lastErr);
    const detail = (lastErr && typeof lastErr === 'object' ? JSON.stringify(lastErr) : String(lastErr || ''));
    return res.status(200).json({ text: '', error: 'transcribe_failed', detail });
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

// Функция выбора голоса Google TTS на основе персонажа/локации
function selectVoiceForContext(params: {
  characterId?: string;
  locationId?: string;
  gender?: string | null;
  characterGender?: string | null;
  isNarrator?: boolean;
  locationType?: string | null;
}): { voice: string; pitch: number; rate: number } {
  const { characterId, locationId, gender, characterGender, isNarrator, locationType } = params;
  
  // Определяем пол для выбора голоса
  const finalGender = characterGender || gender || null;
  const isFemale = finalGender && (finalGender.toLowerCase().includes('жен') || finalGender.toLowerCase().includes('female') || finalGender.toLowerCase().includes('f'));
  const isMale = finalGender && (finalGender.toLowerCase().includes('муж') || finalGender.toLowerCase().includes('male') || finalGender.toLowerCase().includes('m'));
  
  // Google TTS голоса для русского языка:
  // ru-RU-Wavenet-A - мужской, глубокий
  // ru-RU-Wavenet-B - мужской, нейтральный
  // ru-RU-Wavenet-C - женский, нейтральный
  // ru-RU-Wavenet-D - нейтральный/универсальный (по умолчанию)
  // ru-RU-Wavenet-E - женский, мягкий
  
  let voice = 'ru-RU-Wavenet-D'; // По умолчанию - нейтральный
  let pitch = 0.0; // Нейтральная интонация
  let rate = 1.0; // Нормальный темп
  
  // Выбор голоса на основе персонажа
  if (characterId && !isNarrator) {
    if (isFemale) {
      voice = 'ru-RU-Wavenet-E'; // Женский, мягкий
      pitch = 2.0; // Немного выше для женского голоса
    } else if (isMale) {
      voice = 'ru-RU-Wavenet-B'; // Мужской, нейтральный
      pitch = -1.0; // Немного ниже для мужского голоса
    } else {
      voice = 'ru-RU-Wavenet-D'; // Нейтральный
    }
  } else if (isNarrator) {
    // Для рассказчика используем нейтральный голос с небольшими вариациями
    voice = 'ru-RU-Wavenet-D';
    pitch = 0.0;
    rate = 0.95; // Немного медленнее для повествования
  } else if (locationType) {
    // Выбор голоса на основе типа локации
    const locType = locationType.toLowerCase();
    if (locType.includes('темн') || locType.includes('подзем') || locType.includes('пещер')) {
      voice = 'ru-RU-Wavenet-B'; // Мужской, более глубокий для мрачных локаций
      pitch = -1.5;
      rate = 0.9; // Медленнее для атмосферы
    } else if (locType.includes('светл') || locType.includes('лес') || locType.includes('природ')) {
      voice = 'ru-RU-Wavenet-E'; // Женский, мягкий для светлых локаций
      pitch = 1.5;
      rate = 1.05; // Немного быстрее
    } else {
      voice = 'ru-RU-Wavenet-D'; // Нейтральный
    }
  }
  
  return { voice, pitch, rate };
}

app.post('/api/tts', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const voiceReq = typeof req.body?.voice === 'string' ? req.body.voice : undefined;
    const format = typeof req.body?.format === 'string' ? req.body.format : 'mp3';
    const speedReq = typeof req.body?.speed === 'string' ? parseFloat(req.body.speed) : undefined;
    const pitchReq = typeof req.body?.pitch === 'string' ? parseFloat(req.body.pitch) : undefined;
    const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'ru-RU';
    
    // Контекст для выбора голоса
    const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : undefined;
    const locationId = typeof req.body?.locationId === 'string' ? req.body.locationId : undefined;
    const gender = typeof req.body?.gender === 'string' ? req.body.gender : undefined;
    const isNarrator = typeof req.body?.isNarrator === 'boolean' ? req.body.isNarrator : false;
    
    if (!text.trim()) return res.status(400).json({ error: 'text_required' });
    
    // Получаем информацию о персонаже/локации из базы данных для выбора голоса
    let characterGender: string | null = null;
    let locationType: string | null = null;
    
    if (characterId || locationId) {
      try {
        const prisma = getPrisma();
        if (characterId) {
          const char = await prisma.character.findUnique({ where: { id: characterId }, select: { gender: true } });
          if (char) characterGender = char.gender;
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
    
    // Выбираем голос на основе контекста
    const voiceContext = selectVoiceForContext({
      characterId,
      locationId,
      gender: gender || characterGender,
      characterGender,
      isNarrator,
      locationType,
    });
    
    // Используем выбранный голос или переданный явно
    const finalVoice = voiceReq || voiceContext.voice;
    const finalSpeed = speedReq !== undefined ? speedReq : voiceContext.rate;
    const finalPitch = pitchReq !== undefined ? pitchReq : voiceContext.pitch;
    
    // Google Cloud TTS (приоритет) - используем REST API
    const googleKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_CLOUD_API_KEY || process.env.GOOGLE_API_KEY;
    const googleCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    
    if (googleKey || googleCreds) {
      try {
        let accessToken: string | null = null;
        
        // Если используется Service Account, получаем access token
        if (googleCreds) {
          try {
            const { TextToSpeechClient } = await import('@google-cloud/text-to-speech');
            const client = new TextToSpeechClient({ keyFilename: googleCreds });
            // Для Service Account используем клиент напрямую
            const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const ssmlText = `<speak><prosody rate="${Math.max(0.75, Math.min(1.25, speedReq))}" pitch="${pitchReq >= 0 ? '+' : ''}${Math.max(-5.0, Math.min(5.0, pitchReq))}st">${escapedText}</prosody></speak>`;
            
            let voiceName = 'ru-RU-Wavenet-D';
            if (voiceReq.includes('ru-RU')) {
              voiceName = voiceReq;
            } else if (voiceReq === 'female' || voiceReq === 'jane' || voiceReq === 'oksana') {
              voiceName = 'ru-RU-Wavenet-E';
            } else if (voiceReq === 'male') {
              voiceName = 'ru-RU-Wavenet-B';
            }
            
            const [response] = await client.synthesizeSpeech({
              input: { ssml: ssmlText },
              voice: {
                languageCode: lang,
                name: voiceName,
                ssmlGender: voiceName.includes('E') || voiceName.includes('C') ? 'FEMALE' : 'MALE',
              },
              audioConfig: {
                audioEncoding: format === 'oggopus' ? 'OGG_OPUS' : 'MP3',
                speakingRate: Math.max(0.75, Math.min(1.25, finalSpeed)),
                pitch: Math.max(-5.0, Math.min(5.0, finalPitch)),
                volumeGainDb: 0.0,
                effectsProfileId: ['telephony-class-application'],
              },
            });
            
            if (response.audioContent) {
              const audioBuffer = Buffer.from(response.audioContent as Uint8Array);
              res.setHeader('Content-Type', format === 'oggopus' ? 'audio/ogg; codecs=opus' : 'audio/mpeg');
              res.setHeader('Content-Length', String(audioBuffer.length));
              return res.send(audioBuffer);
            }
          } catch (serviceErr) {
            console.error('[TTS] Google Service Account failed:', serviceErr);
          }
        }
        
        // Если используется API ключ, используем REST API напрямую
        if (googleKey && !accessToken) {
          const escapedText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const ssmlText = `<speak><prosody rate="${Math.max(0.75, Math.min(1.25, finalSpeed))}" pitch="${finalPitch >= 0 ? '+' : ''}${Math.max(-5.0, Math.min(5.0, finalPitch))}st">${escapedText}</prosody></speak>`;
          
          let voiceName = finalVoice;
          if (!voiceName.includes('ru-RU')) {
            // Маппинг старых имен голосов
            if (voiceName === 'female' || voiceName === 'jane' || voiceName === 'oksana') {
              voiceName = 'ru-RU-Wavenet-E';
            } else if (voiceName === 'male') {
              voiceName = 'ru-RU-Wavenet-B';
            } else {
              voiceName = 'ru-RU-Wavenet-D';
            }
          }
          
          const requestBody = {
            input: { ssml: ssmlText },
            voice: {
              languageCode: lang,
              name: voiceName,
              ssmlGender: voiceName.includes('E') || voiceName.includes('C') ? 'FEMALE' : 'MALE',
            },
            audioConfig: {
              audioEncoding: format === 'oggopus' ? 'OGG_OPUS' : 'MP3',
              speakingRate: Math.max(0.75, Math.min(1.25, finalSpeed)),
              pitch: Math.max(-5.0, Math.min(5.0, finalPitch)),
              volumeGainDb: 0.0,
              effectsProfileId: ['telephony-class-application'],
            },
          };
          
          const apiUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleKey}`;
          const apiResponse = await undiciFetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          });
          
          if (apiResponse.ok) {
            const jsonResponse = await apiResponse.json() as any;
            if (jsonResponse.audioContent) {
              const audioBuffer = Buffer.from(jsonResponse.audioContent, 'base64');
              res.setHeader('Content-Type', format === 'oggopus' ? 'audio/ogg; codecs=opus' : 'audio/mpeg');
              res.setHeader('Content-Length', String(audioBuffer.length));
              return res.send(audioBuffer);
            }
          } else {
            const errorText = await apiResponse.text().catch(() => '');
            console.error('[TTS] Google REST API failed:', errorText);
          }
        }
      } catch (googleErr) {
        console.error('[TTS] Google TTS failed:', googleErr);
        // Fallback на Yandex если Google не работает
      }
    }
    
    // Fallback на Yandex TTS (если Google не настроен)
    const yandexKey = process.env.YANDEX_TTS_API_KEY || process.env.YC_TTS_API_KEY || process.env.YC_API_KEY || process.env.YANDEX_API_KEY;
    if (!yandexKey && !googleKey && !googleCreds) {
      return res.status(500).json({ error: 'tts_key_missing', message: 'Необходимо настроить GOOGLE_TTS_API_KEY или GOOGLE_APPLICATION_CREDENTIALS для Google TTS' });
    }
    
    if (!yandexKey) {
      return res.status(502).json({ error: 'tts_failed', details: 'Google TTS failed and no fallback configured' });
    }

    async function synth(params: { voice: string; withExtras: boolean }) {
      const form = new FormData();
      form.append('text', text);
      form.append('lang', lang);
      form.append('voice', params.voice);
      if (params.withExtras) {
        form.append('emotion', 'friendly'); // Yandex emotion
        form.append('speed', String(speedReq)); // Используем speedReq из запроса
      }
      form.append('format', format);
      const r = await undiciFetch('https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize', {
        method: 'POST',
        headers: { Authorization: `Api-Key ${yandexKey}` },
        body: form as any,
      });
      return r;
    }

    // 1) Пробуем запрошенный голос с параметрами
    let r = await synth({ voice: voiceReq, withExtras: true });
    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      // 2) Если неподдерживаемый голос — пробуем jane с теми же параметрами
      if (/Unsupported voice/i.test(errTxt) || /unsupported voice/i.test(errTxt)) {
        r = await synth({ voice: 'jane', withExtras: true });
      }
      // 3) Если по-прежнему BAD_REQUEST — убираем extras (emotion/speed)
      if (!r.ok) {
        const txt2 = await r.text().catch(() => '');
        if (r.status === 400 || /BAD_REQUEST/i.test(txt2)) {
          // Сначала пробуем jane без extras
          r = await synth({ voice: 'jane', withExtras: false });
          if (!r.ok) {
            // Затем oksana как последний резерв
            r = await synth({ voice: 'oksana', withExtras: true });
            if (!r.ok) {
              const txt3 = await r.text().catch(() => '');
              if (r.status === 400 || /BAD_REQUEST/i.test(txt3)) {
                r = await synth({ voice: 'oksana', withExtras: false });
              }
            }
          }
        } else {
          // вернуть оригинальную ошибку
          return res.status(502).json({ error: 'tts_failed', details: errTxt || txt2 });
        }
      }
    }
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      return res.status(502).json({ error: 'tts_failed', details: err || r.statusText });
    }
    const arrayBuf = await r.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    res.setHeader('Content-Type', format === 'oggopus' ? 'audio/ogg; codecs=opus' : 'audio/mpeg');
    res.setHeader('Content-Length', String(buf.length));
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: 'tts_error' });
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

  for (const p of attempts) {
    try {
      const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';
      const body = {
        contents: [ { parts: [ { text: `Сгенерируй фоновое изображение сцены, без текста, без водяных знаков. ${prompt}` } ] } ],
        tools: [ { image_generation: {} } ],
        tool_config: {
          image_generation_config: {
            number_of_images: 1,
            mime_types: [ 'image/png' ],
            width_px: Math.min(1024, Math.max(256, w)),
            height_px: Math.min(1024, Math.max(256, h))
          }
        }
      } as any;
      const r = await undiciFetch(url, {
        method: 'POST',
        dispatcher,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        console.warn('[IMG] gemini http', r.status, t.slice(0, 200));
        continue;
      }
      const data = await r.json() as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((x: any) => x?.inline_data?.data || x?.inlineData?.data);
      const b64 = imgPart?.inline_data?.data || imgPart?.inlineData?.data || '';
      if (b64) return b64;
    } catch (e) {

      console.warn('[IMG] gemini attempt failed:', e);
    }
  }

  for (const p of attempts) {
    try {
      const dispatcher = p !== '__direct__' ? new ProxyAgent(p) : undefined;
      const url = 'https://generativelanguage.googleapis.com/v1beta/images:generate';
      const body = {
        prompt: { text: prompt },
        imageGenerationConfig: {
          numberOfImages: 1,
          imageFormat: 'PNG'
        }
      } as any;
      const r = await undiciFetch(url, {
        method: 'POST',
        dispatcher,
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');

        console.warn('[IMG] gemini http', r.status, t.slice(0, 200));
        continue;
      }
      const data = await r.json() as any;
      const gi = Array.isArray(data?.generatedImages) ? data.generatedImages[0] : null;
      const b64a = gi?.image?.base64 || gi?.image?.bytesBase64Encoded || gi?.bytesBase64Encoded || gi?.base64;
      if (b64a) return b64a;
    } catch (e) {

      console.warn('[IMG] gemini attempt2 failed:', e);
    }
  }
  return '';
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
  const { systemPrompt, userPrompt, history = [], apiKey, modelName = process.env.GEMINI_MODEL || 'gemini-2.5-pro' } = params;
  
  const proxies = parseGeminiProxies();
  const attempts = proxies.length ? proxies : ['__direct__'];
  const timeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 20000);
  const contents = history.map(h => ({
    role: h.role === 'assistant' || h.role === 'model' ? 'model' : 'user',
    parts: [{ text: h.content }]
  }));
  contents.push({ role: 'user', parts: [{ text: userPrompt }] });

  const body: any = {
    contents,
    generationConfig: {
      temperature: 0.45,
      maxOutputTokens: 1024,
    },
  };
  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  let lastErr: unknown = null;
  for (const p of attempts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
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
        console.error('[GEMINI-TEXT] HTTP', r.status, t.slice(0, 200));
        lastErr = t || r.statusText;
        continue;
      }
      const data = await r.json() as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p: any) => p?.text).filter(Boolean).join('\n').trim();
      if (text) return text;
      lastErr = 'empty_text';
    } catch (e) {
      lastErr = e;
      console.error('[GEMINI-TEXT] Error:', e);
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

  if (geminiKey) {
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
        modelName: process.env.GEMINI_MODEL || 'gemini-2.5-pro'
      });
      if (text) return { text, provider: 'gemini' };
    } catch (e) {
      console.error('[COMPLETION] Gemini failed:', e);
    }
  }

  if (openaiKey) {
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
        max_tokens: 800,
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


async function generateDiceNarrative(prisma: ReturnType<typeof getPrisma>, gameId: string, context: string, outcomeText: string): Promise<{ text: string; fallback: boolean }> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.CHAT_GPT_TOKEN || process.env.GPT_API_KEY;
  const game = await prisma.game.findUnique({ where: { id: gameId }, include: { characters: true } }).catch(() => null);
  const playable = (game?.characters || []).filter((c: any) => c.isPlayable);
  const baseLines: string[] = [];
  if (game) {
    baseLines.push(`Игра: ${game.title}`);
    if (game.worldRules) baseLines.push(`Правила мира: ${game.worldRules}`);
    if (game.gameplayRules) baseLines.push(`Правила процесса: ${game.gameplayRules}`);
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
      'Отвечай только текстом.';
  const user = [
    baseLines.length ? ('Контекст игры:\n' + baseLines.join('\n')) : '',
    context ? `Действие игрока: ${context}` : '',
    outcomeText ? `Исход проверки: ${outcomeText}` : '',
    'Продолжи сцену согласно исходу. Опиши обнаруженное/последствия/альтернативы. В конце задай, что герой делает дальше.'
  ].filter(Boolean).join('\n\n');

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_KEY;
  if (geminiKey) {
    try {
      const text = await generateViaGeminiText({
        apiKey: geminiKey,
        systemPrompt: sys,
        userPrompt: user,
        modelName: process.env.GEMINI_MODEL || 'gemini-2.5-pro'
      });
      if (text) return { text, fallback: false };
    } catch (e) {
      console.error('[NARRATIVE] Gemini failed, falling back to OpenAI/Hardcode:', e);
    }
  }

  if (!apiKey) {
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
  try {
    const client = createOpenAIClient(apiKey);
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const r = await client.chat.completions.create({
      model,
      temperature: 0.45,
      max_tokens: 400,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
    const text = r.choices?.[0]?.message?.content?.trim() || '';
    if (text) return { text, fallback: false };
    return { text: 'Сцена продолжается. Что вы сделаете дальше?', fallback: true };
  } catch {
    return { text: 'Сцена продолжается. Что вы сделаете дальше?', fallback: true };
  }
}

async function buildGptSceneContext(prisma: ReturnType<typeof getPrisma>, params: {
  gameId: string;
  lobbyId?: string;
  userId?: string | null;
  history?: Array<{ from?: string; text?: string }>;
}): Promise<string> {
  const { gameId, lobbyId, userId } = params;
  let sess: any = null;
  try {
    if (lobbyId) {
      sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, lobbyId } });
    } else if (userId) {
      sess = await prisma.gameSession.findFirst({ where: { scenarioGameId: gameId, userId } });
    }
  } catch {}
  let loc: any = null;
  if (sess?.currentLocationId) {
    try { loc = await prisma.location.findUnique({ where: { id: sess.currentLocationId } }); } catch {}
  } else {
    try { loc = await prisma.location.findFirst({ where: { gameId }, orderBy: { order: 'asc' } }); } catch {}
  }
  let exits: any[] = [];
  try {
    if (loc?.id) exits = await prisma.locationExit.findMany({ where: { locationId: loc.id } });
  } catch {}
  const targetIds = Array.from(new Set((exits || []).map((e) => e.targetLocationId).filter(Boolean))) as string[];
  let targets: any[] = [];
  try {
    if (targetIds.length) targets = await prisma.location.findMany({ where: { id: { in: targetIds } } });
  } catch {}
  const targetTitleById = new Map<string, string>();
  for (const t of targets) targetTitleById.set(t.id, t.title || '');
  let npcs: any[] = [];
  try {
    npcs = await prisma.character.findMany({ where: { gameId, OR: [{ isPlayable: false }, { isPlayable: null }] }, take: 50 });
  } catch {}
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
  };
  const gptContext = [
    `SCENE_JSON:\n${JSON.stringify(sceneJson, null, 2)}`,
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
    history.push({ from: 'bot', text: fmt });

    const gptContext = await buildGptSceneContext(prisma, { gameId, lobbyId, history });
    const narr = await generateDiceNarrative(prisma, gameId, gptContext || (context || ''), outcome || fmt);
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
    const sess = await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId } } });
    const history = ((sess?.history as any) || []) as Array<{ from: 'bot' | 'me'; text: string }>;
    history.push({ from: 'bot', text: fmt });
    const gptContext = await buildGptSceneContext(prisma, { gameId, userId: uid, history });
    const narr = await generateDiceNarrative(prisma, gameId, gptContext || (context || ''), outcome || fmt);
    history.push({ from: 'bot', text: narr.text });
    await prisma.chatSession.upsert({
      where: { userId_gameId: { userId: uid, gameId } },
      update: { history: history as any },
      create: { userId: uid, gameId, history: history as any },
    });
    return res.json({ ok: true, messages: [fmt, narr.text] });
  } catch {
    return res.status(400).json({ ok: false, error: 'dice_chat_error' });
  }
});
