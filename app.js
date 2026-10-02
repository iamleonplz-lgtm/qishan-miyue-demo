import { auth, db } from "./firebase.js";
import {
  GoogleAuthProvider, onAuthStateChanged, signInAnonymously, signInWithPopup, signInWithRedirect,
  signOut, getRedirectResult
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  addDoc, collection, doc, getDoc, onSnapshot, query, serverTimestamp,
  setDoc, updateDoc, where, Timestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const OPS = [
  { code: "circumcision", name: "包皮手術" },
  { code: "vasectomy", name: "輸精管結紮" },
  { code: "steam", name: "攝護腺水蒸氣消融" },
  { code: "other", name: "其他自費門診手術（依醫師說明）" }
];
const STATUS = {
  new: "新開立",
  preop: "術前準備",
  postop: "術後追蹤",
  closed: "追蹤結束"
};
const RED_FLAGS = ["血塊", "尿不出來", "尿管不通", "發燒", "寒顫", "劇痛", "很喘", "意識不清"];
const ROSTER = ["曾淑芬", "尤政仁", "黃冠霖", "張道安"];
const PHOTO_MAX = 6;
const SEEN_KEY = "miyue.seen.v1";
const PHOTO_KEY = "miyue.localphotos.v1";

const appEl = document.getElementById("app");
const whoEl = document.getElementById("who");
const casebarEl = document.getElementById("casebar");
let user = null;
let role = "";
let doctorProfile = null;
let doctorCases = [];
let patientItems = [];
let caseCache = {};
let msgCache = {};
let unsubDoctor = null;
let unsubPatient = null;
let unsubCase = null;
let unsubMsgs = null;
let listeningCase = "";
let pendingSend = null;
let emerMode = "";
let emerReturn = null;
let lbReturn = null;
let authReady = false;

function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return "&#"+c.charCodeAt(0)+";";});}
function opName(code) {
  const hit = OPS.filter(function (o) { return o.code === code; })[0];
  return hit ? hit.name : "依醫師說明";
}
function statusName(code) {
  return STATUS[code] || "新開立";
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { el.hidden = true; }, 2200);
}
function fmtTime(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    calendar: "gregory",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(d);
  const g = function (t) { return (parts.find(function (p) { return p.type === t; }) || {}).value || ""; };
  return g("year") + "/" + g("month") + "/" + g("day") + " " + g("hour") + ":" + g("minute");
}
function sensitive(s) {
  return /[A-Za-z][12]\d{8}/.test(s) || /09\d{8}/.test(s) || /\d{8,}/.test(s);
}
function hasRedFlag(s) {
  return RED_FLAGS.some(function (w) { return String(s || "").indexOf(w) >= 0; });
}
function normToken(raw) {
  const s = String(raw || "").toUpperCase().replace(/[^A-Z2-9]/g, "").replace(/[01OI]/g, "");
  if (s.length < 10) return "";
  if (s.length === 12) return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8);
  return s;
}
function extractToken(raw) {
  const text = String(raw || "").trim();
  let token = text;
  const hashInvite = text.indexOf("#i/");
  const hashOld = text.indexOf("#invite/");
  if (hashInvite >= 0) token = decodeURIComponent(text.slice(hashInvite + 3).split(/[?#\s]/)[0]);
  else if (hashOld >= 0) token = decodeURIComponent(text.slice(hashOld + 8).split(/[/?#\s]/)[0]);
  else {
    const found = text.match(/[?&]i=([^&#\s]+)/);
    if (found) token = decodeURIComponent(found[1]);
  }
  return normToken(token);
}
function genToken() {
  const ch = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < 12; i++) s += ch[buf[i] % ch.length];
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8);
}
function pageUrl() {
  const u = new URL(location.href);
  u.search = "";
  u.hash = "";
  if (u.pathname.endsWith("/index.html")) u.pathname = u.pathname.slice(0, -"/index.html".length);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.toString();
}
function inviteLink(token) {
  return pageUrl() + "#i/" + encodeURIComponent(token);
}
function hashNow() {
  return (location.hash || "").replace(/^#/, "");
}
function go(h, replace) {
  const next = h || "";
  if (hashNow() === next) { render(); return; }
  if (replace) location.replace("#" + next);
  else location.hash = next;
}
function clearInviteUrl() {
  const u = new URL(location.href);
  u.searchParams.delete("i");
  u.searchParams.delete("p");
  history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
}
function replaceToCase(caseId) {
  const u = new URL(location.href);
  u.searchParams.delete("i");
  u.searchParams.delete("p");
  u.hash = "case/" + caseId;
  history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
}
function readIncomingToken() {
  if (!/#i\/|#invite\/|[?&]i=/.test(location.href)) return "";
  return extractToken(location.href);
}
function seenMap() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch (e) { return {}; }
}
function markSeen(id) {
  const m = seenMap();
  m[id] = Date.now();
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)); } catch (e) {}
}
function hasNew(c) {
  if (!c || !c.lastPatientMsgAt || !c.lastPatientMsgAt.toDate) return false;
  const seen = seenMap()[c.id] || 0;
  return c.lastPatientMsgAt.toDate().getTime() > seen;
}
function photoMap() {
  try { return JSON.parse(localStorage.getItem(PHOTO_KEY) || "{}"); } catch (e) { return {}; }
}
function photosOf(id) {
  return photoMap()[id] || [];
}
function savePhoto(id, dataUrl) {
  const all = photoMap();
  const list = all[id] || [];
  if (list.length >= PHOTO_MAX) return false;
  list.push(dataUrl);
  all[id] = list;
  try {
    localStorage.setItem(PHOTO_KEY, JSON.stringify(all));
    return true;
  } catch (e) {
    toast("這支手機空間不足，照片沒有存下");
    return false;
  }
}
function showEmergency(mode, trigger) {
  emerMode = mode || "view";
  emerReturn = trigger || document.activeElement;
  const box = document.getElementById("emergency");
  box.className = "lb on";
  document.getElementById("ackok").hidden = emerMode !== "ack";
  document.getElementById("stillSend").hidden = emerMode !== "send";
  document.getElementById("emerClose").hidden = emerMode === "ack";
  const focus = emerMode === "ack" ? "ackok" : "emerClose";
  setTimeout(function () { const b = document.getElementById(focus); if (b) b.focus(); }, 30);
}
function hideEmergency() {
  document.getElementById("emergency").className = "lb";
  document.getElementById("ackok").hidden = true;
  document.getElementById("stillSend").hidden = true;
  document.getElementById("emerClose").hidden = false;
}
function emerBlock() {
  return '<div class="warn emer"><strong>【緊急狀況　請不要等 APP 回覆】</strong><br>出現以下任一情形，請直接到急診，或打 <a href="tel:119">119</a>，或旗山醫院總機 <a href="tel:076613811">07-6613811</a> 轉急診：<br>・大量血尿或有血塊<br>・尿不出來，或尿管不通<br>・發燒或寒顫<br>・劇烈腰痛或腹痛<br>・傷口大量滲血<br>・意識不清或喘<br>APP 訊息不保證即時有人回覆，也不能取代看診。緊急時不要等 APP 回覆。<br>本提示不是診斷，也不是治療建議。<div class="emer-actions"><a class="btn" href="tel:119">打 119</a><a class="btn" href="tel:076613811">打總機 07-6613811</a></div></div>';
}
function setCaseBar(html) {
  if (!html) {
    casebarEl.className = "casebar";
    casebarEl.innerHTML = "";
  } else {
    casebarEl.className = "casebar on";
    casebarEl.innerHTML = html;
  }
  const h = document.getElementById("stick").offsetHeight || 72;
  appEl.style.paddingTop = (h + 12) + "px";
}
function dock(html) {
  const old = document.getElementById("dock");
  if (old) old.remove();
  if (!html) return;
  const d = document.createElement("div");
  d.id = "dock";
  d.className = "dock";
  d.innerHTML = html;
  document.body.appendChild(d);
}
function bindLift() {
  [].forEach.call(document.querySelectorAll("input,select,textarea"), function (el) {
    if (el.type === "file") return;
    el.addEventListener("focus", function () {
      setTimeout(function () {
        try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { el.scrollIntoView(false); }
      }, 320);
    });
  });
}
function scrollThread() {
  const th = document.querySelector(".thread");
  if (th) th.scrollTop = th.scrollHeight;
}
function qrDataUrl(text) {
  try {
    const maker = window.qrcode;
    if (!maker) return "";
    const qr = maker(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createDataURL(6, 8);
  } catch (e) {
    return "";
  }
}
function stopCaseListen() {
  if (unsubCase) unsubCase();
  if (unsubMsgs) unsubMsgs();
  unsubCase = null;
  unsubMsgs = null;
  listeningCase = "";
}
function listenDoctor() {
  if (unsubDoctor || !user) return;
  unsubDoctor = onSnapshot(query(collection(db, "cases"), where("ownerUid", "==", user.uid)), function (snap) {
    doctorCases = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    doctorCases.sort(function (a, b) {
      const ta = (a.lastPatientMsgAt && a.lastPatientMsgAt.toDate) ? a.lastPatientMsgAt.toDate().getTime() : 0;
      const tb = (b.lastPatientMsgAt && b.lastPatientMsgAt.toDate) ? b.lastPatientMsgAt.toDate().getTime() : 0;
      return tb - ta;
    });
    if (hashNow() === "" || hashNow() === "dash") render();
  }, function () { toast("案件清單讀取失敗"); });
}
function listenPatient() {
  if (unsubPatient || !user) return;
  unsubPatient = onSnapshot(collection(db, "patientIndex", user.uid, "items"), function (snap) {
    patientItems = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    if (hashNow() === "" || hashNow() === "dash") render();
  }, function () { toast("我的手術讀取失敗"); });
}
function ensureCaseListen(id) {
  if (listeningCase === id) return;
  stopCaseListen();
  listeningCase = id;
  unsubCase = onSnapshot(doc(db, "cases", id), function (snap) {
    if (!snap.exists()) { delete caseCache[id]; }
    else caseCache[id] = Object.assign({ id: snap.id }, snap.data());
    if (hashNow().indexOf("case/" + id) === 0 || hashNow().indexOf("qr/" + id) === 0) render();
  }, function () {
    appEl.innerHTML = '<div class="warn">沒有此案件權限，或網路中斷。</div>';
  });
  unsubMsgs = onSnapshot(query(collection(db, "cases", id, "messages")), function (snap) {
    const rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    rows.sort(function (a, b) {
      const ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
      const tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
      return ta - tb;
    });
    msgCache[id] = rows;
    if (hashNow().indexOf("case/" + id) !== 0) return;
    const typing = document.activeElement && (document.activeElement.id === "msg" || document.activeElement.id === "np" || document.activeElement.id === "pname");
    const thread = document.querySelector(".thread");
    if (typing && thread) {
      thread.innerHTML = threadHtml(id);
      scrollThread();
      return;
    }
    render();
  }, function () {
    appEl.innerHTML = '<div class="warn">沒有此案件權限，或網路中斷。</div>';
  });
}
async function ensureAnon() {
  if (user && user.isAnonymous) return user;
  if (user && !user.isAnonymous) throw new Error("doctor-session");
  const cred = await signInAnonymously(auth);
  user = cred.user;
  role = "patient";
  return user;
}
async function joinToken(token, alias) {
  token = extractToken(token);
  alias = String(alias || "").trim();
  if (!token) throw new Error("找不到這組邀請碼，請掃 QR 或貼上醫師給的完整連結");
  if (!alias || alias.length > 10) throw new Error("請填化名，最多 10 字。");
  if (sensitive(alias)) throw new Error("請勿填身分證、電話或長串數字。");
  const u = await ensureAnon();
  const invSnap = await getDoc(doc(db, "invites", token));
  if (!invSnap.exists()) throw new Error("找不到這組邀請碼，請掃 QR 或貼上醫師給的完整連結");
  const inv = invSnap.data();
  const exp = inv.expiresAt && inv.expiresAt.toDate ? inv.expiresAt.toDate() : null;
  if (inv.revoked || !exp || exp.getTime() < Date.now()) throw new Error("邀請碼已作廢或已過期。");
  if (inv.oneTime && inv.used && inv.usedBy !== u.uid) throw new Error("這組邀請碼已使用。");
  const caseId = inv.caseId;
  const memberRef = doc(db, "cases", caseId, "members", u.uid);
  const memberSnap = await getDoc(memberRef);
  if (!memberSnap.exists()) {
    await setDoc(memberRef, { uid: u.uid, token: token, alias: alias, joinedAt: serverTimestamp() });
    replaceToCase(caseId);
    await setDoc(doc(db, "patientIndex", u.uid, "items", caseId), { caseId: caseId, token: token, joinedAt: serverTimestamp() });
    await updateDoc(doc(db, "cases", caseId), { hasMember: true });
    if (inv.oneTime && !inv.used) {
      try { await updateDoc(doc(db, "invites", token), { used: true, usedBy: u.uid, usedAt: serverTimestamp() }); } catch (e) {}
    }
  } else {
    replaceToCase(caseId);
  }
  const after = await getDoc(memberRef);
  if (!after.exists() || !after.data().noticeAckAt) {
    sessionStorage.setItem("ackCase", caseId);
    showEmergency("ack");
    return;
  }
  go("case/" + caseId, true);
}
async function ackNotice() {
  const caseId = sessionStorage.getItem("ackCase") || "";
  if (!user || !caseId) { hideEmergency(); return; }
  try {
    await updateDoc(doc(db, "cases", caseId, "members", user.uid), { noticeAckAt: serverTimestamp() });
  } catch (e) {
    toast("記錄失敗，請再按一次我了解");
    return;
  }
  sessionStorage.removeItem("ackCase");
  hideEmergency();
  go("case/" + caseId, true);
}
async function sendMessage(caseId, text) {
  text = String(text || "").trim();
  if (!text) return;
  if (text.length > 500) return toast("留言最多 500 字");
  if (sensitive(text) && !confirm("這段文字像是身分證、電話或長串數字。請勿傳送可識別資料。仍要送出？")) return;
  const fromRole = role === "doctor" ? "doc" : "pat";
  await addDoc(collection(db, "cases", caseId, "messages"), {
    fromRole: fromRole,
    fromUid: user.uid,
    text: text,
    createdAt: serverTimestamp()
  });
  if (fromRole === "pat") {
    try { await updateDoc(doc(db, "cases", caseId), { lastPatientMsgAt: serverTimestamp() }); } catch (e) {}
  }
}
function compressImage(file, done) {
  if (!file) return toast("請選照片");
  const r = new FileReader();
  r.onerror = function () { toast("讀取失敗，請改用 JPG"); };
  r.onload = function () {
    const img = new Image();
    img.onload = function () {
      let w = img.width || 800, h = img.height || 600, max = 960;
      if (w > max || h > max) {
        const k = Math.min(max / w, max / h);
        w = Math.round(w * k);
        h = Math.round(h * k);
      }
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      done(cv.toDataURL("image/jpeg", 0.68));
    };
    img.onerror = function () { toast("此檔無法顯示，請改存 JPG"); };
    img.src = r.result;
  };
  r.readAsDataURL(file);
}
function threadHtml(id) {
  const msgs = msgCache[id] || [];
  const mine = role === "doctor" ? "doc" : "pat";
  if (!msgs.length) return '<p class="muted">還沒有留言。</p>';
  return msgs.map(function (m) {
    const me = m.fromRole === mine;
    return '<div class="bubble' + (me ? " me" : "") + '"><div class="meta">' + (m.fromRole === "doc" ? "醫師" : "病人") + "　" + esc(fmtTime(m.createdAt)) + "</div>" + esc(m.text || "") +
      (role === "patient" && m.fromRole === "pat" ? '<div class="sentnote">已送出。APP 訊息不保證即時有人回覆，緊急時請直接到急診。</div>' : "") + "</div>";
  }).join("");
}
function exportText(c, msgs) {
  const lines = [
    "泌約文字紀錄（不含照片）",
    "化名：" + (c.alias || ""),
    "術式：" + opName(c.opCode),
    "狀態：" + statusName(c.status),
    ""
  ];
  (msgs || []).forEach(function (m) {
    lines.push("[" + fmtTime(m.createdAt) + "] " + (m.fromRole === "doc" ? "醫師" : "病人"));
    lines.push(m.text || "");
    lines.push("");
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "miyue-note.txt";
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
}
function copyText(t) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).then(function () { toast("已複製"); }, function () { fallbackCopy(t); });
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const box = document.getElementById("copybox");
  if (!box) return toast("請長按複製");
  box.value = t;
  box.focus();
  box.select();
  try { document.execCommand("copy"); toast("已複製"); } catch (e) { toast("請長按複製"); }
}

function renderHome(pending) {
  document.body.className = "";
  setCaseBar("");
  dock("");
  appEl.innerHTML = emerBlock() +
    '<div class="card"><h1>病人／家屬</h1><p>請填化名（例如：陳先生），請勿填真實全名、身分證、病歷號或電話。</p>' +
    '<form id="joinform"><label for="icode">邀請碼</label><input id="icode" maxlength="300" value="' + esc(pending) + '" placeholder="例如 ABCD-EFGH-JKLM" autocapitalize="characters" autocomplete="off" enterkeyhint="next">' +
    '<label for="pname">怎麼稱呼您（請填化名，例如：病人A、陳先生）</label><input id="pname" maxlength="10" placeholder="陳先生" autocomplete="off" enterkeyhint="done" required>' +
    '<button type="submit" class="btn block">用邀請碼進入</button></form></div>' +
    '<div class="card"><h2>旗山泌尿科醫師</h2><p>名單依院方白名單：' + esc(ROSTER.join("、")) + '。請用 Google 帳號登入，不能自行註冊。</p>' +
    '<button type="button" class="btn block" id="glogin">醫師 Google 登入</button></div>' +
    (navigator.onLine ? "" : '<div class="warn">目前沒有網路。邀請碼與留言需要網路。緊急按鈕不需要網路。</div>') +
    '<div class="kb"></div>';
  document.getElementById("joinform").onsubmit = function (ev) {
    ev.preventDefault();
    const alias = document.getElementById("pname").value.trim();
    const token = document.getElementById("icode").value;
    if (!extractToken(token)) return toast("找不到這組邀請碼，請掃 QR 或貼上醫師給的完整連結");
    if (!alias) return toast("請填化名");
    joinToken(token, alias).catch(function (err) {
      toast(err && err.message === "doctor-session" ? "請先登出醫師帳號" : (err.message || "無法加入"));
    });
  };
  document.getElementById("glogin").onclick = function () { doctorLogin(); };
  bindLift();
}

function renderPendingDoctor() {
  document.body.className = "role-doctor";
  setCaseBar("");
  dock('<button type="button" class="btn ghost" id="out">登出</button>');
  appEl.innerHTML = '<h1>尚未加入醫師白名單</h1><div class="card"><p>請把下面這組 uid 交給設定人員，寫進 Firestore 的 doctors 集合後再登入。</p><p><strong>' + esc(user.uid) + '</strong></p><button type="button" class="btn block" id="copyuid">複製 uid</button></div>';
  document.getElementById("copyuid").onclick = function () { copyText(user.uid); };
  document.getElementById("out").onclick = doLogout;
}

function renderDoctorDash() {
  document.body.className = "role-doctor";
  setCaseBar("");
  const tab = sessionStorage.getItem("miyueTab") || "active";
  const active = doctorCases.filter(function (c) { return !c.archived && c.status !== "closed"; });
  const closed = doctorCases.filter(function (c) { return !c.archived && c.status === "closed"; });
  const archived = doctorCases.filter(function (c) { return !!c.archived; });
  const shown = tab === "closed" ? closed : tab === "arch" ? archived : active;
  appEl.innerHTML = '<div class="ok">旗山泌尿科　' + esc(doctorProfile.name || "醫師") + ' 醫師工作台</div><h1>我的案件</h1>' +
    '<div class="tabs"><button type="button" class="btn' + (tab !== "active" ? " ghost" : "") + '" id="tabA">進行中 ' + active.length + '</button>' +
    '<button type="button" class="btn' + (tab !== "closed" ? " ghost" : "") + '" id="tabC">追蹤結束 ' + closed.length + '</button>' +
    '<button type="button" class="btn' + (tab !== "arch" ? " ghost" : "") + '" id="tabR">封存 ' + archived.length + '</button></div>' +
    (tab === "active" ? '<button type="button" class="btn block" id="newc">新開案件並產生邀請碼</button>' : "") +
    (shown.length ? shown.map(function (c) {
      return '<div class="card' + (c.status === "closed" || c.archived ? " done" : "") + '"><div><strong>' + esc(c.alias) + '</strong> <span class="badge' + (c.status === "closed" ? " done" : "") + '">' + esc(statusName(c.status)) + '</span> ' +
        (hasNew(c) ? '<span class="badge newmsg">有新留言</span>' : "") + (c.hasMember ? ' <span class="badge">病人已加入</span>' : "") +
        '</div><div>' + esc(opName(c.opCode)) + '</div><div class="muted">邀請碼 ' + esc(c.activeInvite || "") + '</div>' +
        '<button type="button" class="btn block" data-open="' + esc(c.id) + '">打開檢視</button>' +
        '<button type="button" class="btn ghost block" data-qr="' + esc(c.id) + '">給病人邀請碼</button>' +
        (c.archived ? '<button type="button" class="btn ghost block" data-unarch="' + esc(c.id) + '">復原封存</button>' : '<button type="button" class="btn ghost block" data-arch="' + esc(c.id) + '">封存</button>') +
        '</div>';
    }).join("") : '<div class="card muted">這個分頁沒有案件。</div>');
  dock('<button type="button" class="btn ghost" id="out">登出</button>');
  document.getElementById("tabA").onclick = function () { sessionStorage.setItem("miyueTab", "active"); render(); };
  document.getElementById("tabC").onclick = function () { sessionStorage.setItem("miyueTab", "closed"); render(); };
  document.getElementById("tabR").onclick = function () { sessionStorage.setItem("miyueTab", "arch"); render(); };
  const neu = document.getElementById("newc");
  if (neu) neu.onclick = function () { go("new"); };
  document.getElementById("out").onclick = doLogout;
  [].forEach.call(document.querySelectorAll("[data-open]"), function (el) { el.onclick = function () { go("case/" + el.getAttribute("data-open")); }; });
  [].forEach.call(document.querySelectorAll("[data-qr]"), function (el) { el.onclick = function () { go("qr/" + el.getAttribute("data-qr")); }; });
  [].forEach.call(document.querySelectorAll("[data-arch]"), function (el) {
    el.onclick = function () { updateDoc(doc(db, "cases", el.getAttribute("data-arch")), { archived: true, updatedAt: serverTimestamp() }).then(function () { toast("已封存，可復原"); }); };
  });
  [].forEach.call(document.querySelectorAll("[data-unarch]"), function (el) {
    el.onclick = function () { updateDoc(doc(db, "cases", el.getAttribute("data-unarch")), { archived: false, updatedAt: serverTimestamp() }).then(function () { toast("已復原"); }); };
  });
}

function renderNew() {
  document.body.className = "role-doctor";
  setCaseBar("");
  appEl.innerHTML = '<h1>開新案並產生邀請碼</h1><div class="card"><form id="newform"><label for="np">病人稱呼（請填化名，例如：病人A、陳先生）</label><input id="np" maxlength="10" placeholder="陳先生" required><label for="nop">術式</label><select id="nop">' +
    OPS.map(function (o) { return '<option value="' + esc(o.code) + '">' + esc(o.name) + "</option>"; }).join("") +
    '</select><button type="submit" class="btn block">產生邀請碼</button></form></div><div class="kb"></div>';
  dock('<button type="button" class="btn" id="back">回上一層</button><button type="button" class="btn ghost" id="out">登出</button>');
  document.getElementById("back").onclick = function () { go("dash"); };
  document.getElementById("out").onclick = doLogout;
  document.getElementById("newform").onsubmit = function (ev) {
    ev.preventDefault();
    const alias = document.getElementById("np").value.trim();
    const opCode = document.getElementById("nop").value;
    if (!alias) return toast("請填化名");
    if (alias.length > 10) return toast("化名最多 10 字");
    if (sensitive(alias)) return toast("請勿填身分證、電話或長串數字");
    const caseRef = doc(collection(db, "cases"));
    const token = genToken();
    const name = ((doctorProfile && doctorProfile.name) || "醫師").slice(0, 20);
    setDoc(caseRef, {
      ownerUid: user.uid,
      ownerName: name,
      opCode: opCode,
      status: "new",
      prevStatus: "new",
      alias: alias,
      archived: false,
      hasMember: false,
      activeInvite: token,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }).then(function () {
      return setDoc(doc(db, "invites", token), {
        caseId: caseRef.id,
        ownerUid: user.uid,
        expiresAt: Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 3600 * 1000)),
        revoked: false,
        used: false,
        oneTime: false,
        createdAt: serverTimestamp()
      });
    }).then(function () { go("qr/" + caseRef.id, true); }).catch(function () { toast("開案失敗，請確認白名單與規則已發布"); });
  };
  bindLift();
}

function renderQr(id) {
  document.body.className = "role-doctor";
  const c = caseCache[id] || doctorCases.filter(function (x) { return x.id === id; })[0];
  if (!c || c.ownerUid !== user.uid) {
    appEl.innerHTML = '<div class="warn">只有開案醫師可以發邀請碼。</div>';
    return;
  }
  ensureCaseListen(id);
  const link = inviteLink(c.activeInvite || "");
  const img = qrDataUrl(link);
  setCaseBar("");
  appEl.innerHTML = '<h1>給病人的邀請碼</h1><div class="card" style="text-align:center"><div class="muted">' + esc(c.alias) + "　" + esc(opName(c.opCode)) + '</div><div class="code">' + esc(c.activeInvite || "") + '</div>' +
    (img ? '<img class="qr" alt="病人加入用 QR code" src="' + img + '">' : '<p class="warn">QR 產生失敗，請改複製完整連結。</p>') +
    '<p class="muted">請讓病人用相機掃這個 QR，或傳送完整連結。只傳邀請碼時，另一支手機也能加入。邀請碼 7 天內有效，可作廢或重發。連結只含邀請碼，不含病人資料。</p>' +
    '<label for="copybox">病人連結</label><input id="copybox" readonly value="' + esc(link) + '">' +
    '<button type="button" class="btn block" id="copycode">複製邀請碼</button><button type="button" class="btn block" id="copylink">複製完整連結</button>' +
    '<button type="button" class="btn ghost block" id="once">' + (c.oneTime ? "已設一次性" : "設為一次性") + '</button>' +
    '<button type="button" class="btn ghost block" id="reissue">作廢並重發</button></div>';
  dock('<button type="button" class="btn" id="back">回上一層</button><button type="button" class="btn ghost" id="out">登出</button>');
  document.getElementById("back").onclick = function () { go("case/" + id); };
  document.getElementById("out").onclick = doLogout;
  document.getElementById("copycode").onclick = function () { copyText(c.activeInvite || ""); };
  document.getElementById("copylink").onclick = function () { copyText(link); };
  document.getElementById("once").onclick = function () {
    if (!c.activeInvite) return;
    const patch = { oneTime: true };
    if (c.hasMember) patch.used = true;
    updateDoc(doc(db, "invites", c.activeInvite), patch).then(function () {
      toast(c.hasMember ? "已設為一次性，其他人不能再用" : "已設為一次性");
    });
  };
  document.getElementById("reissue").onclick = function () {
    const token = genToken();
    const old = c.activeInvite;
    setDoc(doc(db, "invites", token), {
      caseId: id,
      ownerUid: user.uid,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 3600 * 1000)),
      revoked: false,
      used: false,
      oneTime: false,
      createdAt: serverTimestamp()
    }).then(function () {
      const jobs = [updateDoc(doc(db, "cases", id), { activeInvite: token, updatedAt: serverTimestamp() })];
      if (old) jobs.push(updateDoc(doc(db, "invites", old), { revoked: true }));
      return Promise.all(jobs);
    }).then(function () { toast("已重發"); }).catch(function () { toast("重發失敗"); });
  };
}

function renderCase(id) {
  const c = caseCache[id];
  ensureCaseListen(id);
  if (!c) {
    setCaseBar("");
    appEl.innerHTML = '<div class="card muted">讀取案件中…</div>';
    dock('<button type="button" class="btn" id="back">回上一層</button>');
    document.getElementById("back").onclick = function () { go(role === "doctor" ? "dash" : ""); };
    return;
  }
  if (role === "doctor") markSeen(id);
  document.body.className = role === "doctor" ? "role-doctor" : "";
  const msgs = msgCache[id] || [];
  setCaseBar('<div class="lbl">手術名稱</div><div class="op">' + esc(opName(c.opCode)) + '</div><div class="meta">' + esc((c.ownerName || "醫師") + " 醫師") + "　｜　" + esc(statusName(c.status)) + "</div>");
  const photos = photosOf(id);
  const mine = role === "doctor" ? "doc" : "pat";
  appEl.innerHTML = (role === "patient" ? emerBlock() + '<button type="button" class="btn ghost block" id="sos2">我有緊急狀況</button>' : "") +
    (role === "doctor" ? '<p class="muted">病人 ' + esc(c.alias) + "　｜　邀請碼 " + esc(c.activeInvite || "") + '</p><button type="button" class="btn block" id="give">給病人邀請碼／QR</button><label for="st">狀態</label><select id="st">' +
      Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (c.status === k ? " selected" : "") + ">" + esc(STATUS[k]) + "</option>"; }).join("") +
      '</select><button type="button" class="btn ghost block" id="saveSt">儲存狀態</button>' +
      (c.status === "closed" ? '<button type="button" class="btn ghost block" id="restore">恢復原本狀態</button>' : "") +
      '<button type="button" class="btn ghost block" id="arch">' + (c.archived ? "復原封存" : "封存") + "</button>" : "") +
    '<div class="card"><div class="thread" tabindex="0" aria-label="留言">' + threadHtml(id) +
    '</div><form id="msgform"><label for="msg">' + (role === "doctor" ? "回覆病人" : "一般問題留言") + '</label><textarea id="msg" maxlength="500" placeholder="' + (role === "doctor" ? "回覆病人" : "一般問題留言（緊急狀況請直接到急診）") + '"></textarea><button type="submit" class="btn block">送出文字</button></form></div>' +
    '<div class="card"><h2>這支手機上的照片</h2><p class="muted">照片只存在這支手機，不會傳給醫師，也不會上傳。照片僅供您自己留存，不會即時判讀。出血或尿不出來請直接到急診。請勿拍身分證或健保卡。每案最多 ' + PHOTO_MAX + ' 張。</p><div class="photos">' +
    (photos.map(function (src, i) { return '<button type="button" data-big="' + i + '"><img src="' + src + '" alt="這支手機留存的照片 ' + (i + 1) + '"></button>'; }).join("") || '<span class="muted">尚未留存照片</span>') +
    '</div><label class="btn block filebtn">從相簿選照片<input id="lib" type="file" accept="image/*"></label><label class="btn ghost block filebtn">拍照<input id="cam" type="file" accept="image/*" capture="environment"></label></div>' +
    '<button type="button" class="btn ghost block" id="exp">匯出文字紀錄</button><div class="kb"></div>';
  dock('<button type="button" class="btn" id="back">回上一層</button><button type="button" class="btn ghost" id="out">登出</button>');
  document.getElementById("back").onclick = function () { go(role === "doctor" ? "dash" : ""); };
  document.getElementById("out").onclick = doLogout;
  const give = document.getElementById("give");
  if (give) give.onclick = function () { go("qr/" + id); };
  const saveSt = document.getElementById("saveSt");
  if (saveSt) saveSt.onclick = function () {
    const next = document.getElementById("st").value;
    const patch = { status: next, updatedAt: serverTimestamp(), prevStatus: c.prevStatus || c.status };
    if (next === "closed" && c.status !== "closed") patch.prevStatus = c.status;
    updateDoc(doc(db, "cases", id), patch).then(function () { toast("狀態已更新"); }).catch(function () { toast("狀態更新失敗"); });
  };
  const restore = document.getElementById("restore");
  if (restore) restore.onclick = function () {
    const back = c.prevStatus && c.prevStatus !== "closed" ? c.prevStatus : "postop";
    updateDoc(doc(db, "cases", id), { status: back, prevStatus: back, updatedAt: serverTimestamp() }).then(function () { toast("已恢復為" + statusName(back)); }).catch(function () { toast("恢復失敗"); });
  };
  const arch = document.getElementById("arch");
  if (arch) arch.onclick = function () {
    updateDoc(doc(db, "cases", id), { archived: !c.archived, updatedAt: serverTimestamp() }).then(function () { toast(c.archived ? "已復原" : "已封存，可復原"); });
  };
  document.getElementById("msgform").onsubmit = function (ev) {
    ev.preventDefault();
    const text = document.getElementById("msg").value.trim();
    if (!text) return;
    if (role === "patient" && hasRedFlag(text)) {
      pendingSend = { id: id, text: text };
      showEmergency("send", document.getElementById("msg"));
      return;
    }
    sendMessage(id, text).then(function () { toast("已送出"); }).catch(function () { toast("送出失敗"); });
  };
  const sos2 = document.getElementById("sos2");
  if (sos2) sos2.onclick = function () { showEmergency("view", sos2); };
  document.getElementById("exp").onclick = function () { exportText(c, msgs); };
  function onPick(input) {
    input.addEventListener("change", function () {
      const f = input.files && input.files[0];
      input.value = "";
      if (!f) return;
      if (photosOf(id).length >= PHOTO_MAX) return toast("每案最多 " + PHOTO_MAX + " 張");
      toast("只存在這支手機，不會傳出");
      compressImage(f, function (dataUrl) {
        if (savePhoto(id, dataUrl)) render();
      });
    });
  }
  onPick(document.getElementById("lib"));
  onPick(document.getElementById("cam"));
  [].forEach.call(document.querySelectorAll("[data-big]"), function (btn) {
    btn.onclick = function () {
      lbReturn = btn;
      const img = document.getElementById("lbimg");
      img.src = photosOf(id)[Number(btn.getAttribute("data-big"))] || "";
      img.alt = "這支手機留存的照片";
      document.getElementById("lightbox").className = "lb on";
      document.getElementById("lbx").focus();
    };
  });
  bindLift();
  scrollThread();
}

function renderPatientDash() {
  document.body.className = "";
  setCaseBar("");
  const cards = patientItems.map(function (item) {
    const c = caseCache[item.id];
    if (!c) getDoc(doc(db, "cases", item.id)).then(function (snap) {
      if (snap.exists()) caseCache[snap.id] = Object.assign({ id: snap.id }, snap.data());
      if (hashNow() === "" || hashNow() === "dash") render();
    }).catch(function () {});
    return '<div class="card"><div class="muted">手術名稱</div><div class="opname">' + esc(c ? opName(c.opCode) : "讀取中") + '</div><p>' + esc(c ? (c.ownerName || "醫師") + " 醫師" : "") + '　｜　<span class="badge">' + esc(c ? statusName(c.status) : "") + '</span></p><button type="button" class="btn block" data-open="' + esc(item.id) + '">進入溝通</button></div>';
  }).join("");
  appEl.innerHTML = emerBlock() + '<div class="ok">' + esc("病人") + '</div><h1>我的手術</h1>' +
    (cards || '<div class="card muted">還沒有加入的手術。請用醫師給您的邀請碼加入。</div>') +
    '<div class="card"><h2>用邀請碼加入</h2><form id="joinform"><label for="code">邀請碼</label><input id="code" maxlength="300" placeholder="ABCD-EFGH-JKLM" autocapitalize="characters" autocomplete="off"><label for="pname">怎麼稱呼您（請填化名，例如：病人A、陳先生）</label><input id="pname" maxlength="10" placeholder="陳先生" required><button type="submit" class="btn block">加入</button></form></div><div class="kb"></div>';
  dock('<button type="button" class="btn ghost" id="out">登出</button>');
  document.getElementById("out").onclick = function () {
    if (!confirm("再次進入需重新使用邀請連結。這支手機的匿名身分登出後會換新，舊的一次性邀請碼不能再加入。")) return;
    doLogout();
  };
  document.getElementById("joinform").onsubmit = function (ev) {
    ev.preventDefault();
    const token = document.getElementById("code").value;
    const alias = document.getElementById("pname").value.trim();
    if (!extractToken(token)) return toast("找不到這組邀請碼，請掃 QR 或貼上醫師給的完整連結");
    joinToken(token, alias).catch(function (err) { toast(err.message || "無法加入"); });
  };
  [].forEach.call(document.querySelectorAll("[data-open]"), function (el) {
    el.onclick = function () { go("case/" + el.getAttribute("data-open")); };
  });
  bindLift();
}

function doctorLogin() {
  const provider = new GoogleAuthProvider();
  signInWithPopup(auth, provider).catch(function (err) {
    const code = (err && err.code) || "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      toast("登入視窗已關閉");
      return;
    }
    signInWithRedirect(auth, provider).catch(function () { toast("Google 登入沒有完成"); });
  });
}
function doLogout() {
  stopCaseListen();
  if (unsubDoctor) unsubDoctor();
  if (unsubPatient) unsubPatient();
  unsubDoctor = null;
  unsubPatient = null;
  doctorCases = [];
  patientItems = [];
  signOut(auth).then(function () { go("", true); });
}

function render() {
  if (!authReady) {
    appEl.innerHTML = '<div class="card muted">載入中…</div>';
    return;
  }
  const hash = hashNow();
  const incoming = readIncomingToken();
  whoEl.textContent = role === "doctor" ? ((doctorProfile && doctorProfile.name) || "醫師") + " 醫師" : (role === "patient" ? "病人" : "");
  document.getElementById("home").onclick = function () { go(role === "doctor" ? "dash" : ""); };
  if (role === "pending-doctor") { renderPendingDoctor(); return; }
  if (incoming && (hash.indexOf("i/") === 0 || hash.indexOf("invite/") === 0 || location.search.indexOf("i=") >= 0)) {
    if (role === "doctor") {
      appEl.innerHTML = '<div class="warn">您現在是醫師登入。請先登出，再用病人身分加入。</div>';
      dock('<button type="button" class="btn ghost" id="out">登出</button>');
      document.getElementById("out").onclick = doLogout;
      return;
    }
    if (!user) { renderHome(incoming); return; }
  }
  if (!user) { renderHome(incoming); return; }
  if (role === "doctor") {
    if (hash === "new") return renderNew();
    if (hash.indexOf("qr/") === 0) return renderQr(hash.split("/")[1]);
    if (hash.indexOf("case/") === 0) return renderCase(hash.split("/")[1]);
    if (hash !== "dash") return go("dash", true);
    return renderDoctorDash();
  }
  if (hash.indexOf("case/") === 0) return renderCase(hash.split("/")[1]);
  if (hash.indexOf("i/") === 0 || hash.indexOf("invite/") === 0) { renderHome(incoming); return; }
  renderPatientDash();
}

document.getElementById("ackok").onclick = function () { ackNotice(); };
document.getElementById("stillSend").onclick = function () {
  const job = pendingSend;
  pendingSend = null;
  hideEmergency();
  if (!job) return;
  sendMessage(job.id, job.text).then(function () { toast("已送出"); }).catch(function () { toast("送出失敗"); });
};
document.getElementById("lbx").onclick = function () {
  document.getElementById("lightbox").className = "lb";
  if (lbReturn) lbReturn.focus();
};
document.addEventListener("keydown", function (ev) {
  if (ev.key !== "Escape") return;
  const emer = document.getElementById("emergency");
  if (emer.className.indexOf("on") >= 0) {
    const ack = document.getElementById("ackok");
    if (ack && !ack.hidden) return;
    hideEmergency();
    if (emerReturn && emerReturn.focus) emerReturn.focus();
    return;
  }
  const lb = document.getElementById("lightbox");
  if (lb.className.indexOf("on") >= 0) {
    lb.className = "lb";
    if (lbReturn) lbReturn.focus();
  }
});
document.getElementById("sos").addEventListener("click", function (ev) {
  emerMode = "view";
  emerReturn = ev.currentTarget;
});
document.getElementById("emerClose").addEventListener("click", function () {
  if (emerReturn && emerReturn.focus) emerReturn.focus();
});
window.addEventListener("hashchange", function () { stopCaseListen(); render(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", function () {
    const gap = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
    document.body.style.paddingBottom = gap ? (gap + 16) + "px" : "";
  });
}
if (location.search.indexOf("p=") >= 0) {
  const cleaned = new URL(location.href);
  cleaned.searchParams.delete("p");
  history.replaceState(null, "", cleaned.pathname + (cleaned.search || "") + cleaned.hash);
}
getRedirectResult(auth).catch(function () { toast("Google 登入沒有完成"); });
onAuthStateChanged(auth, function (u) {
  user = u;
  authReady = true;
  if (!u) {
    role = "";
    doctorProfile = null;
    render();
    return;
  }
  if (u.isAnonymous) {
    role = "patient";
    doctorProfile = null;
    listenPatient();
    render();
    return;
  }
  getDoc(doc(db, "doctors", u.uid)).then(function (snap) {
    if (snap.exists() && snap.data().active !== false) {
      role = "doctor";
      doctorProfile = snap.data();
      listenDoctor();
      if (!hashNow() || hashNow().indexOf("i/") === 0 || hashNow().indexOf("invite/") === 0) go("dash", true);
      else render();
    } else {
      role = "pending-doctor";
      render();
    }
  }).catch(function () {
    role = "pending-doctor";
    render();
  });
});
render();
