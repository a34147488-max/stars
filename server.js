const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log('Stars UI listening on ' + PORT));