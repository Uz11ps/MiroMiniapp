#!/bin/bash
# Скрипт для очистки сервера от npm и node, оставляя только Docker

echo "🧹 Начинаем очистку сервера от npm/node..."

# 1. Удаляем все глобальные npm пакеты
echo "📦 Удаляем глобальные npm пакеты..."
if command -v npm &> /dev/null; then
    npm list -g --depth=0 2>/dev/null | grep -v "npm@" | awk '{print $2}' | cut -d@ -f1 | xargs -r npm uninstall -g 2>/dev/null || true
    echo "✅ Глобальные npm пакеты удалены"
else
    echo "⚠️ npm не найден"
fi

# 2. Удаляем npm и nodejs
echo "🗑️ Удаляем npm и nodejs..."
sudo apt remove --purge -y npm nodejs nodejs-doc 2>/dev/null || true
sudo apt autoremove --purge -y 2>/dev/null || true

# 3. Удаляем yarn, pnpm если установлены
echo "🗑️ Удаляем yarn, pnpm..."
sudo apt remove --purge -y yarn pnpm 2>/dev/null || true

# 4. Удаляем кэш npm
echo "🗑️ Очищаем кэш npm..."
rm -rf ~/.npm 2>/dev/null || true
rm -rf ~/.node-gyp 2>/dev/null || true
rm -rf ~/.npmrc 2>/dev/null || true

# 5. Удаляем node_modules из домашней директории (если есть)
echo "🗑️ Удаляем node_modules из домашней директории..."
find ~ -name "node_modules" -type d -prune -exec rm -rf {} + 2>/dev/null || true

# 6. Проверяем что Docker работает
echo "🐳 Проверяем Docker..."
if command -v docker &> /dev/null; then
    echo "✅ Docker установлен: $(docker --version)"
    if command -v docker-compose &> /dev/null || docker compose version &> /dev/null; then
        echo "✅ Docker Compose установлен"
    else
        echo "⚠️ Docker Compose не найден, но это нормально для новых версий Docker"
    fi
else
    echo "❌ Docker не найден! Установите Docker для работы проекта."
fi

# 7. Очищаем apt кэш
echo "🧹 Очищаем apt кэш..."
sudo apt autoclean 2>/dev/null || true

echo ""
echo "✅ Очистка завершена!"
echo ""
echo "📋 Что осталось на сервере:"
echo "   - Docker: $(docker --version 2>/dev/null || echo 'не установлен')"
echo "   - Docker Compose: $(docker compose version 2>/dev/null || docker-compose --version 2>/dev/null || echo 'не установлен')"
echo ""
echo "💡 Все npm/node пакеты теперь только в Docker контейнерах!"

