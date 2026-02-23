(function(){
"use strict";

var MAX_LOG=2000, MAX_DASH=20;
var AUTH_KEY="vs_auth";
var authHash=null, ws=null, reconnectTimer=null, onlineClients=[], logInit=false;

// ---- DOM refs ----
var loginOverlay=document.getElementById("login-overlay");
var loginForm=document.getElementById("login-form");
var loginPasswordInput=document.getElementById("login-password");
var loginErrorEl=document.getElementById("login-error");
var loginSubmitBtn=document.getElementById("login-submit");

var hamburgerBtn=document.getElementById("hamburger-btn");
var sidebarOverlay=document.getElementById("sidebar-overlay");
var statusDot=document.getElementById("server-status-dot");
var statusText=document.getElementById("server-status-text");
var statFiles=document.getElementById("stat-files");
var statSize=document.getElementById("stat-size");
var statOnline=document.getElementById("stat-online");
var clientsOnEl=document.getElementById("clients-online");
var clientsOffEl=document.getElementById("clients-offline");
var changeLogEl=document.getElementById("change-log");
var dashLogEl=document.getElementById("dashboard-log");
var modalOverlay=document.getElementById("modal-overlay");
var modalCount=document.getElementById("modal-file-count");
var settingsStatus=document.getElementById("settings-status-text");
var settingsUptime=document.getElementById("settings-uptime");

// ---- SHA-256 ----
function sha256hex(str) {
  if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
    return Promise.reject(new Error("Password hashing requires HTTPS or localhost access. Enable TLS on the server or open the dashboard via localhost."));
  }
  return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(str)).then(function(buf) {
    return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");
  });
}

// ---- Auth-aware fetch ----
function apiFetch(url, options) {
  options=options||{};
  options.headers=options.headers||{};
  if(authHash) options.headers["Authorization"]="Bearer "+authHash;
  return fetch(url, options).then(function(res) {
    if(res.status===401) {
      sessionStorage.removeItem(AUTH_KEY);
      authHash=null;
      if(ws){ws.onclose=null;ws.close();}
      showLogin("Session expired. Please sign in again.");
      throw new Error("Unauthorized");
    }
    return res;
  });
}

// ---- Login screen ----
function showLogin(errorMsg) {
  loginOverlay.classList.remove("hidden");
  loginPasswordInput.value="";
  loginSubmitBtn.disabled=false;
  loginSubmitBtn.textContent="Sign In";
  if(errorMsg){
    loginErrorEl.textContent=errorMsg;
    loginErrorEl.classList.remove("hidden");
  } else {
    loginErrorEl.classList.add("hidden");
  }
  setTimeout(function(){loginPasswordInput.focus();},50);
}

loginForm.addEventListener("submit", function(e) {
  e.preventDefault();
  var password=loginPasswordInput.value;
  if(!password) return;
  loginSubmitBtn.disabled=true;
  loginSubmitBtn.textContent="Signing in\u2026";
  loginErrorEl.classList.add("hidden");

  var capturedHash;
  sha256hex(password).then(function(hash) {
    capturedHash=hash;
    return fetch("/api/ui-auth", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({passwordHash:hash})
    });
  }).then(function(res) {
    if(!res.ok) return res.json().then(function(d){throw new Error(d.error||"Invalid password");});
    return res.json();
  }).then(function() {
    authHash=capturedHash;
    sessionStorage.setItem(AUTH_KEY, capturedHash);
    loginOverlay.classList.add("hidden");
    initDashboard();
  }).catch(function(err) {
    loginErrorEl.textContent=err.message||"Login failed";
    loginErrorEl.classList.remove("hidden");
    loginSubmitBtn.disabled=false;
    loginSubmitBtn.textContent="Sign In";
  });
});

// ---- Theme: only apply accent color ----
function applyTheme(vars) {
  var accent=vars["--interactive-accent"];
  if(accent) document.documentElement.style.setProperty("--interactive-accent", accent);
}

// ---- Dashboard init ----
function initDashboard() {
  // Mobile hamburger menu
  if(hamburgerBtn){
    hamburgerBtn.addEventListener("click",function(){document.body.classList.toggle("sidebar-open");});
  }
  if(sidebarOverlay){
    sidebarOverlay.addEventListener("click",function(){document.body.classList.remove("sidebar-open");});
  }

  // Wire up navigation
  document.querySelectorAll(".nav-item").forEach(function(item){
    item.addEventListener("click", function(){
      document.body.classList.remove("sidebar-open");
      var tab=item.getAttribute("data-tab");
      document.querySelectorAll(".nav-item").forEach(function(n){n.classList.remove("active");});
      document.querySelectorAll(".tab-content").forEach(function(t){t.classList.remove("active");});
      item.classList.add("active");
      document.getElementById("tab-"+tab).classList.add("active");
      if(tab==="devices") loadOfflineClients();
    });
  });

  document.getElementById("btn-reset").addEventListener("click", function(){
    modalCount.textContent=statFiles.textContent;
    modalOverlay.classList.remove("hidden");
  });
  document.getElementById("btn-modal-cancel").addEventListener("click", function(){modalOverlay.classList.add("hidden");});
  document.getElementById("btn-modal-confirm").addEventListener("click", function(){
    modalOverlay.classList.add("hidden");
    apiFetch("/api/reset",{method:"POST"}).then(function(){
      statFiles.textContent="0"; statSize.textContent="0 B";
      onlineClients=[]; renderOnlineClients();
      clearLogUI(); addEntry("connect","Server data reset");
    }).catch(function(){alert("Reset failed.");});
  });
  modalOverlay.addEventListener("click", function(e){if(e.target===modalOverlay) modalOverlay.classList.add("hidden");});
  document.getElementById("btn-clear-log").addEventListener("click", clearLog);

  setInterval(function(){
    fetch("/health").then(function(r){return r.json();}).then(function(d){
      var s=Math.floor(d.uptime),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
      if(settingsUptime) settingsUptime.textContent=(h>0?h+"h ":"")+(m>0?m+"m ":"")+ss+"s";
    }).catch(function(){});
  }, 5000);

  apiFetch("/api/theme").then(function(r){return r.json();}).then(applyTheme).catch(function(){});

  connect();
  loadOfflineClients();
}

// ---- WebSocket ----
function connect() {
  var proto=location.protocol==="https:"?"wss:":"ws:";
  ws=new WebSocket(proto+"//"+location.host+"/ui?auth="+encodeURIComponent(authHash||""));
  ws.onopen=function(){setStatus("connected","Connected");};
  ws.onclose=function(e){
    if(e.code===4003){
      sessionStorage.removeItem(AUTH_KEY);
      authHash=null;
      showLogin("Session expired. Please sign in again.");
      return;
    }
    setStatus("disconnected","Disconnected");
    scheduleReconnect();
  };
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

// ---- Event handling ----
function handleEvent(event,data){
  switch(event){
    case"status":
      updateStats(data.stats);
      onlineClients=data.clients||[];
      renderOnlineClients();
      if(data.log) loadLogHistory(data.log);
      break;
    case"client_connected":
      onlineClients.push({clientId:data.clientId,deviceName:data.deviceName,ip:data.ip,connectedAt:Date.now()});
      renderOnlineClients();
      addEntry("connect",data.deviceName+" connected from "+data.ip);
      break;
    case"client_disconnected":
      onlineClients=onlineClients.filter(function(c){return c.clientId!==data.clientId;});
      renderOnlineClients();
      addEntry("connect",data.deviceName+" disconnected");
      if(document.getElementById("tab-devices").classList.contains("active")) loadOfflineClients();
      break;
    case"file_changed":
      addEntry("upload",(data.deviceName||"Device")+" synced "+data.fileId.substring(0,8)+"... ("+fmtSize(data.size)+")");
      refreshStats();
      break;
    case"file_removed":
      addEntry("remove","File "+data.fileId.substring(0,8)+"... deleted by "+(data.deviceName||"device"));
      refreshStats();
      break;
    case"theme":
      applyTheme(data);
      break;
  }
  statOnline.textContent=onlineClients.length;
}

// ---- Stats ----
function refreshStats(){
  apiFetch("/api/stats").then(function(r){return r.json();}).then(function(s){
    statFiles.textContent=s.totalFiles; statSize.textContent=fmtSize(s.totalSize);
  }).catch(function(){});
}
function updateStats(stats){
  statFiles.textContent=stats.totalFiles; statSize.textContent=fmtSize(stats.totalSize);
}

// ---- Clients ----
function renderOnlineClients(){
  statOnline.textContent=onlineClients.length;
  if(onlineClients.length===0){clientsOnEl.innerHTML='<div class="empty-state">No devices online</div>';return;}
  clientsOnEl.innerHTML="";
  onlineClients.forEach(function(c){
    clientsOnEl.appendChild(makeClientEl(c.clientId,c.deviceName,c.ip,"since "+fmtTime(c.connectedAt||Date.now()),true));
  });
}

function loadOfflineClients(){
  if(!authHash) return;
  apiFetch("/api/sessions").then(function(r){return r.json();}).then(function(data){
    var sessions=Array.isArray(data)?data:[];
    var offline=sessions.filter(function(s){return !s.isOnline;});
    if(offline.length===0){clientsOffEl.innerHTML='<div class="empty-state">No device history</div>';return;}
    clientsOffEl.innerHTML="";
    offline.forEach(function(c){
      var ts=c.lastUsed||c.lastSeen||0;
      clientsOffEl.appendChild(makeClientEl(c.clientId,c.deviceName,c.ip,"last seen "+fmtTimeAgo(ts),false));
    });
  }).catch(function(){});
}

function makeClientEl(clientId,name,ip,meta,online){
  var el=document.createElement("div"); el.className="client-item";
  var initial=(name||"?")[0].toUpperCase();
  var badgeCls=online?"client-badge-online":"client-badge-offline";
  var badgeText=online?"Online":"Offline";
  var kickLabel=online?"Kick":"Revoke";

  el.innerHTML=
    '<div class="client-left">'+
      '<div class="client-avatar">'+esc(initial)+'</div>'+
      '<div class="client-info">'+
        '<span class="client-name">'+esc(name)+'</span>'+
        '<span class="client-meta">'+esc(ip)+' &middot; '+esc(meta)+'</span>'+
      '</div>'+
    '</div>'+
    '<div class="client-right">'+
      '<span class="'+badgeCls+'">'+badgeText+'</span>'+
      '<button class="btn btn-sm btn-danger client-kick-btn">'+kickLabel+'</button>'+
    '</div>';

  el.querySelector(".client-kick-btn").addEventListener("click",function(){
    kickClient(clientId,el,online);
  });
  return el;
}

function kickClient(clientId,el,online){
  var msg=online
    ? "Disconnect and revoke this device's session? It will need to re-enter the password to reconnect."
    : "Revoke this device's saved session? It will need to re-enter the password to reconnect.";
  if(!confirm(msg)) return;
  var btn=el.querySelector(".client-kick-btn");
  if(btn){btn.disabled=true;btn.textContent="\u2026";}
  apiFetch("/api/sessions/"+encodeURIComponent(clientId)+"/revoke",{method:"POST"})
    .then(function(){
      el.style.opacity="0";
      el.style.transition="opacity 0.2s";
      setTimeout(function(){
        el.remove();
        if(online){
          onlineClients=onlineClients.filter(function(c){return c.clientId!==clientId;});
          statOnline.textContent=onlineClients.length;
          if(clientsOnEl.children.length===0)
            clientsOnEl.innerHTML='<div class="empty-state">No devices online</div>';
        } else {
          if(clientsOffEl.children.length===0)
            clientsOffEl.innerHTML='<div class="empty-state">No device history</div>';
        }
      },200);
    })
    .catch(function(){
      alert("Failed to revoke device.");
      if(btn){btn.disabled=false;btn.textContent=online?"Kick":"Revoke";}
    });
}

// ---- Log ----
function loadLogHistory(entries) {
  logInit=true;
  changeLogEl.innerHTML="";
  if(!entries||entries.length===0){
    changeLogEl.innerHTML='<div class="empty-state">No activity yet</div>';
  } else {
    entries.forEach(function(e){
      changeLogEl.appendChild(makeEntry(e.type, e.text, e.timestamp));
    });
  }
  dashLogEl.innerHTML="";
  var recent=entries?entries.slice(0,MAX_DASH):[];
  if(recent.length===0){
    dashLogEl.innerHTML='<div class="empty-state">No recent activity</div>';
  } else {
    recent.forEach(function(e){dashLogEl.appendChild(makeEntry(e.type,e.text,e.timestamp));});
  }
}

function addEntry(type,text){
  if(!logInit){changeLogEl.innerHTML="";logInit=true;}
  var e1=makeEntry(type,text,Date.now());
  changeLogEl.insertBefore(e1,changeLogEl.firstChild);
  while(changeLogEl.children.length>MAX_LOG) changeLogEl.removeChild(changeLogEl.lastChild);
  var e2=makeEntry(type,text,Date.now());
  if(dashLogEl.querySelector(".empty-state")) dashLogEl.innerHTML="";
  dashLogEl.insertBefore(e2,dashLogEl.firstChild);
  while(dashLogEl.children.length>MAX_DASH) dashLogEl.removeChild(dashLogEl.lastChild);
}

function makeEntry(type,text,ts){
  var el=document.createElement("div"); el.className="log-entry "+type;
  el.innerHTML='<span class="log-dot"></span><span class="log-text">'+esc(text)+'</span><span class="log-time">'+fmtTime(ts||Date.now())+'</span>';
  return el;
}

function clearLog(){
  apiFetch("/api/log/clear",{method:"POST"}).catch(function(){});
  clearLogUI();
}
function clearLogUI(){
  changeLogEl.innerHTML='<div class="empty-state">Log cleared</div>';
  dashLogEl.innerHTML='<div class="empty-state">No recent activity</div>';
  logInit=false;
}

// ---- Utilities ----
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

// ---- Boot ----
authHash=sessionStorage.getItem(AUTH_KEY);
if(authHash){
  loginOverlay.classList.add("hidden");
  initDashboard();
} else {
  showLogin();
}

})();
