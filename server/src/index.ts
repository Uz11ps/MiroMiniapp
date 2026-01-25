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

// Директория для прегенерированных аудио
const PRAGEN_DIR = process.env.PRAGEN_DIR || path.join(UPLOAD_DIR, 'pregen');
try { fs.mkdirSync(PRAGEN_DIR, { recursive: true }); } catch {}
app.use('/pregen', express.static(PRAGEN_DIR));

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
function hasPregenMaterials(scenarioGameId: string): boolean {
  try {
    const gameDir = path.join(PRAGEN_DIR, scenarioGameId);
    if (!fs.existsSync(gameDir)) {
      return false;
    }
    
    // Проверяем, есть ли хотя бы один .wav файл в директории
    const checkDir = (dir: string): boolean => {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const itemPath = path.join(dir, item);
          const stat = fs.statSync(itemPath);
          if (stat.isDirectory()) {
            if (checkDir(itemPath)) return true;
          } else if (item.endsWith('.wav')) {
            return true;
          }
        }
      } catch (e) {
        // Игнорируем ошибки
      }
      return false;
    };
    
    return checkDir(gameDir);
  } catch (e) {
    return false;
  }
}

// Функция для параллельной генерации материалов в реальном времени (не блокирует ответ)
function generatePregenMaterialInBackground(params: {
  scenarioGameId: string;
  text: string;
  locationId?: string;
  characterId?: string;
  messageType?: 'narrator' | 'character';
  depth?: number;
  choiceIndex?: number;
  parentHash?: string;
}): void {
  // Запускаем в фоне, не ждем результата
  (async () => {
    try {
      const { scenarioGameId, text, locationId, characterId, messageType = 'narrator', depth, choiceIndex, parentHash } = params;
      
      // Проверяем, нет ли уже такого файла по точному хэшу
      // КРИТИЧЕСКИ ВАЖНО: Сначала ищем БЕЗ locationId в хеше (для диалогов внутри локации)
      let existingPath = findPregenAudio(scenarioGameId, text, undefined, characterId, messageType, depth, choiceIndex, parentHash);
      if (!existingPath) {
        existingPath = findPregenAudio(scenarioGameId, text, locationId, characterId, messageType, depth, choiceIndex, parentHash);
      }
      if (existingPath) {
        console.log(`[BG-PREGEN] Material already exists for scenarioGameId=${scenarioGameId} (hash: ${createAudioHash(text, undefined, characterId, messageType, depth, choiceIndex, parentHash)}), skipping`);
        return;
      }
      
      console.log(`[BG-PREGEN] Starting background generation for scenarioGameId=${scenarioGameId}, locationId=${locationId || 'none'}`);
      
      // Генерируем TTS
      const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
      const ttsUrl = `${apiBase}/api/tts`;
      
      const ttsResponse = await undiciFetch(ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          gameId: scenarioGameId,
          locationId,
          characterId,
          format: 'wav',
          isNarrator: messageType === 'narrator',
        }),
        signal: AbortSignal.timeout(30000)
      });
      
      if (ttsResponse.ok) {
        const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
        // КРИТИЧЕСКИ ВАЖНО: Сохраняем БЕЗ locationId в хеше, но в папке локации
        const hashWithoutLoc = createAudioHash(text, undefined, characterId, messageType, depth, choiceIndex, parentHash);
        const subDir = locationId || 'general';
        const audioPath = path.join(PRAGEN_DIR, scenarioGameId, subDir, `${messageType}_${hashWithoutLoc}.wav`);
        const audioDir = path.dirname(audioPath);
        try { fs.mkdirSync(audioDir, { recursive: true }); } catch {}
        fs.writeFileSync(audioPath, audioBuffer);
        
        // Сохраняем также текст
        const textPath = path.join(PRAGEN_DIR, scenarioGameId, subDir, `${messageType}_${hashWithoutLoc}.txt`);
        try { fs.mkdirSync(path.dirname(textPath), { recursive: true }); } catch {}
        fs.writeFileSync(textPath, text, 'utf-8');
        
        console.log(`[BG-PREGEN] ✅ Background generation completed for scenarioGameId=${scenarioGameId}, saved to: ${audioPath}`);
      } else {
        console.warn(`[BG-PREGEN] ❌ Background generation failed for scenarioGameId=${scenarioGameId}: ${ttsResponse.status}`);
      }
    } catch (e) {
      console.error(`[BG-PREGEN] Error in background generation:`, e);
    }
  })().catch(e => {
    console.error(`[BG-PREGEN] Unhandled error in background generation:`, e);
  });
}

function findSimilarPregenAudio(gameId: string, text: string, locationId?: string, characterId?: string, messageType: 'narrator' | 'character' = 'narrator'): string | null {
  // Сначала проверяем точное совпадение
  const exactMatch = findPregenAudio(gameId, text, locationId, characterId, messageType);
  if (exactMatch) return exactMatch;
  
  // Если точного совпадения нет, проверяем по нормализованному тексту
  const normalizedText = normalizeTextForComparison(text);
  const normalizedPath = getPregenAudioPath(gameId, normalizedText, locationId, characterId, messageType);
  
  // Проверяем нормализованный путь
  if (fs.existsSync(normalizedPath)) {
    return normalizedPath;
  }
  
  // Если есть locationId, проверяем все файлы в директории локации
  if (locationId) {
    try {
      const locationDir = path.join(PRAGEN_DIR, gameId, locationId);
      if (fs.existsSync(locationDir)) {
        const files = fs.readdirSync(locationDir);
        const normalizedTarget = normalizeTextForComparison(text);
        
        for (const file of files) {
          if (file.endsWith('.wav') && file.startsWith(`${messageType}_`)) {
            // Извлекаем текст из имени файла (хеш) и проверяем по нормализованному тексту
            // Но лучше проверить по содержимому .txt файла
            const txtFile = file.replace('.wav', '.txt');
            const txtPath = path.join(locationDir, txtFile);
            if (fs.existsSync(txtPath)) {
              try {
                const existingText = fs.readFileSync(txtPath, 'utf-8');
                const normalizedExisting = normalizeTextForComparison(existingText);
                // Если нормализованные тексты совпадают (или очень похожи), считаем это совпадением
                if (normalizedExisting === normalizedTarget || 
                    normalizedExisting.includes(normalizedTarget) || 
                    normalizedTarget.includes(normalizedExisting)) {
                  return path.join(locationDir, file);
                }
              } catch (e) {
                // Продолжаем поиск
              }
            }
          }
        }
      }
    } catch (e) {
      // Игнорируем ошибки при поиске
    }
  }
  
  return null;
}

// Единая функция для создания хеша аудио файла
// Используется для сопоставления предгенерированных сообщений с аудио
// Учитывает все параметры: текст, локация, персонаж, тип сообщения, глубина диалога, индекс выбора, родительский хэш
function createAudioHash(
  text: string, 
  locationId?: string, 
  characterId?: string, 
  messageType: 'narrator' | 'character' = 'narrator',
  depth?: number,
  choiceIndex?: number,
  parentHash?: string
): string {
  const contextString = `${text.trim()}_${locationId || ''}_${characterId || ''}_${messageType}_${depth !== undefined ? depth : ''}_${choiceIndex !== undefined ? choiceIndex : ''}_${parentHash || ''}`;
  return crypto.createHash('md5').update(contextString).digest('hex').slice(0, 16);
}

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

// Определяет choiceIndex из userText с помощью AI
// Использует AI для понимания намерения пользователя и сопоставления с вариантами выбора
async function detectChoiceIndexWithAI(userText: string, botMessageText?: string): Promise<number | undefined> {
  if (!userText || typeof userText !== 'string') return undefined;
  
  // Сначала пробуем быстрый хардкод для простых случаев (цифры)
  const normalized = userText.trim().toLowerCase();
  const directNumberMatch = normalized.match(/^(\d+)[\s\-\.й]*/);
  if (directNumberMatch) {
    const num = parseInt(directNumberMatch[1], 10);
    if (num >= 1 && num <= 10) {
      return num - 1;
    }
  }
  
  // Если нет вариантов выбора - возвращаем undefined
  if (!botMessageText) return undefined;
  
  const choices = parseChoiceOptions(botMessageText);
  if (choices.length === 0) return undefined;
  
  try {
    // Используем AI для определения выбора
    const systemPrompt = `Ты помощник для определения выбора пользователя в текстовой игре. 
Пользователь написал ответ, и нужно определить, какой вариант выбора (1-${choices.length}) он имел в виду.

Варианты выбора:
${choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Ответ пользователя: "${userText}"

Верни ТОЛЬКО номер варианта (1-${choices.length}) или "0" если не можешь определить. Никаких объяснений, только число.`;

    console.log('[AI-CHOICE] Calling AI to detect choiceIndex for userText:', userText?.slice(0, 50), 'choices count:', choices.length);
    const { text: aiResponse } = await generateChatCompletion({
      systemPrompt,
      userPrompt: `Определи, какой вариант выбора имел в виду пользователь в ответе: "${userText}"`,
      history: []
    });
    
    console.log('[AI-CHOICE] AI response:', aiResponse?.slice(0, 100));
    const choiceNum = parseInt(aiResponse.trim(), 10);
    if (choiceNum >= 1 && choiceNum <= choices.length) {
      console.log('[AI-CHOICE] ✅ Detected choiceIndex:', choiceNum - 1, 'from userText:', userText);
      return choiceNum - 1;
    } else if (choiceNum === 0) {
      // AI вернул 0 - не может определить выбор, нужно уточнить у пользователя
      console.warn('[AI-CHOICE] ⚠️ AI returned 0 - cannot determine choice, user needs to clarify');
      return -1; // Специальное значение: AI не смог определить, нужно уточнить у пользователя
    } else {
      console.warn('[AI-CHOICE] ⚠️ AI returned invalid choice number:', choiceNum, 'expected 1-', choices.length);
      return -1; // Невалидное значение - тоже просим уточнить
    }
  } catch (e) {
    console.warn('[AI-CHOICE] Failed to detect choice with AI:', e);
    return -1; // Ошибка AI - просим уточнить
  }
  
  // НЕ используем fallback на detectChoiceIndex - всегда полагаемся на AI
  // Если AI не может определить - просим пользователя уточнить
  return -1;
}

// Определяет choiceIndex из userText с учетом различных вариантов ответа (fallback, без AI)
// Поддерживает: цифры ("2", "2.", "2-й"), слова ("второй", "два"), частичные совпадения, копирование текста
function detectChoiceIndex(userText: string, botMessageText?: string): number | undefined {
  if (!userText || typeof userText !== 'string') return undefined;
  
  const normalized = userText.trim().toLowerCase();
  
  // 1. Прямое совпадение с цифрой: "2", "2.", "2-й", "2й", "2-й вариант"
  const directNumberMatch = normalized.match(/^(\d+)[\s\-\.й]*/);
  if (directNumberMatch) {
    const num = parseInt(directNumberMatch[1], 10);
    if (num >= 1 && num <= 10) {
      return num - 1; // choiceIndex начинается с 0
    }
  }
  
  // 2. Слова-цифры: "первый", "второй", "третий", "четвертый", "пятый", "шестой", "седьмой", "восьмой", "девятый", "десятый"
  const numberWords: Record<string, number> = {
    'первый': 1, 'первая': 1, 'первое': 1, 'первым': 1, 'первой': 1,
    'второй': 2, 'вторая': 2, 'второе': 2, 'вторым': 2, 'второй': 2,
    'третий': 3, 'третья': 3, 'третье': 3, 'третьим': 3, 'третьей': 3,
    'четвертый': 4, 'четвертая': 4, 'четвертое': 4, 'четвертым': 4, 'четвертой': 4,
    'пятый': 5, 'пятая': 5, 'пятое': 5, 'пятым': 5, 'пятой': 5,
    'шестой': 6, 'шестая': 6, 'шестое': 6, 'шестым': 6, 'шестой': 6,
    'седьмой': 7, 'седьмая': 7, 'седьмое': 7, 'седьмым': 7, 'седьмой': 7,
    'восьмой': 8, 'восьмая': 8, 'восьмое': 8, 'восьмым': 8, 'восьмой': 8,
    'девятый': 9, 'девятая': 9, 'девятое': 9, 'девятым': 9, 'девятой': 9,
    'десятый': 10, 'десятая': 10, 'десятое': 10, 'десятым': 10, 'десятой': 10,
    'один': 1, 'два': 2, 'три': 3, 'четыре': 4, 'пять': 5,
    'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10
  };
  
  for (const [word, num] of Object.entries(numberWords)) {
    if (normalized.includes(word)) {
      return num - 1;
    }
  }
  
  // 3. Поиск по тексту варианта (если пользователь скопировал текст варианта)
  if (botMessageText) {
    const choices = parseChoiceOptions(botMessageText);
    const normalizedUserText = normalized.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    
    for (let i = 0; i < choices.length; i++) {
      const choiceText = choices[i].toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      // Проверяем частичное совпадение (минимум 3 символа совпадают)
      if (choiceText.length >= 3 && normalizedUserText.length >= 3) {
        // Проверяем, содержит ли userText ключевые слова из варианта
        const choiceWords = choiceText.split(/\s+/).filter(w => w.length >= 3);
        const userWords = normalizedUserText.split(/\s+/).filter(w => w.length >= 3);
        
        // Если хотя бы 2 слова совпадают или userText содержит большую часть choiceText
        const matchingWords = choiceWords.filter(cw => userWords.some(uw => uw.includes(cw) || cw.includes(uw)));
        if (matchingWords.length >= Math.min(2, choiceWords.length) || 
            normalizedUserText.includes(choiceText) || 
            choiceText.includes(normalizedUserText)) {
          return i;
        }
      }
    }
  }
  
  return undefined;
}

// Функция для получения пути к предгенерированному аудио файлу
function getPregenAudioPath(
  gameId: string, 
  text: string, 
  locationId?: string, 
  characterId?: string, 
  messageType: 'narrator' | 'character' = 'narrator',
  depth?: number,
  choiceIndex?: number,
  parentHash?: string
): string {
  const textHash = createAudioHash(text, locationId, characterId, messageType, depth, choiceIndex, parentHash);
  const subDir = locationId ? locationId : 'general';
  return path.join(PRAGEN_DIR, gameId, subDir, `${messageType}_${textHash}.wav`);
}

// Функция для получения пути к предгенерированному тексту
function getPregenTextPath(
  gameId: string, 
  text: string, 
  locationId?: string, 
  characterId?: string, 
  messageType: 'narrator' | 'character' = 'narrator',
  depth?: number,
  choiceIndex?: number,
  parentHash?: string
): string {
  const textHash = createAudioHash(text, locationId, characterId, messageType, depth, choiceIndex, parentHash);
  const subDir = locationId ? locationId : 'general';
  return path.join(PRAGEN_DIR, gameId, subDir, `${messageType}_${textHash}.txt`);
}

// Функция для поиска предгенерированного аудио (проверяет несколько возможных путей)
function findPregenAudio(
  gameId: string, 
  text: string, 
  locationId?: string, 
  characterId?: string, 
  messageType: 'narrator' | 'character' = 'narrator',
  depth?: number,
  choiceIndex?: number,
  parentHash?: string
): string | null {
  // КРИТИЧЕСКИ ВАЖНО: Сначала ищем БЕЗ locationId в хеше (для диалогов внутри локации)
  const hashWithoutLoc = createAudioHash(text, undefined, characterId, messageType, depth, choiceIndex, parentHash);
  
  // КРИТИЧЕСКИ ВАЖНО: Если choiceIndex определен, сначала ищем в 'general', потом в папке локации
  const possiblePaths: string[] = [];
  
  if (choiceIndex !== undefined) {
    // При определенном choiceIndex сначала ищем в 'general' (ПРИОРИТЕТ!)
    possiblePaths.push(
      path.join(PRAGEN_DIR, gameId, 'general', `${messageType}_${hashWithoutLoc}.wav`)
    );
    // Потом в папке локации (для обратной совместимости)
    if (locationId) {
      possiblePaths.push(
        path.join(PRAGEN_DIR, gameId, locationId, `${messageType}_${hashWithoutLoc}.wav`)
      );
    }
    // КРИТИЧЕСКИ ВАЖНО: Ищем во ВСЕХ папках локаций, так как locationId может меняться между запросами
    try {
      const gameDir = path.join(PRAGEN_DIR, gameId);
      if (fs.existsSync(gameDir)) {
        const subDirs = fs.readdirSync(gameDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory() && dirent.name !== 'general')
          .map(dirent => dirent.name);
        for (const subDir of subDirs) {
          possiblePaths.push(
            path.join(gameDir, subDir, `${messageType}_${hashWithoutLoc}.wav`)
          );
        }
      }
    } catch (e) {
      // Игнорируем ошибки при чтении директории
    }
  } else {
    // Если choiceIndex не определен, ищем в папке локации
    const subDir = locationId || 'general';
    possiblePaths.push(
      path.join(PRAGEN_DIR, gameId, subDir, `${messageType}_${hashWithoutLoc}.wav`)
    );
  }
  
  // КРИТИЧЕСКИ ВАЖНО: НЕ добавляем fallback-поиск без параметров depth/choiceIndex/parentHash
  // Это может привести к загрузке контента из другой части игры (другой depth или другой выбор)
  // Добавляем только пути с точными параметрами для обратной совместимости
  possiblePaths.push(
    // Основной путь (старый формат с locationId в хеше - для обратной совместимости)
    getPregenAudioPath(gameId, text, locationId, characterId, messageType, depth, choiceIndex, parentHash)
  );
  
  // КРИТИЧЕСКИ ВАЖНО: Fallback-поиск без параметров depth/choiceIndex/parentHash УБРАН
  // Это предотвращает загрузку контента из другой части игры
  
  const filteredPaths = possiblePaths.filter(Boolean) as string[];
  
  for (const audioPath of filteredPaths) {
    try {
      if (fs.existsSync(audioPath)) {
        return audioPath;
      }
    } catch (e) {
      // Продолжаем проверку других путей
    }
  }
  return null;
}

// Функция для поиска предгенерированного текста
function findPregenText(
  gameId: string, 
  text: string, 
  locationId?: string, 
  characterId?: string, 
  messageType: 'narrator' | 'character' = 'narrator',
  depth?: number,
  choiceIndex?: number,
  parentHash?: string
): string | null {
  const audioPath = findPregenAudio(gameId, text, locationId, characterId, messageType, depth, choiceIndex, parentHash);
  if (!audioPath) return null;
  
  const textPath = audioPath.replace('.wav', '.txt');
  try {
    if (fs.existsSync(textPath)) {
      return fs.readFileSync(textPath, 'utf-8');
    }
  } catch (e) {
    // Игнорируем ошибки
  }
  
  return null;
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
  '2. ПРАВИЛА: Строго соблюдай правила D&D 5e. Используй характеристики персонажей (STR, DEX, CON, INT, WIS, CHA), классы и навыки. ' +
  'ВАЖНО: Когда в контексте указаны "Правила мира" или "Правила процесса" - СОПОСТАВЛЯЙ их с текущей сценой и сценарием, а не просто обобщай. ' +
  'Например, если в правилах написано "Мир D&D основан на ключевых предположениях: боги реальны..." - это обобщение. ' +
  'Вместо этого используй конкретные детали из текущей сцены: какие боги упомянуты в этой локации, какие фракции действуют здесь, какая атмосфера именно в этой сцене. ' +
  '3. ПРОВЕРКИ: Для любых действий, исход которых не очевиден, запрашивай проверки характеристик (d20 + модификатор). Модификатор = (характеристика-10)/2. ' +
  '4. СПАСБРОСКИ: При опасностях запрашивай спасброски (STR/DEX/CON/INT/WIS/CHA) и учитывай их результат. ' +
  '5. ПРЕИМУЩЕСТВО/ПОМЕХА: Если условия дают преимущество или помеху, явно указывай это при броске d20. ' +
  '6. БОЙ: В случае конфликта инициируй бросок инициативы, рассчитывай попадания (бросок атаки против AC цели) и урон (согласно оружию/заклинанию). Учитывай крит на нат.20. ' +
  '7. ПАМЯТЬ: Ты работаешь с расширенным контекстом Gemini — помни всё состояние мира, инвентарь, HP и предысторию персонажей. ' +
  'ВАЖНО: Когда описываешь изменения HP, урон или лечение, используй явные формулировки: "Персонаж теряет X HP", "Персонаж восстанавливает X HP", "Урон: X HP". ' +
  'Система автоматически отслеживает и обновляет состояние персонажей на основе твоих описаний. ' +
  'СОСТОЯНИЯ: Состояния (отравление, паралич, оглушение и т.д.) имеют реальные эффекты: отравление причиняет урон каждый ход, паралич блокирует действия, оглушение дает помеху на проверки. ' +
  'Используй состояния осознанно и описывай их применение. Для снятия состояний используй: "Персонаж излечен от отравления", "Лечение снимает паралич", "Отдых восстанавливает силы". ' +
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
    const gameDir = path.join(PRAGEN_DIR, gameId);
    try {
      if (fs.existsSync(gameDir)) {
        fs.rmSync(gameDir, { recursive: true, force: true });
        console.log(`[GAME-DELETE] Deleted pregenerated files directory: ${gameDir}`);
      }
    } catch (e) {
      console.error(`[GAME-DELETE] Failed to delete pregenerated files for game ${gameId}:`, e);
    }
    
    // Флаг остановки оставляем установленным, чтобы активные генерации могли его проверить и остановиться
    // Он будет удален автоматически при следующем запуске генерации для этой игры (если она будет создана заново)
    
    res.status(204).end();
  } catch {
    const ok = deleteGame(gameId);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    
    // Устанавливаем флаг остановки
    generationStopFlags.set(gameId, true);
    
    // Удаляем прегенерированные файлы
    const gameDir = path.join(PRAGEN_DIR, gameId);
    try {
      if (fs.existsSync(gameDir)) {
        fs.rmSync(gameDir, { recursive: true, force: true });
        console.log(`[GAME-DELETE] Deleted pregenerated files directory: ${gameDir}`);
      }
    } catch (e) {
      console.error(`[GAME-DELETE] Failed to delete pregenerated files for game ${gameId}:`, e);
    }
    
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
      const worldRules = ((pickBlock(/Правила мира/i) || pickBlock(/Особенности местности/i) || '—').trim()).slice(0, 500);
      const gameplayRules = ((pickBlock(/Правила игрового процесса/i) || pickBlock(/Дальнейшие события/i) || '—').trim()).slice(0, 500);
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
          worldRulesFull: worldRules, // Сохраняем полные правила для ИИ
          gameplayRulesFull: gameplayRules, // Сохраняем полные правила для ИИ
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
        
        // Функция для чтения файла
        const readFile = async (file: Express.Multer.File): Promise<string> => {
          const fileName = file.originalname || '';
          const ext = fileName.toLowerCase().split('.').pop() || '';
          
          if (ext === 'txt') {
            return file.buffer.toString('utf-8').replace(/\r/g, '\n');
          } else {
            // Примечание: pdf-parse может выводить предупреждения "Warning: TT: undefined function" и "Warning: TT: invalid function id"
            // Это не критичные ошибки - они связаны с обработкой шрифтов TrueType в PDF и не влияют на извлечение текста
            const parsed = await pdfParse(file.buffer).catch(() => null);
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
- worldRulesFull: ПОЛНОЕ описание сеттинга (для ИИ, без ограничений длины).
- gameplayRulesFull: ПОЛНОЕ описание механик (для ИИ, без ограничений длины). 
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
          if (worldRulesShort) {
            scenario.game.worldRules = worldRulesShort.length > 500 ? worldRulesShort.slice(0, 500) : worldRulesShort;
            scenario.game.worldRulesFull = worldRulesFull || worldRulesShort; // Сохраняем полные правила для AI
          }
          if (gameplayRulesShort) {
            scenario.game.gameplayRules = gameplayRulesShort.length > 500 ? gameplayRulesShort.slice(0, 500) : gameplayRulesShort;
            scenario.game.gameplayRulesFull = gameplayRulesFull || gameplayRulesShort; // Сохраняем полные правила для AI
          }
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
   - isGameOver: true только если это конец игры

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
            'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
            'Если игрок пишет что-то вне кнопок — мягко возвращай его к выбору, но через атмосферное описание. ' +
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
      
      // ИЩЕМ прегенерированный текст ПЕРЕД генерацией
      let pregenTextFound: string | null = null;
      if (scenarioGameIdForPregen && first?.id) {
        const hasMaterials = hasPregenMaterials(scenarioGameIdForPregen);
        if (hasMaterials) {
          // Ищем по тексту локации или по любому welcome сообщению для этой локации
          // КРИТИЧЕСКИ ВАЖНО: Сначала ищем БЕЗ locationId в хеше (для диалогов внутри локации)
          let foundText = findPregenText(scenarioGameIdForPregen, base || loc?.title || '', undefined, undefined, 'narrator', 0);
          if (!foundText) {
            // Пробуем с locationId (для обратной совместимости)
            foundText = findPregenText(scenarioGameIdForPregen, base || loc?.title || '', first.id, undefined, 'narrator', 0);
          }
          if (!foundText) {
            // КРИТИЧЕСКИ ВАЖНО: Ищем только файлы с depth=0, choiceIndex=undefined, parentHash=undefined (welcome сообщения)
            // НЕ ищем любые файлы, так как это может привести к загрузке середины игры вместо начала
            try {
              const locationDir = path.join(PRAGEN_DIR, scenarioGameIdForPregen, first.id);
              if (fs.existsSync(locationDir)) {
                const files = fs.readdirSync(locationDir);
                // Вычисляем ожидаемый хеш для welcome сообщения (depth=0, choiceIndex=undefined, parentHash=undefined)
                const expectedHash = createAudioHash(base || loc?.title || '', undefined, undefined, 'narrator', 0);
                for (const file of files) {
                  if (file.endsWith('.txt') && file.startsWith('narrator_')) {
                    // Проверяем, что хеш в имени файла соответствует welcome сообщению
                    const fileHash = file.replace('narrator_', '').replace('.txt', '');
                    if (fileHash === expectedHash) {
                      const txtPath = path.join(locationDir, file);
                      foundText = fs.readFileSync(txtPath, 'utf-8');
                      console.log(`[WELCOME] ✅ Found pre-generated text by location (verified depth=0): ${file}`);
                      break;
                    }
                  }
                }
              }
            } catch (e) {
              // Игнорируем ошибки
            }
          }
          if (foundText) {
            pregenTextFound = foundText;
            console.log('[WELCOME] ✅ Found pre-generated text BEFORE generation');
          }
        }
      }
      
      // Если включено использование прегенерированных материалов - ищем прегенерированный текст
      let text = offlineText;
      if (pregenTextFound) {
        text = pregenTextFound;
        console.log('[WELCOME] ✅ Using pre-generated text from file (BEFORE generation)');
      } else if (game?.usePregenMaterials && gameId && first?.id) {
        // Пытаемся найти прегенерированный текст для этой локации
        // Ищем по хешу описания локации
        // КРИТИЧЕСКИ ВАЖНО: Сначала ищем БЕЗ locationId в хеше
        let pregenText = findPregenText(gameId, base || loc?.title || '', undefined, undefined, 'narrator');
        if (!pregenText) {
          pregenText = findPregenText(gameId, base || loc?.title || '', first.id, undefined, 'narrator');
        }
        if (pregenText) {
          text = pregenText;
          console.log('[WELCOME] ✅ Using pre-generated text for location');
        } else {
          // Если прегенерированного текста нет, используем fallback
          console.warn('[WELCOME] ⚠️ Pre-generated text not found, using fallback');
        }
      } else if (apiKey && !pregenTextFound) {
        // Генерируем в реальном времени только если не включено использование прегенерированных материалов
        try {
          const client = createOpenAIClient(apiKey);
          const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
          const sys = getSysPrompt();
            'Всегда пиши кинематографично, живо и образно, будто зритель стоит посреди сцены. ' +
            'Всегда учитывай локацию и мини-промпт из сценария — это основа сюжета. ' +
            'Играй от лица рассказчика, а не игрока: избегай фраз "вы решаете", "вы начинаете", "вы выбираете". ' +
            'Описывай мир так, будто он реагирует сам: свет мерцает, стены шепчут, NPC ведут себя естественно. ' +
            'Если в сцене есть NPC — обязательно отыгрывай их короткими репликами, характером, эмоциями и настроением. Каждый NPC должен говорить в своём стиле (см. persona). ' +
            'Если в сцене есть проверки d20 — объявляй их естественно, как часть происходящего. ' +
            'Никогда не выходи за пределы текущей сцены и Flow. Не создавай новые локации, предметы или пути, если их нет в сценарии. Все действия игрока должны соответствовать кнопкам или триггерам. ' +
            'Если игрок пишет что-то вне кнопок — мягко возвращай его к выбору, но через атмосферное описание. ' +
            'После атмосферного описания всегда выводи чёткие варианты действий, опираясь на кнопки текущей сцены. ' +
            'ВАЖНО: Варианты выбора форматируй ТОЛЬКО нумерованным списком (1. Вариант, 2. Вариант), БЕЗ звездочек (*) или других символов. Каждый вариант на новой строке. ' +
            'Это нужно, чтобы игрок мог выбрать вариант, просто отправив номер (1, 2, 3), и чтобы TTS не озвучивал звездочки. ' +
            'Обязательно формулируй их коротко и ясно, чтобы игрок понял, что делать дальше. ' +
            'Всегда отвечай короткими абзацами, 3–7 строк. Главная цель — удерживать атмосферу игры и следовать сценарию.';
          const visual = loc?.backgroundUrl ? `Фон (изображение): ${loc.backgroundUrl}` : '';
          const rules = [
            game?.worldRules ? `Правила мира (сопоставляй с текущей сценой, не обобщай): ${game.worldRules}` : '',
            game?.gameplayRules ? `Правила процесса (сопоставляй с текущей сценой, не обобщай): ${game.gameplayRules}` : '',
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
          if (text) {
            text = (text || '').trim();
            // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
            text = formatChoiceOptions(text);
            
            // Проверяем, есть ли варианты выбора в тексте
            const choices = parseChoiceOptions(text);
            if (choices.length === 0 && first?.id) {
              // Если вариантов нет, добавляем их из кнопок локации
              const exits = await prisma.locationExit.findMany({ where: { locationId: first.id } });
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
        } catch {
          text = offlineText;
        }
      }
      // ПРЕГЕНЕРАЦИЯ ОЗВУЧКИ для первого сообщения
      // КРИТИЧЕСКИ ВАЖНО: текст и аудио ВСЕГДА идут вместе
      // ИСПРАВЛЕНИЕ: scenarioGameIdForPregen уже определен выше, не нужно определять заново
      let audioData: { buffer: Buffer; contentType: string } | null = null;
      if (text) {
        try {
          // КРИТИЧЕСКИ ВАЖНО: Проверяем прегенерированное аудио ДО генерации
          // scenarioGameIdForPregen уже определен выше при поиске текста
          if (scenarioGameIdForPregen && first?.id) {
            // Поиск прегенерированных материалов (логи убраны)
            
            // Проверяем наличие прегенерованных материалов для scenarioGameId
            const hasMaterials = hasPregenMaterials(scenarioGameIdForPregen);
            
            if (hasMaterials) {
              // КРИТИЧЕСКИ ВАЖНО: Используем уже найденный текст (pregenTextFound), если он был найден выше
              // Если текст был найден выше - используем его, иначе используем текущий text
              const searchText = pregenTextFound || text;
              
              // Если материалы есть - ищем по точному хэшу (каждое сообщение имеет свой хэш)
              // WELCOME сообщение имеет depth=0, choiceIndex=undefined, parentHash=undefined
              // КРИТИЧЕСКИ ВАЖНО: Сначала ищем БЕЗ locationId в хеше (для диалогов внутри локации)
              let foundPregenText = pregenTextFound || findPregenText(scenarioGameIdForPregen, searchText, undefined, undefined, 'narrator', 0);
              let pregenPath = findPregenAudio(scenarioGameIdForPregen, searchText, undefined, undefined, 'narrator', 0);
              
              // Если не нашли БЕЗ locationId, пробуем С locationId (для обратной совместимости)
              if (!foundPregenText || !pregenPath) {
                if (!foundPregenText) {
                  foundPregenText = findPregenText(scenarioGameIdForPregen, searchText, first.id, undefined, 'narrator', 0);
                }
                if (!pregenPath) {
                  pregenPath = findPregenAudio(scenarioGameIdForPregen, searchText, first.id, undefined, 'narrator', 0);
                }
              }
              
              // КРИТИЧЕСКИ ВАЖНО: НЕ ищем "любой файл" по локации, так как это может привести к загрузке середины игры
              // Ищем только файлы с точным соответствием тексту и параметрам welcome сообщения (depth=0, choiceIndex=undefined, parentHash=undefined)
              // Если не нашли по точному тексту - не используем файлы из середины игры
              
              // КРИТИЧЕСКИ ВАЖНО: Проверяем наличие ОБОИХ файлов
              // Если нашли аудио, проверяем наличие текста рядом с ним
              if (pregenPath && !foundPregenText) {
                try {
                  const textPath = pregenPath.replace(/\.wav$/, '.txt');
                  if (fs.existsSync(textPath)) {
                    foundPregenText = fs.readFileSync(textPath, 'utf-8');
                    console.log('[WELCOME] ✅ Loaded pre-generated text from file:', textPath);
                  } else {
                    // Если текста нет - удаляем аудио и генерируем заново
                    console.warn('[WELCOME] ⚠️ Found audio but no text file, deleting incomplete files and regenerating');
                    try {
                      fs.unlinkSync(pregenPath);
                      console.log('[WELCOME] 🗑️ Deleted incomplete audio file:', pregenPath);
                    } catch (e) {
                      console.warn('[WELCOME] Failed to delete incomplete audio:', e);
                    }
                    pregenPath = null;
                  }
                } catch (e) {
                  console.warn('[WELCOME] Failed to check text file:', e);
                  pregenPath = null;
                }
              }
              
              // Если нашли текст, проверяем наличие аудио рядом с ним
              if (foundPregenText && !pregenPath) {
                try {
                  // КРИТИЧЕСКИ ВАЖНО: Используем хеш БЕЗ locationId, но сохраняем в папке локации
                  const hashWithoutLoc = createAudioHash(searchText, undefined, undefined, 'narrator', 0);
                  const textPath = path.join(PRAGEN_DIR, scenarioGameIdForPregen, first.id || 'general', `narrator_${hashWithoutLoc}.txt`);
                  if (fs.existsSync(textPath)) {
                    const audioPath = textPath.replace(/\.txt$/, '.wav');
                    if (fs.existsSync(audioPath)) {
                      pregenPath = audioPath;
                    } else {
                      // Если аудио нет - удаляем текст и генерируем заново
                      console.warn('[WELCOME] ⚠️ Found text but no audio file, deleting incomplete files and regenerating');
                      try {
                        fs.unlinkSync(textPath);
                        console.log('[WELCOME] 🗑️ Deleted incomplete text file:', textPath);
                      } catch (e) {
                        console.warn('[WELCOME] Failed to delete incomplete text:', e);
                      }
                      foundPregenText = null;
                    }
                  }
                } catch (e) {
                  console.warn('[WELCOME] Failed to check audio file:', e);
                  foundPregenText = null;
                }
              }
              
              if (foundPregenText && pregenPath) {
                try {
                  // Проверяем, что оба файла действительно существуют
                  if (!fs.existsSync(pregenPath) || !fs.existsSync(pregenPath.replace(/\.wav$/, '.txt'))) {
                    console.warn('[WELCOME] ⚠️ Files do not exist, deleting and regenerating');
                    try {
                      if (fs.existsSync(pregenPath)) fs.unlinkSync(pregenPath);
                      const textPath = pregenPath.replace(/\.wav$/, '.txt');
                      if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
                    } catch {}
                    foundPregenText = null;
                    pregenPath = null;
                  } else {
                    // Используем предгенерированный текст (если он был найден)
                    if (foundPregenText && foundPregenText !== text) {
                      text = foundPregenText;
                      console.log('[WELCOME] ✅ Using pre-generated text from file');
                    }
                  
                  // Используем предгенерированное аудио
                  console.log('[WELCOME] ✅ Using pre-generated audio from:', pregenPath);
                  const audioBuffer = fs.readFileSync(pregenPath);
                    const MIN_AUDIO_SIZE = 250 * 1024; // 250 КБ
                    if (audioBuffer.byteLength < MIN_AUDIO_SIZE) {
                      console.warn(`[WELCOME] ⚠️ Pre-generated audio too small: ${audioBuffer.byteLength} bytes (expected at least ${MIN_AUDIO_SIZE} bytes). Regenerating...`);
                      // Удаляем невалидные файлы
                      try {
                        fs.unlinkSync(pregenPath);
                        const textPath = pregenPath.replace(/\.wav$/, '.txt');
                        if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
                      } catch (e) {
                        console.warn('[WELCOME] Failed to delete invalid pre-generated files:', e);
                      }
                      pregenText = null;
                      pregenPath = null;
                    } else {
                  audioData = { buffer: audioBuffer, contentType: 'audio/wav' };
                  console.log(`[WELCOME] ✅ Pre-generated audio loaded, size: ${audioBuffer.byteLength} bytes`);
                    }
                  }
                } catch (e) {
                  console.warn('[WELCOME] Failed to read pre-generated materials:', e);
                  pregenText = null;
                  pregenPath = null;
                }
              } else {
                console.log(`[WELCOME] ⚠️ Pre-generated materials not found or incomplete for scenarioGameId=${scenarioGameIdForPregen}, locationId=${first.id} (hash: ${createAudioHash(text, first.id, undefined, 'narrator', 0)})`);
              }
            }
            // УБРАНО: background generation - не нужен, так как мы генерируем синхронно ниже
          }
          
          // Если прегенерированного аудио нет - генерируем в реальном времени
          // Если флаг usePregenMaterials включен - сохраняем сгенерированное навсегда
          if (!audioData) {
            const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
            const ttsUrl = `${apiBase}/api/tts`;
            console.log('[WELCOME] 🎤 Generating TTS for welcome message, text length:', text.length);
            
            const ttsResponse = await undiciFetch(ttsUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text,
                gameId,
                locationId: first?.id,
                format: 'wav',
                isNarrator: true
              }),
              signal: AbortSignal.timeout(60000) // 60 секунд для SSML генерации
            });
            
            if (ttsResponse.ok) {
              const contentType = ttsResponse.headers.get('content-type') || 'audio/wav';
              const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
              const MIN_AUDIO_SIZE = 250 * 1024; // 250 КБ
              if (audioBuffer.byteLength < MIN_AUDIO_SIZE) {
                console.error(`[WELCOME] ❌ Generated audio too small: ${audioBuffer.byteLength} bytes (expected at least ${MIN_AUDIO_SIZE} bytes). This is likely an error!`);
                audioData = null;
              } else {
              audioData = { buffer: audioBuffer, contentType };
              console.log('[WELCOME] ✅ TTS generation successful, audio size:', audioBuffer.byteLength, 'bytes');
              }
              
              // КРИТИЧЕСКИ ВАЖНО: Сохраняем ОБА файла (текст и аудио) всегда, но только если аудио валидное
              if (audioData && gameId && first?.id) {
                try {
                  // КРИТИЧЕСКИ ВАЖНО: Сохраняем БЕЗ locationId в хеше, но в папке локации
                  const hashWithoutLoc = createAudioHash(text, undefined, undefined, 'narrator', 0);
                  const subDir = first.id || 'general';
                  const audioPath = path.join(PRAGEN_DIR, gameId, subDir, `narrator_${hashWithoutLoc}.wav`);
                  const audioDir = path.dirname(audioPath);
                  try { fs.mkdirSync(audioDir, { recursive: true }); } catch {}
                  fs.writeFileSync(audioPath, audioData.buffer);
                  
                  // Сохраняем также текст
                  const textPath = path.join(PRAGEN_DIR, gameId, subDir, `narrator_${hashWithoutLoc}.txt`);
                  try { fs.mkdirSync(path.dirname(textPath), { recursive: true }); } catch {}
                  fs.writeFileSync(textPath, text, 'utf-8');
                  
                  console.log('[WELCOME] 💾 Saved generated audio and text for future use:', audioPath);
                } catch (e) {
                  console.warn('[WELCOME] Failed to save generated audio:', e);
                }
              } else if (audioData && gameId && first?.id) {
                // Сохраняем и при выключенном флаге для кэширования
                // КРИТИЧЕСКИ ВАЖНО: Сохраняем ОБА файла (текст и аудио)
                try {
                  // КРИТИЧЕСКИ ВАЖНО: Сохраняем БЕЗ locationId в хеше, но в папке локации
                  const hashWithoutLoc = createAudioHash(text, undefined, undefined, 'narrator', 0);
                  const subDir = first.id || 'general';
                  const audioPath = path.join(PRAGEN_DIR, gameId, subDir, `narrator_${hashWithoutLoc}.wav`);
                  const audioDir = path.dirname(audioPath);
                  try { fs.mkdirSync(audioDir, { recursive: true }); } catch {}
                  fs.writeFileSync(audioPath, audioData.buffer);
                  
                  // Сохраняем также текст
                  const textPath = path.join(PRAGEN_DIR, gameId, subDir, `narrator_${hashWithoutLoc}.txt`);
                  try { fs.mkdirSync(path.dirname(textPath), { recursive: true }); } catch {}
                  fs.writeFileSync(textPath, text, 'utf-8');
                  
                  console.log('[WELCOME] 💾 Saved generated audio and text for caching:', audioPath);
                } catch (e) {
                  console.warn('[WELCOME] Failed to save generated audio:', e);
                }
              }
            } else {
              console.warn('[WELCOME] TTS generation failed:', ttsResponse.status);
            }
          }
        } catch (ttsErr: any) {
          console.warn('[WELCOME] TTS generation error (non-critical):', ttsErr?.message || String(ttsErr));
          // КРИТИЧЕСКИ ВАЖНО: Если TTS не сгенерировался, audioData остается null
          // Ответ все равно отправляется, но без аудио (после завершения попытки генерации)
        }
      }
      
      // КРИТИЧЕСКИ ВАЖНО: Ответ отправляется ТОЛЬКО после завершения TTS (успешного или с ошибкой)
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
      
      // КРИТИЧЕСКИ ВАЖНО: Ответ отправляется ТОЛЬКО после завершения TTS
      const response: any = { message: text || '', fallback: !Boolean(apiKey) };
      if (audioData) {
        response.audio = {
          data: audioData.buffer.toString('base64'),
          contentType: audioData.contentType || 'audio/wav',
          format: 'base64'
        };
        console.log('[WELCOME] ✅ Returning text + audio together (audio size:', audioData.buffer.byteLength, 'bytes)');
      } else {
        console.warn('[WELCOME] ⚠️ No audio generated - response will be sent without audio');
      }
      return res.json(response);
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
          
      // КРИТИЧЕСКИ ВАЖНО: Ищем прегенерированный текст и аудио по фиксированному ключу welcomeKey
      // WELCOME сообщение имеет depth=0, choiceIndex=undefined, parentHash=undefined
      let pregenPath = findPregenAudio(scenarioGameIdForPregen, welcomeKey, undefined, undefined, 'narrator', 0);
      
      // Если не нашли БЕЗ locationId, пробуем С locationId (для обратной совместимости)
      if (!pregenPath) {
        pregenPath = findPregenAudio(scenarioGameIdForPregen, welcomeKey, first.id, undefined, 'narrator', 0);
      }
      
      // КРИТИЧЕСКИ ВАЖНО: НЕ ищем "любой файл" по локации, так как это может привести к загрузке середины игры
      // Ищем только файлы с depth=0, choiceIndex=undefined, parentHash=undefined (welcome сообщения)
      // Если не нашли по точному тексту - не используем файлы из середины игры
          
          if (pregenPath) {
            try {
              console.log('[WELCOME] ✅ Using pre-generated audio from (SOLO):', pregenPath);
              const audioBuffer = fs.readFileSync(pregenPath);
              const MIN_AUDIO_SIZE = 250 * 1024; // 250 КБ
              if (audioBuffer.byteLength < MIN_AUDIO_SIZE) {
                console.warn(`[WELCOME] ⚠️ Pre-generated audio too small (SOLO): ${audioBuffer.byteLength} bytes (expected at least ${MIN_AUDIO_SIZE} bytes). Regenerating...`);
                // Удаляем невалидные файлы
                try {
                  fs.unlinkSync(pregenPath);
                  const textPath = pregenPath.replace(/\.wav$/, '.txt');
                  if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
                } catch (e) {
                  console.warn('[WELCOME] Failed to delete invalid pre-generated files (SOLO):', e);
                }
                pregenPath = null;
              } else {
              audioData = { buffer: audioBuffer, contentType: 'audio/wav' };
              console.log(`[WELCOME] ✅ Pre-generated audio loaded (SOLO), size: ${audioBuffer.byteLength} bytes`);
              }
              
              // КРИТИЧЕСКИ ВАЖНО: Ищем и загружаем соответствующий текст
              const textPath = pregenPath.replace(/\.wav$/, '.txt');
              if (fs.existsSync(textPath)) {
                try {
                  const pregenText = fs.readFileSync(textPath, 'utf-8');
                  if (pregenText && pregenText.trim()) {
                    text = pregenText.trim();
                    console.log('[WELCOME] ✅ Pre-generated text loaded (SOLO) from:', textPath);
                    
                    // Проверяем, есть ли варианты выбора в прегенерированном тексте
                    const choices = parseChoiceOptions(text);
                    if (choices.length === 0 && first?.id) {
                      // Если вариантов нет, добавляем их из кнопок локации
                      const exits = await prisma.locationExit.findMany({ where: { locationId: first.id } });
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
                  } else {
                    console.warn('[WELCOME] ⚠️ Pre-generated text file is empty (SOLO), deleting incomplete files');
                    try {
                      fs.unlinkSync(pregenPath);
                      fs.unlinkSync(textPath);
                      audioData = null;
                      pregenPath = null;
                    } catch (delErr) {
                      console.warn('[WELCOME] Failed to delete incomplete files:', delErr);
                    }
                  }
                } catch (textErr) {
                  console.warn('[WELCOME] ⚠️ Failed to read pre-generated text (SOLO), deleting incomplete files:', textErr);
                  try {
                    fs.unlinkSync(pregenPath);
                    fs.unlinkSync(textPath);
                    audioData = null;
                    pregenPath = null;
                  } catch (delErr) {
                    console.warn('[WELCOME] Failed to delete incomplete files:', delErr);
                  }
                }
              } else {
                console.warn('[WELCOME] ⚠️ Pre-generated text file not found (SOLO), deleting incomplete audio:', textPath);
                try {
                  fs.unlinkSync(pregenPath);
                  audioData = null;
                  pregenPath = null;
                } catch (delErr) {
                  console.warn('[WELCOME] Failed to delete incomplete audio:', delErr);
                }
              }
            } catch (e) {
              console.warn('[WELCOME] Failed to read pre-generated audio (SOLO):', e);
            }
          } else {
            console.log(`[WELCOME] ⚠️ Pre-generated audio not found (SOLO) for scenarioGameId=${scenarioGameIdForPregen}, locationId=${first.id}`);
          }
          
          // Если прегенерированного текста нет - генерируем через AI
          if (!text) {
            const sc = await buildGptSceneContext(prisma, { gameId, userId: uid, history: [] });
            const { text: generatedText } = await generateChatCompletion({
              systemPrompt: sys,
              userPrompt: 'Контекст сцены:\n' + sc,
              history: []
            });
            text = generatedText;
            if (text) {
              // Постобработка: преобразуем варианты выбора со звездочками в нумерованный список
              text = formatChoiceOptions(text);
              
              // Проверяем, есть ли варианты выбора в тексте
              const choices = parseChoiceOptions(text);
              if (choices.length === 0 && first?.id) {
                // Если вариантов нет, добавляем их из кнопок локации
                const exits = await prisma.locationExit.findMany({ where: { locationId: first.id } });
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
            text = (text || '').trim();
        }
        
        // Если прегенерированного аудио нет, генерируем новое
          if (!audioData && text) {
            try {
          const apiBase = process.env.API_BASE_URL || 'http://localhost:4000';
          const ttsUrl = `${apiBase}/api/tts`;
          console.log('[WELCOME] 🎤 Generating TTS for welcome message (SOLO), text length:', text.length);
          
          const ttsResponse = await undiciFetch(ttsUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              gameId,
              locationId: first?.id,
              format: 'wav',
              isNarrator: true,
              depth: 0, // WELCOME сообщение имеет depth=0
              choiceIndex: undefined,
              parentHash: undefined
            }),
            signal: AbortSignal.timeout(60000) // 60 секунд таймаут (нужно время для SSML генерации)
          });
          
          if (ttsResponse.ok) {
            const contentType = ttsResponse.headers.get('content-type') || 'audio/wav';
            const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
            const MIN_AUDIO_SIZE = 250 * 1024; // 250 КБ
            if (audioBuffer.byteLength < MIN_AUDIO_SIZE) {
              console.error(`[WELCOME] ❌ Generated audio too small (SOLO): ${audioBuffer.byteLength} bytes (expected at least ${MIN_AUDIO_SIZE} bytes). This is likely an error!`);
              audioData = null;
            } else {
            audioData = { buffer: audioBuffer, contentType };
            console.log('[WELCOME] ✅ TTS generation successful (SOLO), audio size:', audioBuffer.byteLength, 'bytes');
            }
            
            // Сохраняем сгенерированное аудио для будущего использования, но только если аудио валидное
            // КРИТИЧЕСКИ ВАЖНО: Используем welcomeKey вместо text для создания хеша
            if (audioData && sess?.scenarioGameId && first?.id && text) {
              try {
                // WELCOME сообщение имеет depth=0, choiceIndex=undefined, parentHash=undefined
                // КРИТИЧЕСКИ ВАЖНО: Сохраняем по фиксированному ключу welcomeKey, чтобы хеш был одинаковым для одной локации
                const hashWithoutLoc = createAudioHash(welcomeKey, undefined, undefined, 'narrator', 0);
                const subDir = first.id || 'general';
                const audioPath = path.join(PRAGEN_DIR, sess.scenarioGameId, subDir, `narrator_${hashWithoutLoc}.wav`);
                const audioDir = path.dirname(audioPath);
                try { fs.mkdirSync(audioDir, { recursive: true }); } catch {}
                fs.writeFileSync(audioPath, audioData.buffer);
                
                // Сохраняем также текст
                const textPath = path.join(PRAGEN_DIR, sess.scenarioGameId, subDir, `narrator_${hashWithoutLoc}.txt`);
                try { fs.mkdirSync(path.dirname(textPath), { recursive: true }); } catch {}
                fs.writeFileSync(textPath, text, 'utf-8');
                
                console.log('[WELCOME] 💾 Saved generated audio for future use (SOLO):', audioPath);
              } catch (e) {
                console.warn('[WELCOME] Failed to save generated audio (SOLO):', e);
              }
            }
          } else {
            console.warn('[WELCOME] TTS generation failed (SOLO):', ttsResponse.status);
        }
      } catch (ttsErr: any) {
        console.warn('[WELCOME] TTS generation error (SOLO, non-critical):', ttsErr?.message || String(ttsErr));
              // КРИТИЧЕСКИ ВАЖНО: Если TTS не сгенерировался, audioData остается null
              // Ответ все равно отправляется, но без аудио (после завершения попытки генерации)
            }
      }
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Ответ отправляется ТОЛЬКО после завершения TTS (успешного или с ошибкой)
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
    
    // КРИТИЧЕСКИ ВАЖНО: Ответ отправляется ТОЛЬКО после завершения TTS
    const response: any = { message: text || '', fallback: !Boolean(client) };
    if (audioData) {
      response.audio = {
        data: audioData.buffer.toString('base64'),
        contentType: audioData.contentType || 'audio/wav',
        format: 'base64'
      };
      console.log('[WELCOME] ✅ Returning text + audio together (SOLO, audio size:', audioData.buffer.byteLength, 'bytes)');
    } else {
      console.warn('[WELCOME] ⚠️ No audio generated (SOLO) - response will be sent without audio');
    }
    return res.json(response);
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
    
    // СНАЧАЛА пытаемся смэпить ввод игрока к кнопке/триггеру и сменить сцену (если есть активная сессия)
    let forcedGameOver = false;
    if (gameId) {
      try {
        const sess = await getGameSession();
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
            console.log('[REPLY] ✅ Chosen exit:', { id: chosen.id, buttonText: chosen.buttonText, triggerText: chosen.triggerText, isGameOver: chosen.isGameOver, type: chosen.type, targetLocationId: chosen.targetLocationId });
            if (chosen.isGameOver || chosen.type === 'GAMEOVER') {
              console.log('[REPLY] ⚠️ Exit marked as game over - setting forcedGameOver');
              try {
                const state = (await prisma.gameSession.findUnique({ where: { id: sess.id }, select: { state: true } }))?.state as any || {};
                state.finishedAt = new Date().toISOString();
                state.finishReason = 'game_over';
                await prisma.gameSession.update({ where: { id: sess.id }, data: { state } });
                forcedGameOver = true;
              } catch {}
            } else if (chosen.targetLocationId) {
              await prisma.gameSession.update({ where: { id: sess.id }, data: { currentLocationId: chosen.targetLocationId } });
              // Обновляем кэш после изменения локации
              cachedGameSession = await prisma.gameSession.findUnique({ where: { id: sess.id } });
            } else {
              console.warn('[REPLY] ⚠️ Chosen exit has no targetLocationId and is not game over');
            }
          } else {
            console.log('[REPLY] ⚠️ No exit chosen for userText:', userText);
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
        return res.json({ message: finalText, fallback: false, gameOver: true });
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
      if (game.worldRules) context.push(`Правила мира (сопоставляй с текущей сценой, не обобщай): ${game.worldRules}`);
      if (game.gameplayRules) context.push(`Правила процесса (сопоставляй с текущей сценой, не обобщай): ${game.gameplayRules}`);
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
        
        context.push('Игровые персонажи D&D 5e (ТЕКУЩЕЕ СОСТОЯНИЕ):\n' + playable.map((p: any) => {
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

    // ОПТИМИЗАЦИЯ: Передаем кэшированные данные в buildGptSceneContext
    const sc = await (async () => {
      try {
        if (gameId) {
          return await buildGptSceneContext(prisma, {
            gameId,
            lobbyId,
            userId: lobbyId ? undefined : (await getUserId()),
            history: baseHistory,
            cachedGameSession: cachedGameSession, // Передаем кэшированную сессию
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

    // КРИТИЧЕСКИ ВАЖНО: Определяем choiceIndex ДО создания userPrompt, чтобы передать его в промпт
    // Это нужно, чтобы AI знал, какой вариант выбрал пользователь, даже если прегенерированного контента нет
    let detectedChoiceIndexForPrompt: number | undefined = undefined;

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
    let choiceIndexFromAI: boolean = false; // Флаг: был ли choiceIndex определен AI
    let parentHashForPregen: string | undefined = undefined;
    let pregenTextFound: string | null = null; // Инициализируем здесь
    
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
            
            // КРИТИЧЕСКИ ВАЖНО: choiceIndex определяем из ТЕКУЩЕГО userText (ответ пользователя)
            // А не из истории, так как для первого ответа на welcome сообщение это еще не в истории
            // КРИТИЧЕСКИ ВАЖНО: Всегда используем AI для определения choiceIndex, если есть варианты выбора
            if (userText) {
              const lastBotMessage = botMessages.length > 0 ? botMessages[botMessages.length - 1] : null;
              try {
                const detectedChoiceIndex = await detectChoiceIndexWithAI(userText, lastBotMessage?.text);
                if (detectedChoiceIndex === -1) {
                  // AI не смог определить выбор - отправляем сообщение пользователю
                  console.log('[REPLY] ⚠️ AI cannot determine choiceIndex, asking user to clarify');
                  return res.json({ message: 'Не распознали ваш ответ, выберите вариант корректно!', fallback: false });
                } else if (detectedChoiceIndex !== undefined) {
                  // AI успешно определил choiceIndex
                  choiceIndexForPregen = detectedChoiceIndex;
                  choiceIndexFromAI = true; // Помечаем, что choiceIndex определен AI
                  console.log('[REPLY] ✅ Detected choiceIndex from current userText (AI):', choiceIndexForPregen, 'for userText:', userText);
                } else {
                  // AI вернул undefined - нет вариантов выбора, это нормально, продолжаем без choiceIndex
                  console.log('[REPLY] ⚠️ AI returned undefined - no choices found in bot message, continuing without choiceIndex');
                }
              } catch (e) {
                console.warn('[REPLY] Failed to detect choiceIndex with AI:', e);
                // Если AI не смог определить - просим пользователя уточнить
                return res.json({ message: 'Не распознали ваш ответ, выберите вариант корректно!', fallback: false });
              }
            }
            
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
            // Если истории нет (первый ответ на welcome), depth=1, choiceIndex из userText
            depthForPregen = 1;
            if (userText) {
              // Получаем welcome сообщение для AI-поиска
              let welcomeMessageText: string | undefined = undefined;
              try {
                const uid = lobbyId ? undefined : await resolveUserIdFromQueryOrBody(req, prisma);
                const chatSess = lobbyId 
                  ? await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } } })
                  : uid ? await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId: gameId || 'unknown' } } }) : null;
                if (chatSess?.history) {
                  const hist = (chatSess.history as any) as Array<{ from: 'bot' | 'me'; text: string }>;
                  const welcomeMsg = hist.find(m => m.from === 'bot');
                  if (welcomeMsg?.text) {
                    welcomeMessageText = welcomeMsg.text;
                  }
                }
              } catch (e) {
                // Игнорируем ошибки
              }
              
              // КРИТИЧЕСКИ ВАЖНО: Всегда используем AI для определения choiceIndex, если есть варианты выбора
              try {
                const detectedChoiceIndex = await detectChoiceIndexWithAI(userText, welcomeMessageText);
                if (detectedChoiceIndex === -1) {
                  // AI не смог определить выбор - отправляем сообщение пользователю
                  console.log('[REPLY] ⚠️ AI cannot determine choiceIndex, asking user to clarify');
                  return res.json({ message: 'Не распознали ваш ответ, выберите вариант корректно!', fallback: false });
                } else if (detectedChoiceIndex !== undefined) {
                  // AI успешно определил choiceIndex
                  choiceIndexForPregen = detectedChoiceIndex;
                  choiceIndexFromAI = true; // Помечаем, что choiceIndex определен AI
                  detectedChoiceIndexForPrompt = detectedChoiceIndex; // Сохраняем для использования в промпте
                  console.log('[REPLY] ✅ First reply: detected choiceIndex from userText (AI):', choiceIndexForPregen, 'for userText:', userText);
                } else {
                  // AI вернул undefined - нет вариантов выбора, это нормально, продолжаем без choiceIndex
                  console.log('[REPLY] ⚠️ AI returned undefined - no choices found in welcome message, continuing without choiceIndex');
                }
              } catch (e) {
                console.warn('[REPLY] Failed to detect choiceIndex with AI:', e);
                // Если AI не смог определить - просим пользователя уточнить
                return res.json({ message: 'Не распознали ваш ответ, выберите вариант корректно!', fallback: false });
              }
            }
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
        console.warn('[REPLY] Failed to get session context for pregen check:', e);
        scenarioGameIdForPregen = gameId;
      }
    }
    
    // КРИТИЧЕСКИ ВАЖНО: Определяем choiceIndex через AI ПЕРЕД поиском прегенерации
    // Это нужно, чтобы использовать правильный choiceIndex при поиске
    if (scenarioGameIdForPregen && userText && choiceIndexForPregen === undefined) {
      try {
        // Получаем последнее сообщение бота для AI-обработки
        let lastBotMessageText: string | undefined = undefined;
        if (baseHistory && baseHistory.length > 0) {
          const botMessages = baseHistory.filter(m => m.from === 'bot');
          if (botMessages.length > 0) {
            lastBotMessageText = botMessages[botMessages.length - 1]?.text;
          }
        } else {
          // Если истории нет, получаем welcome сообщение из chatSession
          try {
            const uid = lobbyId ? undefined : await resolveUserIdFromQueryOrBody(req, prisma);
            const chatSess = lobbyId 
              ? await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: 'lobby:' + lobbyId, gameId: gameId || 'unknown' } } })
              : uid ? await prisma.chatSession.findUnique({ where: { userId_gameId: { userId: uid, gameId: gameId || 'unknown' } } }) : null;
            if (chatSess?.history) {
              const hist = (chatSess.history as any) as Array<{ from: 'bot' | 'me'; text: string }>;
              const welcomeMsg = hist.find(m => m.from === 'bot');
              if (welcomeMsg?.text) {
                lastBotMessageText = welcomeMsg.text;
              }
            }
          } catch (e) {
            // Игнорируем ошибки
          }
        }
        
        // КРИТИЧЕСКИ ВАЖНО: Всегда используем AI для определения choiceIndex, если есть варианты выбора
        const detectedChoiceIndex = await detectChoiceIndexWithAI(userText, lastBotMessageText);
        if (detectedChoiceIndex === -1) {
          // AI не смог определить выбор - отправляем сообщение пользователю
          console.log('[REPLY] ⚠️ AI cannot determine choiceIndex, asking user to clarify');
          return res.json({ message: 'Не распознали ваш ответ, выберите вариант корректно!', fallback: false });
        } else if (detectedChoiceIndex !== undefined) {
          // AI успешно определил choiceIndex
          choiceIndexForPregen = detectedChoiceIndex;
          choiceIndexFromAI = true; // Помечаем, что choiceIndex определен AI
          console.log('[REPLY] ✅ Detected choiceIndex with AI BEFORE pregen search:', choiceIndexForPregen, 'for userText:', userText);
        } else {
          // AI вернул undefined - нет вариантов выбора, это нормально, продолжаем без choiceIndex
          console.log('[REPLY] ⚠️ AI returned undefined - no choices found in bot message, continuing without choiceIndex');
        }
      } catch (e) {
        console.warn('[REPLY] Failed to detect choiceIndex with AI before pregen search:', e);
        // Если AI не смог определить - просим пользователя уточнить
        return res.json({ message: 'Не распознали ваш ответ, выберите вариант корректно!', fallback: false });
      }
    }
    
    // ИЩЕМ прегенерированный текст ПЕРЕД генерацией
    if (scenarioGameIdForPregen) {
      const hasMaterials = hasPregenMaterials(scenarioGameIdForPregen);
