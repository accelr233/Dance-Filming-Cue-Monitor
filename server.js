const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Serve static files from current directory
app.use(express.static(__dirname));

// Store latest cues per room so new clients joining can get them immediately
const roomCues = new Map();
const roomState = new Map(); // Store latest play state (pausedAt, running, startAt)

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
    
    // Send current state to newly joined client
    if (roomCues.has(room)) {
      socket.emit('syncCues', roomCues.get(room));
    }
    if (roomState.has(room)) {
      socket.emit('syncState', roomState.get(room));
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
    // Keep state for reconnects
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
