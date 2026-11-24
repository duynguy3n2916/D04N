import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyReduceFx, ConfirmProvider, ToastProvider } from './components/ui';
import { AuthProvider } from './lib/auth';
import { applyTheme, DEFAULT_THEME } from './lib/theme';
import './styles.css';
import './theme.css';
import './polish.css';

applyReduceFx();
applyTheme(DEFAULT_THEME); // màu chủ đạo cố định: đỏ đô
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
