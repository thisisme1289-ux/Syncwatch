require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { roomManager } = require('./rooms');
const { setupSocketHandlers } = require('./socket');
const uploadRouter = require('./upload');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket'],
  perMessageDeflate: {
    zlibDeflateOptions: { level: 6 },
    threshold: 512,
  },
});

app.locals.io = io;
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1d',
  etag: true,
}));

// POST /api/rooms - create room
app.post('/api/rooms', (req, res) => {
  const { nickname, mode, password, settings } = req.body;
  if (!nickname || !mode) return res.status(400).json({ error: 'nickname and mode required' });
  const validModes = ['local', 'upload', 'screenshare'];
  if (!validModes.includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  const room = roomManager.create({ hostNickname: nickname, mode, password, settings });
  res.json({ roomId: room.id, roomCode: room.code, hostToken: room.hostToken });
});

// GET /api/rooms/:identifier - lookup by UUID or 6-char code
app.get('/api/rooms/:identifier', (req, res) => {
  const id = req.params.identifier;
  const room = id.length === 36 ? roomManager.get(id) : roomManager.getByCode(id.toUpperCase());
  if (!room) return res.status(404).json({ error: 'room not found' });
  res.json({
    roomId: room.id,
    code: room.code,
    mode: room.mode,
    hasPassword: !!room.password,
    hostNickname: room.hostNickname,
    userCount: room.users.size,
    media: room.media ? { url: room.media.url, filename: room.media.filename } : null,
  });
});

app.use('/api/upload', uploadRouter);

setInterval(() => roomManager.cleanup(), 30 * 60 * 1000);
setupSocketHandlers(io);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('SyncWatch running on port ' + PORT);
});
