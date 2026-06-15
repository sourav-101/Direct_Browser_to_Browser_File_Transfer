import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { nanoid } from 'nanoid';

const app = express();
app.use(cors());

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    // origin: 'https://direct-browser-to-browser-file-tran-xi.vercel.app',
    origin: [
        "http://localhost:5173",
        "https://peerlink-p2p.vercel.app",
    ],
    methods: ['GET', 'POST'],
  },
});

// Health check - also useful to "wake up" Render before recording your demo
app.get('/', (req, res) => {
  res.send('P2P signaling server is running');
});

// roomId -> Set of socket ids currently in that room
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Sender clicks "Create Room"
  socket.on('create-room', () => {
    const roomId = nanoid(8); // short, unguessable id
    rooms.set(roomId, new Set([socket.id]));
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit('room-created', { roomId });
    console.log(`Room created: ${roomId} by ${socket.id}`);
  });

  // Receiver opens the shared link, which triggers this with the roomId
  socket.on('join-room', ({ roomId }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('room-error', { message: 'Room not found or expired.' });
      return;
    }
    if (room.size >= 2) {
      socket.emit('room-error', { message: 'Room is full.' });
      return;
    }

    room.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined-room', { roomId });
    socket.to(roomId).emit('peer-joined', { peerId: socket.id });

    console.log(`${socket.id} joined room ${roomId}`);
  });

  // Relay WebRTC handshake data (offer/answer/ICE) - server never looks inside this
  socket.on('signal', ({ roomId, data }) => {
    socket.to(roomId).emit('signal', { data, from: socket.id });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      rooms.get(roomId).delete(socket.id);
      socket.to(roomId).emit('peer-left');
      if (rooms.get(roomId).size === 0) rooms.delete(roomId);
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});