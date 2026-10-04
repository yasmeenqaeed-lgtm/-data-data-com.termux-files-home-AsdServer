/*
 * AsdServer System Upgrades 2026-10-04
 * Additive browser-side extension for the existing Secure Messenger UI.
 * Does not replace existing app.js functionality.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "sm_token";
  const USER_KEY = "sm_user";
  const LANG_KEY = "sm_language";

  let upgradeSocket = null;
  let unreadMap = new Map();
  let knownMessageIds = new Set();
  let notificationIds = new Set();
  let lastNotificationCount = 0;
  let capabilityTimer = null;
  let unreadTimer = null;
  let notificationsTimer = null;
  let locationWatchId = null;
  let emergencyStopButton = null;
  let mapInstance = null;
  let mapMarkers = [];
  let recording = false;

  const user = () => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null") || {};
    } catch (_) {
      return {};
    }
  };

  const token = () => localStorage.getItem(TOKEN_KEY) || "";

  const isAdmin = () => {
    const u = user();
    return Boolean(u.is_admin === 1 || u.role === "admin" || u.role === "system_manager");
  };

  async function api(path, options = {}) {
    if (typeof window.api === "function") {
      return window.api(path, options);
    }

    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (options.body && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    if (token()) headers.set("Authorization", `Bearer ${token()}`);

    const response = await fetch(path, { ...options, headers });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
    if (!response.ok) {
      const error = new Error(data.message || data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function nowText(value) {
    if (!value) return "—";
    try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
  }

  function injectStyle() {
    if ($("system-upgrades-style")) return;
    const style = document.createElement("style");
    style.id = "system-upgrades-style";
    style.textContent = `
      .sm-upgrade-toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      .sm-upgrade-btn{border:1px solid rgba(0,160,255,.35);background:rgba(255,255,255,.96);color:#14324a;border-radius:9px;padding:7px 11px;font:600 12px Tahoma,Arial,sans-serif;cursor:pointer;box-shadow:0 2px 9px rgba(0,0,0,.06)}
      .sm-upgrade-btn:hover{transform:translateY(-1px)}
      .sm-upgrade-btn.danger{border-color:rgba(210,30,30,.4);color:#9c1818}
      .sm-upgrade-badge{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:#d71920;color:#fff;font:bold 10px Tahoma,Arial,sans-serif;margin-inline-start:6px;vertical-align:middle;box-shadow:0 0 0 2px rgba(255,255,255,.85)}
      .sm-report-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:10px 0}
      .sm-report-card{border:1px solid #dbe4ec;border-radius:12px;padding:13px;background:#f8fbfd;text-align:center}
      .sm-report-card strong{display:block;font-size:23px;margin-top:4px}
      .sm-report-actions{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}
      .sm-upgrade-table{width:100%;border-collapse:collapse;font-size:12px;background:#fff}
      .sm-upgrade-table th,.sm-upgrade-table td{border:1px solid #e0e6eb;padding:7px;text-align:right;vertical-align:top}
      .sm-upgrade-table th{background:#eef5fa;white-space:nowrap}
      .sm-pre{white-space:pre-wrap;word-break:break-word;max-height:430px;overflow:auto;background:#f7f9fb;color:#17212b;padding:11px;border-radius:10px;font-size:11px}
      .sm-map{width:100%;height:420px;border-radius:12px;overflow:hidden;border:1px solid #d7e0e7;background:#eef3f6}
      .sm-list{display:grid;gap:7px;max-height:430px;overflow:auto}
      .sm-list-item{border:1px solid #e1e7ec;border-radius:10px;padding:9px;background:#fff}
      .sm-list-item b{display:block;margin-bottom:3px}
      .sm-voice-grid{display:grid;gap:9px}
      .sm-voice-actions{display:flex;flex-wrap:wrap;gap:7px}
      .sm-status{padding:9px;border-radius:10px;background:#f1f7fb;border:1px solid #dbe7ef;margin:7px 0;font-size:12px}
      .sm-violation{background:#fff7f7!important;border-color:#efcaca!important}
      .sm-language-wrap{margin:9px 0 2px}
      .sm-language-wrap label{display:block;font-size:12px;margin-bottom:4px}
      .sm-language-select{width:100%;padding:9px 10px;border:1px solid #cfd9e2;border-radius:9px;background:#fff;font:500 13px Tahoma,Arial,sans-serif}
      .sm-emergency-stop{font-size:13px!important;font-weight:800!important;padding:7px 13px!important;border:2px solid #a71515!important;background:#fff!important;color:#a71515!important;border-radius:10px!important;cursor:pointer!important;box-shadow:0 2px 9px rgba(150,0,0,.14)!important}
      @media(max-width:700px){.sm-map{height:330px}.sm-upgrade-btn{font-size:11px;padding:6px 8px}.sm-report-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  function findTopContainer() {
    return document.querySelector(".topbar") || document.querySelector("header") || document.querySelector(".app-header") || document.body;
  }

  function addToolbarButton(id, label, handler, extraClass = "") {
    if ($(id)) return $(id);
    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className = `sm-upgrade-btn ${extraClass}`.trim();
    button.innerHTML = label;
    button.addEventListener("click", handler);

    const top = findTopContainer();
    let toolbar = top.querySelector?.(".sm-upgrade-toolbar");
    if (!toolbar) {
      toolbar = document.createElement("div");
      toolbar.className = "sm-upgrade-toolbar";
      toolbar.style.marginInline = "8px";
      toolbar.style.marginBlock = "5px";
      if (top === document.body) {
        toolbar.style.position = "fixed";
        toolbar.style.top = "8px";
        toolbar.style.left = "8px";
        toolbar.style.right = "8px";
        toolbar.style.zIndex = "9998";
        toolbar.style.justifyContent = "flex-end";
        document.body.appendChild(toolbar);
      } else {
        top.appendChild(toolbar);
      }
    }
    toolbar.appendChild(button);
    return button;
  }

  function show(title, body) {
    if (typeof window.showModal === "function") {
      window.showModal(title, body);
      return null;
    }

    let modal = $("system-upgrades-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "system-upgrades-modal";
      modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.56);z-index:30000;display:flex;align-items:center;justify-content:center;padding:18px";
      document.body.appendChild(modal);
    }
    modal.innerHTML = `<div style="width:min(1050px,100%);max-height:92vh;overflow:auto;background:#fff;color:#18222c;border-radius:16px;box-shadow:0 20px 80px rgba(0,0,0,.32);padding:16px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px"><h3 style="margin:0">${escapeHtml(title)}</h3><button type="button" id="smFallbackClose" style="border:0;background:#eee;border-radius:8px;padding:7px 10px;cursor:pointer">✕</button></div><div id="smFallbackBody">${body}</div></div>`;
    $("smFallbackClose")?.addEventListener("click", () => modal.remove());
    return modal;
  }

  function getLanguage() {
    return localStorage.getItem(LANG_KEY) || "ar";
  }

  function applyLoginLanguage() {
    const form = $("loginForm");
    if (!form) return;

    let wrap = $("smLanguageWrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "smLanguageWrap";
      wrap.className = "sm-language-wrap";
      const password = $("loginPassword")?.closest?.(".input-group") || $("loginPassword")?.parentElement || form.firstElementChild;
      if (password?.parentNode) password.parentNode.insertBefore(wrap, password.nextSibling);
      else form.appendChild(wrap);
    }

    wrap.innerHTML = `
      <label for="smLanguage">${getLanguage() === "en" ? "Language" : "اللغة"}</label>
      <select id="smLanguage" class="sm-language-select" aria-label="Language">
        <option value="ar">العربية</option>
        <option value="en">English</option>
      </select>`;

    const select = $("smLanguage");
    if (select) {
      select.value = getLanguage();
      select.addEventListener("change", () => {
        const lang = select.value === "en" ? "en" : "ar";
        localStorage.setItem(LANG_KEY, lang);
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
        translateLogin(lang);
      });
    }

    document.documentElement.lang = getLanguage();
    document.documentElement.dir = getLanguage() === "en" ? "ltr" : "rtl";
    translateLogin(getLanguage());
  }

  function translateLogin(lang) {
    const en = lang === "en";
    const userLabel = document.querySelector('label[for="loginUsername"]');
    const passLabel = document.querySelector('label[for="loginPassword"]');
    const userInput = $("loginUsername");
    const passInput = $("loginPassword");
    const error = $("loginError");
    const loginButtonText = document.querySelector('#loginForm .login-button span');
    const notice = document.querySelector('#loginForm .notice.blue');

    if (userLabel) userLabel.innerHTML = `<i class="fa-solid fa-user"></i> ${en ? "Username" : "اسم المستخدم"}`;
    if (passLabel) passLabel.innerHTML = `<i class="fa-solid fa-lock"></i> ${en ? "Password" : "كلمة المرور"}`;
    if (userInput) userInput.placeholder = en ? "Enter username" : "أدخل اسم المستخدم";
    if (passInput) passInput.placeholder = en ? "Enter password" : "أدخل كلمة المرور";
    if (loginButtonText) loginButtonText.textContent = en ? "Secure Login" : "دخول آمن";
    if (notice) notice.innerHTML = `<i class="fa-solid fa-shield-halved"></i> ${en ? "Secure system login" : "تسجيل الدخول الآمن للنظام"}`;
    if (error?.dataset?.upgradeDefault === "1") error.textContent = "";
  }

  function primeAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = window.__smUpgradeAudioContext || new Ctx();
      window.__smUpgradeAudioContext = ctx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch (_) {}
  }

  function ring() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = window.__smUpgradeAudioContext || new Ctx();
      window.__smUpgradeAudioContext = ctx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      const start = ctx.currentTime;
      [0, 0.24, 0.48].forEach((offset, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(index % 2 ? 660 : 880, start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.06, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + offset);
        osc.stop(start + offset + 0.2);
      });
    } catch (_) {}
  }

  async function sendCapabilityUpdate(payload) {
    if (!token()) return;
    try {
      await api("/api/system/capabilities", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    } catch (error) {
      if (error?.status === 403) {
        showFreezeMessage(error.message || "تم تجميد الحساب.");
      }
    }
  }

  function showFreezeMessage(message) {
    const existing = $("smFrozenOverlay");
    if (existing) return;
    const overlay = document.createElement("div");
    overlay.id = "smFrozenOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:40000;background:rgba(90,0,0,.96);display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:#fff";
    overlay.innerHTML = `<div style="max-width:520px;border:2px solid #fff;border-radius:18px;padding:28px;background:rgba(0,0,0,.22)"><div style="font-size:54px">⛔</div><h2>الحساب مجمّد</h2><p style="font-size:16px;line-height:1.8">${escapeHtml(message)}</p><button id="smFrozenReload" class="sm-upgrade-btn" type="button">العودة إلى تسجيل الدخول</button></div>`;
    document.body.appendChild(overlay);
    $("smFrozenReload")?.addEventListener("click", () => window.location.reload());
  }

  async function checkCapabilitiesOnce() {
    if (!token()) return;

    if (navigator.permissions?.query) {
      try {
        const gpsPermission = await navigator.permissions.query({ name: "geolocation" });
        await sendCapabilityUpdate({ gps_status: gpsPermission.state === "denied" ? "denied" : gpsPermission.state === "granted" ? "active" : "unknown" });
      } catch (_) {}
      try {
        const micPermission = await navigator.permissions.query({ name: "microphone" });
        await sendCapabilityUpdate({ microphone_status: micPermission.state === "denied" ? "denied" : micPermission.state === "granted" ? "active" : "unknown" });
      } catch (_) {}
    }

    if (!navigator.geolocation) {
      await sendCapabilityUpdate({ gps_status: "unavailable" });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        await sendCapabilityUpdate({ gps_status: "active" });
        try {
          await api("/api/location", {
            method: "POST",
            body: JSON.stringify({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              captured_at: new Date().toISOString()
            })
          });
        } catch (error) {
          if (error?.status === 403) showFreezeMessage(error.message || "تم تجميد الحساب.");
        }
      },
      async (error) => {
        const status = error?.code === 1 ? "denied" : "unavailable";
        await sendCapabilityUpdate({ gps_status: status });
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  }

  function startLocationWatch() {
    if (!token() || !navigator.geolocation || locationWatchId !== null) return;
    locationWatchId = navigator.geolocation.watchPosition(
      async (position) => {
        await sendCapabilityUpdate({ gps_status: "active" });
        try {
          await api("/api/location", {
            method: "POST",
            body: JSON.stringify({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              captured_at: new Date().toISOString()
            })
          });
        } catch (error) {
          if (error?.status === 403) showFreezeMessage(error.message || "تم تجميد الحساب.");
        }
      },
      async (error) => {
        const status = error?.code === 1 ? "denied" : "unavailable";
        await sendCapabilityUpdate({ gps_status: status });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  function refreshUnreadBadges() {
    const rows = document.querySelectorAll(".user-item,.user-row,[data-user-id],#usersList>div");
    rows.forEach((row) => {
      const text = (row.textContent || "").toLowerCase();
      let count = 0;
      for (const item of unreadMap.values()) {
        const name = String(item.name || "").toLowerCase();
        const username = String(item.username || "").toLowerCase();
        if ((name && text.includes(name)) || (username && text.includes(username))) {
          count = Math.max(count, Number(item.count || 0));
        }
      }
      const old = row.querySelector?.(".sm-unread-badge");
      if (old) old.remove();
      if (count > 0) {
        const badge = document.createElement("span");
        badge.className = "sm-unread-badge";
        badge.textContent = count > 99 ? "99+" : String(count);
        row.appendChild(badge);
      }
    });
  }

  async function loadUnread() {
    if (!token()) return;
    try {
      const data = await api("/api/messages/unread-summary");
      unreadMap.clear();
      const rows = Array.isArray(data.by_sender) ? data.by_sender : [];
      for (const row of rows) {
        unreadMap.set(String(row.sender_id), { sender_id: row.sender_id, count: row.count });
      }

      // Enrich badges with names from the current user list or cached API response.
      try {
        const usersData = await api("/api/users");
        const users = Array.isArray(usersData) ? usersData : (usersData.users || []);
        users.forEach((u) => {
          const item = unreadMap.get(String(u.id));
          if (item) Object.assign(item, { name: u.name || u.nickname || "", username: u.username || "" });
        });
      } catch (_) {}

      refreshUnreadBadges();
    } catch (error) {
      if (error?.status === 403) showFreezeMessage(error.message || "تم تجميد الحساب.");
    }
  }

  function attachUserClickReadHandler() {
    document.addEventListener("click", async (event) => {
      const row = event.target?.closest?.(".user-item,.user-row,[data-user-id],#usersList>div");
      if (!row) return;
      const direct = row.getAttribute("data-user-id");
      let senderId = direct ? Number(direct) : 0;
      if (!senderId) {
        const text = (row.textContent || "").toLowerCase();
        for (const item of unreadMap.values()) {
          if ((item.name && text.includes(String(item.name).toLowerCase())) || (item.username && text.includes(String(item.username).toLowerCase()))) {
            senderId = Number(item.sender_id);
            break;
          }
        }
      }
      if (!Number.isInteger(senderId) || senderId <= 0) return;
      try {
        await api(`/api/messages/${senderId}/read`, { method: "POST" });
        unreadMap.delete(String(senderId));
        refreshUnreadBadges();
      } catch (_) {}
    }, true);
  }

  function connectUpgradeSocket() {
    if (!token() || typeof window.io !== "function") return;
    if (upgradeSocket && (upgradeSocket.connected || upgradeSocket.connecting)) return;

    try {
      upgradeSocket = window.io({
        auth: { token: token() },
        transports: ["websocket", "polling"]
      });

      upgradeSocket.on("connect", () => {
        const u = user();
        if (Number.isInteger(Number(u.id))) {
          // Compatible with older server socket authentication and with newer token middleware.
          upgradeSocket.emit("authenticate", { user_id: Number(u.id) });
        }
      });

      const onIncoming = (message) => {
        if (!message) return;
        const id = Number(message.id || 0);
        if (id && knownMessageIds.has(id)) return;
        if (id) knownMessageIds.add(id);
        const me = Number(user().id || 0);
        if (Number(message.sender_id) === me) return;
        ring();
        loadUnread();
      };

      upgradeSocket.on("new_message", onIncoming);
      upgradeSocket.on("broadcast_message", onIncoming);
      upgradeSocket.on("system_notification", (notification) => {
        ring();
        showNotificationToast(notification);
        loadNotifications(true);
      });
    } catch (_) {}
  }

  function showNotificationToast(notification) {
    if (!notification) return;
    let box = $("smNotificationToast");
    if (!box) {
      box = document.createElement("div");
      box.id = "smNotificationToast";
      box.style.cssText = "position:fixed;top:12px;right:12px;z-index:35000;width:min(380px,calc(100% - 24px));background:#fff;border:1px solid #dfb3b3;border-radius:12px;box-shadow:0 15px 40px rgba(0,0,0,.18);padding:12px";
      document.body.appendChild(box);
    }
    box.innerHTML = `<b>🔔 ${escapeHtml(notification.title || "إشعار النظام")}</b><div style="margin-top:5px;font-size:12px;line-height:1.65">${escapeHtml(notification.body || "")}</div>`;
    setTimeout(() => box.remove(), 7000);
  }

  async function loadNotifications(forceRing = false) {
    if (!token() || !isAdmin()) return;
    try {
      const data = await api("/api/admin/system-notifications?unread=1");
      const rows = Array.isArray(data.notifications) ? data.notifications : [];
      const newRows = rows.filter(x => !notificationIds.has(Number(x.id)));
      if (forceRing || (newRows.length && lastNotificationCount !== rows.length)) ring();
      newRows.forEach(x => notificationIds.add(Number(x.id)));
      lastNotificationCount = rows.length;
      updateNotificationButton(rows.length);
    } catch (_) {}
  }

  function updateNotificationButton(count) {
    const button = $("systemNotificationsBtn");
    if (!button) return;
    const existing = button.querySelector(".sm-unread-badge");
    if (existing) existing.remove();
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "sm-unread-badge";
      badge.textContent = count > 99 ? "99+" : String(count);
      button.appendChild(badge);
    }
  }

  async function openNotifications() {
    if (!isAdmin()) return;
    try {
      const data = await api("/api/admin/system-notifications");
      const rows = Array.isArray(data.notifications) ? data.notifications : [];
      const body = rows.length ? `<div class="sm-list">${rows.map(x => `
        <div class="sm-list-item ${x.type === "violation" ? "sm-violation" : ""}">
          <b>${escapeHtml(x.title)}</b>
          <div style="font-size:12px;line-height:1.7">${escapeHtml(x.body)}</div>
          <small>${escapeHtml(nowText(x.created_at))}</small>
          <button class="sm-upgrade-btn" type="button" data-notification-id="${Number(x.id)}">تمت القراءة</button>
        </div>`).join("")}</div>` : "<div class='sm-status'>لا توجد إشعارات.</div>";
      show("إشعارات النظام والمخالفات", body);
      document.querySelectorAll("[data-notification-id]").forEach((button) => {
        button.addEventListener("click", async () => {
          try { await api(`/api/admin/system-notifications/${Number(button.dataset.notificationId)}/read`, { method: "POST" }); button.closest(".sm-list-item")?.remove(); }
          catch (_) {}
          loadNotifications();
        });
      });
    } catch (error) {
      show("إشعارات النظام", `<div class="sm-status">${escapeHtml(error.message)}</div>`);
    }
  }

  function reportTable(rows) {
    if (!Array.isArray(rows) || !rows.length) return "<div class='sm-status'>لا توجد بيانات.</div>";
    const columns = Object.keys(rows[0] || {}).slice(0, 14);
    return `<div style="overflow:auto;max-height:520px"><table class="sm-upgrade-table"><thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(c => `<td>${escapeHtml(typeof row[c] === "object" ? JSON.stringify(row[c]) : row[c])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function downloadText(filename, content, type = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toCsv(data) {
    if (!Array.isArray(data) || !data.length) return "";
    const columns = [...new Set(data.flatMap(x => Object.keys(x || {})))];
    const quote = (v) => `"${String(v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v).replaceAll('"', '""')}"`;
    return [columns.map(quote).join(","), ...data.map(row => columns.map(c => quote(row[c])).join(","))].join("\n");
  }

  async function openReports(initialType = "summary") {
    if (!isAdmin()) return;
    const types = [
      ["summary", "ملخص"],
      ["users", "المستخدمون"],
      ["messages", "الرسائل"],
      ["locations", "المواقع"],
      ["violations", "المخالفات"],
      ["audit", "سجل العمليات"],
      ["notifications", "الإشعارات"],
      ["full", "تقرير شامل"]
    ];

    show("التقارير", `
      <div class="sm-report-actions">
        <select id="smReportType" class="sm-language-select" style="max-width:190px">${types.map(([v,t]) => `<option value="${v}">${t}</option>`).join("")}</select>
        <input id="smReportFrom" type="date" class="sm-language-select" style="max-width:160px">
        <input id="smReportTo" type="date" class="sm-language-select" style="max-width:160px">
        <input id="smReportSearch" type="search" class="sm-language-select" style="max-width:220px" placeholder="بحث">
        <button id="smRunReport" class="sm-upgrade-btn" type="button">عرض التقرير</button>
        <button id="smPrintReport" class="sm-upgrade-btn" type="button">طباعة</button>
        <button id="smDownloadReport" class="sm-upgrade-btn" type="button">تنزيل CSV/JSON</button>
      </div>
      <div id="smReportStatus" class="sm-status">جارٍ تحميل التقرير...</div>
      <div id="smReportData"></div>
    `);

    $("smReportType").value = initialType;

    let lastData = null;
    async function runReport() {
      const type = $("smReportType")?.value || "summary";
      const qs = new URLSearchParams({ type });
      if ($("smReportFrom")?.value) qs.set("from", $("smReportFrom").value);
      if ($("smReportTo")?.value) qs.set("to", $("smReportTo").value);
      if ($("smReportSearch")?.value.trim()) qs.set("search", $("smReportSearch").value.trim());
      try {
        const result = await api(`/api/admin/reports?${qs.toString()}`);
        lastData = result.data;
        const box = $("smReportData");
        const status = $("smReportStatus");
        if (type === "summary" && result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
          box.innerHTML = `<div class="sm-report-grid">${Object.entries(result.data).filter(([k]) => !["from","to"].includes(k)).map(([k,v]) => `<div class="sm-report-card"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`).join("")}</div>`;
        } else if (Array.isArray(result.data)) {
          box.innerHTML = reportTable(result.data);
        } else {
          box.innerHTML = `<pre class="sm-pre">${escapeHtml(JSON.stringify(result.data,null,2))}</pre>`;
        }
        status.textContent = `نوع التقرير: ${type}`;
      } catch (error) {
        lastData = null;
        $("smReportStatus").textContent = error.message || "تعذر تحميل التقرير.";
        $("smReportData").innerHTML = "";
      }
    }

    $("smRunReport")?.addEventListener("click", runReport);
    $("smPrintReport")?.addEventListener("click", () => window.print());
    $("smDownloadReport")?.addEventListener("click", () => {
      const type = $("smReportType")?.value || "report";
      if (Array.isArray(lastData)) downloadText(`asdserver-${type}-${Date.now()}.csv`, toCsv(lastData), "text/csv;charset=utf-8");
      else downloadText(`asdserver-${type}-${Date.now()}.json`, JSON.stringify(lastData || {}, null, 2), "application/json;charset=utf-8");
    });
    runReport();
  }

  async function loadLeaflet() {
    if (window.L) return true;
    try {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(css);
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
      return Boolean(window.L);
    } catch (_) {
      return false;
    }
  }

  async function openUserMap() {
    if (!isAdmin()) return;
    show("خريطة المستخدمين", `<div id="smMapStatus" class="sm-status">جارٍ تحميل مواقع المستخدمين...</div><div id="smMapCanvas" class="sm-map"></div><div id="smMapList" class="sm-list" style="margin-top:10px"></div>`);
    try {
      const result = await api("/api/admin/user-map");
      const rows = Array.isArray(result.users) ? result.users : [];
      const mapReady = await loadLeaflet();
      const mapBox = $("smMapCanvas");
      if (mapReady && mapBox) {
        mapInstance?.remove?.();
        mapMarkers.forEach(m => m.remove?.());
        mapMarkers = [];
        mapInstance = window.L.map(mapBox).setView([15.3694, 44.1910], 6);
        window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }).addTo(mapInstance);
        const bounds = [];
        rows.forEach(row => {
          const lat = Number(row.latitude);
          const lng = Number(row.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
          const marker = window.L.marker([lat,lng]).addTo(mapInstance);
          marker.bindPopup(`<b>${escapeHtml(row.name || row.username || "مستخدم")}</b><br>آخر تحديث: ${escapeHtml(nowText(row.last_update || row.captured_at))}<br>الدقة: ${escapeHtml(row.accuracy || "—")}`);
          mapMarkers.push(marker);
          bounds.push([lat,lng]);
        });
        if (bounds.length) mapInstance.fitBounds(bounds, { padding: [25,25], maxZoom: 14 });
        setTimeout(() => mapInstance?.invalidateSize?.(), 80);
      } else if (mapBox) {
        mapBox.innerHTML = `<div style="padding:16px;text-align:center">الخريطة التفاعلية غير متاحة حالياً، لكن بيانات المواقع أدناه متاحة.</div>`;
      }
      $("smMapStatus").textContent = `عدد المستخدمين الذين شاركوا موقعاً: ${rows.length}`;
      $("smMapList").innerHTML = rows.length ? rows.map(row => `<div class="sm-list-item"><b>${escapeHtml(row.name || row.username || "مستخدم")}</b><div>اسم المستخدم: ${escapeHtml(row.username || "—")}</div><div>GPS: ${escapeHtml(row.gps_status || "unknown")}</div><div>آخر تحديث: ${escapeHtml(nowText(row.last_update || row.captured_at))}</div><div>الإحداثيات: ${escapeHtml(row.latitude)}, ${escapeHtml(row.longitude)}</div></div>`).join("") : `<div class="sm-status">لا توجد مواقع مشاركة حالياً.</div>`;
    } catch (error) {
      $("smMapStatus") && ($("smMapStatus").textContent = error.message || "تعذر تحميل الخريطة.");
    }
  }

  function normalizedFeatures(values) {
    const n = Math.hypot(...values);
    if (!Number.isFinite(n) || n <= 1e-9) throw new Error("تعذر استخراج بصمة صوتية صالحة.");
    return values.map(v => v / n);
  }

  function extractVoiceFeatures(audioBuffer) {
    const source = audioBuffer.getChannelData(0);
    const targetRate = 16000;
    const ratio = audioBuffer.sampleRate / targetRate;
    const targetLength = Math.min(Math.floor(source.length / ratio), targetRate * 3);
    const samples = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i += 1) samples[i] = source[Math.min(source.length - 1, Math.floor(i * ratio))];

    const features = [];
    const frameSize = 256;
    const frameCount = 8;
    for (let f = 0; f < frameCount; f += 1) {
      const start = Math.max(0, Math.min(samples.length - frameSize, Math.floor((samples.length - frameSize) * (f / Math.max(1, frameCount - 1)))));
      let sumSq = 0;
      let crossings = 0;
      let prev = samples[start] || 0;
      for (let i = 0; i < frameSize; i += 1) {
        const x = samples[start + i] || 0;
        sumSq += x * x;
        if ((prev < 0 && x >= 0) || (prev >= 0 && x < 0)) crossings += 1;
        prev = x;
      }
      const rms = Math.sqrt(sumSq / frameSize);

      let weighted = 0;
      let magnitudeTotal = 0;
      for (let k = 1; k <= 32; k += 1) {
        let real = 0;
        let imag = 0;
        const freq = (2 * Math.PI * k) / frameSize;
        for (let n = 0; n < frameSize; n += 1) {
          const x = samples[start + n] || 0;
          real += x * Math.cos(freq * n);
          imag -= x * Math.sin(freq * n);
        }
        const mag = Math.hypot(real, imag);
        magnitudeTotal += mag;
        weighted += k * mag;
      }
      const centroid = magnitudeTotal > 0 ? weighted / magnitudeTotal : 0;
      features.push(rms, crossings / frameSize, centroid / 32);
    }
    return normalizedFeatures(features);
  }

  async function recordVoiceBlob(durationMs = 1600) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error("تسجيل الصوت غير مدعوم في هذا المتصفح.");
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (error) {
      await sendCapabilityUpdate({ microphone_status: "denied" });
      throw new Error("تم رفض الوصول إلى الميكروفون أو تعذر استخدامه.");
    }

    await sendCapabilityUpdate({ microphone_status: "active" });

    const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    const mime = mimeCandidates.find(x => MediaRecorder.isTypeSupported?.(x)) || "";
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    const chunks = [];

    return new Promise((resolve, reject) => {
      let timer = null;
      recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = () => { clearTimeout(timer); stream.getTracks().forEach(t => t.stop()); reject(new Error("فشل تسجيل الصوت.")); };
      recorder.onstop = async () => {
        clearTimeout(timer);
        stream.getTracks().forEach(t => t.stop());
        try {
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const arrayBuffer = await blob.arrayBuffer();
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) throw new Error("محرك الصوت غير متاح.");
          const ctx = window.__smUpgradeAudioContext || new Ctx();
          window.__smUpgradeAudioContext = ctx;
          const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
          const features = extractVoiceFeatures(decoded);
          resolve({ blob, features, mime: recorder.mimeType || blob.type || "audio/webm" });
        } catch (error) {
          reject(new Error(error.message || "تعذر تحليل البصمة الصوتية."));
        }
      };
      try {
        recorder.start(250);
        recording = true;
        timer = setTimeout(() => {
          if (recorder.state === "recording") recorder.stop();
          recording = false;
        }, durationMs);
      } catch (error) {
        stream.getTracks().forEach(t => t.stop());
        reject(error);
      }
    });
  }

  async function testSpeaker() {
    try {
      primeAudio();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = window.__smUpgradeAudioContext || new Ctx();
        window.__smUpgradeAudioContext = ctx;
        if (ctx.state === "suspended") await ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 740;
        gain.gain.value = 0.05;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
        setTimeout(() => { try { osc.stop(); } catch (_) {} }, 260);
      }
      if ("speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(getLanguage() === "en" ? "Speaker test completed." : "تم اختبار السماعة بنجاح.");
        utterance.lang = getLanguage() === "en" ? "en-US" : "ar-SA";
        utterance.onend = () => sendCapabilityUpdate({ speaker_status: "active" });
        utterance.onerror = () => sendCapabilityUpdate({ speaker_status: "unavailable" });
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } else {
        await sendCapabilityUpdate({ speaker_status: "unavailable" });
      }
      return true;
    } catch (error) {
      await sendCapabilityUpdate({ speaker_status: "unavailable" });
      return false;
    }
  }

  function speak(text) {
    primeAudio();
    if (!("speechSynthesis" in window)) return false;
    const utterance = new SpeechSynthesisUtterance(String(text || ""));
    utterance.lang = getLanguage() === "en" ? "en-US" : "ar-SA";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return true;
  }

  async function enrollVoiceprint() {
    const status = $("smVoiceStatus");
    if (status) status.textContent = "سجل عبارة قصيرة وواضحة لمدة ثانية ونصف تقريباً...";
    try {
      const result = await recordVoiceBlob(1800);
      await api("/api/voiceprint/enroll", {
        method: "POST",
        body: JSON.stringify({ features: result.features })
      });
      await sendCapabilityUpdate({ voiceprint_status: "active" });
      if (status) status.textContent = "تم تسجيل البصمة الصوتية بنجاح.";
      speak(getLanguage() === "en" ? "Voice fingerprint enrolled." : "تم تسجيل البصمة الصوتية بنجاح.");
    } catch (error) {
      if (status) status.textContent = error.message || "تعذر تسجيل البصمة الصوتية.";
    }
  }

  async function verifyVoiceCommand(command) {
    const status = $("smVoiceStatus");
    try {
      const result = await recordVoiceBlob(1500);
      const verify = await api("/api/voiceprint/verify", {
        method: "POST",
        body: JSON.stringify({ features: result.features })
      });
      if (!verify.enrolled) throw new Error("سجّل بصمتك الصوتية أولاً.");
      if (!verify.verified) throw new Error(`البصمة غير مؤكدة. درجة التطابق: ${Number(verify.score || 0).toFixed(3)}`);
      if (status) status.textContent = `تم التحقق من البصمة (${Number(verify.score || 0).toFixed(3)}). تنفيذ الأمر...`;
      const action = await api("/api/voice-command", {
        method: "POST",
        body: JSON.stringify({ command, features: result.features, score: verify.score })
      });
      await executeVoiceAction(action.action);
    } catch (error) {
      if (status) status.textContent = error.message || "تعذر تنفيذ الأمر الصوتي.";
    }
  }

  async function executeVoiceAction(action) {
    const messages = {
      open_reports: "فتح التقارير.",
      open_user_map: "فتح خريطة المستخدمين.",
      open_violations: "فتح المخالفات.",
      speaker_test: "جارٍ اختبار السماعة.",
      emergency_stop: "تم إيقاف الطوارئ.",
      emergency_start: "تم تفعيل الطوارئ."
    };

    if (action === "open_reports") openReports();
    else if (action === "open_user_map") openUserMap();
    else if (action === "open_violations") openReports("violations");
    else if (action === "speaker_test") await testSpeaker();
    else if (["emergency_start", "emergency_stop"].includes(action)) {
      // Server already applies the persistent emergency state.
      if (action === "emergency_stop") {
        try { await api("/api/admin/emergency-stop", { method: "POST" }); } catch (_) {}
      }
    }
    speak(messages[action] || "تم تنفيذ الأمر.");
  }

  function startSpeechRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const status = $("smVoiceStatus");
    if (!Recognition) {
      if (status) status.textContent = "التعرف على الكلام غير متاح في هذا المتصفح. استخدم الأزرار الصوتية المتاحة.";
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    recognition.lang = getLanguage() === "en" ? "en-US" : "ar-SA";
    recognition.onstart = () => { if (status) status.textContent = "استمع... قل الأمر المطلوب."; };
    recognition.onerror = () => { if (status) status.textContent = "تعذر التعرف على الأمر الصوتي."; };
    recognition.onresult = async (event) => {
      const transcript = Array.from(event.results || []).map(x => x?.[0]?.transcript || "").join(" ").trim();
      if (!transcript) return;
      if (status) status.textContent = `الأمر: ${transcript}. جارٍ التحقق من البصمة...`;
      await verifyVoiceCommand(transcript);
    };
    recognition.start();
  }

  window.openVoiceSimulator = openVoiceSimulator;

  function openVoiceSimulator() {
    show("محاكي الصوت والبصمة الصوتية", `
      <div class="sm-voice-grid">
        <div class="sm-status">الميزة اختيارية بعد تسجيل الدخول. البصمة الصوتية لا تغيّر الصلاحيات ولا تستبدل تسجيل الدخول بكلمة المرور.</div>
        <div id="smVoiceStatus" class="sm-status">اختر وظيفة صوتية.</div>
        <div class="sm-voice-actions">
          <button id="smEnrollVoice" class="sm-upgrade-btn" type="button">🎙️ تسجيل البصمة</button>
          <button id="smRecognizeVoice" class="sm-upgrade-btn" type="button">🗣️ الاستماع للأمر</button>
          <button id="smSpeakerTest" class="sm-upgrade-btn" type="button">🔊 اختبار السماعة</button>
          <button id="smVoiceReports" class="sm-upgrade-btn" type="button">📊 التقارير</button>
          <button id="smVoiceMap" class="sm-upgrade-btn" type="button">🗺️ خريطة المستخدمين</button>
          <button id="smVoiceViolations" class="sm-upgrade-btn" type="button">⚠️ المخالفات</button>
          ${isAdmin() ? `<button id="smVoiceStopEmergency" class="sm-upgrade-btn danger" type="button">⛔ إيقاف الطوارئ</button>` : ""}
        </div>

        ${isAdmin() ? `
        <div class="sm-status" style="margin-top:12px;font-weight:700">
          البث الصوتي
        </div>

        <div id="smVoiceBroadcastPanel" class="sm-voice-actions">
          <button id="smBroadcastStart" class="sm-upgrade-btn" type="button">🎙️ بدء</button>
          <button id="smBroadcastStop" class="sm-upgrade-btn danger" type="button" disabled>⏹️ إيقاف وإرسال</button>
          <button id="smBroadcastSpeaker" class="sm-upgrade-btn" type="button">🔊 اختبار السماعة</button>
        </div>

        <input
          id="smBroadcastText"
          class="sm-language-select"
          value="بث صوتي من مدير النظام"
          maxlength="500"
          placeholder="وصف البث"
          style="width:100%;margin-top:8px"
        >

        <div id="smBroadcastStatus" class="sm-status" style="margin-top:8px">
          اضغط بدء التسجيل، ثم إيقاف وإرسال لبث المقطع للمستخدمين النشطين.
        </div>
        ` : ""}
        <div class="sm-status">أوامر صوتية مسموحة: التقارير، خريطة المستخدمين، المخالفات، اختبار السماعة، وإيقاف/تفعيل الطوارئ للمشرف فقط.</div>
      </div>
    `);

    $("smEnrollVoice")?.addEventListener("click", enrollVoiceprint);
    $("smRecognizeVoice")?.addEventListener("click", startSpeechRecognition);
    $("smSpeakerTest")?.addEventListener("click", testSpeaker);
    $("smVoiceReports")?.addEventListener("click", openReports);
    $("smVoiceMap")?.addEventListener("click", openUserMap);
    $("smVoiceViolations")?.addEventListener("click", () => openReports("violations"));

    if (isAdmin() && $("smVoiceBroadcastPanel")) {
      startAudioBroadcast();
    }
    $("smVoiceStopEmergency")?.addEventListener("click", async () => {
      try {
        await api("/api/admin/emergency-stop", { method: "POST" });
        speak("تم إيقاف الطوارئ.");
        if ($("smVoiceStatus")) $("smVoiceStatus").textContent = "تم إيقاف إنذار الطوارئ.";
      } catch (error) {
        if ($("smVoiceStatus")) $("smVoiceStatus").textContent = error.message || "تعذر إيقاف الطوارئ.";
      }
    });
  }

  async function startAudioBroadcast() {
    if (!isAdmin()) return;

    const inlineBroadcast = $("smVoiceBroadcastPanel");

    if (!inlineBroadcast) {
      show("البث الصوتي", `
      <div id="smBroadcastStatus" class="sm-status">اضغط بدء التسجيل، ثم إيقاف لإرسال المقطع للمستخدمين النشطين.</div>
      <div class="sm-voice-actions">
        <button id="smBroadcastStart" class="sm-upgrade-btn" type="button">🎙️ بدء</button>
        <button id="smBroadcastStop" class="sm-upgrade-btn danger" type="button" disabled>⏹️ إيقاف وإرسال</button>
        <button id="smBroadcastSpeaker" class="sm-upgrade-btn" type="button">🔊 اختبار السماعة</button>
      </div>
      <input id="smBroadcastText" class="sm-language-select" value="بث صوتي من مدير النظام" maxlength="500" placeholder="وصف البث">
      `);
    }

    const broadcastStatus = $("smBroadcastStatus");
    const broadcastStart = $("smBroadcastStart");
    const broadcastStop = $("smBroadcastStop");
    const broadcastSpeaker = $("smBroadcastSpeaker");
    const broadcastText = $("smBroadcastText");

    if (!broadcastStart || !broadcastStop) return;

    let recorder = null;
    let stream = null;
    let chunks = [];
    let timer = null;

    broadcastSpeaker?.addEventListener("click", testSpeaker);
    broadcastStart.addEventListener("click", async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        await sendCapabilityUpdate({ microphone_status: "active" });
        const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
        const mime = candidates.find(x => MediaRecorder.isTypeSupported?.(x)) || "";
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        chunks = [];
        recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
        recorder.start(250);
        recording = true;
        broadcastStart.disabled = true;
        broadcastStop.disabled = false;
        if (broadcastStatus) broadcastStatus.textContent = "جاري التسجيل...";
        timer = setTimeout(() => broadcastStop.click(), 15000);
      } catch (error) {
        await sendCapabilityUpdate({ microphone_status: "denied" });
        if (broadcastStatus) broadcastStatus.textContent = error.message || "تعذر الوصول إلى الميكروفون.";
      }
    });

    broadcastStop.addEventListener("click", async () => {
      clearTimeout(timer);
      if (!recorder || recorder.state !== "recording") return;
      recorder.onstop = async () => {
        recording = false;
        stream?.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        try {
          await api("/api/admin/audio-broadcast", {
            method: "POST",
            body: JSON.stringify({ audio_base64: dataUrl, mime_type: blob.type || "audio/webm", message: $("smBroadcastText")?.value || "بث صوتي من مدير النظام" })
          });
          if (broadcastStatus) broadcastStatus.textContent = "تم إرسال البث الصوتي.";
          ring();
        } catch (error) {
          if (broadcastStatus) broadcastStatus.textContent = error.message || "تعذر إرسال البث الصوتي.";
        }
      };
      recorder.stop();
      broadcastStart.disabled = false;
      broadcastStop.disabled = true;
      if (broadcastStatus) broadcastStatus.textContent = "جارٍ تجهيز المقطع وإرساله...";
    });
  }

  async function checkEmergencyState() {
    if (!token() || !isAdmin()) return;
    try {
      const data = await api("/api/alert-mode");
      installEmergencyStopButton(Boolean(data.alert_mode));
    } catch (_) {}
  }

  async function emergencyStop() {
    try {
      const data = await api("/api/admin/emergency-stop", { method: "POST" });
      installEmergencyStopButton(false);
      if (typeof window.adminStatus === "function") window.adminStatus(data.message || "تم إيقاف إنذار الطوارئ.", "orange");
      speak(getLanguage() === "en" ? "Emergency stopped." : "تم إيقاف إنذار الطوارئ.");
      // Also close common existing overlay ids without touching app.js code.
      ["emergencyOverlay","globalEmergencyBanner","emergencyBanner"].forEach(id => $(id)?.remove?.());
    } catch (error) {
      if (typeof window.adminStatus === "function") window.adminStatus(error.message || "تعذر إيقاف الطوارئ.", "red");
    }
  }

  function installEmergencyStopButton(active = false) {
    if (!isAdmin()) return;
    const existingOverlay = $("emergencyOverlay") || $("globalEmergencyBanner") || $("emergencyBanner");

    if (active) {
      if (!emergencyStopButton || !document.body.contains(emergencyStopButton)) {
        emergencyStopButton = document.createElement("button");
        emergencyStopButton.type = "button";
        emergencyStopButton.className = "sm-emergency-stop";
        emergencyStopButton.textContent = "⛔ إيقاف";
        emergencyStopButton.addEventListener("click", emergencyStop);
      }

      if (existingOverlay) {
        if (!existingOverlay.querySelector?.(".sm-emergency-stop")) existingOverlay.appendChild(emergencyStopButton);
      } else {
        const top = findTopContainer();
        if (!document.body.contains(emergencyStopButton)) top.appendChild(emergencyStopButton);
      }
    } else {
      emergencyStopButton?.remove?.();
    }
  }

  function observer() {
    const mo = new MutationObserver(() => {
      refreshUnreadBadges();
      if (isAdmin() && ($(/* emergency overlays */ "emergencyOverlay") || $("globalEmergencyBanner") || $("emergencyBanner"))) installEmergencyStopButton(true);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function installButtons() {
    addToolbarButton("systemReportsBtn", "📊 التقارير", openReports);
    addToolbarButton("userMapBtn", "🗺️ خريطة المستخدمين", openUserMap);
    // تم ربط المحاكي بالزر الرئيسي "محاكي الصوت والبصمة الصوتية".
        if (isAdmin()) {
      addToolbarButton("audioBroadcastBtn", "📡 البث الصوتي", startAudioBroadcast);
      const n = addToolbarButton("systemNotificationsBtn", "🔔 الإشعارات", openNotifications);
      n.dataset.ready = "1";
    }

    // Keep the explicit emergency stop control available in the same emergency screen when it appears.
    checkEmergencyState();
  }

  function startPolling() {
    if (!token()) return;
    checkCapabilitiesOnce();
    startLocationWatch();
    loadUnread();
    if (isAdmin()) loadNotifications();

    clearInterval(capabilityTimer);
    capabilityTimer = setInterval(checkCapabilitiesOnce, 30000);
    clearInterval(unreadTimer);
    unreadTimer = setInterval(loadUnread, 5000);
    clearInterval(notificationsTimer);
    if (isAdmin()) notificationsTimer = setInterval(() => loadNotifications(), 5000);
  }

  function boot() {
    injectStyle();
    applyLoginLanguage();
    installButtons();
    attachUserClickReadHandler();
    observer();
    primeAudio();

    document.addEventListener("click", primeAudio, { once: true, capture: true });

    const initialToken = Boolean(token());
    if (initialToken) {
      startPolling();
      connectUpgradeSocket();
    }

    // Login creates the token asynchronously; wait briefly and start add-ons without modifying login().
    let checks = 0;
    const waiter = setInterval(() => {
      checks += 1;
      if (token()) {
        clearInterval(waiter);
        installButtons();
        startPolling();
        connectUpgradeSocket();
      }
      if (checks > 60) clearInterval(waiter);
    }, 1000);
  }

  window.addEventListener("storage", () => {
    if (token()) {
      installButtons();
      startPolling();
      connectUpgradeSocket();
    }
  });

  document.addEventListener("DOMContentLoaded", boot);
})();
