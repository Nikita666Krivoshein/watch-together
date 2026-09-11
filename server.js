const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      videoUrl: "",
      position: 0,
      playing: false,
      messages: [],
      controllerId: null,
      stateVersion: 0
    });
  }
  return rooms.get(id);
}

function cleanRoomId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 32);
}

function emitAuthoritative(roomId, room, originId = null) {
  io.to(roomId).emit("authoritative-state", {
    position: room.position,
    playing: room.playing,
    originId,
    stateVersion: ++room.stateVersion,
    serverAt: Date.now()
  });
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, name }) => {
    roomId = cleanRoomId(roomId);
    if (!roomId) return;

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = String(name || "Гость").trim().slice(0, 30) || "Гость";

    const room = getRoom(roomId);

    socket.emit("room-state", {
      videoUrl: room.videoUrl,
      position: room.position,
      playing: room.playing,
      messages: room.messages,
      stateVersion: room.stateVersion
    });

    io.to(roomId).emit(
      "users",
      io.sockets.adapter.rooms.get(roomId)?.size || 1
    );
  });

  socket.on("set-video", ({ roomId, videoUrl }) => {
    roomId = cleanRoomId(roomId);
    const room = getRoom(roomId);
    room.videoUrl = String(videoUrl || "").trim();
    room.position = 0;
    room.playing = false;
    room.controllerId = socket.id;

    io.to(roomId).emit("remote-video", { videoUrl: room.videoUrl });
  });

  socket.on("player-command", ({ roomId, command }) => {
    roomId = cleanRoomId(roomId);
    const room = getRoom(roomId);
    if (!command || typeof command.type !== "string") return;

    room.controllerId = socket.id;

    if (command.type === "play") {
      room.playing = true;
      if (Number.isFinite(command.time)) room.position = command.time;
    }

    if (command.type === "pause") {
      room.playing = false;
      if (Number.isFinite(command.time)) room.position = command.time;
    }

    if (command.type === "seek" && Number.isFinite(command.time)) {
      room.position = command.time;
    }

    const actionId = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    socket.to(roomId).emit("remote-command", {
      ...command,
      serverAt: Date.now(),
      actionId
    });
    emitAuthoritative(roomId, room, socket.id);
  });

  socket.on("sync-position", ({ roomId, time, sentAt, playing }) => {
    roomId = cleanRoomId(roomId);
    const room = getRoom(roomId);
    if (room.controllerId !== socket.id || !Number.isFinite(time)) return;
    room.position = time;
    room.playing = !!playing;
    emitAuthoritative(roomId, room, socket.id);
  });

  socket.on("chat-message", ({ roomId, text }) => {
    roomId = cleanRoomId(roomId);
    const clean = String(text || "").trim().slice(0, 500);
    if (!clean) return;

    const room = getRoom(roomId);
    const message = {
      name: socket.data.name || "Гость",
      text: clean,
      time: Date.now()
    };

    room.messages.push(message);
    if (room.messages.length > 100) room.messages.shift();

    io.to(roomId).emit("chat-message", message);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (room && room.controllerId === socket.id) {
      room.controllerId = null;
    }

    const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit("users", count);
  });
});


// Keep every connected player aligned with the room's authoritative state.
// This is especially important while paused: no client can accidentally resume
// because of a stale player:changeState event.
setInterval(() => {
  for (const [roomId, room] of rooms) {
    if (room.controllerId) emitAuthoritative(roomId, room, room.controllerId);
  }
}, 700);

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Watch Together запущен на порту ${PORT}`);
});