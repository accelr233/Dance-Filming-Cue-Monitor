const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);
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

// Store latest cues per room so new clients joining can get them immediately
const roomCues = new Map();
const roomState = new Map(); // Store latest play state (pausedAt, running, startAt)
const roomSockets = new Map(); // room -> Set<socketId>

io.on('connection', (socket) => {
  // 1. Time Sync (NTP-like)
  socket.on('ping', (clientTime, callback) => {
    callback(Date.now());
  });

  // 2. Room Management
  socket.on('joinRoom', ({ room, role }) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.role = role;

    // Track connected sockets per room
    if (!roomSockets.has(room)) roomSockets.set(room, new Set());
    roomSockets.get(room).add(socket.id);
    io.to(room).emit('clientCount', roomSockets.get(room).size);

    // Send current state to newly joined client
    if (roomCues.has(room)) socket.emit('syncCues', roomCues.get(room));
    if (roomState.has(room)) socket.emit('syncState', roomState.get(room));

    // Ask host to re-broadcast latest state to new client
    if (role === 'client') {
      socket.to(room).emit('requestResync');
    }
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
  // state: { pausedAt: number, running: boolean, startAt: number }
  socket.on('updateState', (state) => {
    const room = socket.data.room;
    if (room && socket.data.role === 'host') {
      // In a real network, we map host's Date.now() reference to Server's Date.now() reference.
      // Host sends its local Date.now() in state.hostTime (when the event was fired).
      // We attach the server's time of reception so clients can compute exact timeline.
      state.serverTime = Date.now();
      
      roomState.set(room, state);
      socket.to(room).emit('syncState', state);
    }
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room && roomSockets.has(room)) {
      roomSockets.get(room).delete(socket.id);
      io.to(room).emit('clientCount', roomSockets.get(room).size);
    }
  });

  // 5. Client done relay (client -> host)
  socket.on('clientDone', (data) => {
    const room = socket.data.room;
    if (room) {
      socket.to(room).emit('clientDone', data);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
