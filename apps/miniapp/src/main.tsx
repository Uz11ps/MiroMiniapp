import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import WebApp from '@twa-dev/sdk';

import { App } from './modules/app/App';
// CSS загружается через <link> в index.html для загрузки ДО рендера страницы

// Инициализация Telegram WebApp (в мини-приложении это есть в окне TG)
try {
  WebApp.ready();
  WebApp.expand();
} catch {}

const router = createBrowserRouter([
  {
    path: '/*',
    element: <App />,
  },
]);

const root = createRoot(document.getElementById('root')!);
root.render(<RouterProvider router={router} />);



