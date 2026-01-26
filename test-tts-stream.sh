#!/bin/bash
# Пример запроса к streaming TTS endpoint

# Базовый URL (измените если нужно)
BASE_URL="${API_BASE_URL:-http://localhost:4000}"

echo "🧪 Тест streaming TTS"
echo "URL: ${BASE_URL}/api/tts-stream"
echo ""

# Отправка POST запроса
curl -X POST "${BASE_URL}/api/tts-stream" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Привет! Это тест streaming TTS через Gemini.",
    "voiceName": "Aoede",
    "modelName": "gemini-2.5-flash-preview-tts"
  }' \
  --output test-audio.pcm \
  --write-out "\nHTTP: %{http_code} | Size: %{size_download} bytes | Time: %{time_total}s\n"

echo ""
if [ -f test-audio.pcm ]; then
  FILE_SIZE=$(stat -c%s test-audio.pcm 2>/dev/null || stat -f%z test-audio.pcm 2>/dev/null || echo "0")
  FILE_TYPE=$(file test-audio.pcm 2>/dev/null || echo "unknown")
  
  echo "✅ Аудио сохранено в test-audio.pcm"
  echo "📊 Размер: ${FILE_SIZE} bytes"
  echo "📄 Тип: ${FILE_TYPE}"
  
  # Проверяем на ошибки
  if [ "$FILE_SIZE" -lt 100 ] || echo "$FILE_TYPE" | grep -q "JSON\|text"; then
    echo ""
    echo "⚠️ Возможна ошибка! Содержимое:"
    head -c 500 test-audio.pcm
    echo ""
    exit 1
  fi
else
  echo "❌ Файл не создан!"
  exit 1
fi

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

