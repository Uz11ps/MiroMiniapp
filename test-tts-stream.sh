#!/bin/bash
# Пример запроса к streaming TTS endpoint

# Базовый URL (измените если нужно)
BASE_URL="http://localhost:4000"

# Отправка POST запроса
curl -X POST "${BASE_URL}/api/tts-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Привет! Это тест streaming TTS через Gemini.",
    "voiceName": "Aoede",
    "modelName": "gemini-2.5-flash-preview-tts"
  }' \
  --output test-audio.pcm

echo ""
echo "✅ Аудио сохранено в test-audio.pcm"

# Проверяем размер файла
if [ -f test-audio.pcm ]; then
  FILE_SIZE=$(stat -c%s test-audio.pcm 2>/dev/null || stat -f%z test-audio.pcm 2>/dev/null || echo "unknown")
  echo "📊 Размер файла: ${FILE_SIZE} bytes"
  
  # Конвертируем в WAV автоматически
  if command -v ffmpeg &> /dev/null; then
    echo "🔄 Конвертация PCM в WAV..."
    ffmpeg -f s16le -ar 24000 -ac 1 -i test-audio.pcm test-audio.wav -y 2>/dev/null
    
    if [ -f test-audio.wav ]; then
      WAV_SIZE=$(stat -c%s test-audio.wav 2>/dev/null || stat -f%z test-audio.wav 2>/dev/null || echo "unknown")
      echo "✅ WAV файл создан: test-audio.wav (${WAV_SIZE} bytes)"
      echo ""
      echo "📥 Скачайте test-audio.wav и прослушайте на локальной машине"
      echo "   Или используйте: scp user@server:/opt/miniapp/test-audio.wav ."
    else
      echo "⚠️ Не удалось создать WAV файл"
    fi
  else
    echo "⚠️ ffmpeg не установлен, конвертация пропущена"
    echo "   Установите: apt-get install ffmpeg"
    echo ""
    echo "Для конвертации вручную:"
    echo "  ffmpeg -f s16le -ar 24000 -ac 1 -i test-audio.pcm test-audio.wav"
  fi
else
  echo "❌ Файл test-audio.pcm не создан!"
fi

echo ""
echo "💡 Для воспроизведения на сервере (если есть аудио):"
echo "   aplay test-audio.wav  # или"
echo "   paplay test-audio.wav"

