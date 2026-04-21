const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { roomManager } = require('./rooms');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB) || 2048;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.ogg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('File type not supported'));
  },
});

// Serve uploaded files with range support (needed for video seeking)
router.use('/files', (req, res, next) => {
  res.setHeader('Accept-Ranges', 'bytes');
  next();
}, express.static(UPLOAD_DIR, { maxAge: '1h' }));

router.post('/', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { roomId, hostToken } = req.body;
  const room = roomManager.get(roomId);

  if (!room) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Room not found' });
  }
  if (room.hostToken !== hostToken) {
    fs.unlinkSync(req.file.path);
    return res.status(403).json({ error: 'Not authorized' });
  }
  if (room.mode !== 'upload') {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Room not in upload mode' });
  }

  const fileUrl = `/api/upload/files/${req.file.filename}`;
  room.media = {
    filename: req.file.originalname,
    storedName: req.file.filename,
    url: fileUrl,
    size: req.file.size,
    uploadedAt: Date.now(),
  };

  res.json({ url: fileUrl, filename: req.file.originalname });

  // Notify guests in the room via socket.io
  // We attach io to the router via app.locals
  const io = req.app.locals.io;
  if (io) {
    io.to(roomId).emit('media_ready', { url: fileUrl, filename: req.file.originalname });
  }
});

module.exports = router;
