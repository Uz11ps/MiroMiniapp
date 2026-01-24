import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import WebApp from '@twa-dev/sdk';

import { App } from './modules/app/App';
// Импортируем CSS для гарантированной загрузки в Vite/WebView
import './styles.css';

// Инициализация Telegram WebApp (в мини-приложении это есть в окне TG)
try {
  WebApp.ready();
  WebApp.expand();
} catch {}

// КРИТИЧЕСКИ ВАЖНО: Принудительная загрузка CSS для Telegram WebView при КАЖДОМ открытии
// Telegram WebView имеет проблемы с загрузкой CSS при первом открытии из-за кеширования
if (typeof document !== 'undefined') {
  // Загружаем CSS ПЕРЕД рендером React, чтобы избежать FOUC
  const forceLoadCSS = () => {
    // Ищем все существующие CSS ссылки
    const existingLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
    const viteCSSLinks = existingLinks.filter(link => {
      const href = link.getAttribute('href') || '';
      return href.includes('styles.css') || href.includes('assets/') || href.includes('index');
    });
    
    // Если CSS от Vite не найден - загружаем принудительно
    if (viteCSSLinks.length === 0) {
      console.warn('[CSS] ⚠️ CSS от Vite не найден, загружаем принудительно...');
      
      // Пробуем разные пути (dev и production)
      // В dev режиме Vite обрабатывает /src/styles.css, в production - /assets/styles.[hash].css
      const paths = [
        '/src/styles.css',
        '/assets/styles.css',
        './src/styles.css',
        './assets/styles.css'
      ];
      
      // Загружаем все пути параллельно (первый успешный загрузится)
      paths.forEach((path, index) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = path + '?v=' + Date.now() + '&t=' + performance.now();
        link.setAttribute('data-attempt', String(index));
        
        link.onerror = () => {
          console.warn(`[CSS] ❌ Не удалось загрузить ${path}`);
        };
        
        link.onload = () => {
          console.log(`[CSS] ✅ CSS успешно загружен из ${path}`);
        };
        
        // Добавляем в head СРАЗУ, не ждем
        document.head.appendChild(link);
      });
    } else {
      console.log(`[CSS] ✅ Найдено ${viteCSSLinks.length} CSS файлов от Vite`);
    }
  };
  
  // Загружаем СРАЗУ, не ждем событий
  if (document.head) {
    forceLoadCSS();
  } else {
    // Если head еще не готов, ждем
    const observer = new MutationObserver((mutations, obs) => {
      if (document.head) {
        forceLoadCSS();
        obs.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }
  
  // Также проверяем после загрузки DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', forceLoadCSS);
  } else {
    forceLoadCSS();
  }
  
  // И после полной загрузки страницы
  window.addEventListener('load', forceLoadCSS);
  
  // Периодическая проверка (на случай, если загрузка затянулась)
  let checkCount = 0;
  const maxChecks = 30; // 3 секунды максимум
  const checkInterval = setInterval(() => {
    checkCount++;
    
    // Проверяем наличие стилей через вычисленные стили
    const testEl = document.createElement('div');
    testEl.className = 'screen';
    testEl.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    if (document.body) {
      document.body.appendChild(testEl);
      const styles = window.getComputedStyle(testEl);
      const hasStyles = styles.height && styles.height !== 'auto' && styles.height !== '0px';
      document.body.removeChild(testEl);
      
      if (hasStyles) {
        clearInterval(checkInterval);
        console.log('[CSS] ✅ CSS стили применены успешно');
      } else if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        console.error('[CSS] ⚠️ CSS не загрузился после проверок, повторная попытка...');
        forceLoadCSS();
      }
    }
  }, 100);
}

const router = createBrowserRouter([
  {
    path: '/*',
    element: <App />,
  },
]);

const root = createRoot(document.getElementById('root')!);
root.render(<RouterProvider router={router} />);



