/**
 * Streaming TTS playback using Web Audio API
 * Plays PCM audio chunks as they arrive from the server
 * 
 * @example
 * ```typescript
 * import { playStreamingTTS } from './api';
 * 
 * // Простое использование
 * await playStreamingTTS({
 *   text: "Привет! Это проверка streaming TTS.",
 *   onProgress: (bytes) => console.log('Received:', bytes, 'bytes'),
 *   onComplete: () => console.log('Playback complete'),
 *   onError: (err) => console.error('Error:', err)
 * });
 * 
 * // С кастомным голосом
 * await playStreamingTTS({
 *   text: "Длинный текст для проверки streaming...",
 *   voiceName: "Kore",
 *   modelName: "gemini-2.5-flash-preview-tts"
 * });
 * ```
 */

interface StreamingTTSOptions {
  text: string;
  voiceName?: string;
  modelName?: string;
  onProgress?: (bytesReceived: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

export async function playStreamingTTS(options: StreamingTTSOptions): Promise<void> {
  const { text, voiceName, modelName, onProgress, onComplete, onError } = options;
  
  // Получаем API base URL
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' 
    ? 'http://localhost:4000/api' 
    : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  
  const url = `${apiBase}/tts-stream`;
  
  try {
    // Инициализируем Web Audio API с правильным sampleRate
    // ВАЖНО: Браузеры блокируют AudioContext до первого клика пользователя
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioContext = new AudioContextClass({ sampleRate: 24000 });
    
    // Разблокируем звук (если заблокирован)
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    
    const sampleRate = audioContext.sampleRate; // Используем реальный sampleRate контекста
    const channels = 1; // Моно
    
    // Планировщик для плавного воспроизведения без щелчков
    let nextStartTime = audioContext.currentTime;
    
    // Буфер для накопления аудио данных (джиттер-буфер для стабильности)
    let bytesReceived = 0;
    const jitterBuffer: ArrayBuffer[] = [];
    const jitterBufferSize = sampleRate * 0.1; // 100ms буфер для стабильности при нестабильном интернете
    let jitterBufferSamples = 0;
    let isPlaying = false;
    
    // Функция для воспроизведения PCM чанка
    const playPCMChunk = (pcmData: ArrayBuffer) => {
      bytesReceived += pcmData.byteLength;
      onProgress?.(bytesReceived);
      
      // 1. Конвертируем Int16 (PCM Little Endian) в Float32 (формат AudioContext)
      const int16Array = new Int16Array(pcmData);
      const float32Array = new Float32Array(int16Array.length);
      
      // Нормализуем Int16 (-32768..32767) в Float32 (-1.0..1.0)
      for (let i = 0; i < int16Array.length; i++) {
        const sample = int16Array[i];
        if (sample !== undefined) {
          float32Array[i] = sample / 32768.0;
        } else {
          float32Array[i] = 0;
        }
      }
      
      // 2. Создаем AudioBuffer и планируем воспроизведение
      const audioBuffer = audioContext.createBuffer(channels, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);
      
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      
      // 3. Расчет времени старта, чтобы не было щелчков между чанками
      const startTime = Math.max(audioContext.currentTime, nextStartTime);
      source.start(startTime);
      nextStartTime = startTime + audioBuffer.duration;
      
      console.log(`[STREAMING-TTS] Scheduled chunk: ${float32Array.length} samples, start: ${startTime.toFixed(3)}s, duration: ${audioBuffer.duration.toFixed(3)}s`);
    };
    
    // Функция для добавления PCM данных с джиттер-буфером
    const addAudioChunk = (pcmData: ArrayBuffer) => {
      const samples = pcmData.byteLength / 2; // 16-bit = 2 bytes per sample
      
      // Добавляем в джиттер-буфер
      jitterBuffer.push(pcmData);
      jitterBufferSamples += samples;
      
      // Если буфер достаточно заполнен, начинаем воспроизведение
      if (!isPlaying && jitterBufferSamples >= jitterBufferSize) {
        isPlaying = true;
        console.log('[STREAMING-TTS] Jitter buffer filled, starting playback');
        
        // Воспроизводим все данные из буфера
        for (const chunk of jitterBuffer) {
          playPCMChunk(chunk);
        }
        jitterBuffer.length = 0;
        jitterBufferSamples = 0;
      } else if (isPlaying) {
        // Если уже играет, воспроизводим сразу
        playPCMChunk(pcmData);
      }
    };
    
    // Отправляем запрос на streaming TTS
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voiceName: voiceName || 'Aoede',
        modelName: modelName || 'gemini-2.5-flash-preview-tts',
      }),
    });
    
    if (!response.ok) {
      throw new Error(`TTS streaming failed: ${response.status} ${response.statusText}`);
    }
    
    // Читаем поток данных
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }
    
    const decoder = new TextDecoder();
    let buffer = new Uint8Array(0);
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        // Поток завершен, добавляем оставшиеся данные
        if (buffer.length > 0) {
          addAudioChunk(buffer.buffer);
        }
        
        // Если еще не начали проигрывать, начинаем сейчас (даже если данных мало)
        if (!isPlaying && jitterBuffer.length > 0) {
          isPlaying = true;
          console.log('[STREAMING-TTS] Stream ended, playing remaining buffer');
          
          // Воспроизводим все данные из буфера
          for (const chunk of jitterBuffer) {
            playPCMChunk(chunk);
          }
          jitterBuffer.length = 0;
          jitterBufferSamples = 0;
        }
        
        // Ждем окончания воспроизведения (все чанки запланированы, ждем последний)
        if (isPlaying) {
          const waitTime = (nextStartTime - audioContext.currentTime) * 1000 + 500; // Время до последнего чанка + запас
          if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        
        onComplete?.();
        break;
      }
      
      // Объединяем новый чанк с буфером
      const newBuffer = new Uint8Array(buffer.length + value.length);
      newBuffer.set(buffer);
      newBuffer.set(value, buffer.length);
      buffer = newBuffer;
      
      // Обрабатываем полные PCM чанки (16-bit samples = 2 bytes per sample)
      // Уменьшенный размер чанка для более быстрого начала воспроизведения (real-time)
      const chunkSize = 2048; // 1024 samples = ~42ms при 24kHz (быстрее старт)
      while (buffer.length >= chunkSize) {
        const chunk = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        addAudioChunk(chunk.buffer);
      }
    }
    
    // Очистка
    // AudioContext и BufferSource автоматически очищаются после завершения воспроизведения
    // Закрываем контекст только если нужно освободить ресурсы
    // audioContext.close(); // Раскомментируйте, если нужно закрыть контекст
    
  } catch (error) {
    console.error('[STREAMING-TTS] Error:', error);
    onError?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

/**
 * Разбивает текст на части по указанному количеству слов и последовательно воспроизводит их
 * @param options - опции для streaming TTS
 * @param wordsPerChunk - количество слов в каждой части (по умолчанию 50)
 */
export async function playStreamingTTSChunked(
  options: StreamingTTSOptions & { wordsPerChunk?: number }
): Promise<void> {
  const { text, wordsPerChunk = 50, onProgress, onComplete, onError } = options;
  
  // Разбиваем текст на части по словам
  const words = text.trim().split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const chunk = words.slice(i, i + wordsPerChunk).join(' ');
    chunks.push(chunk);
  }
  
  console.log(`[STREAMING-TTS-CHUNKED] Split text into ${chunks.length} chunks (${wordsPerChunk} words each)`);
  
  // Воспроизводим каждую часть последовательно
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue; // Пропускаем пустые чанки
    
    const isLast = i === chunks.length - 1;
    
    console.log(`[STREAMING-TTS-CHUNKED] Playing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);
    
    try {
      await playStreamingTTS({
        text: chunk,
        voiceName: options.voiceName || undefined,
        modelName: options.modelName || undefined,
        onProgress: isLast ? onProgress : undefined, // Прогресс только для последнего чанка
        onComplete: isLast ? onComplete : undefined, // Завершение только для последнего чанка
        onError: onError
      });
      
      // Небольшая пауза между частями для плавности (кроме последней)
      if (!isLast) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`[STREAMING-TTS-CHUNKED] Error playing chunk ${i + 1}:`, error);
      onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
}

/**
 * Альтернативный вариант: использование MediaSource API для streaming WAV
 * (более совместимый, но требует конвертации PCM в WAV на сервере)
 */
export async function playStreamingTTSMediaSource(options: StreamingTTSOptions): Promise<void> {
  const { text, voiceName, modelName, onProgress, onComplete, onError } = options;
  
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' 
    ? 'http://localhost:4000/api' 
    : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  
  const url = `${apiBase}/tts-stream`;
  
  try {
    // Проверяем поддержку MediaSource
    if (!('MediaSource' in window)) {
      throw new Error('MediaSource API is not supported in this browser');
    }
    
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(mediaSource);
    
    await new Promise<void>((resolve, reject) => {
      mediaSource.addEventListener('sourceopen', () => {
        resolve();
      }, { once: true });
      
      audio.onerror = () => reject(new Error('Audio playback failed'));
    });
    
    // Создаем SourceBuffer для WAV (но сервер должен отправлять WAV, а не PCM)
    // Для PCM нужен другой подход - используем первый вариант с Web Audio API
    throw new Error('MediaSource requires WAV format, use playStreamingTTS instead');
    
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

