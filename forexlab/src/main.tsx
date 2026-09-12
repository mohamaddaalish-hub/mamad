import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/shell/App.tsx';
import './ui/styles.css';
import { ErrorBoundary } from './ui/shell/ErrorBoundary.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
