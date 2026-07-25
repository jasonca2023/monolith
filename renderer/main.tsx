import React from 'react';
import { createRoot } from 'react-dom/client';
import CommandDeck from './components/CommandDeck';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <React.StrictMode>
    <CommandDeck />
  </React.StrictMode>,
);
