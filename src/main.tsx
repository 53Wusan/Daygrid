import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const style = document.createElement("style");
style.innerHTML = `
  html, body { width: 100%; height: 100%; margin: 0; padding: 0; overflow-x: hidden; }
  *, *::before, *::after { box-sizing: border-box; }
`;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
