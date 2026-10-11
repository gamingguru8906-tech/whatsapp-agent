import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { startSmoothScroll, startReveal } from './motion.js';

createRoot(document.getElementById('root')).render(<App />);
requestAnimationFrame(() => { startSmoothScroll(); startReveal(document.getElementById('root')); });
