const socket = io();

const startScreen = document.getElementById("startScreen");
const roomScreen = document.getElementById("roomScreen");
const nameInput = document.getElementById("nameInput");
const videoInput = document.getElementById("videoInput");
const createBtn = document.getElementById("createBtn");

const roomLabel = document.getElementById("roomLabel");
const usersLabel = document.getElementById("usersLabel");
const copyBtn = document.getElementById("copyBtn");

const videoFrame = document.getElementById("videoFrame");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const changeVideoInput = document.getElementById("changeVideoInput");
const changeVideoBtn = document.getElementById("changeVideoBtn");
const statusEl = document.getElementById("status");

const messagesEl = document.getElementById("messages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

let roomId = "";
let userName = "";
let currentVideoUrl = "";
let rutubeReady = false;
let applyingRemote = false;

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getRoomFromUrl() {
  return new URLSearchParams(location.search).get("room");
}

function normalizeUrl(value) {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function getEmbedUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return null;

  const host = url.hostname.toLowerCase();

  // RUTUBE: https://rutube.ru/video/ID/
  if (host === "rutube.ru" || host.endsWith(".rutube.ru")) {
    const match = url.pathname.match(/\/video\/([a-zA-Z0-9_-]+)/);
    if (match) return `https://rutube.ru/play/embed/${match[1]}/`;
  }

  // YouTube watch / youtu.be / shorts
  if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
    const id = url.searchParams.get("v");
    const shorts = url.pathname.match(/\/shorts\/([^/]+)/);
    if (id) return `https://www.youtube.com/embed/${id}?enablejsapi=1`;
    if (shorts) return `https://www.youtube.com/embed/${shorts[1]}?enablejsapi=1`;
  }

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (id) return `https://www.youtube.com/embed/${id}?enablejsapi=1`;
  }

  // Для остальных сайтов пробуем открыть ссылку прямо в iframe.
  return url.href;
}

function isRutubeUrl(value) {
  const url = normalizeUrl(value);
  return !!url && /(^|\.)rutube\.ru$/i.test(url.hostname);
}

function setStatus(text) {
  statusEl.textContent = text;
}

function showRoom() {
  startScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  roomLabel.textContent = `Комната ${roomId}`;
}

function loadVideo(value, remote = false) {
  const embed = getEmbedUrl(value);
  if (!embed) {
    setStatus("Неверная ссылка");
    return false;
  }

  currentVideoUrl = value;
  rutubeReady = false;
  videoPlaceholder.classList.add("hidden");
  videoFrame.src = embed;
  setStatus(isRutubeUrl(value) ? "RUTUBE: загрузка..." : "Видео загружается");

  if (!remote) {
    socket.emit("set-video", { roomId, videoUrl: value });
  }

  return true;
}

function rutubeCommand(command) {
  if (!videoFrame.contentWindow) return;
  videoFrame.contentWindow.postMessage(
    JSON.stringify(command),
    "https://rutube.ru"
  );
}

function sendPlayerCommand(command) {
  if (applyingRemote) return;

  socket.emit("player-command", {
    roomId,
    command
  });

  if (isRutubeUrl(currentVideoUrl)) {
    if (command.type === "play") rutubeCommand({ type: "player:play" });
    if (command.type === "pause") rutubeCommand({ type: "player:pause" });
    if (command.type === "seek") {
      rutubeCommand({
        type: "player:setCurrentTime",
        data: { time: command.time }
      });
    }
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== "https://rutube.ru") return;

  let data;
  try {
    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }

  if (!data || !data.type) return;

  if (data.type === "player:ready") {
    rutubeReady = true;
    setStatus("RUTUBE готов");

    if (roomState) {
      setTimeout(() => {
        rutubeCommand({
          type: "player:setCurrentTime",
          data: { time: roomState.position || 0 }
        });

        if (roomState.playing) {
          rutubeCommand({ type: "player:play" });
        }
      }, 300);
    }
  }

  if (data.type === "player:changeState") {
    const state = data.data?.state;

    if (applyingRemote) return;

    if (state === "playing") {
      socket.emit("player-command", {
        roomId,
        command: { type: "play", time: Number(data.data?.time) || 0 }
      });
    }

    if (state === "paused") {
      socket.emit("player-command", {
        roomId,
        command: { type: "pause", time: Number(data.data?.time) || 0 }
      });
    }
  }

  if (data.type === "player:currentTime") {
    // В текущей версии время используется для локального состояния,
    // но не отправляется постоянно, чтобы не создавать лишний трафик.
  }
});

let roomState = null;

function applyRemoteCommand(command) {
  if (!command) return;

  applyingRemote = true;

  if (isRutubeUrl(currentVideoUrl)) {
    if (command.type === "play") {
      rutubeCommand({
        type: "player:setCurrentTime",
        data: { time: Number(command.time) || 0 }
      });
      rutubeCommand({ type: "player:play" });
      setStatus("Синхронизировано");
    }

    if (command.type === "pause") {
      rutubeCommand({
        type: "player:setCurrentTime",
        data: { time: Number(command.time) || 0 }
      });
      rutubeCommand({ type: "player:pause" });
      setStatus("Пауза");
    }

    if (command.type === "seek") {
      rutubeCommand({
        type: "player:setCurrentTime",
        data: { time: Number(command.time) || 0 }
      });
    }
  }

  setTimeout(() => {
    applyingRemote = false;
  }, 200);
}

function addMessage(message) {
  const item = document.createElement("div");
  item.className = "message";

  const name = document.createElement("strong");
  name.textContent = message.name || "Гость";

  const text = document.createElement("span");
  text.textContent = message.text || "";

  item.append(name, text);
  messagesEl.appendChild(item);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessages(messages) {
  messagesEl.innerHTML = "";
  (messages || []).forEach(addMessage);
}

function joinRoom(id, name) {
  roomId = String(id || "").trim().toUpperCase();
  userName = String(name || "Гость").trim() || "Гость";

  if (!roomId) return;

  showRoom();
  socket.emit("join-room", {
    roomId,
    name: userName
  });
}

createBtn.addEventListener("click", () => {
  userName = nameInput.value.trim() || "Гость";
  roomId = randomRoomId();

  const initialVideo = videoInput.value.trim();

  history.replaceState({}, "", `?room=${roomId}`);
  joinRoom(roomId, userName);

  if (initialVideo) {
    loadVideo(initialVideo);
  }
});

changeVideoBtn.addEventListener("click", () => {
  const value = changeVideoInput.value.trim();
  if (value) loadVideo(value);
});

changeVideoInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    changeVideoBtn.click();
  }
});

copyBtn.addEventListener("click", async () => {
  const link = location.href;
  try {
    await navigator.clipboard.writeText(link);
    copyBtn.textContent = "Скопировано ✓";
    setTimeout(() => {
      copyBtn.textContent = "Скопировать ссылку";
    }, 1800);
  } catch {
    prompt("Скопируйте ссылку:", link);
  }
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const text = chatInput.value.trim();
  if (!text) return;

  socket.emit("chat-message", {
    roomId,
    text
  });

  chatInput.value = "";
  chatInput.focus();
});

socket.on("room-state", (state) => {
  roomState = state;
  renderMessages(state.messages);

  if (state.videoUrl) {
    loadVideo(state.videoUrl, true);
  }
});

socket.on("remote-video", ({ videoUrl }) => {
  if (videoUrl) loadVideo(videoUrl, true);
});

socket.on("remote-command", applyRemoteCommand);

socket.on("chat-message", addMessage);

socket.on("users", (count) => {
  usersLabel.textContent = `👤 ${count}`;
});

const existingRoom = getRoomFromUrl();

if (existingRoom) {
  const savedName = localStorage.getItem("watchTogetherName") || "";
  const name = savedName || prompt("Введите ваше имя:") || "Гость";

  localStorage.setItem("watchTogetherName", name);
  joinRoom(existingRoom, name);
}

nameInput.addEventListener("change", () => {
  localStorage.setItem("watchTogetherName", nameInput.value.trim());
});