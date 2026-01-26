#!/bin/bash
# Конвертация PCM в WAV

INPUT_FILE="${1:-test-audio.pcm}"
OUTPUT_FILE="${2:-test-audio.wav}"

if [ ! -f "$INPUT_FILE" ]; then
  echo "❌ Файл $INPUT_FILE не найден!"
  exit 1
fi

echo "🔄 Конвертация $INPUT_FILE в $OUTPUT_FILE..."

# Конвертируем PCM (s16le, 24kHz, mono) в WAV
ffmpeg -f s16le -ar 24000 -ac 1 -i "$INPUT_FILE" "$OUTPUT_FILE" -y

if [ -f "$OUTPUT_FILE" ]; then
  FILE_SIZE=$(stat -c%s "$OUTPUT_FILE" 2>/dev/null || stat -f%z "$OUTPUT_FILE" 2>/dev/null || echo "unknown")
  echo "✅ WAV файл создан: $OUTPUT_FILE (${FILE_SIZE} bytes)"
  echo ""
  echo "📥 Скачайте файл:"
  echo "   scp user@server:$(pwd)/$OUTPUT_FILE ."
else
  echo "❌ Ошибка конвертации"
  exit 1
fi

