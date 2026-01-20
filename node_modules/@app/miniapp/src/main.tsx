import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import WebApp from '@twa-dev/sdk';

import { App } from './modules/app/App';
import './styles.css';

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



