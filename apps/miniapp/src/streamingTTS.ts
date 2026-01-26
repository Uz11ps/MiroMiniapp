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
    if (globalAudioContext) {
      console.log('[STREAMING-TTS] AudioContext initialized, state:', globalAudioContext.state);
    }
  }
  
  const ctx = globalAudioContext;
  if (!ctx) {
    throw new Error('Failed to initialize AudioContext');
  }

  if (ctx.state === 'suspended') {
    ctx.resume().catch(e => console.error('[STREAMING-TTS] Resume failed:', e));
  }
  return ctx;
}

// Авто-инициализация при любом взаимодействии
if (typeof window !== 'undefined') {
  const unlock = () => {
    initAudioContext();
    window.removeEventListener('click', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('click', unlock);
  window.addEventListener('touchstart', unlock);
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
    const channels = 1;
    
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(audioContext.destination);
    
    let nextStartTime = 0;
    let bytesReceived = 0;
    let chunkCount = 0;
    const jitterBuffer: ArrayBuffer[] = [];
    const jitterBufferSize = sampleRate * 0.3; // 300ms
    let jitterBufferSamples = 0;
    let isPlaying = false;
    
    const playPCMChunk = (pcmData: ArrayBuffer) => {
      chunkCount++;
      bytesReceived += pcmData.byteLength;
      onProgress?.(bytesReceived);
      
      const int16Array = new Int16Array(pcmData);
      const float32Array = new Float32Array(int16Array.length);
      
      for (let i = 0; i < int16Array.length; i++) {
        const sample = int16Array[i];
        float32Array[i] = sample !== undefined ? sample / 32768.0 : 0;
      }
      
      const audioBuffer = audioContext.createBuffer(channels, float32Array.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Array);
      
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNode);
      
      const now = audioContext.currentTime;
      if (nextStartTime < now) {
        nextStartTime = now + 0.1;
      }
      
      source.start(nextStartTime);
      nextStartTime += audioBuffer.duration;
    };
    
    const addAudioChunk = (pcmData: ArrayBuffer) => {
      const samples = pcmData.byteLength / 2;
      if (!isPlaying) {
        jitterBuffer.push(pcmData);
        jitterBufferSamples += samples;
        if (jitterBufferSamples >= jitterBufferSize) {
          isPlaying = true;
          while (jitterBuffer.length > 0) {
            const chunk = jitterBuffer.shift();
            if (chunk) playPCMChunk(chunk);
          }
        }
      } else {
        playPCMChunk(pcmData);
      }
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
    
    let buffer = new Uint8Array(0);
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        if (buffer.length > 0) addAudioChunk(buffer.buffer);
        if (!isPlaying && jitterBuffer.length > 0) {
          while (jitterBuffer.length > 0) {
            const chunk = jitterBuffer.shift();
            if (chunk) playPCMChunk(chunk);
          }
        }
        const waitTime = (nextStartTime - audioContext.currentTime) * 1000 + 300;
        if (waitTime > 0) await new Promise(resolve => setTimeout(resolve, waitTime));
        onComplete?.();
        break;
      }
      
      const newBuf = new Uint8Array(buffer.length + value.length);
      newBuf.set(buffer);
      newBuf.set(value, buffer.length);
      buffer = newBuf;
      
      const chunkSize = 4096;
      while (buffer.length >= chunkSize) {
        const chunk = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        addAudioChunk(chunk.buffer);
      }
    }
    
  } catch (error) {
    console.error('[STREAMING-TTS] Fatal:', error);
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Разбивает текст на части по количеству слов и проигрывает их последовательно.
 * Это позволяет обходить лимиты на длину текста и начинать воспроизведение быстрее.
 */
export async function playStreamingTTSChunked(options: StreamingTTSOptions & { wordsPerChunk?: number }): Promise<void> {
  const { text, wordsPerChunk = 50, ...rest } = options;
  
  // Разбиваем текст на слова
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
  }
  
  console.log(`[STREAMING-TTS] Split text into ${chunks.length} chunks (${words.length} words total)`);
  
  // Проигрываем чанки последовательно
  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i];
    if (!chunkText) continue;
    
    console.log(`[STREAMING-TTS] Playing text chunk ${i + 1}/${chunks.length} (${chunkText.length} chars)`);
    
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
