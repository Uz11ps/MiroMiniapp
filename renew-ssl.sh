#!/bin/bash
# Скрипт для обновления SSL сертификата Let's Encrypt

set -e

echo "🔄 Обновление SSL сертификата для miraplay.ru..."

# Проверяем наличие certbot
if ! command -v certbot &> /dev/null; then
    echo "❌ certbot не установлен. Установите его:"
    echo "   sudo apt-get update && sudo apt-get install certbot"
    exit 1
fi

# Обновляем сертификат
echo "📝 Запуск обновления сертификата..."
sudo certbot renew --force-renewal

# Проверяем результат
if [ $? -eq 0 ]; then
    echo "✅ Сертификат успешно обновлен!"
    
    # Перезагружаем nginx (если используется)
    if systemctl is-active --quiet nginx; then
        echo "🔄 Перезагрузка nginx..."
        sudo systemctl reload nginx
        echo "✅ Nginx перезагружен"
    fi
    
    # Или apache (если используется)
    if systemctl is-active --quiet apache2; then
        echo "🔄 Перезагрузка apache2..."
        sudo systemctl reload apache2
        echo "✅ Apache перезагружен"
    fi
    
    echo ""
    echo "✅ SSL сертификат обновлен и веб-сервер перезагружен!"
else
    echo "❌ Ошибка при обновлении сертификата"
    exit 1
fi

