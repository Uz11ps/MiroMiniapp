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

// Принудительная проверка загрузки CSS для Telegram WebView
// Если CSS не загрузился, пытаемся перезагрузить его
if (typeof document !== 'undefined') {
  const checkCSS = () => {
    // Проверяем, загрузился ли CSS (проверяем наличие стилей для body)
    const testEl = document.createElement('div');
    testEl.className = 'screen';
    document.body.appendChild(testEl);
    const styles = window.getComputedStyle(testEl);
    const hasStyles = styles.height !== 'auto' && styles.height !== '0px';
    document.body.removeChild(testEl);
    
    if (!hasStyles) {
      // CSS не загрузился - пытаемся перезагрузить
      console.warn('[CSS] CSS не загрузился, пытаемся перезагрузить...');
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/src/styles.css?' + Date.now(); // Добавляем timestamp для cache-busting
      document.head.appendChild(link);
    }
  };
  
  // Проверяем после небольшой задержки, чтобы дать время загрузиться
  setTimeout(checkCSS, 100);
  // Также проверяем после полной загрузки
  if (document.readyState === 'complete') {
    checkCSS();
  } else {
    window.addEventListener('load', checkCSS);
  }
}

const router = createBrowserRouter([
  {
    path: '/*',
    element: <App />,
  },
]);

const root = createRoot(document.getElementById('root')!);
root.render(<RouterProvider router={router} />);



