const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files from current directory
app.use(express.static(__dirname));

// Keep-alive endpoint (prevents Render free tier from sleeping)
app.get('/ping', (req, res) => res.send('ok'));

// ── MongoDB ─────────────────────────────────────────────────────────────────
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));
} else {
  console.warn('MONGODB_URI not set — song library API disabled');
}

const versionSchema = new mongoose.Schema({
  choreographer: { type: String, default: '' }, // 振付
  label:         { type: String, default: '' }, // 版本标签
  cues:          { type: String, default: '' }, // 提示词文本
  createdAt:     { type: Date, default: Date.now },
  updatedAt:     { type: Date, default: Date.now }
});

const songSchema = new mongoose.Schema({
  title:     { type: String, required: true },  // 歌名（搜索用）
  artist:    { type: String, default: '' },      // 歌手
  createdAt: { type: Date, default: Date.now },
  versions:  [versionSchema]
});

const Song = mongoose.model('Song', songSchema);

// Admin auth middleware — requires X-Admin-Key header matching ADMIN_KEY env var
function adminOnly(req, res, next) {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_KEY;
  if (!expected) return res.status(503).json({ error: 'ADMIN_KEY not configured on server' });
  if (key !== expected) return res.status(401).json({ error: '管理员密钥不正确' });
  next();
}

function dbRequired(req, res, next) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: '数据库未连接，请设置 MONGODB_URI 环境变量' });
  }
  next();
}

// ── Song Library API ─────────────────────────────────────────────────────────

// GET /api/songs?q=keyword  — search (public, no auth)
app.get('/api/songs', dbRequired, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    const filter = q
      ? { $or: [
          { title:  { $regex: q, $options: 'i' } },
          { artist: { $regex: q, $options: 'i' } }
        ] }
      : {};
    const songs = await Song.find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(songs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/songs/:id  — full song (public)
app.get('/api/songs/:id', dbRequired, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id).lean();
    if (!song) return res.status(404).json({ error: '未找到' });
    res.json(song);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/songs  — create song (admin)
app.post('/api/songs', dbRequired, adminOnly, async (req, res) => {
  try {
    const { title, artist } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: '歌曲名不能为空' });
    const song = await Song.create({ title: title.trim(), artist: (artist || '').trim() });
    res.json(song);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/songs/:id  — update song title/artist (admin)
app.patch('/api/songs/:id', dbRequired, adminOnly, async (req, res) => {
  try {
    const { title, artist } = req.body;
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ error: '未找到' });
    if (title !== undefined) song.title = title.trim();
    if (artist !== undefined) song.artist = artist.trim();
    await song.save();
    res.json(song);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/songs/:id  — delete song (admin)
app.delete('/api/songs/:id', dbRequired, adminOnly, async (req, res) => {
  try {
    await Song.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/songs/:id/versions  — add version (admin)
app.post('/api/songs/:id/versions', dbRequired, adminOnly, async (req, res) => {
  try {
    const { choreographer, label, cues } = req.body;
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ error: '未找到' });
    song.versions.push({ choreographer, label, cues });
    await song.save();
    res.json(song);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/songs/:id/versions/:vid  — edit version (admin)
app.patch('/api/songs/:id/versions/:vid', dbRequired, adminOnly, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ error: '未找到' });
    const ver = song.versions.id(req.params.vid);
    if (!ver) return res.status(404).json({ error: '版本未找到' });
    const { choreographer, label, cues } = req.body;
    if (choreographer !== undefined) ver.choreographer = choreographer;
    if (label !== undefined) ver.label = label;
    if (cues !== undefined) ver.cues = cues;
    ver.updatedAt = new Date();
    await song.save();
    res.json(song);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/songs/:id/versions/:vid  — delete version (admin)
app.delete('/api/songs/:id/versions/:vid', dbRequired, adminOnly, async (req, res) => {
  try {
    const song = await Song.findById(req.params.id);
    if (!song) return res.status(404).json({ error: '未找到' });
    song.versions = song.versions.filter(v => v._id.toString() !== req.params.vid);
    await song.save();
    res.json(song);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Room state (existing) ────────────────────────────────────────────────────
const roomCues    = new Map();
const roomState   = new Map();
const roomSockets = new Map();
const roomUsers   = new Map();

io.on('connection', (socket) => {
  // 1. Time Sync (NTP-like)
  socket.on('ping', (clientTime, callback) => { callback(Date.now()); });

  // 2. Room Management
  socket.on('joinRoom', ({ room, role, name }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.role = role;
    socket.data.name = name || (role === 'host' ? 'Host' : '摄影师');

    if (!roomSockets.has(room)) roomSockets.set(room, new Set());
    roomSockets.get(room).add(socket.id);
    io.to(room).emit('clientCount', roomSockets.get(room).size);

    if (!roomUsers.has(room)) roomUsers.set(room, new Map());
    roomUsers.get(room).set(socket.id, { name: socket.data.name, role });
    io.to(room).emit('userList', Array.from(roomUsers.get(room).values()));

    if (roomCues.has(room))  socket.emit('syncCues',  roomCues.get(room));
    if (roomState.has(room)) socket.emit('syncState', roomState.get(room));

    if (role === 'client') socket.to(room).emit('requestResync');
  });

  // 3. Cue List Updates (Host -> Clients)
  socket.on('updateCues', (cues) => {
    const room = socket.data.room;
    if (room && socket.data.role === 'host') {
      roomCues.set(room, cues);
      socket.to(room).emit('syncCues', cues);
    }
  });

  // 4. Playback State Updates (Host -> Clients)
  socket.on('updateState', (state) => {
    const room = socket.data.room;
    if (room && socket.data.role === 'host') {
      state.serverTime = Date.now();
      roomState.set(room, state);
      socket.to(room).emit('syncState', state);
    }
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      if (roomSockets.has(room)) {
        roomSockets.get(room).delete(socket.id);
        io.to(room).emit('clientCount', roomSockets.get(room).size);
      }
      if (roomUsers.has(room)) {
        roomUsers.get(room).delete(socket.id);
        io.to(room).emit('userList', Array.from(roomUsers.get(room).values()));
      }
    }
  });

  // 5. Client done relay (client -> host)
  socket.on('clientDone', (data) => {
    const room = socket.data.room;
    if (room) socket.to(room).emit('clientDone', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
