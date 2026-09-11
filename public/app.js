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
  currentVideoUrl=value; rutubeReady=false; localPlayerState="paused"; lastPlayerTime=0; lastTimeStamp=performance.now();
  videoPlaceholder.classList.add("hidden"); videoFrame.src=embed;
  setStatus(isRutubeUrl(value)?"RUTUBE: загрузка...":"Видео загружается");
  if(!remote) socket.emit("set-video",{roomId,videoUrl:value}); return true;
}
function rutubeCommand(command){ if(videoFrame.contentWindow) videoFrame.contentWindow.postMessage(JSON.stringify(command),"*"); }
function sendPlayerCommand(command){
  if(applyingRemote) return;
  lastLocalAction=performance.now();
  socket.emit("player-command",{roomId,command});
  if(isRutubeUrl(currentVideoUrl)&&rutubeReady){
    if(command.type==="play") rutubeCommand({type:"player:play",data:{}});
    if(command.type==="pause") rutubeCommand({type:"player:pause",data:{}});
    if(command.type==="seek"||command.type==="sync") rutubeCommand({type:"player:setCurrentTime",data:{time:Number(command.time)||0}});
  }
}
window.addEventListener("message",event=>{
  if(event.origin!=="https://rutube.ru") return;
  let data; try{data=typeof event.data==="string"?JSON.parse(event.data):event.data;}catch{return;}
  if(!data||!data.type)return;
  if(data.type==="player:ready"){
    rutubeReady=true; setStatus("RUTUBE готов");
    if(roomState)setTimeout(()=>{
      rutubeCommand({type:"player:setCurrentTime",data:{time:Number(roomState.position)||0}});
      if(roomState.playing)rutubeCommand({type:"player:play",data:{}});
    },350);
  }
  if(data.type==="player:changeState"){
    const state=data.data?.state; if(!["playing","paused","stopped"].includes(state))return;
    localPlayerState=state==="playing"?"playing":"paused"; lastTimeStamp=performance.now();
    if(applyingRemote)return;
    sendPlayerCommand({type:localPlayerState==="playing"?"play":"pause",time:lastPlayerTime});
  }
  if(data.type==="player:currentTime"){
    const time=Number(data.data?.time); if(!Number.isFinite(time))return;
    const now=performance.now(), elapsed=(now-lastTimeStamp)/1000;
    const expected=localPlayerState==="playing"?lastPlayerTime+elapsed:lastPlayerTime;
    if(!applyingRemote && now-lastLocalAction>700 && Math.abs(time-expected)>1.8) sendPlayerCommand({type:"seek",time});
    lastPlayerTime=time; lastTimeStamp=now;
  }
});
function applyRemoteCommand(command){
  if(!command||!isRutubeUrl(currentVideoUrl))return;
  applyingRemote=true;
  const t=Number(command.time)||0; lastPlayerTime=t;
  if(command.type==="play"){
    localPlayerState="playing";
    rutubeCommand({type:"player:setCurrentTime",data:{time:t}});
    setTimeout(()=>rutubeCommand({type:"player:play",data:{}}),80); setStatus("Синхронизировано ▶");
  } else if(command.type==="pause"){
    localPlayerState="paused";
    rutubeCommand({type:"player:setCurrentTime",data:{time:t}});
    setTimeout(()=>rutubeCommand({type:"player:pause",data:{}}),80); setStatus("Синхронизировано ⏸");
  } else if(command.type==="seek"||command.type==="sync"){
    rutubeCommand({type:"player:setCurrentTime",data:{time:t}}); setStatus("Синхронизировано");
  }
  setTimeout(()=>{applyingRemote=false;lastTimeStamp=performance.now();},500);
}
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
socket.on("remote-command",applyRemoteCommand);socket.on("chat-message",addMessage);socket.on("users",count=>usersLabel.textContent=`👤 ${count}`);
setInterval(()=>{if(!roomId||!isRutubeUrl(currentVideoUrl)||!rutubeReady||applyingRemote||localPlayerState!=="playing")return;if(performance.now()-lastLocalAction<1200)return;socket.emit("sync-position",{roomId,time:lastPlayerTime});},2000);
const existingRoom=getRoomFromUrl();
if(existingRoom){const savedName=localStorage.getItem("watchTogetherName")||"";const name=savedName||prompt("Введите ваше имя:")||"Гость";localStorage.setItem("watchTogetherName",name);joinRoom(existingRoom,name);}
nameInput.addEventListener("change",()=>localStorage.setItem("watchTogetherName",nameInput.value.trim()));
