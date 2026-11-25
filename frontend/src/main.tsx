import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyReduceFx, ConfirmProvider, ToastProvider } from './components/ui';
import { AuthProvider } from './lib/auth';
import { applyTheme, savedTheme } from './lib/theme';
import './styles/base.css';
import './styles/theme.css';
import './styles/polish.css';

applyReduceFx();
applyTheme(savedTheme()); // màu chủ đạo: xanh mầm mặc định, đổi được trong Cài đặt
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
