// Глобальный экземпляр AudioContext (синглтон)
let globalAudioContext: AudioContext | null = null;

// Типы для TTS
export interface StreamingTTSOptions {
  text: string;
  voiceName?: string;
  modelName?: string;
  onProgress?: (bytes: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

// Функция для инициализации контекста (вызывать по жесту пользователя)
export function initAudioContext(): AudioContext {
  if (!globalAudioContext) {
    const AudioContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
    globalAudioContext = new AudioContextClass({ sampleRate: 24000 });
    console.log('[STREAMING-TTS] AudioContext created, state:', globalAudioContext.state);
  }
  
  const ctx = globalAudioContext;
  if (!ctx) throw new Error('Failed to create AudioContext');

  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.error('[STREAMING-TTS] Resume failed:', e));
  }
  return ctx;
}

// Разблокировка при первом тапе
if (typeof window !== 'undefined') {
  const unlock = () => {
    initAudioContext();
    window.removeEventListener('click', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('click', unlock, { once: true });
  window.addEventListener('touchstart', unlock, { once: true });
}

export async function playStreamingTTS(options: StreamingTTSOptions): Promise<void> {
  const { text, voiceName, modelName, onProgress, onComplete, onError } = options;
  
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const root = host.split('.').slice(-2).join('.');
  const apiBase = root === 'localhost' 
    ? 'http://localhost:4000/api' 
    : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//api.${root}/api`;
  
  const url = `${apiBase}/tts-stream`;
  
  try {
    const audioContext = initAudioContext();
    const sampleRate = audioContext.sampleRate;
    
    // GainNode для контроля громкости
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(audioContext.destination);
    
    // Планировщик времени
    let nextStartTime = audioContext.currentTime;
    let bytesReceived = 0;
    
    // Функция проигрывания сырого PCM куска
    const playPCM = (pcmBuffer: ArrayBuffer) => {
      if (pcmBuffer.byteLength < 2) return;
      
      // КРИТИЧНО: Убеждаемся, что длина кратна 2 для Int16
      const safeLength = pcmBuffer.byteLength - (pcmBuffer.byteLength % 2);
      const int16Array = new Int16Array(pcmBuffer, 0, safeLength / 2);
      const float32Array = new Float32Array(int16Array.length);
      
      // Конвертация Int16 -> Float32
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }
      
      const audioBuffer = audioContext.createBuffer(1, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);
      
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      
      const now = audioContext.currentTime;
      // Если мы отстали (или это первый чанк), начинаем от "сейчас" + небольшой буфер
      if (nextStartTime < now) {
        nextStartTime = now + 0.05; 
      }
      
      source.start(nextStartTime);
      nextStartTime += audioBuffer.duration;
      
      bytesReceived += pcmBuffer.byteLength;
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
    });
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No reader');
    
    console.log('[STREAMING-TTS] Reading stream...');
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        console.log('[STREAMING-TTS] Stream complete');
        // Ждем завершения последнего звука
        const wait = (nextStartTime - audioContext.currentTime) * 1000 + 100;
        setTimeout(() => onComplete?.(), Math.max(0, wait));
        break;
      }
      
      // Если пришел пустой кусок - пропускаем
      if (!value || value.length === 0) continue;

      // Проверка на JSON (если сервер прислал ошибку текстом вместо бинарных данных)
      if (value[0] === 123) { // 123 это '{'
        const text = new TextDecoder().decode(value);
        if (text.startsWith('{"error"')) {
          console.error('[STREAMING-TTS] Server returned error JSON:', text);
          throw new Error(text);
        }
      }

      // Проигрываем кусок сразу, как только он пришел
      playPCM(value.buffer);
    }
    
  } catch (error) {
    console.error('[STREAMING-TTS] Error:', error);
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Вспомогательная функция для проигрывания длинных текстов частями
 */
export async function playStreamingTTSChunked(options: StreamingTTSOptions & { wordsPerChunk?: number }): Promise<void> {
  const { text, wordsPerChunk = 50, ...rest } = options;
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  
  for (const chunkText of chunks) {
    if (!chunkText) continue;
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
