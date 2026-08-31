import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [result, setResult] = useState('Ready');
  return <main aria-label="Verification app">
    <h1>Intent complete</h1>
    <p id="result">{result}</p>
    <button type="button" onClick={() => setResult('Verified')}>Reveal result</button>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
