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
echo "Для воспроизведения PCM (Linux/Mac):"
echo "  ffplay -f s16le -ar 24000 -ac 1 test-audio.pcm"
echo ""
echo "Или конвертируйте в WAV:"
echo "  ffmpeg -f s16le -ar 24000 -ac 1 -i test-audio.pcm test-audio.wav"

