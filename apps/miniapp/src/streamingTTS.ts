// Глобальный экземпляр AudioContext (синглтон)
let globalAudioContext: AudioContext | null = null;
let activeSources: AudioBufferSourceNode[] = [];
let currentAbortController: AbortController | null = null;

// Типы для TTS
export interface StreamingTTSOptions {
  text: string;
  voiceName?: string;
  modelName?: string;
  onProgress?: (bytes: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

// Функция для остановки текущего проигрывания
export function stopStreamingTTS() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  activeSources.forEach(source => {
    try {
      source.stop();
      source.disconnect();
    } catch (e) {
      // Игнорируем ошибки если источник уже остановлен
    }
  });
  activeSources = [];
  console.log('[STREAMING-TTS] Playback stopped and cleared');
}

// Функция для инициализации контекста (вызывать по жесту пользователя)
export function initAudioContext(): AudioContext {
  if (!globalAudioContext) {
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    globalAudioContext = new AudioContextClass({ sampleRate: 24000 });
    console.log('[STREAMING-TTS] AudioContext created, state:', globalAudioContext?.state);
  }
  
  const ctx = globalAudioContext;
  if (!ctx) throw new Error('Failed to create AudioContext');

  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.error('[STREAMING-TTS] Resume failed:', e));
  }
  return ctx;
}

// Разблокировка при первом тапе (с хаком тишины для iOS/Telegram)
if (typeof window !== 'undefined') {
  const unlock = () => {
    try {
      const ctx = initAudioContext();
      
      // Хак для iOS/Telegram: проигрываем пустой буфер
      const dummy = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = dummy;
      source.connect(ctx.destination);
      source.start(0);
      
      console.log('[STREAMING-TTS] Audio Unlocked via dummy sound');
      window.removeEventListener('click', unlock);
      window.removeEventListener('touchstart', unlock);
    } catch (e) {
      console.error('[STREAMING-TTS] Unlock failed:', e);
    }
  };
  window.addEventListener('click', unlock);
  window.addEventListener('touchstart', unlock);
}

export async function playStreamingTTS(options: StreamingTTSOptions): Promise<void> {
  const { text, voiceName, modelName, onProgress, onComplete, onError } = options;
  
  // Если уже что-то играет, останавливаем (опционально, зависит от того как вызываем)
  // stopStreamingTTS(); 

  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' 
    ? 'http://localhost:4000/api' 
    : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  
  const url = `${apiBase}/tts-stream`;
  
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  try {
    const audioContext = initAudioContext();
    const sampleRate = 24000; // Gemini Live по умолчанию шлет 24кГц
    
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(audioContext.destination);
    
    let nextStartTime = audioContext.currentTime;
    let bytesReceived = 0;
    let leftover: Uint8Array | null = null;
    let isFirstChunk = true; // Флаг для первого чанка - начинаем воспроизведение сразу
    let chunksReceived = 0; // Счетчик полученных чанков
    
    // Функция проигрывания сырого PCM куска (Шаг 1)
    const playPCM = (value: Uint8Array) => {
      if (signal.aborted) return;
      
      chunksReceived++;
      
      // Логируем первый чанк ДО обработки
      if (isFirstChunk) {
        console.log('[STREAMING-TTS] 📦 First chunk received, size:', value.length, 'bytes');
      }

      // 1. Соединяем с остатком от прошлого чанка
      let combined = value;
      if (leftover) {
        const newCombined = new Uint8Array(leftover.length + value.length);
        newCombined.set(leftover);
        newCombined.set(value, leftover.length);
        combined = newCombined;
        leftover = null;
      }

      // 2. PCM 16-bit требует 2 байта на семпл. Если байт нечетный — сохраняем в остаток
      if (combined.length % 2 !== 0) {
        leftover = combined.slice(combined.length - 1);
        combined = combined.slice(0, combined.length - 1);
      }

      if (combined.length === 0) {
        if (isFirstChunk) {
          console.warn('[STREAMING-TTS] ⚠️ First chunk is empty after processing, skipping');
        }
        return;
      }
      
      // Проверяем, не является ли первый чанк полностью тишиной (все байты равны 0 или близки к 0)
      if (isFirstChunk && combined.length >= 2) {
        const checkArray = new Int16Array(combined.buffer, combined.byteOffset, Math.min(combined.length / 2, 100));
        let allZero = true;
        for (let i = 0; i < checkArray.length; i++) {
          const val = checkArray[i];
          if (val !== undefined && Math.abs(val) > 100) { // Порог для определения тишины
            allZero = false;
            break;
          }
        }
        if (allZero) {
          console.warn('[STREAMING-TTS] ⚠️ First chunk appears to be silence, but playing anyway to avoid skipping audio');
        }
      }

      // 3. КРИТИЧНО: Используем byteOffset и длину в конструкторе
      const int16Array = new Int16Array(
        combined.buffer,
        combined.byteOffset,
        combined.length / 2
      );

      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        const val = int16Array[i];
        float32Array[i] = val !== undefined ? val / 32768.0 : 0;
      }

      const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      
      // Добавляем в список активных для возможности остановки
      activeSources.push(source);
      source.onended = () => {
        activeSources = activeSources.filter(s => s !== source);
      };

      const now = audioContext.currentTime;
      
      // КРИТИЧЕСКИ ВАЖНО: Для максимально быстрого старта воспроизведения
      // Первый чанк должен начать воспроизводиться СРАЗУ, без задержек
      if (isFirstChunk) {
        // Первый чанк - начинаем воспроизведение немедленно
        nextStartTime = now;
        isFirstChunk = false;
        console.log('[STREAMING-TTS] 🎵 First chunk - starting playback immediately, samples:', float32Array.length, 'duration:', audioBuffer.duration.toFixed(3), 's');
      } else if (nextStartTime < now) {
        // Если мы отстали (например, из-за задержек сети) - начинаем сразу
        nextStartTime = now;
      }
      // Если nextStartTime уже в будущем (последующие чанки), используем его как есть
      // Это обеспечивает плавное воспроизведение без пропусков

      source.start(nextStartTime);
      nextStartTime += audioBuffer.duration;
      
      bytesReceived += combined.length;
      onProgress?.(bytesReceived);
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voiceName: voiceName || 'Kore',
        modelName: modelName || 'gemini-2.0-flash-exp',
      }),
      signal
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No reader');
    
    console.log('[STREAMING-TTS] Reading stream...');
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done || signal.aborted) {
        if (!signal.aborted) {
          console.log('[STREAMING-TTS] Stream complete');
          const wait = (nextStartTime - audioContext.currentTime) * 1000 + 100;
          setTimeout(() => {
            if (!signal.aborted) onComplete?.();
          }, Math.max(0, wait));
        }
        break;
      }
      
      if (!value || value.length === 0) {
        console.warn('[STREAMING-TTS] ⚠️ Received empty chunk, skipping');
        continue;
      }

      // Проверка на JSON
      if (value[0] === 123) {
        const textErr = new TextDecoder().decode(value);
        if (textErr.startsWith('{"error"')) {
          console.error('[STREAMING-TTS] Server error:', textErr);
          throw new Error(textErr);
        }
      }

      // КРИТИЧЕСКИ ВАЖНО: Передаем чанк сразу для воспроизведения, без задержек
      // playPCM вызывается синхронно и сразу планирует воспроизведение
      // НЕ пропускаем чанки, даже если они кажутся пустыми - это может быть начало аудио
      playPCM(value);
    }
    
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log('[STREAMING-TTS] Fetch aborted');
      return;
    }
    console.error('[STREAMING-TTS] Error:', error);
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Разбивает текст на части по предложениям и проигрывает последовательно.
 */
export async function playStreamingTTSChunked(options: StreamingTTSOptions & { wordsPerChunk?: number }): Promise<void> {
  const { text, wordsPerChunk = 40, ...rest } = options;
  
  // Регулярка для разбивки по предложениям, сохраняя знаки препинания
  // Разбиваем по . ! ? \n, но следим за длиной
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    
    // Если добавление предложения не превышает лимит слов (примерно)
    if ((currentChunk + ' ' + trimmed).split(/\s+/).length <= wordsPerChunk) {
      currentChunk += (currentChunk ? ' ' : '') + trimmed;
    } else {
      if (currentChunk) chunks.push(currentChunk);
      currentChunk = trimmed;
    }
  }
  if (currentChunk) chunks.push(currentChunk);
  
  // Перед началом новой очереди останавливаем старую
  stopStreamingTTS();
  
  const abortController = currentAbortController; // Запоминаем текущий контроллер

  for (const chunkText of chunks) {
    if (!chunkText) continue;
    if (abortController?.signal.aborted) break;

    await new Promise<void>((resolve, reject) => {
      playStreamingTTS({
        ...rest,
        text: chunkText,
        onComplete: () => resolve(),
        onError: (err) => reject(err)
      });
    });
  }
}

/**
 * Очередь для проигрывания аудио-кусков, приходящих через сокет или SSE.
 * Умеет склеивать сегменты в правильном порядке.
 */
class AudioQueue {
  private segments: Map<number, Uint8Array[]> = new Map();
  private isPlaying = false;
  private ctx: AudioContext;
  private nextStartTime = 0;
  private currentSegmentIndex = 0;
  private segmentLeftover: Map<number, Uint8Array | null> = new Map();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.nextStartTime = ctx.currentTime;
  }

  push(index: number, chunk: Uint8Array) {
    if (!this.segments.has(index)) {
      this.segments.set(index, []);
    }
    this.segments.get(index)!.push(chunk);
    this.process();
  }

  private async process() {
    if (this.isPlaying) return;
    this.isPlaying = true;

    while (true) {
      const segmentChunks = this.segments.get(this.currentSegmentIndex);
      
      // Если у нас нет данных для текущего сегмента, но есть для следующих - ждем
      if (!segmentChunks || segmentChunks.length === 0) {
        // Проверяем, есть ли вообще данные в очереди (для отладки)
        const hasAnyData = Array.from(this.segments.values()).some(q => q.length > 0);
        if (!hasAnyData) break;
        
        // Ждем немного появления данных для текущего сегмента
        await new Promise(r => setTimeout(r, 50));
        continue;
      }

      const value = segmentChunks.shift();
      if (!value) continue;

      // Логика PCM
      let leftover = this.segmentLeftover.get(this.currentSegmentIndex) || null;
      let combined = value;
      if (leftover) {
        const newCombined = new Uint8Array(leftover.length + value.length);
        newCombined.set(leftover);
        newCombined.set(value, leftover.length);
        combined = newCombined;
      }

      if (combined.length % 2 !== 0) {
        this.segmentLeftover.set(this.currentSegmentIndex, combined.slice(combined.length - 1));
        combined = combined.slice(0, combined.length - 1);
      } else {
        this.segmentLeftover.set(this.currentSegmentIndex, null);
      }

      if (combined.length === 0) continue;

      const int16Array = new Int16Array(combined.buffer, combined.byteOffset, combined.length / 2);
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = (int16Array[i] || 0) / 32768.0;
      }

      const audioBuffer = this.ctx.createBuffer(1, float32Array.length, 24000);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = this.ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.ctx.destination);
      activeSources.push(source);
      
      source.onended = () => {
        activeSources = activeSources.filter(s => s !== source);
        
        // Если сегмент закончился (на сервере пришел turnComplete и очередь пуста)
        // ВАЖНО: Мы переходим к следующему сегменту, когда текущий проигран полностью
        // Но так как у нас стриминг, мы просто продолжаем пока есть данные.
        // Переход к следующему сегменту осуществляется когда текущий ПУСТ и мы получили сигнал о конце (но тут мы упростим)
      };

      const now = this.ctx.currentTime;
      if (this.nextStartTime < now) {
        this.nextStartTime = now + 0.05;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;

      // Если в текущем сегменте больше нет чанков, пробуем заглянуть в следующий
      if (segmentChunks.length === 0) {
        // Даем небольшую фору серверу
        await new Promise(r => setTimeout(r, 50));
        if (segmentChunks.length === 0) {
          // Если все еще пусто, проверяем наличие следующего сегмента
          if (this.segments.has(this.currentSegmentIndex + 1)) {
            this.currentSegmentIndex++;
            console.log('[AUDIO-QUEUE] Switching to segment:', this.currentSegmentIndex);
          }
        }
      }

      await new Promise(r => setTimeout(r, 10));
    }

    this.isPlaying = false;
  }

  stop() {
    this.segments.clear();
    this.currentSegmentIndex = 0;
    this.isPlaying = false;
    this.segmentLeftover.clear();
    this.nextStartTime = this.ctx.currentTime;
  }
}

let globalAudioQueue: AudioQueue | null = null;

export function getAudioQueue(ctx: AudioContext): AudioQueue {
  if (!globalAudioQueue) {
    globalAudioQueue = new AudioQueue(ctx);
  }
  return globalAudioQueue;
}

export function stopAudioQueue() {
  if (globalAudioQueue) {
    globalAudioQueue.stop();
  }
}
