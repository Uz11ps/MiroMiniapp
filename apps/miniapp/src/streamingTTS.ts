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
    // Инициализируем Web Audio API
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const sampleRate = 24000; // Как указано в заголовках сервера
    const channels = 1; // Моно
    
    // Создаем gain node для управления громкостью
    const gainNode = audioContext.createGain();
    gainNode.connect(audioContext.destination);
    
    // Буфер для накопления аудио данных
    let bytesReceived = 0;
    let isPlaying = false;
    let startTime = 0;
    
    // Используем ScriptProcessorNode для streaming воспроизведения
    // (более старый API, но работает везде)
    // Или используем AudioWorklet (современный, но требует отдельного файла)
    // Для простоты используем ScriptProcessorNode
    
    let scriptProcessor: ScriptProcessorNode | null = null;
    let audioQueue: Float32Array[] = [];
    let queueOffset = 0;
    let currentQueueBuffer: Float32Array | null = null;
    
    // Функция для добавления PCM данных в очередь
    const addAudioChunk = (pcmData: ArrayBuffer) => {
      bytesReceived += pcmData.byteLength;
      onProgress?.(bytesReceived);
      
      // Конвертируем Int16 PCM в Float32 для Web Audio API
      const int16Array = new Int16Array(pcmData);
      const float32Array = new Float32Array(int16Array.length);
      
      // Нормализуем Int16 (-32768..32767) в Float32 (-1.0..1.0)
      for (let i = 0; i < int16Array.length; i++) {
        const sample = int16Array[i];
        if (sample !== undefined) {
          float32Array[i] = sample / 32768.0;
        }
      }
      
      audioQueue.push(float32Array);
      
      // Если еще не начали проигрывать, начинаем после накопления небольшого буфера
      const minSamplesToStart = sampleRate * 0.2; // 0.2 секунды буфера
      if (!isPlaying) {
        const totalSamples = audioQueue.reduce((sum, buf) => sum + buf.length, 0);
        if (totalSamples >= minSamplesToStart) {
          startPlayback();
        }
      }
    };
    
    // Функция для начала воспроизведения
    const startPlayback = () => {
      if (isPlaying) return;
      isPlaying = true;
      
      // Создаем ScriptProcessorNode для streaming
      const bufferSize = 4096; // Размер буфера обработки
      scriptProcessor = audioContext.createScriptProcessor(bufferSize, 0, channels);
      
      scriptProcessor.onaudioprocess = (e) => {
        const output = e.outputBuffer.getChannelData(0);
        let outputOffset = 0;
        
        while (outputOffset < output.length) {
          // Если текущий буфер закончился, берем следующий из очереди
          if (!currentQueueBuffer || queueOffset >= currentQueueBuffer.length) {
            if (audioQueue.length === 0) {
              // Нет данных - заполняем тишиной
              for (let i = outputOffset; i < output.length; i++) {
                output[i] = 0;
              }
              break;
            }
            currentQueueBuffer = audioQueue.shift()!;
            queueOffset = 0;
          }
          
          // Копируем данные из текущего буфера в выходной
          const remainingInBuffer = currentQueueBuffer.length - queueOffset;
          const remainingInOutput = output.length - outputOffset;
          const copyLength = Math.min(remainingInBuffer, remainingInOutput);
          
          output.set(
            currentQueueBuffer.subarray(queueOffset, queueOffset + copyLength),
            outputOffset
          );
          
          outputOffset += copyLength;
          queueOffset += copyLength;
        }
      };
      
      scriptProcessor.connect(gainNode);
      startTime = audioContext.currentTime;
      
      console.log('[STREAMING-TTS] Started streaming playback');
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
        if (!isPlaying) {
          const totalSamples = audioQueue.reduce((sum, buf) => sum + buf.length, 0);
          if (totalSamples > 0) {
            startPlayback();
          }
        }
        
        // Ждем окончания воспроизведения всех данных из очереди
        if (isPlaying && scriptProcessor !== null) {
          // Ждем пока очередь не опустеет и ScriptProcessor не обработает все данные
          while (audioQueue.length > 0 || currentQueueBuffer !== null) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          // Дополнительная задержка для завершения обработки последнего буфера
          await new Promise(resolve => setTimeout(resolve, 500));
          
          if (scriptProcessor !== null) {
            scriptProcessor.disconnect();
            scriptProcessor = null;
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
      // Обрабатываем чанки по 4096 байт (2048 samples) для плавного воспроизведения
      const chunkSize = 4096;
      while (buffer.length >= chunkSize) {
        const chunk = buffer.slice(0, chunkSize);
        buffer = buffer.slice(chunkSize);
        addAudioChunk(chunk.buffer);
      }
    }
    
    // Очистка
    if (scriptProcessor !== null) {
      scriptProcessor.disconnect();
      scriptProcessor = null;
    }
    gainNode.disconnect();
    audioContext.close();
    
  } catch (error) {
    console.error('[STREAMING-TTS] Error:', error);
    onError?.(error instanceof Error ? error : new Error(String(error)));
    throw error;
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

