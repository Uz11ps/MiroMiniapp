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
    
    // Функция проигрывания сырого PCM куска (Шаг 1)
    const playPCM = (value: Uint8Array) => {
      if (signal.aborted) return;

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

      if (combined.length === 0) return;

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
      if (nextStartTime < now) {
        nextStartTime = now + 0.05; 
      }

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
        voiceName: voiceName || 'Aoede',
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
      
      if (!value || value.length === 0) continue;

      // Проверка на JSON
      if (value[0] === 123) {
        const textErr = new TextDecoder().decode(value);
        if (textErr.startsWith('{"error"')) {
          console.error('[STREAMING-TTS] Server error:', textErr);
          throw new Error(textErr);
        }
      }

      // Передаем весь объект Uint8Array (Шаг 2)
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
 * Проигрывает текст с учетом сегментации (разные голоса для диалогов).
 */
export async function playStreamingTTSSegmented(options: StreamingTTSOptions & { gameId?: string }): Promise<void> {
  const { text, gameId, ...rest } = options;
  
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' 
    ? 'http://localhost:4000/api' 
    : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;

  // Перед анализом останавливаем старую озвучку
  stopStreamingTTS();
  const abortController = currentAbortController;

  try {
    // 1. Анализируем текст на сегменты
    const analyzeRes = await fetch(`${apiBase}/tts/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, gameId })
    });
    
    if (!analyzeRes.ok) throw new Error('Analysis failed');
    const { segments } = await analyzeRes.json();
    
    if (!segments || segments.length === 0) {
      // Фолбек на обычный режим если анализ не удался
      return playStreamingTTSChunked(options);
    }

    // 2. Проигрываем каждый сегмент
    for (const segment of segments) {
      if (abortController?.signal.aborted) break;
      if (!segment.text?.trim()) continue;

      // Выбор голоса для сегмента
      let voiceName = 'Aoede';
      if (segment.isNarrator) {
        voiceName = 'Aoede';
      } else if (segment.gender?.toLowerCase().includes('жен') || segment.gender?.toLowerCase().includes('female')) {
        voiceName = 'Kore';
      } else {
        // Рандомизируем мужские голоса на основе имени персонажа (чтобы у одного персонажа был один голос)
        const maleVoices = ['Charon', 'Puck', 'Fenrir'];
        const nameHash = (segment.characterName || 'default').split('').reduce((a: number, b: string) => { 
          const hash = ((a << 5) - a) + b.charCodeAt(0); 
          return hash & hash; 
        }, 0);
        voiceName = maleVoices[Math.abs(nameHash) % maleVoices.length] || 'Charon';
      }

      await new Promise<void>((resolve, reject) => {
        playStreamingTTS({
          ...rest,
          text: segment.text,
          voiceName: voiceName,
          onComplete: () => resolve(),
          onError: (err) => reject(err)
        });
      });
    }
  } catch (error) {
    console.error('[STREAMING-TTS] Segmented playback error:', error);
    // Фолбек на обычный режим
    return playStreamingTTSChunked(options);
  }
}
