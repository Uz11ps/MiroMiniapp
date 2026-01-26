// Пример использования streaming TTS из Node.js

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

async function testStreamingTTS() {
  try {
    const response = await fetch(`${BASE_URL}/api/tts-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'Привет! Это тест streaming TTS через Gemini.',
        voiceName: 'Aoede', // опционально
        modelName: 'gemini-2.5-flash-preview-tts' // опционально
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Ошибка:', error);
      return;
    }

    console.log('🎤 Начало получения streaming аудио...');
    console.log('Sample Rate:', response.headers.get('X-Audio-Sample-Rate'));
    console.log('Channels:', response.headers.get('X-Audio-Channels'));
    console.log('Bits Per Sample:', response.headers.get('X-Audio-Bits-Per-Sample'));

    // Получаем поток данных
    const reader = response.body.getReader();
    const chunks = [];
    let totalSize = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      totalSize += value.length;
      console.log(`📦 Получен чанк: ${value.length} bytes, всего: ${totalSize} bytes`);
    }

    // Объединяем все чанки
    const audioBuffer = Buffer.concat(chunks);
    console.log(`✅ Получено всего: ${audioBuffer.length} bytes`);

    // Сохраняем в файл
    const fs = require('fs');
    fs.writeFileSync('test-audio.pcm', audioBuffer);
    console.log('💾 Аудио сохранено в test-audio.pcm');

    // Можно также воспроизвести через sounddevice или другой аудио-плеер
    // Или конвертировать в WAV для удобства

  } catch (error) {
    console.error('❌ Ошибка:', error);
  }
}

testStreamingTTS();

