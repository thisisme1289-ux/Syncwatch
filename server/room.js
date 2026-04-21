const { v4: uuidv4 } = require('uuid');

// Generate short readable room code
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

class RoomManager {
  constructor() {
    this.rooms = new Map();   // id -> room
    this.codes = new Map();   // code -> id
    this.TTL = (parseInt(process.env.ROOM_TTL_HOURS) || 24) * 60 * 60 * 1000;
  }

  create({ hostNickname, mode, password, settings }) {
    const id = uuidv4();
    const hostToken = uuidv4();
    let code;
    do { code = genCode(); } while (this.codes.has(code));

    const room = {
      id,
      code,
      hostToken,
      hostNickname,
      mode,
      password: password || null,
      settings: {
        hostOnlyControl: settings?.hostOnlyControl ?? true,
        voiceEnabled: settings?.voiceEnabled ?? false,
        videoEnabled: settings?.videoEnabled ?? false,
        chatEnabled: settings?.chatEnabled ?? true,
        dataSaver: settings?.dataSaver ?? true,
        defaultQuality: settings?.defaultQuality ?? 'low',
      },
      playback: {
        state: 'paused',
        timestamp: 0,
        updatedAt: Date.now(),
        rate: 1,
      },
      media: null,       // { filename, url, sizes } for upload mode
      users: new Map(),  // socketId -> { nickname, isHost }
      chat: [],          // last 100 messages kept in memory
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.rooms.set(id, room);
    this.codes.set(code, id);
    return room;
  }

  get(id) { return this.rooms.get(id) || null; }

  getByCode(code) {
    const id = this.codes.get(code);
    return id ? this.rooms.get(id) : null;
  }

  addUser(roomId, socketId, nickname, isHost) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.users.set(socketId, { nickname, isHost, joinedAt: Date.now() });
    room.lastActivity = Date.now();
    return true;
  }

  removeUser(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.users.delete(socketId);
    room.lastActivity = Date.now();
  }

  getUserList(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.users.entries()).map(([sid, u]) => ({
      socketId: sid,
      nickname: u.nickname,
      isHost: u.isHost,
    }));
  }

  updatePlayback(roomId, state) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.playback = { ...room.playback, ...state, updatedAt: Date.now() };
    room.lastActivity = Date.now();
  }

  addChat(roomId, message) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.chat.push(message);
    if (room.chat.length > 100) room.chat.shift();
    room.lastActivity = Date.now();
  }

  transferHost(roomId, oldSocketId, newSocketId) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const oldUser = room.users.get(oldSocketId);
    const newUser = room.users.get(newSocketId);
    if (!oldUser || !newUser) return false;
    oldUser.isHost = false;
    newUser.isHost = true;
    room.hostNickname = newUser.nickname;
    return true;
  }

  destroy(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.codes.delete(room.code);
    this.rooms.delete(roomId);
  }

  cleanup() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.lastActivity > this.TTL) {
        this.destroy(id);
      }
    }
  }
}

const roomManager = new RoomManager();
module.exports = { roomManager };
