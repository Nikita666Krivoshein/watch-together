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
let localPlayerState = "paused";
let lastPlayerTime = 0;
let lastTimeStamp = performance.now();
let lastLocalAction = 0;
let roomState = null;
let seekCandidate = null;

function randomRoomId() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function getRoomFromUrl() { return new URLSearchParams(location.search).get("room"); }
function normalizeUrl(value) { try { return new URL(value.trim()); } catch { return null; } }
function getEmbedUrl(value) {
  const url = normalizeUrl(value); if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (host === "rutube.ru" || host.endsWith(".rutube.ru")) {
    const match = url.pathname.match(/\/(?:video|shorts)\/([a-zA-Z0-9_-]+)/);
    if (match) return `https://rutube.ru/play/embed/${match[1]}/`;
  }
  if (["youtube.com","www.youtube.com","m.youtube.com"].includes(host)) {
    const id = url.searchParams.get("v");
    const shorts = url.pathname.match(/\/shorts\/([^/]+)/);
    if (id) return `https://www.youtube.com/embed/${id}?enablejsapi=1`;
    if (shorts) return `https://www.youtube.com/embed/${shorts[1]}?enablejsapi=1`;
  }
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    if (id) return `https://www.youtube.com/embed/${id}?enablejsapi=1`;
  }
  return url.href;
}
function isRutubeUrl(value) { const u=normalizeUrl(value); return !!u && /(^|\.)rutube\.ru$/i.test(u.hostname); }
function setStatus(text) { statusEl.textContent = text; }
function showRoom() { startScreen.classList.add("hidden"); roomScreen.classList.remove("hidden"); roomLabel.textContent=`Комната ${roomId}`; }

function loadVideo(value, remote=false) {
  const embed=getEmbedUrl(value); if(!embed){setStatus("Неверная ссылка");return false;}
  currentVideoUrl=value;
  rutubeReady=false;
  localPlayerState="paused";
  lastPlayerTime=0;
  lastTimeStamp=performance.now();
  seekCandidate=null;
  videoPlaceholder.classList.add("hidden");
  videoFrame.src=embed;
  setStatus(isRutubeUrl(value)?"RUTUBE: загрузка...":"Видео загружается");
  if(!remote) socket.emit("set-video",{roomId,videoUrl:value});
  return true;
}

function rutubeCommand(command) {
  if (videoFrame.contentWindow) {
    videoFrame.contentWindow.postMessage(JSON.stringify(command), "*");
  }
}

function sendPlayerCommand(command) {
  if (applyingRemote || !roomId || !isRutubeUrl(currentVideoUrl)) return;
  lastLocalAction=performance.now();
  socket.emit("player-command",{roomId,command});
}

function getEstimatedTime() {
  if (localPlayerState === "playing") {
    return Math.max(0, lastPlayerTime + (performance.now() - lastTimeStamp) / 1000);
  }
  return Math.max(0, lastPlayerTime);
}

function setLocalTime(time) {
  const t = Math.max(0, Number(time) || 0);
  lastPlayerTime = t;
  lastTimeStamp = performance.now();
  rutubeCommand({type:"player:setCurrentTime",data:{time:t}});
}

function setRemotePlayback(command) {
  const t=Math.max(0,Number(command.time)||0);
  const networkDelay = command.sentAt ? Math.max(0, (Date.now()-Number(command.sentAt))/1000) : 0;
  const target = command.type === "sync" && command.playing ? t + Math.min(networkDelay, 1.5) : t;

  applyingRemote=true;
  lastLocalAction=performance.now();

  if(command.type === "pause") {
    // Pause FIRST. This prevents setCurrentTime from leaving the remote player playing.
    localPlayerState="paused";
    rutubeCommand({type:"player:pause",data:{}});
    setTimeout(() => {
      setLocalTime(target);
      rutubeCommand({type:"player:pause",data:{}});
    }, 80);
    setStatus("Синхронизировано ⏸");
  } else if(command.type === "play") {
    localPlayerState="playing";
    setLocalTime(target);
    setTimeout(() => rutubeCommand({type:"player:play",data:{}}), 80);
    setStatus("Синхронизировано ▶");
  } else if(command.type === "seek") {
    // A manual seek is authoritative, but do not change play/pause state.
    setLocalTime(target);
    if (localPlayerState === "playing") {
      setTimeout(() => rutubeCommand({type:"player:play",data:{}}), 60);
    }
    setStatus("Синхронизировано");
  } else if(command.type === "sync") {
    if (command.playing) {
      localPlayerState="playing";
      const localNow = localPlayerState === "playing"
        ? lastPlayerTime + (performance.now()-lastTimeStamp)/1000
        : lastPlayerTime;
      const drift = Math.abs(target-localNow);
      // Do NOT seek every heartbeat. That is what caused the second device to lag/stutter.
      if (drift > 0.65) {
        setLocalTime(target);
        rutubeCommand({type:"player:play",data:{}});
      }
    } else {
      localPlayerState="paused";
      rutubeCommand({type:"player:pause",data:{}});
      setLocalTime(target);
      rutubeCommand({type:"player:pause",data:{}});
    }
    setStatus("Синхронизировано");
  }

  setTimeout(()=>{
    applyingRemote=false;
    lastTimeStamp=performance.now();
  },500);
}

window.addEventListener("message", event => {
  if(event.origin !== "https://rutube.ru") return;
  if(event.source !== videoFrame.contentWindow) return;
  let data; try { data=typeof event.data==="string"?JSON.parse(event.data):event.data; } catch { return; }
  if(!data || !data.type) return;

  if(data.type==="player:ready") {
    rutubeReady=true; setStatus("RUTUBE готов");
    if(roomState) setTimeout(() => {
      const base = Number(roomState.position)||0;
      if(roomState.playing) {
        localPlayerState="playing";
        setLocalTime(base);
        rutubeCommand({type:"player:play",data:{}});
      } else {
        localPlayerState="paused";
        setLocalTime(base);
        rutubeCommand({type:"player:pause",data:{}});
      }
    },250);
    return;
  }

  if(data.type==="player:changeState") {
    const state=data.data?.state;
    if(!["playing","paused","stopped"].includes(state)) return;
    const nextState = state === "playing" ? "playing" : "paused";
    localPlayerState = nextState;
    lastTimeStamp = performance.now();

    if(applyingRemote) return;

    // The currentTime event normally arrives continuously. Use our latest timestamp.
    // A state change itself is authoritative for play/pause.
    sendPlayerCommand({
      type: nextState === "playing" ? "play" : "pause",
      time: nextState === "paused" ? getEstimatedTime() : lastPlayerTime
    });
    return;
  }

  if(data.type==="player:currentTime") {
    const time=Number(data.data?.time);
    if(!Number.isFinite(time)) return;
    const now=performance.now();

    if(!applyingRemote && localPlayerState === "playing" && now-lastLocalAction>700) {
      const elapsed=(now-lastTimeStamp)/1000;
      const expected=lastPlayerTime+elapsed;
      const jump=Math.abs(time-expected);

      // A real drag is usually a multi-second jump. Small corrections are normal.
      if(jump>2.0) {
        if(!seekCandidate || now-seekCandidate.at>350) {
          seekCandidate={time,at:now};
          sendPlayerCommand({type:"seek",time});
        }
      } else {
        seekCandidate=null;
      }
    }

    lastPlayerTime=time;
    lastTimeStamp=now;
  }
});

function addMessage(message){const item=document.createElement("div");item.className="message";const name=document.createElement("strong");name.textContent=message.name||"Гость";const text=document.createElement("span");text.textContent=message.text||"";item.append(name,text);messagesEl.appendChild(item);messagesEl.scrollTop=messagesEl.scrollHeight;}
function renderMessages(messages){messagesEl.innerHTML="";(messages||[]).forEach(addMessage);}
function joinRoom(id,name){roomId=String(id||"").trim().toUpperCase();userName=String(name||"Гость").trim()||"Гость";if(!roomId)return;showRoom();socket.emit("join-room",{roomId,name:userName});}

createBtn.addEventListener("click",()=>{userName=nameInput.value.trim()||"Гость";roomId=randomRoomId();const initialVideo=videoInput.value.trim();localStorage.setItem("watchTogetherName",userName);history.replaceState({},"",`?room=${roomId}`);joinRoom(roomId,userName);if(initialVideo)loadVideo(initialVideo);});
changeVideoBtn.addEventListener("click",()=>{const value=changeVideoInput.value.trim();if(value)loadVideo(value);});
changeVideoInput.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();changeVideoBtn.click();}});
copyBtn.addEventListener("click",async()=>{const link=location.href;try{await navigator.clipboard.writeText(link);copyBtn.textContent="Скопировано ✓";setTimeout(()=>copyBtn.textContent="Скопировать ссылку",1800);}catch{prompt("Скопируйте ссылку:",link);}});
chatForm.addEventListener("submit",e=>{e.preventDefault();const text=chatInput.value.trim();if(!text)return;socket.emit("chat-message",{roomId,text});chatInput.value="";chatInput.focus();});

socket.on("room-state",state=>{roomState=state;renderMessages(state.messages);if(state.videoUrl)loadVideo(state.videoUrl,true);});
socket.on("remote-video",({videoUrl})=>{if(videoUrl)loadVideo(videoUrl,true);});
socket.on("remote-command",setRemotePlayback);
socket.on("chat-message",addMessage);
socket.on("users",count=>usersLabel.textContent=`👤 ${count}`);

// The controller sends a heartbeat, but receivers only correct large drift.
// This prevents the second device from constantly jumping/stuttering.
setInterval(()=>{
  if(!roomId||!isRutubeUrl(currentVideoUrl)||!rutubeReady||applyingRemote||localPlayerState!=="playing") return;
  if(performance.now()-lastLocalAction<500) return;
  const elapsed=(performance.now()-lastTimeStamp)/1000;
  const current=lastPlayerTime+elapsed;
  socket.emit("sync-position",{roomId,time:current,sentAt:Date.now(),playing:true});
},500);

const existingRoom=getRoomFromUrl();
if(existingRoom){const savedName=localStorage.getItem("watchTogetherName")||"";const name=savedName||prompt("Введите ваше имя:")||"Гость";localStorage.setItem("watchTogetherName",name);joinRoom(existingRoom,name);}
nameInput.addEventListener("change",()=>localStorage.setItem("watchTogetherName",nameInput.value.trim()));
