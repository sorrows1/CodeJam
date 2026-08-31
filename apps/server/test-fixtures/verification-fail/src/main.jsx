import './style.css';
const root = document.getElementById('root');
root.innerHTML = '<main aria-label="Verification app"><h1>Intent complete</h1><p id="result">Ready</p><button type="button">Reveal result</button></main>';
root.querySelector('button').addEventListener('click', () => { root.querySelector('#result').textContent = 'Not verified'; });
