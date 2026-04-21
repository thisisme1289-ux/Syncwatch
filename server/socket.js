const { roomManager } = require('./rooms');

/*
  Event reference:
  Client -> Server:
    join_room       { roomId, nickname, password?, hostToken? }
    playback_play   { roomId, timestamp }
    playback_pause  { roomId, timestamp }
    playback_seek   { roomId, timestamp }
    playback_rate   { roomId, rate }
    chat_message    { roomId, text }
    quality_change  { roomId, quality }
    settings_update { roomId, settings }
    transfer_host   { roomId, targetSocketId }
    request_sync    { roomId }

  Server -> Client:
    room_joined     { room state snapshot }
    room_error      { message }
    user_joined     { socketId, nickname, isHost }
    user_left       { socketId, nickname }
    playback_play   { timestamp, by }
    playback_pause  { timestamp, by }
    playback_seek   { timestamp, by }
    playback_rate   { rate, by }
    chat_message    { nickname, text, ts }
    quality_change  { quality, by }
    settings_update { settings }
    host_transferred { newHostId, newHostNickname }
    sync_state      { playback }
*/

function setupSocketHandlers(io) {
  // Track which room each socket is in
  const socketRooms = new Map(); // socketId -> { roomId, nickname, isHost }

  io.on('connection', (socket) => {

    // ---- JOIN ----
    socket.on('join_room', ({ roomId, nickname, password, hostToken }) => {
      if (!roomId || !nickname) return socket.emit('room_error', { message: 'Missing fields' });
      nickname = String(nickname).trim().slice(0, 30);

      const room = roomManager.get(roomId);
      if (!room) return socket.emit('room_error', { message: 'Room not found' });

      const isHost = room.hostToken === hostToken;

      if (!isHost && room.password && room.password !== password) {
        return socket.emit('room_error', { message: 'Wrong password' });
      }

      roomManager.addUser(roomId, socket.id, nickname, isHost);
      socket.join(roomId);
      socketRooms.set(socket.id, { roomId, nickname, isHost });

      // Send full state snapshot to joiner only
      socket.emit('room_joined', {
        roomId: room.id,
        code: room.code,
        mode: room.mode,
        settings: room.settings,
        playback: room.playback,
        media: room.media,
        users: roomManager.getUserList(roomId),
        chat: room.chat.slice(-30), // last 30 messages on join
        isHost,
        mySocketId: socket.id,
      });

      // Notify others
      socket.to(roomId).emit('user_joined', { socketId: socket.id, nickname, isHost });
    });

    // ---- PLAYBACK ----
    function checkControl(socket, roomId) {
      const room = roomManager.get(roomId);
      if (!room) return false;
      const user = room.users.get(socket.id);
      if (!user) return false;
      if (room.settings.hostOnlyControl && !user.isHost) return false;
      return true;
    }

    socket.on('playback_play', ({ roomId, timestamp }) => {
      if (!checkControl(socket, roomId)) return;
      const ts = parseFloat(timestamp) || 0;
      roomManager.updatePlayback(roomId, { state: 'playing', timestamp: ts });
      const { nickname } = socketRooms.get(socket.id) || {};
      // Broadcast to everyone in room including sender
      io.to(roomId).emit('playback_play', { timestamp: ts, by: nickname });
    });

    socket.on('playback_pause', ({ roomId, timestamp }) => {
      if (!checkControl(socket, roomId)) return;
      const ts = parseFloat(timestamp) || 0;
      roomManager.updatePlayback(roomId, { state: 'paused', timestamp: ts });
      const { nickname } = socketRooms.get(socket.id) || {};
      io.to(roomId).emit('playback_pause', { timestamp: ts, by: nickname });
    });

    socket.on('playback_seek', ({ roomId, timestamp }) => {
      if (!checkControl(socket, roomId)) return;
      const ts = parseFloat(timestamp) || 0;
      roomManager.updatePlayback(roomId, { timestamp: ts });
      const { nickname } = socketRooms.get(socket.id) || {};
      socket.to(roomId).emit('playback_seek', { timestamp: ts, by: nickname });
    });

    socket.on('playback_rate', ({ roomId, rate }) => {
      if (!checkControl(socket, roomId)) return;
      const r = Math.min(Math.max(parseFloat(rate) || 1, 0.25), 4);
      roomManager.updatePlayback(roomId, { rate: r });
      const { nickname } = socketRooms.get(socket.id) || {};
      socket.to(roomId).emit('playback_rate', { rate: r, by: nickname });
    });

    // Viewer requests current state (e.g. late joiner)
    socket.on('request_sync', ({ roomId }) => {
      const room = roomManager.get(roomId);
      if (!room) return;
      // Compensate for time elapsed since last update
      let ts = room.playback.timestamp;
      if (room.playback.state === 'playing') {
        ts += (Date.now() - room.playback.updatedAt) / 1000 * room.playback.rate;
      }
      socket.emit('sync_state', { playback: { ...room.playback, timestamp: ts } });
    });

    // ---- CHAT ----
    socket.on('chat_message', ({ roomId, text }) => {
      const room = roomManager.get(roomId);
      if (!room || !room.settings.chatEnabled) return;
      const { nickname } = socketRooms.get(socket.id) || {};
      if (!nickname) return;
      text = String(text).trim().slice(0, 300);
      if (!text) return;
      const msg = { nickname, text, ts: Date.now() };
      roomManager.addChat(roomId, msg);
      io.to(roomId).emit('chat_message', msg);
    });

    // ---- QUALITY ----
    socket.on('quality_change', ({ roomId, quality }) => {
      const valid = ['low', 'medium', 'high', 'source'];
      if (!valid.includes(quality)) return;
      const { nickname } = socketRooms.get(socket.id) || {};
      // Quality change is per-viewer, no broadcast needed
      // but notify room for logging
      socket.to(roomId).emit('quality_change', { quality, by: nickname });
    });

    // ---- SETTINGS ----
    socket.on('settings_update', ({ roomId, settings }) => {
      const room = roomManager.get(roomId);
      if (!room) return;
      const user = room.users.get(socket.id);
      if (!user?.isHost) return;
      // Only allow known keys
      const allowed = ['hostOnlyControl', 'voiceEnabled', 'videoEnabled', 'chatEnabled', 'dataSaver', 'defaultQuality'];
      const cleaned = {};
      for (const key of allowed) {
        if (key in settings) cleaned[key] = settings[key];
      }
      room.settings = { ...room.settings, ...cleaned };
      io.to(roomId).emit('settings_update', { settings: room.settings });
    });

    // ---- HOST TRANSFER ----
    socket.on('transfer_host', ({ roomId, targetSocketId }) => {
      const room = roomManager.get(roomId);
      if (!room) return;
      const user = room.users.get(socket.id);
      if (!user?.isHost) return;
      const success = roomManager.transferHost(roomId, socket.id, targetSocketId);
      if (success) {
        const newHost = room.users.get(targetSocketId);
        io.to(roomId).emit('host_transferred', {
          newHostId: targetSocketId,
          newHostNickname: newHost?.nickname,
        });
      }
    });


    // ---- SCREEN SHARE SIGNALING (WebRTC relay) ----
    // Host sends offer to all guests
    socket.on('ss_offer', ({ roomId, offer }) => {
      const room = roomManager.get(roomId);
      if (!room) return;
      const user = room.users.get(socket.id);
      if (!user?.isHost) return;
      socket.to(roomId).emit('ss_offer', { offer });
    });

    // Guest sends answer back to host
    socket.on('ss_answer', ({ roomId, answer }) => {
      socket.to(roomId).emit('ss_answer', { answer, from: socket.id });
    });

    // ICE candidates relayed bidirectionally
    socket.on('ss_ice', ({ roomId, candidate, to }) => {
      if (to) {
        io.to(to).emit('ss_ice', { candidate, from: socket.id });
      } else {
        socket.to(roomId).emit('ss_ice', { candidate, from: socket.id });
      }
    });

    socket.on('ss_stopped', ({ roomId }) => {
      socket.to(roomId).emit('ss_stopped');
    });

    // ---- DISCONNECT ----
    socket.on('disconnect', () => {
      const info = socketRooms.get(socket.id);
      if (!info) return;
      const { roomId, nickname, isHost } = info;
      roomManager.removeUser(roomId, socket.id);
      socketRooms.delete(socket.id);

      const room = roomManager.get(roomId);
      if (!room) return;

      socket.to(roomId).emit('user_left', { socketId: socket.id, nickname });

      // Auto-transfer host if host disconnects
      if (isHost && room.users.size > 0) {
        const nextEntry = room.users.entries().next().value;
        if (nextEntry) {
          const [nextSocketId, nextUser] = nextEntry;
          roomManager.transferHost(roomId, socket.id, nextSocketId);
          io.to(roomId).emit('host_transferred', {
            newHostId: nextSocketId,
            newHostNickname: nextUser.nickname,
          });
        }
      }

      // Destroy empty rooms
      if (room.users.size === 0) {
        roomManager.destroy(roomId);
      }
    });
  });
}

module.exports = { setupSocketHandlers };
