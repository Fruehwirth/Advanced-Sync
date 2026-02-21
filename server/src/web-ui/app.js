(function(){
"use strict";
var MAX_LOG=200,MAX_DASH=10,ws=null,reconnectTimer=null,onlineClients=[],logInit=false;
var statusDot=document.getElementById("server-status-dot"),statusText=document.getElementById("server-status-text");
var statFiles=document.getElementById("stat-files"),statSize=document.getElementById("stat-size"),statOnline=document.getElementById("stat-online");
var clientsOnEl=document.getElementById("clients-online"),clientsOffEl=document.getElementById("clients-offline");
var changeLogEl=document.getElementById("change-log"),dashLogEl=document.getElementById("dashboard-log");
var modalOverlay=document.getElementById("modal-overlay"),modalCount=document.getElementById("modal-file-count");
var settingsStatus=document.getElementById("settings-status-text"),settingsUptime=document.getElementById("settings-uptime");

document.querySelectorAll(".nav-item").forEach(function(item){
  item.addEventListener("click",function(){
    var tab=item.getAttribute("data-tab");
    document.querySelectorAll(".nav-item").forEach(function(n){n.classList.remove("active");});
    document.querySelectorAll(".tab-content").forEach(function(t){t.classList.remove("active");});
    item.classList.add("active");
    document.getElementById("tab-"+tab).classList.add("active");
    if(tab==="devices") loadOfflineClients();
  });
});

document.getElementById("btn-reset").addEventListener("click",function(){
  modalCount.textContent=statFiles.textContent;
  modalOverlay.classList.remove("hidden");
});
document.getElementById("btn-modal-cancel").addEventListener("click",function(){modalOverlay.classList.add("hidden");});
document.getElementById("btn-modal-confirm").addEventListener("click",function(){
  modalOverlay.classList.add("hidden");
  fetch("/api/reset",{method:"POST"}).then(function(){
    statFiles.textContent="0"; statSize.textContent="0 B";
    onlineClients=[]; renderOnlineClients(); clearLog(); addEntry("connect","Server data reset");
  }).catch(function(){alert("Reset failed.");});
});
modalOverlay.addEventListener("click",function(e){if(e.target===modalOverlay) modalOverlay.classList.add("hidden");});
document.getElementById("btn-clear-log").addEventListener("click",clearLog);

setInterval(function(){
  fetch("/health").then(function(r){return r.json();}).then(function(d){
    var s=Math.floor(d.uptime),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
    if(settingsUptime) settingsUptime.textContent=(h>0?h+"h ":"")+(m>0?m+"m ":"")+ss+"s";
  }).catch(function(){});
},5000);

function applyTheme(vars){
  var root=document.documentElement;
  for(var key in vars){if(vars[key]) root.style.setProperty(key,vars[key]);}
}
fetch("/api/theme").then(function(r){return r.json();}).then(applyTheme).catch(function(){});

function connect(){
  var proto=location.protocol==="https:"?"wss:":"ws:";
  ws=new WebSocket(proto+"//"+location.host+"/ui");
  ws.onopen=function(){setStatus("connected","Connected");};
  ws.onclose=function(){setStatus("disconnected","Disconnected");scheduleReconnect();};
  ws.onerror=function(){};
  ws.onmessage=function(evt){
    try{var msg=JSON.parse(evt.data);if(msg.type==="UI_EVENT") handleEvent(msg.event,msg.data);}catch(e){}
  };
}
function scheduleReconnect(){
  if(reconnectTimer) return;
  reconnectTimer=setTimeout(function(){reconnectTimer=null;connect();},3000);
}
function setStatus(state,text){
  statusDot.className="status-dot "+state;
  statusText.textContent=text;
  if(settingsStatus) settingsStatus.textContent=text;
}

function handleEvent(event,data){
  switch(event){
    case"status":
      updateStats(data.stats); onlineClients=data.clients||[]; renderOnlineClients();
      break;
    case"client_connected":
      onlineClients.push({clientId:data.clientId,deviceName:data.deviceName,ip:data.ip,connectedAt:Date.now()});
      renderOnlineClients();
      addEntry("connect",esc(data.deviceName)+" connected from "+esc(data.ip));
      break;
    case"client_disconnected":
      onlineClients=onlineClients.filter(function(c){return c.clientId!==data.clientId;});
      renderOnlineClients();
      addEntry("connect",esc(data.deviceName)+" disconnected");
      if(document.getElementById("tab-devices").classList.contains("active")) loadOfflineClients();
      break;
    case"file_changed":
      addEntry("upload",esc(data.deviceName||"Device")+" synced "+esc(data.fileId.substring(0,8))+"... ("+fmtSize(data.size)+")");
      refreshStats();
      break;
    case"file_removed":
      addEntry("remove","File "+esc(data.fileId.substring(0,8))+"... deleted");
      refreshStats();
      break;
    case"theme":
      applyTheme(data);
      break;
  }
  statOnline.textContent=onlineClients.length;
}

function refreshStats(){
  fetch("/api/stats").then(function(r){return r.json();}).then(function(s){
    statFiles.textContent=s.totalFiles; statSize.textContent=fmtSize(s.totalSize);
  }).catch(function(){});
}
function updateStats(stats){
  statFiles.textContent=stats.totalFiles; statSize.textContent=fmtSize(stats.totalSize);
}

function renderOnlineClients(){
  statOnline.textContent=onlineClients.length;
  if(onlineClients.length===0){clientsOnEl.innerHTML='<div class="empty-state">No devices online</div>';return;}
  clientsOnEl.innerHTML="";
  onlineClients.forEach(function(c){clientsOnEl.appendChild(makeClientEl(c.deviceName,c.ip,"since "+fmtTime(c.connectedAt||Date.now()),true));});
}

function loadOfflineClients(){
  fetch("/api/clients").then(function(r){return r.json();}).then(function(data){
    var offline=data.offline||[];
    if(offline.length===0){clientsOffEl.innerHTML='<div class="empty-state">No device history</div>';return;}
    clientsOffEl.innerHTML="";
    offline.forEach(function(c){clientsOffEl.appendChild(makeClientEl(c.deviceName,c.ip,"last seen "+fmtTimeAgo(c.lastSeen),false));});
  }).catch(function(){});
}

function makeClientEl(name,ip,meta,online){
  var el=document.createElement("div"); el.className="client-item";
  var initial=(name||"?")[0].toUpperCase();
  el.innerHTML=
    '<div class="client-left">'+
      '<div class="client-avatar">'+esc(initial)+'</div>'+
      '<div class="client-info">'+
        '<span class="client-name">'+esc(name)+'</span>'+
        '<span class="client-meta">'+esc(ip)+' &middot; '+esc(meta)+'</span>'+
      '</div>'+
    '</div>'+
    '<span class="'+(online?"client-badge-online":"client-badge-offline")+'">'+(online?"Online":"Offline")+'</span>';
  return el;
}

function addEntry(type,text){
  if(!logInit){changeLogEl.innerHTML="";logInit=true;}
  var e1=makeEntry(type,text);
  changeLogEl.insertBefore(e1,changeLogEl.firstChild);
  while(changeLogEl.children.length>MAX_LOG) changeLogEl.removeChild(changeLogEl.lastChild);
  var e2=makeEntry(type,text);
  if(dashLogEl.querySelector(".empty-state")) dashLogEl.innerHTML="";
  dashLogEl.insertBefore(e2,dashLogEl.firstChild);
  while(dashLogEl.children.length>MAX_DASH) dashLogEl.removeChild(dashLogEl.lastChild);
}

function makeEntry(type,text){
  var el=document.createElement("div"); el.className="log-entry "+type;
  el.innerHTML='<span class="log-dot"></span><span class="log-text">'+text+'</span><span class="log-time">'+fmtTime(Date.now())+'</span>';
  return el;
}

function clearLog(){changeLogEl.innerHTML='<div class="empty-state">Log cleared</div>';logInit=false;}

function fmtSize(b){
  if(!b||b===0) return "0 B";
  var u=["B","KB","MB","GB"],i=Math.floor(Math.log(b)/Math.log(1024));
  return (b/Math.pow(1024,i)).toFixed(i>0?1:0)+" "+u[i];
}
function fmtTime(ts){return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function fmtTimeAgo(ts){
  var diff=Date.now()-ts,m=Math.floor(diff/60000);
  if(m<1) return "just now"; if(m<60) return m+"m ago";
  var h=Math.floor(m/60); if(h<24) return h+"h ago";
  return new Date(ts).toLocaleDateString([],{month:"short",day:"numeric"});
}
function esc(str){var d=document.createElement("div");d.textContent=str||"";return d.innerHTML;}

connect();
loadOfflineClients();
})();
