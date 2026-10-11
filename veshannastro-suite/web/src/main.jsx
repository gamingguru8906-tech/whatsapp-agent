import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { startReveal } from './motion.js';

createRoot(document.getElementById('root')).render(<App />);
requestAnimationFrame(() => startReveal(document.getElementById("root")));
