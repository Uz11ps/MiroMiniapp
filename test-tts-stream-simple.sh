#!/bin/bash
# Простой тест streaming TTS

BASE_URL="${API_BASE_URL:-http://localhost:4000}"

echo "🧪 Простой тест streaming TTS"
echo ""

curl -X POST "${BASE_URL}/api/tts-stream" \
  -H "Content-Type: application/json" \
  -d '{"text":"Тест","voiceName":"Aoede"}' \
  --output test.pcm \
  --write-out "\nHTTP Code: %{http_code}\nSize: %{size_download} bytes\nTime: %{time_total}s\n"

if [ -f test.pcm ]; then
  SIZE=$(stat -c%s test.pcm 2>/dev/null || stat -f%z test.pcm 2>/dev/null || echo "0")
  TYPE=$(file test.pcm 2>/dev/null || echo "unknown")
  
  echo ""
  echo "Файл: test.pcm"
  echo "Размер: ${SIZE} bytes"
  echo "Тип: ${TYPE}"
  
  if [ "$SIZE" -lt 100 ]; then
    echo ""
    echo "⚠️ Маленький файл - возможно ошибка:"
    cat test.pcm
  fi
fi

