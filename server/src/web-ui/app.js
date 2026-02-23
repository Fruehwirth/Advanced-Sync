(function(){
"use strict";

var MAX_LOG=2000, MAX_DASH=20;
var AUTH_KEY="vs_auth";
var authHash=null, ws=null, reconnectTimer=null, onlineClients=[], logInit=false;

// ---- DOM refs ----
var loginOverlay=document.getElementById("login-overlay");
var initPanel=document.getElementById("init-panel");
var loginPanel=document.getElementById("login-panel");
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

// ---- SHA-256 (with pure-JS fallback for plain HTTP) ----
function sha256hex(str) {
  var data = new TextEncoder().encode(str);
  if (window.crypto && window.crypto.subtle) {
    return window.crypto.subtle.digest("SHA-256", data).then(function(buf) {
      return Array.from(new Uint8Array(buf)).map(function(b){return b.toString(16).padStart(2,"0");}).join("");
    });
  }
  // Pure JS SHA-256 fallback (no crypto.subtle over plain HTTP)
  return Promise.resolve(jsSha256(data));
}
function jsSha256(data) {
  var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  var len=data.length, bitLen=len*8;
  var padded=new Uint8Array(((len+9+63)&~63));
  padded.set(data); padded[len]=0x80;
  var dv=new DataView(padded.buffer);
  dv.setUint32(padded.length-4, bitLen, false);
  var W=new Int32Array(64);
  for(var off=0;off<padded.length;off+=64){
    for(var i=0;i<16;i++) W[i]=dv.getInt32(off+i*4,false);
    for(i=16;i<64;i++){
      var s0=((W[i-15]>>>7)|(W[i-15]<<25))^((W[i-15]>>>18)|(W[i-15]<<14))^(W[i-15]>>>3);
      var s1=((W[i-2]>>>17)|(W[i-2]<<15))^((W[i-2]>>>19)|(W[i-2]<<13))^(W[i-2]>>>10);
      W[i]=(W[i-16]+s0+W[i-7]+s1)|0;
    }
    var a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for(i=0;i<64;i++){
      var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
      var ch=(e&f)^(~e&g);
      var t1=(h+S1+ch+K[i]+W[i])|0;
      var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
      var maj=(a&b)^(a&c)^(b&c);
      var t2=(S0+maj)|0;
      h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
    }
    h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map(function(v){return (v>>>0).toString(16).padStart(8,"0");}).join("");
}

// ---- Auth-aware fetch ----
function apiFetch(url, options) {
  options=options||{};
  options.headers=options.headers||{};
  if(authHash) options.headers["Authorization"]="Bearer "+authHash;
  return fetch(url, options).then(function(res) {
    if(res.status===428){
      sessionStorage.removeItem(AUTH_KEY);
      authHash=null;
      if(ws){ws.onclose=null;ws.close();}
      showInit();
      throw new Error("Server not initialized");
    }
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
  if(initPanel) initPanel.classList.add("hidden");
  if(loginPanel) loginPanel.classList.remove("hidden");
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

function showInit() {
  if(loginPanel) loginPanel.classList.add("hidden");
  if(initPanel) initPanel.classList.remove("hidden");
  loginOverlay.classList.remove("hidden");
  if(loginErrorEl) loginErrorEl.classList.add("hidden");
  if(loginSubmitBtn){loginSubmitBtn.disabled=true;loginSubmitBtn.textContent="Sign In";}
}

function fetchInitStatus() {
  return fetch("/api/init-status").then(function(r){return r.json();}).catch(function(){return {initialized:false};});
}

loginForm.addEventListener("submit", function(e) {
  e.preventDefault();
  if(initPanel && !initPanel.classList.contains("hidden")) return;
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
    if(res.status===428){
      showInit();
      var err=new Error("Server not initialized");
      err.silent=true;
      throw err;
    }
    if(!res.ok) return res.json().then(function(d){throw new Error(d.error||"Invalid password");});
    return res.json();
  }).then(function() {
    authHash=capturedHash;
    sessionStorage.setItem(AUTH_KEY, capturedHash);
    loginOverlay.classList.add("hidden");
    initDashboard();
  }).catch(function(err) {
    if(err && err.silent) return;
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
    if(e.code===4401){
      sessionStorage.removeItem(AUTH_KEY);
      authHash=null;
      showInit();
      return;
    }
    if(e.code===4003){
      sessionStorage.removeItem(AUTH_KEY);
      authHash=null;
      showLogin("Session expired. Please sign in again.");
      return;
    }
    if(e.code===1012){
      // Server reset — clear session and show init screen
      sessionStorage.removeItem(AUTH_KEY);
      authHash=null;
      showInit();
      return;
    }
    setStatus("disconnected","Disconnected");
    if(authHash) scheduleReconnect();
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
      addEntry(data.isNew?"create":"upload",(data.deviceName||"Device")+" synced "+data.fileId.substring(0,8)+"... ("+fmtSize(data.size)+")");
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
    .then(function(res){
      if(!res.ok) return res.json().then(function(d){throw new Error(d.error||"Revoke failed");});
      return res.json();
    })
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
fetchInitStatus().then(function(s){
  if(!s || !s.initialized){
    showInit();
    var pollInit=setInterval(function(){
      fetchInitStatus().then(function(s2){
        if(s2 && s2.initialized){
          clearInterval(pollInit);
          showLogin();
        }
      });
    }, 2000);
    return;
  }

  var stored=sessionStorage.getItem(AUTH_KEY);
  if(stored){
    // Validate stored hash against the server before trusting it
    fetch("/api/ui-auth", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({passwordHash:stored})
    }).then(function(res){
      if(res.ok){
        authHash=stored;
        loginOverlay.classList.add("hidden");
        initDashboard();
      } else {
        sessionStorage.removeItem(AUTH_KEY);
        showLogin();
      }
    }).catch(function(){
      sessionStorage.removeItem(AUTH_KEY);
      showLogin();
    });
  } else {
    showLogin();
  }
});

})();
