const express = require('express');

const app = express();
app.get('/health', (req, res) => res.send('OK'));
app.listen(3000, () => console.log('Health server running'));

// Simulated polling every 10 seconds
setInterval(() => {
  console.log('[Worker] Checking for pending video jobs... (no real DB yet)');
}, 10000);

console.log('Worker started – waiting for jobs');
