import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyReduceFx, ConfirmProvider, ToastProvider } from './components/ui';
import { AuthProvider } from './lib/auth';
import { applyTheme, getSavedTheme } from './lib/theme';
import './styles.css';
import './theme.css';

applyReduceFx();
applyTheme(getSavedTheme());
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
