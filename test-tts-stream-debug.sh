#!/bin/bash
# Тестовый скрипт для проверки streaming TTS с детальной диагностикой

BASE_URL="${API_BASE_URL:-http://localhost:4000}"
TEXT="${1:-Привет! Это тест streaming TTS через Gemini.}"
VOICE="${2:-Kore}"
MODEL="${3:-gemini-2.5-flash-preview-tts}"

echo "🧪 Тест streaming TTS endpoint"
echo "================================"
echo "URL: ${BASE_URL}/api/tts-stream"
echo "Текст: ${TEXT}"
echo "Голос: ${VOICE}"
echo "Модель: ${MODEL}"
echo ""

# Проверяем доступность endpoint (БЕЗ прокси для localhost)
echo "1️⃣ Проверка доступности endpoint..."

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/tts-stream" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"test\"}" 2>/dev/null)

if [ "$HTTP_CODE" = "404" ]; then
  echo "❌ Endpoint не найден (404). Убедитесь что сервер пересобран и перезапущен."
  exit 1
elif [ "$HTTP_CODE" = "000" ]; then
  echo "❌ Сервер недоступен. Проверьте что сервер запущен на ${BASE_URL}"
  exit 1
else
  echo "✅ Endpoint доступен (HTTP $HTTP_CODE)"
fi

echo ""
echo "2️⃣ Отправка запроса с детальным выводом..."
echo ""

# Отправляем запрос с детальным выводом (БЕЗ прокси для localhost)
curl -v -X POST "${BASE_URL}/api/tts-stream" \
  -H "Content-Type: application/json" \
  -d "{
    \"text\": \"${TEXT}\",
    \"voiceName\": \"${VOICE}\",
    \"modelName\": \"${MODEL}\"
  }" \
  --output test-audio.pcm 2>&1 | tee curl-output.log

echo ""
echo "3️⃣ Анализ результата..."
echo ""

if [ -f test-audio.pcm ]; then
  FILE_SIZE=$(stat -c%s test-audio.pcm 2>/dev/null || stat -f%z test-audio.pcm 2>/dev/null || echo "0")
  echo "📊 Размер файла: ${FILE_SIZE} bytes"
  
  # Проверяем тип файла
  FILE_TYPE=$(file test-audio.pcm 2>/dev/null || echo "unknown")
  echo "📄 Тип файла: ${FILE_TYPE}"
  
  # Проверяем JSON ошибки (независимо от размера)
  if echo "$FILE_TYPE" | grep -q "JSON\|text" || grep -q "error" test-audio.pcm 2>/dev/null; then
    echo "❌ Обнаружена ошибка в ответе (JSON/text вместо аудио):"
    echo ""
    cat test-audio.pcm | python3 -m json.tool 2>/dev/null || cat test-audio.pcm
    echo ""
    echo "💡 Возможные причины:"
    echo "   - Прокси не настроен для SDK (проверьте GEMINI_PROXY в .env)"
    echo "   - Регион не поддерживает streaming TTS"
    echo "   - Ошибка в коде endpoint"
    echo ""
    echo "📋 Проверьте логи сервера:"
    echo "   docker logs miniapp-server-1 --tail 50 | grep GEMINI-TTS-STREAM"
    exit 1
  fi
  
  if [ "$FILE_SIZE" -lt 1000 ]; then
    echo "⚠️ Файл очень маленький (${FILE_SIZE} bytes) - возможно неполные данные"
    echo ""
  else
    echo "✅ Файл выглядит как аудио данные"
    
    # Конвертируем в WAV
    if command -v ffmpeg &> /dev/null; then
      echo ""
      echo "4️⃣ Конвертация PCM в WAV..."
      ffmpeg -f s16le -ar 24000 -ac 1 -i test-audio.pcm test-audio.wav -y 2>&1 | grep -v "frame=" | grep -v "size=" || true
      
      if [ -f test-audio.wav ]; then
        WAV_SIZE=$(stat -c%s test-audio.wav 2>/dev/null || stat -f%z test-audio.wav 2>/dev/null || echo "unknown")
        echo "✅ WAV файл создан: test-audio.wav (${WAV_SIZE} bytes)"
        echo ""
        echo "📥 Для скачивания:"
        echo "   scp user@server:$(pwd)/test-audio.wav ."
      fi
    fi
  fi
else
  echo "❌ Файл не создан!"
  echo ""
  echo "Логи curl:"
  cat curl-output.log 2>/dev/null || true
  exit 1
fi

echo ""
echo "5️⃣ Проверка логов сервера..."
echo ""

# Пытаемся получить логи если docker доступен
if command -v docker &> /dev/null; then
  echo "Последние логи сервера (GEMINI-TTS-STREAM, последние 50 строк):"
  docker logs miniapp-server-1 --tail 50 2>/dev/null | grep -A 5 -B 5 "GEMINI-TTS-STREAM" || docker logs miniapp-server-1 --tail 50 2>/dev/null
  echo ""
else
  echo "⚠️ Docker не доступен, проверьте логи вручную"
fi

echo ""
echo "✅ Тест завершен"

