



/*
  Secure Messenger V5.2
  app.js
  متوافق مع server.js الحالي الذي يعمل بـ Express + sql.js.
  لا يعتمد على Socket.IO أو WebSocket لأن الخادم الحالي REST فقط.
*/

(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  let token = localStorage.getItem("sm_token") || "";
  let me = null;
  let selectedUser = null;
  let selectedGroup = null;
  let selectedAdminUser = null;
  let onlineUsers = new Set();

  /* =======================================================
     SOCKET.IO / المزامنة الفورية لرسالة للجميع
  ======================================================= */

  let messengerSocket = null;

  function connectMessengerSocket() {
    if (
      typeof io !== "function" ||
      !me ||
      !me.id
    ) {
      return;
    }

    if (
      messengerSocket &&
      (
        messengerSocket.connected ||
        messengerSocket.connecting
      )
    ) {
      return;
    }

    try {
      messengerSocket = io();

      messengerSocket.on(
        "connect",
        () => {
          messengerSocket.emit(
            "authenticate",
            {
              user_id: Number(me.id)
            }
          );
        }
      );

      messengerSocket.on(
        "authenticated",
        () => {
          console.log(
            "[SOCKET] authenticated:",
            me.id
          );
        }
      );

      messengerSocket.on(
        "authentication_error",
        (data) => {
          console.warn(
            "[SOCKET] authentication error:",
            data?.message || "unknown"
          );
        }
      );

      messengerSocket.on(
        "broadcast_message",
        (broadcast) => {
          try {
            if (
              !broadcast ||
              !broadcast.message
            ) {
              return;
            }

            const incoming = {
              ...broadcast
            };

            window.messages =
              Array.isArray(window.messages)
                ? window.messages
                : [];

            const exists =
              incoming.id &&
              window.messages.some(
                message =>
                  Number(message.id) ===
                  Number(incoming.id)
              );

            if (!exists) {
              window.messages.push(
                incoming
              );
            }

            /*
             * إعادة تحميل المحادثة الحالية حتى تظهر
             * الرسالة في مكانها الطبيعي حسب الواجهة.
             */
            if (
              typeof renderMessages ===
              "function"
            ) {
              renderMessages();
            }

            console.log(
              "[SOCKET] broadcast received:",
              incoming.id
            );

          } catch (error) {
            console.warn(
              "[SOCKET] broadcast handling:",
              error.message
            );
          }
        }
      );

      messengerSocket.on(
        "disconnect",
        reason => {
          console.log(
            "[SOCKET] disconnected:",
            reason
          );
        }
      );

      messengerSocket.on(
        "connect_error",
        error => {
          console.warn(
            "[SOCKET] connection error:",
            error.message
          );
        }
      );

    } catch (error) {
      console.warn(
        "[SOCKET] initialization:",
        error.message
      );
    }
  }

  /* =======================================================
     EMERGENCY ALERT / نظام التنبيه والطوارئ
  ======================================================= */

  let alertModeState = false;
  let alertAudioContext = null;
  let alertOscillator = null;
  let alertGain = null;
  let alertTimer = null;



  /* =======================================================
     EMERGENCY ALERT / دوال التنبيه والطوارئ
  ======================================================= */

  function stopEmergencyAlert() {
    if (alertTimer) {
      clearInterval(alertTimer);
      alertTimer = null;
    }

    if (alertOscillator) {
      try {
        alertOscillator.stop();
      } catch (_) {}
      try {
        alertOscillator.disconnect();
      } catch (_) {}
      alertOscillator = null;
    }

    if (alertGain) {
      try {
        alertGain.disconnect();
      } catch (_) {}
      alertGain = null;
    }
  }

  function startEmergencyAlertSound() {
    try {
      const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContextClass) {
        console.warn("[ALERT] Web Audio غير مدعوم.");
        return;
      }

      stopEmergencyAlert();

      alertAudioContext =
        alertAudioContext ||
        new AudioContextClass();

      if (alertAudioContext.state === "suspended") {
        alertAudioContext.resume().catch(() => {});
      }

      alertOscillator =
        alertAudioContext.createOscillator();

      alertGain =
        alertAudioContext.createGain();

      alertOscillator.type = "square";
      alertOscillator.frequency.value = 880;
      alertGain.gain.value = 0.08;

      alertOscillator.connect(alertGain);
      alertGain.connect(alertAudioContext.destination);

      alertOscillator.start();

      let high = false;

      alertTimer = setInterval(() => {
        if (!alertOscillator || !alertAudioContext) {
          return;
        }

        high = !high;

        try {
          alertOscillator.frequency.setValueAtTime(
            high ? 880 : 620,
            alertAudioContext.currentTime
          );
        } catch (_) {}
      }, 500);

    } catch (error) {
      console.warn(
        "[ALERT] تعذر تشغيل صوت الإنذار:",
        error?.message || error
      );
    }
  }

  function showEmergencyAlert() {
    let overlay = $("emergencyAlertOverlay");

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "emergencyAlertOverlay";

      overlay.innerHTML = `
        <div style="
          width:min(92vw,520px);
          background:#160606;
          border:2px solid #ef4444;
          border-radius:18px;
          padding:28px 20px;
          text-align:center;
          box-shadow:0 0 35px rgba(239,68,68,.55);
        ">
          <div style="
            font-size:64px;
            color:#ef4444;
            margin-bottom:12px;
          ">
            <i class="fa-solid fa-triangle-exclamation"></i>
          </div>

          <h2 style="
            color:#fff;
            font-size:28px;
            margin:0 0 10px;
          ">
            تنبيه طوارئ
          </h2>

          <p style="
            color:#fecaca;
            font-size:18px;
            line-height:1.8;
            margin:0 0 20px;
          ">
            تم تفعيل حالة التأهب من قبل المشرف.
          </p>

          <button id="emergencyAlertAcknowledge"
            style="
              width:100%;
              padding:13px;
              border:0;
              border-radius:10px;
              background:#ef4444;
              color:#fff;
              font-weight:bold;
              font-size:16px;
              cursor:pointer;
            ">
            فهمت
          </button>
        </div>
      `;

      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "1000000",
        background: "rgba(0,0,0,.88)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
        direction: "rtl"
      });

      document.body.appendChild(overlay);

      $("emergencyAlertAcknowledge")
        ?.addEventListener("click", () => {
          if (alertAudioContext?.state === "suspended") {
            alertAudioContext.resume().catch(() => {});
          }
          stopEmergencyAlert();
        });
    }

    overlay.style.display = "flex";

    if (navigator.vibrate) {
      try {
        navigator.vibrate([700, 300, 700, 300, 1000]);
      } catch (_) {}
    }

    startEmergencyAlertSound();
  }

  function hideEmergencyAlert() {
    const overlay = $("emergencyAlertOverlay");

    if (overlay) {
      overlay.style.display = "none";
    }

    stopEmergencyAlert();
  }

  async function syncEmergencyAlert() {
    if (!token || !me || !me.id) {
      return;
    }

    try {
      const data =
        await api(
          "/api/alert-mode",
          {
            method: "GET",
            cache: "no-store"
          }
        );

      const enabled =
        data?.alert_mode === true;

      /*
       * عند فتح التطبيق لأول مرة:
       * نقرأ الحالة الحالية فقط بدون تشغيل
       * الإنذار تلقائيًا.
       */
      if (!syncEmergencyAlert.initialized) {
        syncEmergencyAlert.initialized = true;
        alertModeState = enabled;
        return;
      }

      /*
       * تشغيل الإنذار فقط عند انتقال الحالة
       * من إيقاف إلى تفعيل بعد بدء المراقبة.
       */
      if (enabled && !alertModeState) {
        alertModeState = true;
        showEmergencyAlert();
      } else if (!enabled && alertModeState) {
        alertModeState = false;
        hideEmergencyAlert();
      }
    } catch (error) {
      console.warn(
        "[ALERT] sync:",
        error?.message || error
      );
    }
  }

  /* =======================================================
     PRESENCE / حالة الاتصال الحقيقية
  ======================================================= */

  async function refreshOnlinePresence() {

    try {

      const response =
        await apiFetch(
          "/api/users"
        );

      if (!response.ok) {
        return;
      }

      const data =
        await response.json();

      if (
        Array.isArray(
          data.online_ids
        )
      ) {

        onlineUsers =
          new Set(
            data.online_ids.map(
              id => Number(id)
            )
          );

      } else if (
        Array.isArray(data.users)
      ) {

        onlineUsers =
          new Set(
            data.users
              .filter(
                user =>
                  user &&
                  user.online === true
              )
              .map(
                user =>
                  Number(user.id)
              )
          );
      }

      /*
       * إعادة رسم القائمة فقط إذا كانت
       * الدالة موجودة بالفعل في التطبيق.
       */
      if (
        typeof loadUsers === "function"
      ) {
        await loadUsers();
      }

      if (
        selectedUser &&
        $("chatStatus")
      ) {

        const selectedOnline =
          onlineUsers.has(
            Number(selectedUser.id)
          );

        $("chatStatus").textContent =
          selectedOnline
            ? "متصل الآن"
            : "غير متصل";

        $("chatStatus").style.color =
          selectedOnline
            ? "#facc15"
            : "#ef4444";
      }

    } catch (presenceError) {

      console.warn(
        "Presence refresh failed:",
        presenceError.message
      );
    }
  }

  let presenceRefreshTimer = null;

  function startPresenceRefresh() {

    if (presenceRefreshTimer) {
      clearInterval(
        presenceRefreshTimer
      );
    }

    /*
     * تحديث كل 20 ثانية.
     */
    presenceRefreshTimer =
      setInterval(
        refreshOnlinePresence,
        20000
      );

    refreshOnlinePresence();
  }

  let pollTimer = null;
  let bootRunning = false;
  let connectionCheckRunning = false;
  let mediaRecorder = null;
  let recordingStream = null;
  let audioChunks = [];

  window.messages = [];

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value ?? "";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[c]));
  }

  function dateText(value) {
    if (!value) return "";

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      return String(value);
    }

    return d.toLocaleString("ar-YE", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  async function api(url, options = {}) {
    const headers = {
      ...(options.headers || {})
    };

    if (
      options.body &&
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] =
        "application/json";
    }

    if (token) {
      headers.Authorization =
        "Bearer " + token;
    }

    const response = await fetch(url, {
      ...options,
      headers,
      cache: options.cache || "no-store"
    });

    let data = {};
    const contentType =
      response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch (_) {
        data = {};
      }
    } else {
      try {
        data = await response.text();
      } catch (_) {
        data = "";
      }
    }

    if (!response.ok) {
      if (response.status === 401) {
        clearSession(false);
      }

      const message =
        typeof data === "string"
          ? data
          : (
              data.message ||
              data.error ||
              "حدث خطأ في الخادم."
            );

      throw new Error(message);
    }

    return data;
  }

  function getCurrentUser() {
    return me;
  }

  function isAdmin() {
    return !!(
      me &&
      (
        me.is_admin === 1 ||
        me.is_admin === true ||
        me.role === "admin"
      )
    );
  }

  function ensureAdmin() {
    if (!isAdmin()) {
      alert(
        "هذه العملية متاحة للمشرف فقط."
      );
      return false;
    }

    return true;
  }

  function showLogin() {
    $("loginPage")?.classList.remove(
      "hidden"
    );

    $("appPage")?.classList.add(
      "hidden"
    );

    // منع ظهور نافذة الموقع أثناء تسجيل الدخول
    $("locationGate")?.classList.add(
      "hidden"
    );
  }

  function showApp() {
    $("loginPage")?.classList.add(
      "hidden"
    );

    $("appPage")?.classList.remove(
      "hidden"
    );
  }

  function adminStatus(
    message,
    type = "blue"
  ) {
    const el = $("adminStatus");

    if (!el) return;

    el.textContent = message || "";
    el.className = "notice " + type;
    el.classList.remove("hidden");
  }

  function connectionNotice(
    message,
    type = "blue"
  ) {
    const el =
      $("connectionNotice");

    if (!el) return;

    el.innerHTML = message || "";
    el.className = "notice " + type;
    el.classList.remove("hidden");
  }

  /* =======================================================
     نظام الرجوع للنوافذ والقوائم
     يحفظ محتوى النافذة السابقة بدون تعطيل وظائفها
  ======================================================= */

  const modalHistory = [];
  let restoringModalHistory = false;

  function showModal(
    titleOrHtml,
    bodyMaybe
  ) {
    const modal = $("modal");
    const title = $("modalTitle");
    const body = $("modalBody");

    if (!modal || !body) return;

    /*
     * إذا كانت هناك نافذة مفتوحة ويتم فتح قائمة جديدة،
     * نحفظ القائمة الحالية حتى يستطيع زر "عودة" الرجوع إليها.
     */
    if (
      !restoringModalHistory &&
      !modal.classList.contains("hidden")
    ) {
      modalHistory.push({
        title:
          title
            ? title.textContent
            : "نافذة النظام",

        body:
          body.innerHTML
      });
    }

    if (
      bodyMaybe === undefined
    ) {
      body.innerHTML =
        String(titleOrHtml ?? "");
    } else {
      if (title) {
        title.textContent =
          String(titleOrHtml ?? "");
      }

      body.innerHTML =
        String(bodyMaybe ?? "");
    }

    modal.classList.remove(
      "hidden"
    );

    updateModalBackButton();
  }


  function updateModalBackButton() {
    const backButton =
      $("backModal");

    if (!backButton) return;

    /*
     * إذا لا توجد قائمة سابقة،
     * يبقى الزر ظاهرًا ويقوم بالعودة للشاشة السابقة
     * عبر إغلاق النافذة الحالية.
     */
    backButton.style.visibility =
      "visible";
  }


  function goBackModal() {
    const modal = $("modal");
    const title = $("modalTitle");
    const body = $("modalBody");

    if (!modal || !body) return;

    /*
     * توجد نافذة سابقة:
     * استرجاعها.
     */
    if (modalHistory.length > 0) {

      const previous =
        modalHistory.pop();

      restoringModalHistory = true;

      if (title) {
        title.textContent =
          previous.title ||
          "نافذة النظام";
      }

      body.innerHTML =
        previous.body || "";

      restoringModalHistory = false;

      modal.classList.remove(
        "hidden"
      );

      updateModalBackButton();

      return;
    }

    /*
     * لا توجد نافذة سابقة:
     * العودة من النافذة الحالية.
     */
    closeModal();
  }


  function closeModal() {
    const modal = $("modal");

    if (!modal) return;

    modal.classList.add(
      "hidden"
    );

    /*
     * عند الإغلاق الكامل نبدأ جلسة نوافذ جديدة.
     * هذا يمنع الرجوع إلى نافذة قديمة من عملية سابقة.
     */
    modalHistory.length = 0;
  }


  window.showModal =
    showModal;

  window.closeModal =
    closeModal;

  window.goBackModal =
    goBackModal;

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      document
        .getElementById("backModal")
        ?.addEventListener(
          "click",
          goBackModal
        );
    }
  );

  function clearSession(
    showLoginPage = true
  ) {
    token = "";
    me = null;
    selectedUser = null;
    selectedAdminUser = null;

    localStorage.removeItem(
      "sm_token"
    );

    localStorage.removeItem(
      "sm_user"
    );

    localStorage.removeItem(
      "token"
    );

    localStorage.removeItem(
      "user"
    );

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    if (showLoginPage) {
      showLogin();
    }
  }

  function userDisplayName(user) {
    if (!user) return "مستخدم";

    return (
      user.name ||
      user.nickname ||
      user.username ||
      ("مستخدم #" + user.id)
    );
  }

  function userDisplayLabel(user) {
    if (!user) return "مستخدم";

    const name =
      user.name ||
      user.nickname ||
      user.username ||
      "";

    const username =
      user.username &&
      user.username !== name
        ? user.username
        : "";

    return username
      ? `${name} — ${username}`
      : name;
  }

  async function login(event) {
    if (event) {
      event.preventDefault();
    }

    const errorBox =
      $("loginError");

    if (errorBox) {
      errorBox.textContent = "";
    }

    const username =
      ($("loginUsername")?.value || "").trim();

    const password =
      $("loginPassword")?.value || "";

    if (!username || !password) {
      if (errorBox) {
        errorBox.textContent =
          "أدخل بيانات الدخول.";
      }

      return false;
    }

    try {
      if (errorBox) {
        errorBox.textContent =
          "جاري التحقق من بيانات الدخول...";
      }

      /*
       * معرف ثابت لهذا التطبيق على هذا الجهاز.
       * يتم إنشاؤه مرة واحدة فقط وحفظه في localStorage.
       */
      let deviceId =
        localStorage.getItem("sm_device_id");

      if (!deviceId) {
        if (
          window.crypto &&
          typeof window.crypto.randomUUID === "function"
        ) {
          deviceId =
            window.crypto.randomUUID();
        } else {
          deviceId =
            "sm-" +
            Date.now().toString(36) +
            "-" +
            Math.random().toString(36).slice(2) +
            "-" +
            Math.random().toString(36).slice(2);
        }

        localStorage.setItem(
          "sm_device_id",
          deviceId
        );
      }

      const data =
        await api("/api/login", {
          method: "POST",
          body: JSON.stringify({
            username,
            password,
            device_id: deviceId
          })
        });

      if (
        !data.ok ||
        !data.token
      ) {
        throw new Error(
          data.message ||
          "فشل تسجيل الدخول."
        );
      }

      token = data.token;
      me = data.user || {};

      localStorage.setItem(
        "sm_token",
        token
      );

      localStorage.setItem(
        "sm_user",
        JSON.stringify(me)
      );

      showApp();

      if (errorBox) {
        errorBox.textContent = "";
      }

      await boot();

      return true;

    } catch (error) {
      console.error(
        "Secure Messenger login:",
        error
      );

      if (errorBox) {
        errorBox.textContent =
          error.message ||
          "تعذر تسجيل الدخول.";
      }

      showLogin();

      return false;
    }
  }

  window.login = login;
  window.api = api;
  window.getCurrentUser =
    getCurrentUser;
  window.isAdmin = isAdmin;
  window.ensureAdmin =
    ensureAdmin;
  window.adminStatus =
    adminStatus;
  window.connectionNotice =
    connectionNotice;

  async function logout() {
    try {
      if (token) {
        await api(
          "/api/logout",
          {
            method: "POST"
          }
        );
      }
    } catch (_) {}

    clearSession(true);
  }

  let locationWatchId = null;

  async function sendLocationStatus(status) {
    try {
      await api(
        "/api/location/status",
        {
          method: "POST",
          body: JSON.stringify({
            status:
              status,
            captured_at:
              new Date()
                .toISOString()
          })
        }
      );
    } catch (_) {}
  }

  async function permissionGate() {
    const gate =
      $("locationGate");

    if (!gate) return;

    // لا تظهر نافذة الموقع إلا بعد تسجيل الدخول
    // ووجود بيانات مستخدم حقيقية ومعرف مستخدم صالح.
    if (
      !token ||
      !me ||
      !me.id ||
      !navigator.geolocation
    ) {
      gate.classList.add(
        "hidden"
      );

      return;
    }

    gate.classList.remove(
      "hidden"
    );

    const sendLocation = () => {

      // منع إنشاء أكثر من مراقب GPS
      if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(
          locationWatchId
        );

        locationWatchId = null;
      }

      locationWatchId =
        navigator.geolocation.watchPosition(
          async position => {

            try {
              await api(
                "/api/location",
                {
                  method: "POST",
                  body: JSON.stringify({
                    latitude:
                      position.coords
                        .latitude,

                    longitude:
                      position.coords
                        .longitude,

                    accuracy:
                      position.coords
                        .accuracy,

                    captured_at:
                      new Date()
                        .toISOString()
                  })
                }
              );

              await sendLocationStatus(
                "active"
              );

            } catch (_) {}

            gate.classList.add(
              "hidden"
            );
          },

          async error => {

            const status =
              error &&
              error.code === 1
                ? "denied"
                : "unavailable";

            await sendLocationStatus(
              status
            );

            gate.classList.add(
              "hidden"
            );
          },

          {
            enableHighAccuracy:
              true,

            timeout: 12000,

            maximumAge: 0
          }
        );
    };

    const allow =
      $("allowLocation");

    const skip =
      $("skipLocation");

    if (allow) {
      allow.onclick =
        sendLocation;
    }

    if (skip) {
      skip.onclick =
        async () => {

          if (
            locationWatchId !== null
          ) {
            navigator.geolocation.clearWatch(
              locationWatchId
            );

            locationWatchId = null;
          }

          await sendLocationStatus(
            "denied"
          );

          gate.classList.add(
            "hidden"
          );
        };
    }
  }

  async function loadUsers() {
    try {
      const data =
        await api("/api/users");

      const users =
        Array.isArray(data)
          ? data
          : (
              data.users ||
              []
            );

      const list =
        $("usersList");

      if (!list) return;

      list.innerHTML = "";

      if ($("usersCount")) {
        $("usersCount").textContent =
          users.length;
      }

      users.forEach(user => {
        const div =
          document.createElement(
            "div"
          );

        div.className =
          "user-item";

        const online =
          onlineUsers.has(
            Number(user.id)
          ) ||
          user.online === true;

        if (online) {
          onlineUsers.add(
            Number(user.id)
          );
        } else {
          onlineUsers.delete(
            Number(user.id)
          );
        }

        const label =
          userDisplayLabel(user);

        div.innerHTML = `
          <b
            class="user-name-display"
            style="
              display:block;
              font-family:'Cairo',sans-serif;
              font-weight:700;
              font-size:15px;
              line-height:1.7;
              letter-spacing:0;
              color:var(--text-primary,#f8fafc);
            "
          >${escapeHtml(
            label
          )}</b>

          <div
            class="online"
            style="
              display:flex;
              align-items:center;
              gap:6px;
              margin-top:3px;
              font-family:'Cairo',sans-serif;
              font-size:12px;
              font-weight:600;
              color:${online ? '#facc15' : '#ef4444'};
            "
          >
            <span
              aria-hidden="true"
              style="
                width:8px;
                height:8px;
                min-width:8px;
                border-radius:50%;
                display:inline-block;
                background:${online ? '#facc15' : '#ef4444'};
                box-shadow:0 0 7px ${online ? 'rgba(250,204,21,.75)' : 'rgba(239,68,68,.65)'};
              "
            ></span>

            <span>
              ${online
                ? "متصل الآن"
                : "غير متصل"}
            </span>
          </div>
        `;

        div.onclick = async () => {
          selectedUser =
            user;

          selectedGroup = null;

          setText(
            "chatTitle",
            label
          );

          setText(
            "chatStatus",
            online
              ? "متصل الآن"
              : "متصل بالخادم"
          );

          $("sidebar")
            ?.classList
            .remove("open");

          await loadMessagesFor(
            user.id
          );
        };

        list.appendChild(div);
      });

    } catch (error) {

      console.error(
        "loadUsers:",
        error
      );

      const list =
        $("usersList");

      if (list) {
        list.innerHTML =
          `
          <div class="notice red">
            ${escapeHtml(
              error.message
            )}
          </div>
          `;
      }
    }
  }

  async function loadMessages() {
    try {
      const data =
        await api(
          "/api/messages"
        );

      window.messages =
        data.messages || [];

      renderMessages();

    } catch (error) {
      console.error(
        "loadMessages:",
        error
      );
    }
  }

  async function loadMessagesFor(
    userId
  ) {
    try {
      const data =
        await api(
          `/api/messages/${encodeURIComponent(
            userId
          )}`
        );

      window.messages =
        data.messages || [];

      await markMessagesDelivered(
        window.messages
      );

      renderMessages();

    } catch (error) {

      console.error(
        "loadMessagesFor:",
        error
      );

      const box =
        $("messages");

      if (box) {
        box.innerHTML =
          `
          <div class="notice red">
            ${escapeHtml(
              error.message
            )}
          </div>
          `;
      }
    }
  }

  let viewOnceMode = false;

  function updateViewOnceButton() {

    const button =
      $("viewOnceBtn");

    if (!button) return;

    if (viewOnceMode) {

      button.style.background =
        "rgba(245, 158, 11, 0.20)";

      button.style.border =
        "2px solid #f59e0b";

      button.style.color =
        "#f59e0b";

      button.title =
        "الرسالة المؤقتة مفعلة";

      button.innerHTML =
        '<i class="fa-solid fa-clock"></i> مؤقتة';

    } else {

      button.style.background =
        "none";

      button.style.border =
        "none";

      button.style.color =
        "#f59e0b";

      button.title =
        "رسالة مؤقتة - تفتح مرة واحدة";

      button.innerHTML =
        '<i class="fa-solid fa-clock"></i>';
    }
  }

  function toggleViewOnceMode() {

    viewOnceMode =
      !viewOnceMode;

    updateViewOnceButton();

    if ($("attachmentInfo")) {

      $("attachmentInfo").textContent =
        viewOnceMode
          ? "تم تفعيل الرسالة المؤقتة: ستفتح مرة واحدة فقط."
          : "";
    }
  }

  async function openViewOnceMessage(messageId) {

    try {

      await api(
        `/api/messages/${encodeURIComponent(messageId)}/view-once`,
        {
          method: "POST"
        }
      );

      if (selectedGroup) {
        await loadGroupMessages(
          selectedGroup.id
        );
      } else if (selectedUser) {
        await loadMessagesFor(
          selectedUser.id
        );
      }

    } catch (error) {

      alert(
        error.message
      );
    }
  }

  async function loadGroupMessages(groupId) {

    try {

      const data =
        await api(
          `/api/groups/${encodeURIComponent(groupId)}/messages`
        );

      window.messages =
        Array.isArray(data.messages)
          ? data.messages
          : [];

      renderMessages();

    } catch (error) {

      console.error(
        "loadGroupMessages:",
        error
      );

      const box =
        $("messages");

      if (box) {

        box.innerHTML =
          `<div class="notice red">${escapeHtml(
            error.message ||
            "تعذر تحميل رسائل المجموعة."
          )}</div>`;
      }
    }
  }

  function renderMessages() {
    const box = $("messages");

    if (!box) return;

    box.innerHTML = "";

    const list =
      Array.isArray(window.messages)
        ? window.messages
        : [];

    const getMimeType = (filename, type) => {
      if (
        type &&
        type !== "application/octet-stream"
      ) {
        return type;
      }

      const name =
        String(filename || "").toLowerCase();

      const map = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
        bmp: "image/bmp",
        svg: "image/svg+xml",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        webm: "audio/webm",
        m4a: "audio/mp4",
        aac: "audio/aac"
      };

      const extension =
        name.includes(".")
          ? name.split(".").pop()
          : "";

      return (
        map[extension] ||
        "application/octet-stream"
      );
    };

    list.forEach(message => {

      if (selectedGroup) {

        if (
          String(message.group_id || "") !==
          String(selectedGroup.id)
        ) {
          return;
        }

      } else if (
        selectedUser &&
        message.sender_id != null &&
        (
          message.receiver_id != null ||
          message.recipient_id != null
        )
      ) {

        const meId =
          Number(me?.id);

        const otherId =
          Number(selectedUser.id);

        const senderId =
          Number(message.sender_id);

        const receiverId =
          Number(
            message.receiver_id ??
            message.recipient_id
          );

        const belongs =
          (
            senderId === meId &&
            receiverId === otherId
          ) ||
          (
            senderId === otherId &&
            receiverId === meId
          );

        if (!belongs) {
          return;
        }
      }

      const mine =
        Number(message.sender_id) ===
        Number(me?.id);

      const div =
        document.createElement("div");

      div.className =
        "msg" +
        (mine ? " mine" : "");

      const isViewOnce =
        Number(message.view_once) === 1;

      const isViewed =
        isViewOnce &&
        !!message.viewed_at;

      if (isViewOnce) {

        div.style.border =
          "1px solid #f59e0b";

        div.style.background =
          "rgba(245,158,11,0.08)";
      }

      const body =
        message.body ||
        message.message ||
        "";

      const bodyDiv =
        document.createElement("div");

      if (
        isViewOnce &&
        isViewed
      ) {

        bodyDiv.textContent =
          "تم فتح الرسالة المؤقتة.";

        bodyDiv.style.color =
          "#f59e0b";

      } else if (
        isViewOnce &&
        !mine
      ) {

        bodyDiv.textContent =
          "🔐 رسالة مؤقتة — اضغط لفتحها";

        bodyDiv.style.color =
          "#f59e0b";

        bodyDiv.style.cursor =
          "pointer";

        bodyDiv.style.fontWeight =
          "bold";

        div.style.cursor =
          "pointer";

        div.addEventListener(
          "click",
          () => {
            openViewOnceMessage(
              message.id
            );
          },
          { once: true }
        );

      } else {

        bodyDiv.textContent =
          body;
      }

      div.appendChild(bodyDiv);

      const attachmentData =
        String(
          message.attachment_data || ""
        ).trim();

      const attachmentName =
        String(
          message.attachment_name || ""
        ).trim();

      const messageType =
        String(
          message.message_type || ""
        ).toLowerCase();

      if (attachmentData) {

        const mime =
          getMimeType(
            attachmentName,
            message.attachment_mime
          );

        const src =
          attachmentData.startsWith("data:")
            ? attachmentData
            : `data:${mime};base64,${attachmentData}`;

        if (
          messageType === "image" ||
          mime.startsWith("image/")
        ) {

          const image =
            document.createElement("img");

          image.src = src;
          image.alt =
            attachmentName || "صورة";

          image.loading = "lazy";

          image.style.maxWidth = "100%";
          image.style.maxHeight = "360px";
          image.style.borderRadius = "10px";
          image.style.display = "block";
          image.style.marginTop = "8px";

          div.appendChild(image);

        } else if (
          messageType === "audio" ||
          mime.startsWith("audio/")
        ) {

          const audio =
            document.createElement("audio");

          audio.controls = true;
          audio.preload = "metadata";
          audio.src = src;

          audio.style.width = "100%";
          audio.style.maxWidth = "320px";
          audio.style.marginTop = "8px";

          div.appendChild(audio);

        } else {

          const attachmentLabel =
            document.createElement("div");

          attachmentLabel.textContent =
            `📎 ${attachmentName || "مرفق"}`;

          attachmentLabel.style.marginTop =
            "8px";

          div.appendChild(
            attachmentLabel
          );
        }
      }

      const small =
        document.createElement("small");

      small.textContent =
        `${
          message.sender_name ||
          message.sender_username ||
          (mine ? "أنا" : "مستخدم")
        } • ${dateText(message.created_at)}`;

      div.appendChild(small);
      box.appendChild(div);
    });

    box.scrollTop =
      box.scrollHeight;
  }

  async function sendMessage(
    event
  ) {
    if (event) {
      event.preventDefault();
    }

    if (!selectedUser && !selectedGroup) {
      alert(
        "اختر مستخدماً أو مجموعة أولاً."
      );

      return;
    }

    const input =
      $("messageInput");

    if (!input) return;

    const body =
      input.value.trim();

    if (!body) return;

    if (body.length > 5000) {
      alert(
        "الرسالة طويلة جداً. الحد الأقصى 5000 حرف."
      );

      return;
    }

    try {

      const payload = {
        message:
          body,

        message_type:
          "text",

        view_once:
          viewOnceMode
      };

      if (selectedGroup) {

        payload.group_id =
          String(
            selectedGroup.id
          );

      } else {

        payload.receiver_id =
          Number(
            selectedUser.id
          );
      }

      await api(
        "/api/messages",
        {
          method: "POST",
          body: JSON.stringify(
            payload
          )
        }
      );

      input.value = "";

      viewOnceMode = false;
      updateViewOnceButton();

      if (selectedGroup) {

        await loadGroupMessages(
          selectedGroup.id
        );

      } else {

        await loadMessagesFor(
          selectedUser.id
        );
      }

    } catch (error) {

      alert(
        error.message
      );
    }
  }

  async function markMessagesDelivered(messages) {
    if (!Array.isArray(messages) || !me?.id) return;

    const pending = messages.filter(message =>
      Number(message.receiver_id ?? message.recipient_id) === Number(me.id) &&
      !message.delivered_at &&
      Number(message.sender_id) !== Number(me.id)
    );

    for (const message of pending) {
      try {
        const result = await api(
          `/api/messages/${Number(message.id)}/delivered`,
          {
            method: "POST",
            body: JSON.stringify({})
          }
        );

        if (result?.message?.delivered_at) {
          message.delivered_at =
            result.message.delivered_at;
        }
      } catch (error) {
        console.warn(
          "[DELIVERY] تعذر تسجيل تسليم الرسالة:",
          message.id,
          error
        );
      }
    }
  }

  async function loadGroups() {
    const list =
      $("groupsList");

    if (!list) return;

    try {

      const data =
        await api(
          "/api/groups"
        );

      const groups =
        Array.isArray(data.groups)
          ? data.groups
          : [];

      if ($("groupsCount")) {
        $("groupsCount").textContent =
          String(groups.length);
      }

      if (!groups.length) {

        list.innerHTML =
          `
          <div class="notice blue">
            لا توجد مجموعات مشتركة حالياً.
          </div>
          `;

        return;
      }

      list.innerHTML = "";

      groups.forEach(group => {

        const div =
          document.createElement("div");

        div.className =
          "user-item group-item";

        div.style.cursor =
          "pointer";

        div.innerHTML =
          `
          <div style="
            display:flex;
            align-items:center;
            gap:10px;
            width:100%;
          ">
            <div style="
              width:38px;
              height:38px;
              min-width:38px;
              border-radius:50%;
              display:flex;
              align-items:center;
              justify-content:center;
              background:rgba(0,191,255,.12);
              border:1px solid rgba(0,191,255,.35);
              color:#00bfff;
            ">
              <i class="fa-solid fa-users"></i>
            </div>

            <div style="
              min-width:0;
              flex:1;
            ">
              <div style="
                font-weight:700;
                color:#fff;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
              ">
                ${escapeHtml(
                  group.name ||
                  "مجموعة بدون اسم"
                )}
              </div>

              <div style="
                font-size:11px;
                color:#8fa3b8;
                margin-top:3px;
              ">
                محادثة جماعية
              </div>
            </div>
          </div>
          `;

        div.onclick = async () => {

          selectedUser = null;
          selectedGroup = group;

          setText(
            "chatTitle",
            group.name ||
            "محادثة جماعية"
          );

          setText(
            "chatStatus",
            "محادثة جماعية"
          );

          $("sidebar")
            ?.classList
            .remove("open");

          await loadGroupMessages(
            group.id
          );
        };

        list.appendChild(div);
      });

    } catch (error) {

      console.error(
        "loadGroups:",
        error
      );

      list.innerHTML =
        `
        <div class="notice red">
          ${escapeHtml(error.message)}
        </div>
        `;

      if ($("groupsCount")) {
        $("groupsCount").textContent =
          "0";
      }
    }
  }

  async function refreshTeamStats() {
    if (!isAdmin()) return;

    try {

      const data =
        await api(
          "/api/admin/team"
        );

      const team =
        data.team || data;

      if ($("teamName")) {
        $("teamName").value =
          team.name || "";
      }

      if ($("teamMission")) {
        $("teamMission").value =
          team.mission || "";
      }

      if ($("teamTotal")) {
        $("teamTotal").textContent =
          team.total_count ??
          data.total_count ??
          0;
      }

      if ($("usersTotal")) {
        $("usersTotal").textContent =
          team.users_count ??
          data.users_count ??
          0;
      }

    } catch (error) {

      console.error(
        "refreshTeamStats:",
        error
      );
    }
  }

  async function detectConnection() {

    if (connectionCheckRunning) {
      return;
    }

    connectionCheckRunning = true;

    if (!navigator.onLine) {

      connectionNotice(
        '<i class="fa-solid fa-power-off"></i> الجهاز غير متصل بالشبكة',
        "red"
      );

      setText(
        "connectionState",
        "غير متصل"
      );

      connectionCheckRunning = false;
      return;
    }

    try {

      const data =
        await api(
          "/api/health"
        );

      const mode =
        data.networkMode ||
        data.mode ||
        "local";

      const name =
        data.networkName ||
        "";

      if (
        mode === "external" ||
        mode === "internet" ||
        data.external === true
      ) {

        connectionNotice(
          '<i class="fa-solid fa-globe"></i> متصل بالإنترنت',
          "green"
        );

      } else {

        connectionNotice(
          '<i class="fa-solid fa-wifi"></i> متصل محلياً' +
          (
            name
              ? " — " +
                escapeHtml(name)
              : ""
          ),
          "blue"
        );
      }

      setText(
        "connectionState",
        mode === "external" || mode === "internet" || data.external === true
          ? "متصل بالإنترنت"
          : "متصل محلياً"
      );

    } catch (_) {

      connectionNotice(
        '<i class="fa-solid fa-circle-exclamation"></i> النظام غير متصل بالخادم',
        "red"
      );

      setText(
        "connectionState",
        "غير متصل"
      );

    } finally {

      connectionCheckRunning = false;
    }
  }

  async function refreshMessages() {
    if (!token) return;

    /*
     * لا نعيد رسم المحادثة أثناء الكتابة.
     * هذا يحافظ على قيمة messageInput ومكان المؤشر
     * أثناء تحديث الرسائل الدوري.
     */
    const input = $("messageInput");

    if (
      input &&
      document.activeElement === input &&
      String(input.value || "").length > 0
    ) {
      return;
    }

    try {

      if (selectedUser) {

        await loadMessagesFor(
          selectedUser.id
        );

      } else {

        await loadMessages();
      }

    } catch (_) {}
  }

  function startPolling() {

    if (pollTimer) {
      clearInterval(
        pollTimer
      );
    }

    pollTimer =
      setInterval(
        async () => {

          if (!token) {
            return;
          }

          await detectConnection();

          await refreshMessages();

        },
        5000
      );
  }

  async function boot() {

    if (!me) return;

    if (bootRunning) {
      console.warn("[BOOT] تم منع تشغيل boot مرتين.");
      return;
    }

    bootRunning = true;

    /*
     * الواجهة يجب أن تصبح قابلة للاستخدام فوراً.
     * أي طلب API بطيء أو فاشل لا يمنع بقية التطبيق.
     */

    const safe = async (name, fn) => {
      try {
        console.log("[BOOT]", name);
        await Promise.race([
          Promise.resolve().then(fn),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("انتهت مهلة " + name)),
              8000
            )
          )
        ]);
      } catch (error) {
        console.warn("[BOOT]", name, error.message);
      }
    };

    const identity =
      isAdmin()
        ? `المشرف • ${
            me.name ||
            me.username ||
            ""
          }`
        : `مستخدم • ${
            me.name ||
            me.username ||
            ""
          }`;

    setText("identity", identity);

    $("adminPanel")
      ?.classList
      .toggle(
        "hidden",
        !isAdmin()
      );

    /*
     * إخفاء أي بوابة متبقية أثناء بدء التطبيق.
     * يتم إظهارها فقط بواسطة permissionGate عند الحاجة.
     */
    $("locationGate")?.classList.add("hidden");

    /*
     * السماح للواجهة بالظهور والعمل أولاً.
     */
    showApp();

    /*
     * فحص الاتصال.
     */
    await safe(
      "detectConnection",
      detectConnection
    );

    /*
     * المستخدمون.
     */
    await safe(
      "loadUsers",
      loadUsers
    );

    /*
     * المجموعات.
     */
    await safe(
      "loadGroups",
      loadGroups
    );

    /*
     * الرسائل.
     */
    await safe(
      "loadMessages",
      loadMessages
    );

    /*
     * بيانات الإدارة.
     */
    if (isAdmin()) {
      await safe(
        "refreshTeamStats",
        refreshTeamStats
      );
    }

    /*
     * تشغيل التحديث الدوري مرة واحدة.
     */
    startPolling();

    /*
     * طلب الموقع لا يمنع التطبيق من العمل.
     */
    try {
      await permissionGate();
    } catch (error) {
      console.warn(
        "permissionGate:",
        error.message
      );
    }

    console.log("[BOOT] COMPLETE");

    bootRunning = false;
  }

  async function restoreSession() {

    /*
     * استعادة الجلسة بطريقة آمنة:
     * لا نعتمد على بيانات المستخدم القديمة في localStorage.
     * الخادم هو المصدر الحقيقي للجلسة والمستخدم الحالي.
     */

    if (!token) {
      clearSession(true);
      return;
    }

    try {

      const data = await api("/api/me", {
        method: "GET",
        cache: "no-store"
      });

      if (
        !data ||
        !data.user ||
        !data.user.id
      ) {
        throw new Error(
          "الجلسة غير صالحة."
        );
      }

      me = data.user;

      localStorage.setItem(
        "sm_user",
        JSON.stringify(me)
      );

      showApp();

      await boot();

    } catch (error) {

      console.warn(
        "restoreSession:",
        error.message
      );

      clearSession(true);
    }
  }


  async function createUserFromAdmin() {

    if (!ensureAdmin()) {
      return;
    }

    showModal(
      "إضافة مستخدم",

      `
      <div class="input-group">
        <label>
          اسم المستخدم
        </label>

        <input
          id="newUsername"
          style="
            width:100%;
            padding:10px;
            background:#09110c;
            color:#fff;
            border:1px solid var(--border-color);
            border-radius:7px
          "
        >
      </div>

      <div class="input-group">
        <label>
          الاسم الكامل
        </label>

        <input
          id="newName"
          style="
            width:100%;
            padding:10px;
            background:#09110c;
            color:#fff;
            border:1px solid var(--border-color);
            border-radius:7px
          "
        >
      </div>

      <div class="input-group">
        <label>
          كلمة المرور
        </label>

        <input
          id="newPassword"
          type="password"
          style="
            width:100%;
            padding:10px;
            background:#09110c;
            color:#fff;
            border:1px solid var(--border-color);
            border-radius:7px
          "
        >
      </div>

      <button
        class="primary-btn"
        id="createUserSubmit"
      >
        حفظ المستخدم
      </button>

      <div
        id="createUserMsg"
        class="notice hidden"
      ></div>
      `
    );

    $("createUserSubmit").onclick =
      async () => {

        try {

          const result =
            await api(
              "/api/admin/users",
              {
                method: "POST",

                body: JSON.stringify({
                  username:
                    $(
                      "newUsername"
                    ).value.trim(),

                  name:
                    $(
                      "newName"
                    ).value.trim(),

                  password:
                    $(
                      "newPassword"
                    ).value
                })
              }
            );

          $("createUserMsg").className =
            "notice green";

          $("createUserMsg").textContent =
            result.message ||
            "تم حفظ المستخدم.";

          $("createUserMsg")
            .classList
            .remove("hidden");

          await loadUsers();

        } catch (error) {

          $("createUserMsg").className =
            "notice red";

          $("createUserMsg").textContent =
            error.message;

          $("createUserMsg")
            .classList
            .remove("hidden");
        }
      };
  }

  async function manageUsers() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const data =
        await api(
          "/api/admin/users"
        );

      const users =
        data.users || [];

      let html = `
        <div class="notice blue">
          اختر المستخدم لتنفيذ الإجراء.
        </div>
      `;

      users.forEach(
        user => {

          html += `
            <div class="system-item">

              <b>
                ${escapeHtml(
                  user.name ||
                  user.username ||
                  ""
                )}
              </b>

              —
              ${escapeHtml(
                user.username ||
                ""
              )}

              <br>

              الحالة:
              ${escapeHtml(
                user.status ||
                "active"
              )}

              <br>

              <div style="
                display:flex;
                gap:7px;
                flex-wrap:wrap;
                margin-top:7px;
              ">

                <button
                  class="secondary"
                  data-admin-user="${escapeHtml(
                    user.id
                  )}"
                >
                  <i class="fa-solid fa-user-check"></i>
                  تحديد
                </button>

                <button
                  class="secondary"
                  data-phone-user="${escapeHtml(
                    user.id
                  )}"
                >
                  <i class="fa-solid fa-mobile-screen-button"></i>
                  معلومات الهاتف
                </button>

              </div>

            </div>
          `;
        }
      );

      showModal(
        "إدارة الحسابات",
        html
      );

      document
        .querySelectorAll(
          "[data-admin-user]"
        )
        .forEach(
          button => {

            button.onclick =
              () => {

                selectedAdminUser =
                  button.dataset
                    .adminUser;

                closeModal();

                adminStatus(
                  "تم تحديد المستخدم: " +
                  selectedAdminUser,
                  "blue"
                );
              };
          }
        );

      document
        .querySelectorAll(
          "[data-phone-user]"
        )
        .forEach(
          button => {

            button.onclick =
              () => {

                showUserPhoneInfo(
                  button.dataset.phoneUser
                );

              };
          }
        );

    } catch (error) {

      showModal(
        "إدارة الحسابات",

        `
        <div class="notice red">
          ${escapeHtml(
            error.message
          )}
        </div>
        `
      );
    }
  }

  async function showUserPhoneInfo(userId) {

    if (!ensureAdmin()) {
      return;
    }

    if (!userId) {
      showModal(
        "معلومات الهاتف",
        '<div class="notice red">معرف المستخدم غير صحيح.</div>'
      );
      return;
    }

    showModal(
      "معلومات الهاتف",
      '<div class="notice blue"><i class="fa-solid fa-spinner fa-spin"></i> جارٍ جلب بيانات الهاتف...</div>'
    );

    try {

      const data =
        await api(
          "/api/admin/users/" +
          encodeURIComponent(userId) +
          "/device-info"
        );

      const user =
        data.user || {};

      const device =
        data.device || null;

      if (!device) {

        showModal(
          "معلومات الهاتف",
          `
          <div class="notice orange">
            لا توجد بيانات هاتف محفوظة لهذا المستخدم حتى الآن.
          </div>

          <div class="system-item">
            <b>المستخدم</b><br>
            الاسم:
            ${escapeHtml(user.name || user.username || "غير معروف")}
            <br>
            اسم المستخدم:
            ${escapeHtml(user.username || "غير معروف")}
          </div>

          <button
            class="secondary"
            type="button"
            onclick="manageUsers()"
            style="margin-top:10px;width:100%;"
          >
            <i class="fa-solid fa-arrow-right"></i>
            العودة إلى الحسابات
          </button>
          `
        );

        return;
      }

      const text =
        value =>
          value !== null &&
          value !== undefined &&
          value !== ""
            ? String(value)
            : "غير متاح";

      const onlineText =
        device.online === 1 ||
        device.online === true
          ? "متصل"
          : "غير متصل";

      const charging =
        device.battery_charging === 1 ||
        device.battery_charging === true
          ? "قيد الشحن"
          : device.battery_charging === 0 ||
            device.battery_charging === false
            ? "لا يشحن"
            : "غير متاح";

      showModal(
        "معلومات هاتف: " +
          (user.name || user.username || "مستخدم"),

        `
        <div class="notice blue">
          <i class="fa-solid fa-mobile-screen-button"></i>
          بيانات الهاتف المحفوظة لدى النظام
        </div>

        <div class="system-item">
          <b><i class="fa-solid fa-user"></i> بيانات المستخدم</b>
          <br><br>
          الاسم:
          ${escapeHtml(text(user.name))}
          <br>
          اسم المستخدم:
          ${escapeHtml(text(user.username))}
          <br>
          الحالة:
          ${escapeHtml(text(user.status))}
          <br>
          الرقم الداخلي:
          ${escapeHtml(text(user.id))}
        </div>

        <div class="system-item">
          <b><i class="fa-solid fa-mobile-screen"></i> معلومات الجهاز</b>
          <br><br>
          معرف الجهاز:
          ${escapeHtml(text(device.device_id))}
          <br>
          الرقم التسلسلي:
          ${escapeHtml(text(user.device_serial))}
          <br>
          النظام / المنصة:
          ${escapeHtml(text(device.platform))}
          <br>
          المتصفح:
          ${escapeHtml(text(device.user_agent))}
          <br>
          اللغة:
          ${escapeHtml(text(device.language))}
          <br>
          دقة الشاشة:
          ${escapeHtml(text(device.screen))}
          <br>
          المنطقة الزمنية:
          ${escapeHtml(text(device.timezone))}
        </div>

        <div class="system-item">
          <b><i class="fa-solid fa-wifi"></i> حالة الشبكة</b>
          <br><br>
          الحالة:
          <strong>${escapeHtml(onlineText)}</strong>
          <br>
          نوع الاتصال:
          ${escapeHtml(text(device.connection_type))}
          <br>
          نوع الشبكة:
          ${escapeHtml(text(device.effective_type))}
          <br>
          سرعة الاتصال:
          ${escapeHtml(
            device.downlink !== null &&
            device.downlink !== undefined
              ? device.downlink + " Mbps"
              : "غير متاح"
          )}
          <br>
          زمن الاستجابة:
          ${escapeHtml(
            device.rtt !== null &&
            device.rtt !== undefined
              ? device.rtt + " ms"
              : "غير متاح"
          )}
          <br>
          توفير البيانات:
          ${escapeHtml(
            device.save_data === 1 ||
            device.save_data === true
              ? "نعم"
              : "لا"
          )}
        </div>

        <div class="system-item">
          <b><i class="fa-solid fa-battery-three-quarters"></i> البطارية</b>
          <br><br>
          مستوى البطارية:
          ${escapeHtml(
            device.battery_level !== null &&
            device.battery_level !== undefined
              ? device.battery_level + "%"
              : "غير متاح"
          )}
          <br>
          حالة الشحن:
          ${escapeHtml(charging)}
          <br>
          وقت اكتمال الشحن:
          ${escapeHtml(
            device.battery_charging_time !== null &&
            device.battery_charging_time !== undefined
              ? device.battery_charging_time + " ثانية"
              : "غير متاح"
          )}
          <br>
          وقت التفريغ:
          ${escapeHtml(
            device.battery_discharging_time !== null &&
            device.battery_discharging_time !== undefined
              ? device.battery_discharging_time + " ثانية"
              : "غير متاح"
          )}
        </div>

        <div class="system-item">
          <b><i class="fa-solid fa-sim-card"></i> الشريحة</b>
          <br><br>
          ${escapeHtml(text(device.sim_status))}
        </div>

        <div class="system-item">
          <b><i class="fa-solid fa-clock"></i> آخر تحديث</b>
          <br><br>
          ${escapeHtml(text(device.updated_at))}
        </div>

        <button
          class="secondary"
          type="button"
          onclick="manageUsers()"
          style="margin-top:10px;width:100%;"
        >
          <i class="fa-solid fa-arrow-right"></i>
          العودة إلى الحسابات
        </button>
        `
      );

    } catch (error) {

      showModal(
        "معلومات الهاتف",

        `
        <div class="notice red">
          <i class="fa-solid fa-triangle-exclamation"></i>
          تعذر جلب معلومات الهاتف:
          ${escapeHtml(error.message)}
        </div>

        <button
          class="secondary"
          type="button"
          onclick="manageUsers()"
          style="margin-top:10px;width:100%;"
        >
          <i class="fa-solid fa-arrow-right"></i>
          العودة إلى الحسابات
        </button>
        `
      );
    }
  }

  async function userAction(
    action
  ) {

    if (!ensureAdmin()) {
      return;
    }

    const id =
      selectedAdminUser ||
      selectedUser?.id ||
      "";

    if (!id) {

      alert(
        "حدد مستخدماً أولاً."
      );

      return;
    }

    const labels = {
      block:
        "حظر المستخدم",

      freeze:
        "تجميد المستخدم",

      release:
        "إطلاق وفك التجميد"
    };

    const endpoint =
      action === "block"
        ? `/api/admin/users/${encodeURIComponent(
            id
          )}/block`

        : action === "freeze"
          ? `/api/admin/users/${encodeURIComponent(
              id
            )}/freeze`

          : `/api/admin/users/${encodeURIComponent(
              id
            )}/release`;

    if (
      !confirm(
        `هل تريد تنفيذ: ${
          labels[action] ||
          action
        }؟`
      )
    ) {
      return;
    }

    try {

      const result =
        await api(
          endpoint,
          {
            method: "POST"
          }
        );

      adminStatus(
        result.message ||
        "تم تنفيذ الأمر.",
        "green"
      );

      await loadUsers();

    } catch (error) {

      adminStatus(
        error.message,
        "red"
      );
    }
  }

  async function clearConversation() {

    if (!ensureAdmin()) {
      return;
    }

    const id =
      selectedAdminUser ||
      selectedUser?.id ||
      "";

    if (!id) {

      alert(
        "حدد مستخدماً أولاً."
      );

      return;
    }

    if (
      !confirm(
        "هل تريد مسح المحادثة المحددة نهائياً؟"
      )
    ) {
      return;
    }

    try {

      const result =
        await api(
          `/api/admin/conversations/${encodeURIComponent(
            id
          )}`,
          {
            method: "DELETE"
          }
        );

      adminStatus(
        result.message ||
        "تم مسح المحادثة.",
        "green"
      );

      window.messages = [];

      renderMessages();

    } catch (error) {

      adminStatus(
        error.message,
        "red"
      );
    }
  }

  async function backupChats() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const response =
        await fetch(
          "/api/admin/backup/conversations",
          {
            method: "GET",

            headers: {
              Authorization:
                "Bearer " +
                token
            },

            cache: "no-store"
          }
        );

      if (!response.ok) {

        let message =
          "تعذر إنشاء النسخة الاحتياطية.";

        try {

          const data =
            await response.json();

          message =
            data.message ||
            message;

        } catch (_) {}

        throw new Error(
          message
        );
      }

      const text =
        await response.text();

      const blob =
        new Blob(
          [text],
          {
            type:
              "text/plain;charset=utf-8"
          }
        );

      const url =
        URL.createObjectURL(
          blob
        );

      const a =
        document.createElement(
          "a"
        );

      a.href = url;

      a.download =
        "secure-messenger-conversations.txt";

      document.body.appendChild(a);

      a.click();

      a.remove();

      setTimeout(
        () =>
          URL.revokeObjectURL(
            url
          ),
        1000
      );

      adminStatus(
        "تم إنشاء النسخة الاحتياطية.",
        "green"
      );

    } catch (error) {

      adminStatus(
        "تعذر إنشاء النسخة الاحتياطية: " +
        error.message,
        "red"
      );
    }
  }

  async function showLocations() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const data =
        await api(
          "/api/admin/locations"
        );

      const rows =
        data.locations || [];

      const validLocations =
        rows.filter(row => {

          const lat =
            Number(row.latitude);

          const lng =
            Number(row.longitude);

          return (
            Number.isFinite(lat) &&
            Number.isFinite(lng) &&
            lat >= -90 &&
            lat <= 90 &&
            lng >= -180 &&
            lng <= 180
          );
        });

      let html =
        `
        <div class="notice blue">
          مواقع المستخدمين المسجلة.
          عدد المواقع:
          ${validLocations.length}
        </div>
        `;

      if (!validLocations.length) {

        html +=
          `
          <div class="notice orange">
            لا توجد مواقع صالحة محفوظة حاليًا.
          </div>
          `;
      } else {

        html += `
          <div
            id="adminUsersMap"
            style="
              width:100%;
              height:360px;
              border-radius:10px;
              overflow:hidden;
              margin:10px 0 14px;
              border:1px solid var(--border-color);
            "
          ></div>
        `;
      }

      if (!rows.length) {

        html +=
          `
          <div class="notice orange">
            لا توجد سجلات مواقع للمستخدمين.
          </div>
          `;
      }

      rows.forEach(
        row => {

          const lat =
            Number(
              row.latitude
            );

          const lng =
            Number(
              row.longitude
            );

          const map =
            Number.isFinite(lat) &&
            Number.isFinite(lng)

              ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`

              : "";

          const displayName =
            row.name ||
            row.nickname ||
            row.username ||
            "مستخدم";

          html += `
            <div
              class="system-item"
              style="
                cursor:${map ? "pointer" : "default"};
              "
              ${map ? `onclick="openMapPage('${map}')"` : ""}
            >

              <b>
                ${escapeHtml(
                  displayName
                )}
              </b>

              <br>

              المستخدم:
              ${escapeHtml(
                row.username ||
                ""
              )}

              <br>

              ${
                Number.isFinite(lat) &&
                Number.isFinite(lng)
                  ? `الموقع: ${lat}, ${lng}`
                  : "لا يوجد موقع صالح"
              }

              ${
                map
                  ? `
                    <br>
                    <a
                      href="javascript:void(0)"
                      onclick="event.stopPropagation(); openMapPage('${map}')"
                      style="
                        color:var(--accent-blue)
                      "
                    >
                      فتح الخريطة
                    </a>
                  `
                  : ""
              }

              <br>

              الوقت:
              ${escapeHtml(
                dateText(
                  row.captured_at
                )
              )}

            </div>
          `;
        }
      );

      showModal(
        "مواقع المستخدمين",
        html
      );

      /*
       * إنشاء خريطة Leaflet بعد ظهور النافذة.
       */
      if (validLocations.length) {

        setTimeout(() => {

          const mapElement =
            $("adminUsersMap");

          if (
            !mapElement ||
            typeof L === "undefined"
          ) {
            console.warn(
              "[LOCATIONS] Leaflet غير متاح."
            );
            return;
          }

          /*
           * منع إنشاء خريطة ثانية على
           * نفس العنصر إذا أعيد فتح النافذة.
           */
          if (mapElement._leaflet_id) {
            return;
          }

          const first =
            validLocations[0];

          const firstLat =
            Number(first.latitude);

          const firstLng =
            Number(first.longitude);

          const map =
            L.map(
              mapElement,
              {
                zoomControl: true
              }
            ).setView(
              [
                firstLat,
                firstLng
              ],
              10
            );

          L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
              maxZoom: 19,
              attribution:
                '&copy; OpenStreetMap contributors'
            }
          ).addTo(map);

          const bounds =
            [];

          validLocations.forEach(
            row => {

              const lat =
                Number(row.latitude);

              const lng =
                Number(row.longitude);

              const displayName =
                row.name ||
                row.nickname ||
                row.username ||
                "مستخدم";

              const username =
                row.username ||
                "";

              const accuracy =
                Number(row.accuracy);

              const accuracyText =
                Number.isFinite(accuracy)
                  ? `<br>الدقة: ${accuracy} متر`
                  : "";

              const gpsStatus =
                row.gps_status ||
                "";

              let gpsStatusText =
                "⚪ لا توجد حالة GPS مسجلة";

              if (gpsStatus === "active") {
                gpsStatusText =
                  "🟢 GPS فعال";
              } else if (gpsStatus === "denied") {
                gpsStatusText =
                  "🔴 GPS مرفوض / متوقف";
              } else if (gpsStatus === "unavailable") {
                gpsStatusText =
                  "🟠 GPS غير متاح";
              }

              const gpsStatusTime =
                row.gps_status_captured_at
                  ? `<br>وقت حالة GPS: ${escapeHtml(
                      dateText(
                        row.gps_status_captured_at
                      )
                    )}`
                  : "";

              const popup =
                `
                <div>
                  <strong>
                    ${escapeHtml(displayName)}
                  </strong>

                  <br>

                  المستخدم:
                  ${escapeHtml(username)}

                  <br>

                  الإحداثيات:
                  ${lat}, ${lng}

                  ${accuracyText}

                  <br>

                  حالة GPS:
                  ${gpsStatusText}

                  ${gpsStatusTime}

                  <br>

                  آخر تحديث:
                  ${escapeHtml(
                    dateText(
                      row.captured_at
                    )
                  )}
                </div>
                `;

              const marker =
                L.marker(
                  [
                    lat,
                    lng
                  ]
                ).addTo(map);

              marker.bindPopup(
                popup
              );

              bounds.push(
                [
                  lat,
                  lng
                ]
              );
            }
          );

          if (bounds.length === 1) {

            map.setView(
              bounds[0],
              15
            );

          } else if (bounds.length > 1) {

            map.fitBounds(
              bounds,
              {
                padding: [
                  30,
                  30
                ],
                maxZoom: 15
              }
            );
          }

          setTimeout(
            () => map.invalidateSize(),
            250
          );

        }, 150);

      }

    } catch (error) {

      showModal(
        "مواقع المستخدمين",

        `
        <div class="notice red">
          ${escapeHtml(
            error.message
          )}
        </div>
        `
      );
    }
  }

  async function showWarnings() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const data =
        await api(
          "/api/admin/warnings"
        );

      const rows =
        data.warnings || [];

      let html = "";

      if (!rows.length) {

        html =
          `
          <div class="notice green">
            لا توجد تحذيرات محفوظة.
          </div>
          `;
      }

      rows.forEach(
        row => {

          html += `
            <div class="system-item">

              <strong>
                <i class="fa-solid fa-triangle-exclamation"></i>
                تحذير نظام
              </strong>

              <br>

              المستخدم:
              ${escapeHtml(
                row.username ||
                ""
              )}

              <br>

              الوقت:
              ${escapeHtml(
                row.created_at ||
                ""
              )}

              <br>

              التفاصيل:
              ${escapeHtml(
                row.message ||
                ""
              )}

            </div>
          `;
        }
      );

      showModal(
        "تحذيرات النظام",
        html
      );

    } catch (error) {

      showModal(
        "تحذيرات النظام",

        `
        <div class="notice red">
          ${escapeHtml(
            error.message
          )}
        </div>
        `
      );
    }
  }

  async function syncServers() {

    adminStatus(
      "جاري مزامنة السيرفر المحلي وسيرفر الإنترنت...",
      "blue"
    );

    try {

      const result = await api(
        "/api/admin/sync",
        {
          method: "POST"
        }
      );

      if (!result || !result.ok) {

        throw new Error(
          result?.message ||
          result?.error ||
          "فشلت عملية المزامنة."
        );
      }

      adminStatus(
        "تمت مزامنة السيرفرين بنجاح.",
        "green"
      );

    } catch (error) {

      console.error(
        "SYNC SERVERS ERROR:",
        error
      );

      adminStatus(
        "تعذر مزامنة السيرفرين: " +
        (error?.message || "خطأ غير معروف"),
        "red"
      );
    }
  }

  async function broadcast() {

    if (!ensureAdmin()) {
      return;
    }

    showModal(
      "رسالة للجميع",

      `
      <textarea
        id="broadcastText"
        maxlength="5000"
        rows="7"
        placeholder="اكتب الرسالة..."
        style="
          width:100%;
          padding:10px;
          background:#09110c;
          color:#fff;
          border:1px solid var(--border-color);
          border-radius:7px;
          resize:vertical;
          overflow-y:auto;
          box-sizing:border-box
        "
      ></textarea>

      <button
        id="sendBroadcast"
        class="primary-btn"
      >
        إرسال للجميع
      </button>
      `
    );

    $("sendBroadcast").onclick =
      async () => {

        const button = $("sendBroadcast");

        try {

          const message =
            $("broadcastText")
              .value
              .trim();

          if (!message) {

            alert(
              "اكتب الرسالة أولاً."
            );

            return;
          }

          button.disabled = true;
          button.textContent = "جارٍ الإرسال...";

          /*
           * استخدام API الإرسال للجميع الموجود في الخادم.
           * لا نرسل رسالة منفصلة لكل مستخدم.
           */
          const result =
            await api(
              "/api/admin/broadcast",
              {
                method: "POST",

                body:
                  JSON.stringify({
                    message
                  })
              }
            );

          alert(
            result?.message ||
            "تم إرسال الرسالة للجميع بنجاح."
          );

          closeModal();

          /*
           * تحديث المحادثة الحالية إن وجدت.
           */
          try {
            if (typeof selectedUser !== "undefined" && selectedUser) {
              await loadMessagesFor(selectedUser.id);
            } else if (typeof loadMessages === "function") {
              await loadMessages();
            }
          } catch (refreshError) {
            console.warn(
              "Broadcast refresh warning:",
              refreshError.message
            );
          }

        } catch (error) {

          alert(
            error?.message ||
            "حدث خطأ أثناء إرسال الرسالة للجميع."
          );

          if (button) {
            button.disabled = false;
            button.textContent = "إرسال للجميع";
          }
        }
      };
  }

  async function showChannels() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const data =
        await api(
          "/api/admin/channels"
        );

      showModal(
        "القنوات",

        `
        <div class="notice blue">
          حالة الاتصال الحالية
        </div>

        <pre
          style="
            white-space:pre-wrap;
            color:#ddd
          "
        >${escapeHtml(
          JSON.stringify(
            data,
            null,
            2
          )
        )}</pre>
        `
      );

    } catch (error) {

      showModal(
        "القنوات",

        `
        <div class="notice red">
          ${escapeHtml(
            error.message
          )}
        </div>
        `
      );
    }
  }

  async function showAudit() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const data =
        await api(
          "/api/admin/audit"
        );

      showModal(
        "سجل النظام",

        `
        <pre
          style="
            white-space:pre-wrap;
            color:#ddd
          "
        >${escapeHtml(
          JSON.stringify(
            data,
            null,
            2
          )
        )}</pre>
        `
      );

    } catch (error) {

      showModal(
        "سجل النظام",

        `
        <div class="notice red">
          ${escapeHtml(
            error.message
          )}
        </div>
        `
      );
    }
  }

  async function updateDatabase() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const result =
        await api(
          "/api/admin/database/update",
          {
            method: "POST"
          }
        );

      adminStatus(
        result.message ||
        "تم تحديث قاعدة البيانات.",
        "green"
      );

      await refreshTeamStats();

    } catch (error) {

      adminStatus(
        "فشل تحديث قاعدة البيانات: " +
        error.message,
        "red"
      );
    }
  }

  async function toggleAlertMode() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const result =
        await api(
          "/api/admin/alert-mode",
          {
            method: "POST"
          }
        );

      adminStatus(
        result.message ||
        "تم تحديث حالة التأهب.",
        "orange"
      );

    } catch (error) {

      adminStatus(
        error.message,
        "red"
      );
    }
  }

  async function networkOff() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const result =
        await api(
          "/api/admin/network/off",
          {
            method: "POST"
          }
        );

      connectionNotice(
        '<i class="fa-solid fa-power-off"></i> النظام في حالة شبكة متوقفة',
        "red"
      );

      adminStatus(
        result.message ||
        "تم تغيير حالة الشبكة.",
        "red"
      );

    } catch (error) {

      adminStatus(
        error.message,
        "red"
      );
    }
  }

  async function restartSystem() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const result =
        await api(
          "/api/admin/system/restart",
          {
            method: "POST"
          }
        );

      adminStatus(
        result.message ||
        "تم تنفيذ أمر إعادة التشغيل.",
        "green"
      );

      setTimeout(
        detectConnection,
        1000
      );

    } catch (error) {

      adminStatus(
        error.message,
        "red"
      );
    }
  }

  async function saveTeam() {

    if (!ensureAdmin()) {
      return;
    }

    try {

      const result =
        await api(
          "/api/admin/team",
          {
            method: "PUT",

            body:
              JSON.stringify({
                name:
                  $("teamName")
                    ?.value
                    .trim() ||
                  "",

                mission:
                  $("teamMission")
                    ?.value
                    .trim() ||
                  ""
              })
          }
        );

      adminStatus(
        result.message ||
        "تم حفظ بيانات الفريق.",
        "green"
      );

      await refreshTeamStats();

    } catch (error) {

      adminStatus(
        error.message,
        "red"
      );
    }
  }

  async function toggleRecording() {

    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices
        .getUserMedia
    ) {

      alert(
        "تسجيل الصوت غير مدعوم في هذا المتصفح."
      );

      return;
    }

    if (
      mediaRecorder &&
      mediaRecorder.state ===
        "recording"
    ) {

      mediaRecorder.stop();

      recordingStream
        ?.getTracks()
        .forEach(
          track =>
            track.stop()
        );

      if ($("voiceBtn")) {

        $("voiceBtn").innerHTML =
          `
          <i class="fa-solid fa-microphone"></i>
          `;
      }

      return;
    }

    try {

      recordingStream =
        await navigator
          .mediaDevices
          .getUserMedia({
            audio: true
          });

      audioChunks = [];

      mediaRecorder =
        new MediaRecorder(
          recordingStream
        );

      mediaRecorder
        .ondataavailable =
        event => {

          if (event.data.size) {
            audioChunks.push(
              event.data
            );
          }
        };

      mediaRecorder.onstop =
        async () => {

          const blob =
            new Blob(
              audioChunks,
              {
                type:
                  mediaRecorder.mimeType ||
                  "audio/webm"
              }
            );

          window.__pendingAudioBlob =
            blob;

          try {

            const extension =
              String(
                blob.type || ""
              ).includes("ogg")
                ? "ogg"
                : String(
                    blob.type || ""
                  ).includes("mp4")
                  ? "m4a"
                  : "webm";

            const audioFile =
              new File(
                [blob],
                `voice-${Date.now()}.${extension}`,
                {
                  type:
                    blob.type ||
                    "audio/webm"
                }
              );

            await sendAttachment(
              audioFile
            );

          } catch (error) {

            console.error(
              "VOICE_SEND_ERROR:",
              error
            );

            if ($("attachmentInfo")) {

              $("attachmentInfo")
                .textContent =
                error.message ||
                "تعذر إرسال المقطع الصوتي.";
            }
          }
        };

      mediaRecorder.start();

      if ($("voiceBtn")) {

        $("voiceBtn").innerHTML =
          `
          <i
            class="fa-solid fa-stop"
            style="
              color:var(--accent-red)
            "
          ></i>
          `;
      }

    } catch (error) {

      alert(
        "تعذر الوصول إلى الميكروفون: " +
        error.message
      );
    }
  }

  async function sendAttachment(
    file
  ) {

    if (!selectedUser) {
      throw new Error(
        "اختر مستخدماً أولاً."
      );
    }

    if (!file) {
      throw new Error(
        "لم يتم اختيار ملف."
      );
    }

    const fileType =
      String(file.type || "")
        .toLowerCase();

    const isImage =
      fileType.startsWith("image/");

    const isAudio =
      fileType.startsWith("audio/");

    const messageType =
      isImage
        ? "image"
        : isAudio
          ? "audio"
          : "file";

    const body =
      isImage
        ? `📷 صورة: ${file.name || "صورة"}`
        : isAudio
          ? `🎵 مقطع صوتي: ${file.name || "صوت"}`
          : `📎 مرفق: ${file.name || "ملف"}`;

    const messageResult =
      await api(
        "/api/messages",
        {
          method: "POST",

          body:
            JSON.stringify({

              receiver_id:
                Number(
                  selectedUser.id
                ),

              message:
                body,

              message_type:
                messageType
            })
        }
      );

    const messageId =
      messageResult?.message?.id ||
      messageResult?.data?.id ||
      messageResult?.id;

    if (!messageId) {

      throw new Error(
        "تم إنشاء الرسالة ولكن لم يعطِ الخادم معرف الرسالة."
      );
    }

    const base64 =
      await new Promise(
        (
          resolve,
          reject
        ) => {

          const reader =
            new FileReader();

          reader.onload =
            () => {

              const value =
                String(
                  reader.result ||
                  ""
                );

              const comma =
                value.indexOf(",");

              resolve(
                comma >= 0
                  ? value.slice(
                      comma + 1
                    )
                  : value
              );
            };

          reader.onerror =
            () =>
              reject(
                new Error(
                  "تعذر قراءة الملف."
                )
              );

          reader.readAsDataURL(
            file
          );
        }
      );

    await api(
      "/api/attachments",
      {
        method: "POST",

        body:
          JSON.stringify({

            message_id:
              Number(messageId),

            filename:
              file.name ||
              (
                isImage
                  ? "image"
                  : "audio"
              ),

            mime_type:
              file.type ||
              "application/octet-stream",

            data_base64:
              base64
          })
      }
    );

    if ($("attachmentInfo")) {

      $("attachmentInfo")
        .textContent =
        isImage
          ? "تم إرسال الصورة بنجاح."
          : isAudio
            ? "تم إرسال المقطع الصوتي بنجاح."
            : "تم إرسال المرفق بنجاح.";
    }

    await loadMessagesFor(
      selectedUser.id
    );
  }

  window.sendAttachment =
    sendAttachment;

  window.toggleRecording =
    toggleRecording;

  async function createGroupFromUI() {

    const name = prompt("اسم المجموعة:");

    if (name === null) return;

    const groupName = name.trim();

    if (!groupName) {
      alert("اسم المجموعة مطلوب.");
      return;
    }

    if (groupName.length > 100) {
      alert("اسم المجموعة طويل جدًا.");
      return;
    }

    const description = prompt(
      "وصف المجموعة (اختياري):"
    );

    if (description === null) {
      return;
    }

    try {

      /*
       * جلب المستخدمين
       */
      const usersData = await api("/api/users");

      const users =
        Array.isArray(usersData)
          ? usersData
          : (
              usersData.users ||
              usersData.data ||
              []
            );

      const availableUsers =
        users.filter(user =>
          Number(user.id) !== Number(me?.id) &&
          String(user.status || "active") === "active"
        );

      if (!availableUsers.length) {
        throw new Error(
          "لا يوجد مستخدمون آخرون يمكن إضافتهم إلى المجموعة."
        );
      }

      /*
       * نافذة اختيار الأعضاء
       */
      const overlay = document.createElement("div");

      overlay.style.cssText = `
        position:fixed;
        inset:0;
        z-index:99999;
        background:rgba(0,0,0,.82);
        display:flex;
        align-items:center;
        justify-content:center;
        padding:16px;
        direction:rtl;
      `;

      const box = document.createElement("div");

      box.style.cssText = `
        width:min(480px,100%);
        max-height:85vh;
        overflow:hidden;
        background:#080d09;
        border:1px solid rgba(0,255,128,.35);
        border-radius:12px;
        box-shadow:0 0 30px rgba(0,255,128,.12);
        color:#fff;
        display:flex;
        flex-direction:column;
      `;

      const header = document.createElement("div");

      header.style.cssText = `
        padding:14px;
        border-bottom:1px solid rgba(0,255,128,.18);
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
      `;

      header.innerHTML = `
        <div>
          <div style="font-weight:700;color:#00ff80;font-size:16px">
            <i class="fa-solid fa-users"></i>
            اختيار أعضاء المجموعة
          </div>
          <div style="font-size:12px;color:#aaa;margin-top:4px">
            اختر المستخدمين الذين تريد إضافتهم
          </div>
        </div>

        <span
          id="groupSelectedCount"
          style="
            min-width:30px;
            text-align:center;
            padding:4px 8px;
            border-radius:12px;
            background:rgba(0,255,128,.10);
            border:1px solid rgba(0,255,128,.25);
            color:#00ff80;
            font-size:12px;
          "
        >0</span>
      `;

      const search = document.createElement("input");

      search.type = "text";
      search.placeholder = "بحث عن مستخدم...";
      search.autocomplete = "off";

      search.style.cssText = `
        margin:12px;
        width:calc(100% - 24px);
        box-sizing:border-box;
        padding:11px 12px;
        border-radius:8px;
        border:1px solid rgba(0,255,128,.25);
        background:#0d1510;
        color:#fff;
        outline:none;
        direction:rtl;
      `;

      const actionsTop = document.createElement("div");

      actionsTop.style.cssText = `
        display:flex;
        gap:8px;
        padding:0 12px 10px;
      `;

      const selectAllBtn = document.createElement("button");
      selectAllBtn.type = "button";
      selectAllBtn.textContent = "تحديد الكل";

      const clearAllBtn = document.createElement("button");
      clearAllBtn.type = "button";
      clearAllBtn.textContent = "إلغاء الكل";

      [selectAllBtn, clearAllBtn].forEach(btn => {
        btn.style.cssText = `
          flex:1;
          padding:9px;
          border-radius:7px;
          border:1px solid rgba(0,255,128,.25);
          background:rgba(0,255,128,.07);
          color:#00ff80;
          cursor:pointer;
          font-family:inherit;
        `;
      });

      actionsTop.appendChild(selectAllBtn);
      actionsTop.appendChild(clearAllBtn);

      const list = document.createElement("div");

      list.style.cssText = `
        overflow-y:auto;
        flex:1;
        min-height:150px;
        max-height:45vh;
        padding:0 12px 12px;
      `;

      const selectedIds = new Set();

      function updateSelectedCount() {
        const counter =
          box.querySelector("#groupSelectedCount");

        if (counter) {
          counter.textContent =
            String(selectedIds.size);
        }
      }

      function createUserRow(user) {

        const row = document.createElement("label");

        row.dataset.userSearch =
          `${user.username || ""} ${user.name || ""} ${user.full_name || ""}`
            .toLowerCase();

        row.style.cssText = `
          display:flex;
          align-items:center;
          gap:10px;
          padding:11px 10px;
          margin-bottom:6px;
          border:1px solid rgba(255,255,255,.08);
          border-radius:8px;
          background:rgba(255,255,255,.025);
          cursor:pointer;
          user-select:none;
        `;

        const checkbox =
          document.createElement("input");

        checkbox.type = "checkbox";
        checkbox.value = String(user.id);

        checkbox.style.cssText = `
          width:19px;
          height:19px;
          accent-color:#00ff80;
          flex-shrink:0;
        `;

        checkbox.addEventListener(
          "change",
          () => {

            const id = Number(user.id);

            if (checkbox.checked) {
              selectedIds.add(id);
              row.style.background =
                "rgba(0,255,128,.10)";
              row.style.borderColor =
                "rgba(0,255,128,.35)";
            } else {
              selectedIds.delete(id);
              row.style.background =
                "rgba(255,255,255,.025)";
              row.style.borderColor =
                "rgba(255,255,255,.08)";
            }

            updateSelectedCount();
          }
        );

        const avatar = document.createElement("div");

        avatar.style.cssText = `
          width:36px;
          height:36px;
          border-radius:50%;
          display:flex;
          align-items:center;
          justify-content:center;
          background:rgba(0,255,128,.10);
          border:1px solid rgba(0,255,128,.25);
          color:#00ff80;
          flex-shrink:0;
        `;

        avatar.innerHTML =
          '<i class="fa-solid fa-user"></i>';

        const info = document.createElement("div");

        info.style.cssText = `
          min-width:0;
          flex:1;
        `;

        const displayName =
          user.name ||
          user.full_name ||
          user.username ||
          `مستخدم ${user.id}`;

        const username =
          user.username ||
          "";

        info.innerHTML = `
          <div style="
            font-weight:700;
            color:#fff;
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
          ">
            ${escapeHtml(displayName)}
          </div>

          <div style="
            color:#888;
            font-size:11px;
            margin-top:3px;
          ">
            ${escapeHtml(username ? "@" + username : "ID: " + user.id)}
          </div>
        `;

        row.appendChild(checkbox);
        row.appendChild(avatar);
        row.appendChild(info);

        return row;
      }

      function renderUsers(filter = "") {

        list.innerHTML = "";

        const query =
          filter.trim().toLowerCase();

        let visible = 0;

        availableUsers.forEach(user => {

          const searchText =
            `${user.username || ""} ${user.name || ""} ${user.full_name || ""}`
              .toLowerCase();

          if (
            query &&
            !searchText.includes(query)
          ) {
            return;
          }

          list.appendChild(
            createUserRow(user)
          );

          visible++;
        });

        if (!visible) {

          const empty =
            document.createElement("div");

          empty.textContent =
            "لا يوجد مستخدم مطابق للبحث.";

          empty.style.cssText = `
            text-align:center;
            color:#888;
            padding:30px 10px;
          `;

          list.appendChild(empty);
        }
      }

      renderUsers();

      search.addEventListener(
        "input",
        () => renderUsers(search.value)
      );

      selectAllBtn.addEventListener(
        "click",
        () => {

          availableUsers.forEach(
            user => selectedIds.add(Number(user.id))
          );

          renderUsers(search.value);

          list
            .querySelectorAll('input[type="checkbox"]')
            .forEach(cb => {

              cb.checked = true;

              const row =
                cb.closest("label");

              if (row) {
                row.style.background =
                  "rgba(0,255,128,.10)";
                row.style.borderColor =
                  "rgba(0,255,128,.35)";
              }
            });

          updateSelectedCount();
        }
      );

      clearAllBtn.addEventListener(
        "click",
        () => {

          selectedIds.clear();

          list
            .querySelectorAll('input[type="checkbox"]')
            .forEach(cb => {

              cb.checked = false;

              const row =
                cb.closest("label");

              if (row) {
                row.style.background =
                  "rgba(255,255,255,.025)";
                row.style.borderColor =
                  "rgba(255,255,255,.08)";
              }
            });

          updateSelectedCount();
        }
      );

      const footer = document.createElement("div");

      footer.style.cssText = `
        display:flex;
        gap:8px;
        padding:12px;
        border-top:1px solid rgba(0,255,128,.18);
      `;

      const cancelBtn = document.createElement("button");

      cancelBtn.type = "button";
      cancelBtn.textContent = "إلغاء";

      const createBtn = document.createElement("button");

      createBtn.type = "button";
      createBtn.textContent =
        "إنشاء المجموعة وإضافة الأعضاء";

      [cancelBtn, createBtn].forEach(btn => {
        btn.style.cssText = `
          flex:1;
          padding:11px 8px;
          border-radius:8px;
          cursor:pointer;
          font-family:inherit;
          font-weight:700;
        `;
      });

      cancelBtn.style.background =
        "rgba(255,51,75,.08)";
      cancelBtn.style.border =
        "1px solid rgba(255,51,75,.30)";
      cancelBtn.style.color =
        "#ff334b";

      createBtn.style.background =
        "rgba(0,255,128,.10)";
      createBtn.style.border =
        "1px solid rgba(0,255,128,.35)";
      createBtn.style.color =
        "#00ff80";

      footer.appendChild(cancelBtn);
      footer.appendChild(createBtn);

      box.appendChild(header);
      box.appendChild(search);
      box.appendChild(actionsTop);
      box.appendChild(list);
      box.appendChild(footer);

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const closeSelector =
        () => overlay.remove();

      cancelBtn.addEventListener(
        "click",
        closeSelector
      );

      /*
       * إنشاء المجموعة بعد الاختيار
       */
      createBtn.addEventListener(
        "click",
        async () => {

          createBtn.disabled = true;
          cancelBtn.disabled = true;
          search.disabled = true;
          selectAllBtn.disabled = true;
          clearAllBtn.disabled = true;

          createBtn.textContent =
            "جاري إنشاء المجموعة...";

          try {

            const data = await api(
              "/api/groups",
              {
                method: "POST",
                body: JSON.stringify({
                  name: groupName,
                  description:
                    description.trim()
                })
              }
            );

            const group = data.group;

            if (!group || !group.id) {
              throw new Error(
                "الخادم لم يُرجع بيانات المجموعة."
              );
            }

            let addedCount = 0;
            const failedUsers = [];

            for (
              const userId of selectedIds
            ) {

              try {

                await api(
                  `/api/groups/${encodeURIComponent(group.id)}/members`,
                  {
                    method: "POST",
                    body: JSON.stringify({
                      user_id: userId
                    })
                  }
                );

                addedCount++;

              } catch (error) {

                console.error(
                  "add group member:",
                  userId,
                  error
                );

                failedUsers.push(userId);
              }
            }

            closeSelector();

            selectedUser = null;
            selectedGroup = group;

            await loadGroups();

            setText(
              "chatTitle",
              group.name ||
              "محادثة جماعية"
            );

            setText(
              "chatStatus",
              "محادثة جماعية"
            );

            await loadGroupMessages(
              group.id
            );

            if (failedUsers.length) {

              alert(
                `تم إنشاء المجموعة.\n` +
                `تمت إضافة ${addedCount} مستخدم.\n` +
                `تعذر إضافة ${failedUsers.length} مستخدم.`
              );

            } else {

              alert(
                `تم إنشاء المجموعة بنجاح.\n` +
                `تمت إضافة ${addedCount} مستخدم.`
              );
            }

          } catch (error) {

            console.error(
              "createGroupFromUI:",
              error
            );

            createBtn.disabled = false;
            cancelBtn.disabled = false;
            search.disabled = false;
            selectAllBtn.disabled = false;
            clearAllBtn.disabled = false;

            createBtn.textContent =
              "إنشاء المجموعة وإضافة الأعضاء";

            alert(
              error.message ||
              "تعذر إنشاء المجموعة."
            );
          }
        }
      );

      /*
       * إغلاق بالنقر خارج النافذة
       */
      overlay.addEventListener(
        "click",
        event => {
          if (event.target === overlay) {
            closeSelector();
          }
        }
      );

    } catch (error) {

      console.error(
        "createGroupFromUI:",
        error
      );

      alert(
        error.message ||
        "تعذر فتح قائمة المستخدمين."
      );
    }
  }

  function bindEvents() {

    $("loginForm")
      ?.addEventListener(
        "submit",
        login
      );

    $("logoutBtn")
      ?.addEventListener(
        "click",
        logout
      );

    $("sendForm")
      ?.addEventListener(
        "submit",
        sendMessage
      );

    $("createGroupBtn")
      ?.addEventListener(
        "click",
        createGroupFromUI
      );


    $("addUserBtn")
      ?.addEventListener(
        "click",
        createUserFromAdmin
      );

    $("manageUsersBtn")
      ?.addEventListener(
        "click",
        manageUsers
      );

    $("blockUserBtn")
      ?.addEventListener(
        "click",
        () =>
          userAction(
            "block"
          )
      );

    $("freezeUserBtn")
      ?.addEventListener(
        "click",
        () =>
          userAction(
            "freeze"
          )
      );

    $("releaseUserBtn")
      ?.addEventListener(
        "click",
        () =>
          userAction(
            "release"
          )
      );


    async function toggleAppLock() {
      if (!ensureAdmin()) return;

      const button = $("appLockBtn");
      if (!button) return;

      try {
        button.disabled = true;

        const current = await api("/api/app-lock", {
          method: "GET",
          cache: "no-store"
        });

        const currentlyLocked =
          current?.app_lock === true;

        const message = currentlyLocked
          ? "هل تريد إطلاق التطبيق وفك القفل عن المستخدمين العاديين؟"
          : "هل تريد قفل التطبيق على المستخدمين العاديين؟";

        if (!confirm(message)) {
          return;
        }

        const result = await api("/api/admin/app-lock", {
          method: "POST",
          body: JSON.stringify({
            locked: !currentlyLocked
          })
        });

        const locked =
          result?.app_lock === true;

        button.innerHTML = locked
          ? '<i class="fa-solid fa-unlock"></i> إطلاق التطبيق'
          : '<i class="fa-solid fa-lock"></i> قفل التطبيق';

        alert(
          result?.message ||
          (locked
            ? "تم قفل التطبيق."
            : "تم إطلاق التطبيق.")
        );

      } catch (error) {
        alert(
          error?.message ||
          "تعذر تغيير حالة قفل التطبيق."
        );
      } finally {
        button.disabled = false;
      }
    }


    $("appLockBtn")
      ?.addEventListener(
        "click",
        toggleAppLock
      );
    $("clearChatBtn")
      ?.addEventListener(
        "click",
        clearConversation
      );

    $("backupBtn")
      ?.addEventListener(
        "click",
        backupChats
      );

    $("locationsBtn")
      ?.addEventListener(
        "click",
        showLocations
      );

    $("warningsBtn")
      ?.addEventListener(
        "click",
        showWarnings
      );

    $("broadcastBtn")
      ?.addEventListener(
        "click",
        broadcast
      );

    $("syncServersBtn")
      ?.addEventListener(
        "click",
        syncServers
      );

    $("channelsBtn")
      ?.addEventListener(
        "click",
        showChannels
      );

    $("auditBtn")
      ?.addEventListener(
        "click",
        showAudit
      );

    $("updateDatabaseBtn")
      ?.addEventListener(
        "click",
        updateDatabase
      );

    $("alertModeBtn")
      ?.addEventListener(
        "click",
        toggleAlertMode
      );

    $("networkOffBtn")
      ?.addEventListener(
        "click",
        networkOff
      );

    $("networkRestartBtn")
      ?.addEventListener(
        "click",
        restartSystem
      );

    $("saveTeamBtn")
      ?.addEventListener(
        "click",
        saveTeam
      );

    $("voiceBtn")
      ?.addEventListener(
        "click",
        toggleRecording
      );

    $("closeModal")
      ?.addEventListener(
        "click",
        closeModal
      );

    $("attachBtn")
      ?.addEventListener(
        "click",
        () => {
          $("attachmentInput")?.click();
        }
      );

    $("cameraBtn")
      ?.addEventListener(
        "click",
        () => {
          $("cameraInput")?.click();
        }
      );

    $("cameraInput")
      ?.addEventListener(
        "change",
        async event => {

          const file =
            event.target.files?.[0];

          if (!file) return;

          try {

            await sendAttachment(file);

            if ($("attachmentInfo")) {
              $("attachmentInfo").textContent =
                "تم التقاط الصورة وإرسالها.";
            }

          } catch (error) {

            if ($("attachmentInfo")) {
              $("attachmentInfo").textContent =
                "تعذر إرسال الصورة: " +
                error.message;
            }
          }

          event.target.value = "";
        }
      );

    $("attachmentInput")
      ?.addEventListener(
        "change",
        async event => {

          const file =
            event.target.files?.[0];

          if (!file) return;

          try {

            await sendAttachment(
              file
            );

            if (
              $("attachmentInfo")
            ) {

              $("attachmentInfo")
                .textContent =
                "تم إرسال المرفق.";
            }

          } catch (error) {

            if (
              $("attachmentInfo")
            ) {

              $("attachmentInfo")
                .textContent =
                "تعذر إرسال المرفق: " +
                error.message;
            }
          }

          event.target.value = "";
        }
      );

    $("mobileBackBtn")
      ?.addEventListener(
        "click",
        () =>
          $("sidebar")
            ?.classList
            .remove(
              "open",
              "mobile-open"
            )
      );

    $("mobileMenuBtn")
      ?.addEventListener(
        "click",
        () =>
          $("sidebar")
            ?.classList
            .toggle(
              "open"
            )
      );

    window.addEventListener(
      "online",
      detectConnection
    );

    window.addEventListener(
      "offline",
      () =>
        connectionNotice(
          '<i class="fa-solid fa-power-off"></i> الجهاز غير متصل بالشبكة',
          "red"
        )
    );
  }

  function installReadyHook() {

    const oldReady =
      window.__secureMessengerReady;

    window.__secureMessengerReady =
      function() {

        if (
          typeof oldReady ===
          "function"
        ) {

          try {
            oldReady();
          } catch (_) {}
        }

        if (isAdmin()) {

          $("adminPanel")
            ?.classList
            .remove(
              "hidden"
            );

          refreshTeamStats();
        }
      };
  }

  function forceCleanInterface() {
    try {
      const loginPage = $("loginPage");
      const appPage = $("appPage");
      const locationGate = $("locationGate");
      const modal = $("modal");
      const lockScreen = $("lockScreen");
      const connection = $("connectionNotice");

      /*
        لا تسمح لأي شاشة ثابتة غير مطلوبة
        بحجب التطبيق بعد تسجيل الدخول.
      */
      locationGate?.classList.add("hidden");
      modal?.classList.add("hidden");
      lockScreen?.classList.add("hidden");

      if (connection) {
        connection.style.pointerEvents = "none";
      }

      if (token && me && me.id) {
        loginPage?.classList.add("hidden");

        if (appPage) {
          appPage.classList.remove("hidden");
          appPage.style.pointerEvents = "auto";
          appPage.style.visibility = "visible";
          appPage.style.zIndex = "1";
        }
      }

      const sidebar = $("sidebar");
      if (sidebar) {
        sidebar.classList.remove("open");
        sidebar.classList.remove("mobile-open");
      }

      console.log(
        "[UI] interface cleaned:",
        {
          token: !!token,
          user: !!me,
          appHidden: appPage?.classList.contains("hidden"),
          loginHidden: loginPage?.classList.contains("hidden"),
          locationHidden: locationGate?.classList.contains("hidden"),
          modalHidden: modal?.classList.contains("hidden"),
          lockHidden: lockScreen?.classList.contains("hidden")
        }
      );

    } catch (error) {
      console.warn("[UI] forceCleanInterface:", error);
    }
  }

  window.addEventListener(
    "DOMContentLoaded",
    () => {

      console.log("[STARTUP] DOMContentLoaded");

      /*
        ربط جميع الأزرار أولاً.
        لا ننتظر الخادم حتى تصبح الواجهة قابلة للتفاعل.
      */
      try {
        bindEvents();
        console.log("[STARTUP] bindEvents COMPLETE");
      } catch (error) {
        console.error("[STARTUP] bindEvents ERROR:", error);
      }

      try {
        installReadyHook();
        console.log("[STARTUP] installReadyHook COMPLETE");
      } catch (error) {
        console.error("[STARTUP] installReadyHook ERROR:", error);
      }

      /*
        تنظيف أي طبقة قد تكون ظاهرة فوق التطبيق.
      */
      forceCleanInterface();

      /*
        استعادة الجلسة بدون منع واجهة المستخدم.
      */
      Promise.resolve()
        .then(() => restoreSession())
        .then(() => {
          try {
            syncEmergencyAlert();
          } catch (error) {
            console.warn("[ALERT] initial sync:", error);
          }

          setInterval(() => {
            try {
              syncEmergencyAlert();
            } catch (error) {
              console.warn("[ALERT] polling:", error);
            }
          }, 5000);
        })
        .catch(error => {
          console.error("[STARTUP] restoreSession ERROR:", error);
        });

      setInterval(
        () => {
          try {
            detectConnection();
          } catch (error) {
            console.warn("[CONNECTION]", error);
          }
        },
        10000
      );

      console.log("[STARTUP] READY");
    }
  );


/* =========================================================
   PERSONAL_DATA_AND_REPORTS_V1
   البيانات الشخصية وتقارير المشرف
   إضافة مستقلة مع الحفاظ على الوظائف الحالية
========================================================= */

(function () {

    function pdEscape(value) {

        if (typeof escapeHtml === "function") {
            return escapeHtml(String(value ?? ""));
        }

        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }


    async function openPersonalDataForm() {

        try {

            const response =
                await api("/api/me/personal-data");

            const data =
                response?.data || {};

            showModal(
                "تسجيل البيانات الشخصية للمستخدم",
                `
                <div class="personal-data-form">

                    <div class="form-group">
                        <label>الرقم العسكري</label>
                        <input
                            id="personalMilitaryNumber"
                            type="text"
                            value="${pdEscape(data.military_number || "")}"
                            maxlength="100"
                            inputmode="numeric"
                            placeholder="أدخل الرقم العسكري"
                        >
                    </div>

                    <div class="form-group">
                        <label>الاسم الرباعي</label>
                        <input
                            id="personalFullName"
                            type="text"
                            value="${pdEscape(data.full_name || "")}"
                            maxlength="200"
                            autocomplete="name"
                            placeholder="أدخل الاسم الرباعي"
                        >
                    </div>

                    <div class="form-group">
                        <label>الكنية</label>
                        <input
                            id="personalNickname"
                            type="text"
                            value="${pdEscape(data.nickname || "")}"
                            maxlength="100"
                            placeholder="أدخل الكنية"
                        >
                    </div>

                    <div class="form-group">
                        <label>الرقم القومي</label>
                        <input
                            id="personalNationalId"
                            type="text"
                            value="${pdEscape(data.national_id || "")}"
                            maxlength="100"
                            inputmode="numeric"
                            placeholder="أدخل الرقم القومي"
                        >
                    </div>

                    <div class="form-group">
                        <label>المسمى الوظيفي</label>
                        <input
                            id="personalJobTitle"
                            type="text"
                            value="${pdEscape(data.job_title || "")}"
                            maxlength="200"
                            placeholder="أدخل المسمى الوظيفي"
                        >
                    </div>

                    <div class="form-group">
                        <label>الفرقة / التشكيل</label>
                        <input
                            id="personalDivision"
                            type="text"
                            value="${pdEscape(data.division || "")}"
                            maxlength="200"
                            placeholder="مثال: الفرقة الأولى"
                        >
                    </div>

                    <div class="form-group">
                        <label>الوحدة</label>
                        <input
                            id="personalUnit"
                            type="text"
                            value="${pdEscape(data.unit || "")}"
                            maxlength="200"
                            placeholder="أدخل اسم الوحدة"
                        >
                    </div>

                    <div class="form-group">
                        <label>الرتبة العسكرية</label>
                        <input
                            id="personalMilitaryRank"
                            type="text"
                            value="${pdEscape(data.military_rank || "")}"
                            maxlength="100"
                            placeholder="أدخل الرتبة العسكرية"
                        >
                    </div>

                    <div class="form-group">
                        <label>تاريخ الميلاد</label>
                        <input
                            id="personalBirthDate"
                            type="date"
                            value="${pdEscape(data.birth_date || "")}"
                        >
                    </div>

                    <div class="form-group">
                        <label>محل الميلاد</label>
                        <input
                            id="personalBirthplace"
                            type="text"
                            value="${pdEscape(data.birthplace || "")}"
                            maxlength="200"
                            placeholder="أدخل محل الميلاد"
                        >
                    </div>

                    <div class="form-group">
                        <label>المؤهل العلمي</label>
                        <input
                            id="personalEducation"
                            type="text"
                            value="${pdEscape(data.education || "")}"
                            maxlength="200"
                            placeholder="أدخل المؤهل العلمي"
                        >
                    </div>

                    <div class="form-group">
                        <label>رقم الهاتف</label>
                        <input
                            id="personalPhone"
                            type="tel"
                            value="${pdEscape(data.phone || "")}"
                            maxlength="30"
                            inputmode="tel"
                            placeholder="أدخل رقم الهاتف"
                        >
                    </div>

                    <div class="form-group">
                        <label>السكن الحالي</label>
                        <input
                            id="personalCurrentResidence"
                            type="text"
                            value="${pdEscape(data.current_residence || "")}"
                            maxlength="300"
                            placeholder="أدخل السكن الحالي"
                        >
                    </div>

                    <div class="form-group">
                        <label>اسم الجهة</label>
                        <input
                            id="personalOrganization"
                            type="text"
                            value="${pdEscape(data.organization || "")}"
                            maxlength="200"
                            placeholder="أدخل اسم الجهة"
                        >
                    </div>

                    <div class="form-group">
                        <label>صورة البطاقة الشخصية</label>
                        <input
                            id="personalIdCardImage"
                            type="file"
                            accept="image/*"
                        >
                        <div
                            id="personalIdCardImageStatus"
                            style="margin-top:6px;"
                        >
                            ${data.personal_id_card_image
                                ? "توجد صورة محفوظة مسبقاً"
                                : "لم يتم اختيار صورة"}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>صورة البطاقة العسكرية</label>
                        <input
                            id="personalMilitaryIdCardImage"
                            type="file"
                            accept="image/*"
                        >
                        <div
                            id="personalMilitaryIdCardImageStatus"
                            style="margin-top:6px;"
                        >
                            ${data.military_id_card_image
                                ? "توجد صورة محفوظة مسبقاً"
                                : "لم يتم اختيار صورة"}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>الملاحظات</label>
                        <textarea
                            id="personalNotes"
                            maxlength="2000"
                            rows="4"
                            placeholder="أدخل الملاحظات"
                        >${pdEscape(data.notes || "")}</textarea>
                    </div>

                    <button
                        id="savePersonalDataBtn"
                        class="primary"
                        type="button"
                    >
                        <i class="fa-solid fa-floppy-disk"></i>
                        حفظ البيانات
                    </button>

                    <div
                        id="personalDataMessage"
                        style="margin-top:10px;"
                    ></div>

                </div>
                `
            );

            setTimeout(() => {

                const btn =
                    document.getElementById(
                        "savePersonalDataBtn"
                    );

                btn?.addEventListener(
                    "click",
                    savePersonalData
                );

            }, 0);

        } catch (error) {

            console.error(
                "OPEN_PERSONAL_DATA_ERROR:",
                error
            );

            showModal(
                "البيانات الشخصية",
                `<div class="error-message">
                    تعذر تحميل البيانات الشخصية.
                </div>`
            );
        }
    }


    async function savePersonalData() {

        const getValue = (id) =>
            document.getElementById(id)?.value.trim() || "";

        const fullName =
            getValue("personalFullName");

        const militaryNumber =
            getValue("personalMilitaryNumber");

        const division =
            getValue("personalDivision");

        const unit =
            getValue("personalUnit");

        const nickname =
            getValue("personalNickname");

        const nationalId =
            getValue("personalNationalId");

        const jobTitle =
            getValue("personalJobTitle");

        const militaryRank =
            getValue("personalMilitaryRank");

        const birthDate =
            getValue("personalBirthDate");

        const birthplace =
            getValue("personalBirthplace");

        const education =
            getValue("personalEducation");

        const phone =
            getValue("personalPhone");

        const currentResidence =
            getValue("personalCurrentResidence");

        const organization =
            getValue("personalOrganization");

        const notes =
            getValue("personalNotes");

        const message =
            document.getElementById(
                "personalDataMessage"
            );

        if (!fullName) {

            if (message) {
                message.innerHTML =
                    `<div class="error-message">
                        الاسم الرباعي مطلوب.
                    </div>`;
            }

            return;
        }

        const btn =
            document.getElementById(
                "savePersonalDataBtn"
            );

        if (btn) {

            btn.disabled = true;

            btn.innerHTML =
                `<i class="fa-solid fa-spinner fa-spin"></i>
                 جارٍ الحفظ...`;
        }

        try {

            const readImage =
                (id, existingValue) =>
                    new Promise((resolve, reject) => {

                        const input =
                            document.getElementById(id);

                        const file =
                            input?.files?.[0];

                        if (!file) {
                            resolve(existingValue || "");
                            return;
                        }

                        if (!file.type.startsWith("image/")) {
                            reject(
                                new Error(
                                    "الملف المختار ليس صورة."
                                )
                            );
                            return;
                        }

                        if (file.size > 5 * 1024 * 1024) {
                            reject(
                                new Error(
                                    "حجم الصورة يجب ألا يتجاوز 5 ميجابايت."
                                )
                            );
                            return;
                        }

                        const reader =
                            new FileReader();

                        reader.onload = () =>
                            resolve(
                                String(
                                    reader.result || ""
                                )
                            );

                        reader.onerror = () =>
                            reject(
                                new Error(
                                    "تعذر قراءة الصورة."
                                )
                            );

                        reader.readAsDataURL(file);
                    });

            const personalIdCardImage =
                await readImage(
                    "personalIdCardImage",
                    ""
                );

            const militaryIdCardImage =
                await readImage(
                    "personalMilitaryIdCardImage",
                    ""
                );

            const result =
                await api(
                    "/api/me/personal-data",
                    {
                        method: "POST",

                        body: JSON.stringify({
                            full_name: fullName,
                            military_number: militaryNumber,
                            division: division,
                            unit: unit,
                            nickname: nickname,
                            national_id: nationalId,
                            job_title: jobTitle,
                            military_rank: militaryRank,
                            birth_date: birthDate,
                            birthplace: birthplace,
                            education: education,
                            phone: phone,
                            current_residence: currentResidence,
                            personal_id_card_image:
                                personalIdCardImage,
                            military_id_card_image:
                                militaryIdCardImage,
                            organization: organization,
                            notes: notes
                        })
                    }
                );

            if (message) {

                message.innerHTML =
                    `<div class="success-message">
                        ${pdEscape(
                            result?.message ||
                            "تم حفظ البيانات بنجاح."
                        )}
                    </div>`;
            }

            if (btn) {

                btn.disabled = false;

                btn.innerHTML =
                    `<i class="fa-solid fa-check"></i>
                     تم الحفظ`;
            }

        } catch (error) {

            console.error(
                "SAVE_PERSONAL_DATA_ERROR:",
                error
            );

            if (message) {

                message.innerHTML =
                    `<div class="error-message">
                        ${pdEscape(
                            error?.message ||
                            "تعذر حفظ البيانات."
                        )}
                    </div>`;
            }

            if (btn) {

                btn.disabled = false;

                btn.innerHTML =
                    `<i class="fa-solid fa-floppy-disk"></i>
                     حفظ البيانات`;
            }
        }
    }


    async function openUserReport(type) {

        const title =
            type === "credentials"
                ? "تقرير الحسابات"
                : "تقرير المستخدمين حسب الوحدة";

        showModal(
            title,
            `
            <div class="user-report-box">

                <div style="
                    display:flex;
                    gap:8px;
                    flex-wrap:wrap;
                    margin-bottom:12px;
                ">
                    <select
                        id="userReportSearchField"
                        style="min-width:170px;"
                    >
                        <option value="all">كل البيانات</option>
                        <option value="name">الاسم</option>
                        <option value="username">اسم المستخدم</option>
                        <option value="military_number">الرقم العسكري</option>
                        <option value="division">الفرقة</option>
                        <option value="unit">الوحدة</option>
                    </select>



                    <input
                        id="userReportSearch"
                        type="search"
                        placeholder="${
                            type === "credentials"
                                ? "ابحث بالاسم أو اسم المستخدم"
                                : "ابحث بالفرقة أو الوحدة أو الاسم أو الرقم العسكري"
                        }"
                        style="flex:1;min-width:220px;"
                    >

                    <button
                        id="runUserReportBtn"
                        class="primary"
                        type="button"
                    >
                        <i class="fa-solid fa-magnifying-glass"></i>
                        بحث
                    </button>

                    <button
                        id="printUserReportBtn"
                        class="secondary"
                        type="button"
                    >
                        <i class="fa-solid fa-print"></i>
                        طباعة
                    </button>

                </div>

                <div id="userReportCount"
                     style="margin-bottom:10px;">
                    أدخل كلمة البحث ثم اضغط بحث.
                </div>

                <div
                    id="userReportResult"
                    style="overflow:auto;"
                >
                </div>

            </div>
            `
        );

        setTimeout(() => {

            document
                .getElementById("runUserReportBtn")
                ?.addEventListener(
                    "click",
                    () => loadUserReport(type)
                );

            document
                .getElementById("printUserReportBtn")
                ?.addEventListener(
                    "click",
                    printUserReport
                );

            document
                .getElementById("userReportSearch")
                ?.addEventListener(
                    "keydown",
                    event => {

                        if (event.key === "Enter") {
                            loadUserReport(type);
                        }
                    }
                );

        }, 0);
    }


    async function loadUserReport(type) {

        const search =
            document.getElementById(
                "userReportSearch"
            )?.value.trim() || "";

        const resultBox =
            document.getElementById(
                "userReportResult"
            );

        const countBox =
            document.getElementById(
                "userReportCount"
            );

        if (resultBox) {

            resultBox.innerHTML =
                `<div>
                    جارٍ البحث...
                </div>`;
        }

        try {

            const query =
                new URLSearchParams();

            query.set("type", type);
            query.set("search", search);

            
              const searchField =
                  document.getElementById(
                      "userReportSearchField"
                  )?.value || "all";

              query.set("searchField", searchField);

              const result =
                  await api(
                    "/api/admin/user-reports?" +
                    query.toString()
                );

            const rows =
                Array.isArray(result?.rows)
                    ? result.rows
                    : [];

            if (countBox) {

                countBox.innerHTML =
                    `عدد النتائج:
                     <strong>${rows.length}</strong>`;
            }

            if (!rows.length) {

                if (resultBox) {

                    resultBox.innerHTML =
                        `<div>
                            لا توجد نتائج مطابقة.
                        </div>`;
                }

                return;
            }

            let html = "";

            if (type === "credentials") {

                html = `
                <table class="admin-table user-report-table">
                    <thead>
                        <tr>
                            <th>الاسم</th>
                            <th>اسم المستخدم</th>
                            <th>حالة كلمة المرور</th>
                            <th>الموقع الجغرافي</th>
                            <th>آخر تحديث</th>
                        </tr>
                    </thead>
                    <tbody>
                `;

                for (const row of rows) {

                    const lat =
                        Number(row.location_latitude);

                    const lng =
                        Number(row.location_longitude);

                    const hasLocation =
                        Number.isFinite(lat) &&
                        Number.isFinite(lng) &&
                        lat >= -90 &&
                        lat <= 90 &&
                        lng >= -180 &&
                        lng <= 180;

                    let locationHtml =
                        `<span>لا يوجد موقع مسجل</span>`;

                    let locationTime = "غير متوفر";

                    if (hasLocation) {

                        const mapUrl =
                            "https://www.openstreetmap.org/?mlat=" +
                            encodeURIComponent(lat) +
                            "&mlon=" +
                            encodeURIComponent(lng) +
                            "#map=17/" +
                            encodeURIComponent(lat) +
                            "/" +
                            encodeURIComponent(lng);

                        const accuracy =
                            Number(row.location_accuracy);

                        const accuracyText =
                            Number.isFinite(accuracy)
                                ? `<small>الدقة: ${pdEscape(
                                    String(Math.round(accuracy))
                                )} م</small>`
                                : "";

                        locationHtml = `
                            <div>
                                <strong>متاح</strong>

                                <div style="
                                    direction:ltr;
                                    text-align:center;
                                    margin:4px 0;
                                    white-space:nowrap;
                                ">
                                    ${pdEscape(lat.toFixed(6))},
                                    ${pdEscape(lng.toFixed(6))}
                                </div>

                                ${accuracyText}

                                <br>

                                <a
                                    href="${mapUrl}"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="secondary"
                                    style="
                                        display:inline-block;
                                        margin-top:5px;
                                        text-decoration:none;
                                        padding:6px 10px;
                                    "
                                >
                                    <i class="fa-solid fa-map-location-dot"></i>
                                    فتح الخريطة
                                </a>
                            </div>
                        `;

                        locationTime =
                            row.location_captured_at ||
                            row.location_created_at ||
                            "غير متوفر";
    }


                    html += `
                        <tr>
                            <td>${pdEscape(row.name)}</td>
                            <td>${pdEscape(row.username)}</td>
                            <td>${pdEscape(
                                row.password_status
                            )}</td>
                            <td>${locationHtml}</td>
                            <td>${pdEscape(locationTime)}</td>
                        </tr>
                    `;
                }

                html += `
                    </tbody>
                </table>
                `;

            } else {

                html = `
                <table class="admin-table user-report-table">
                    <thead>
                        <tr>
                            <th>الاسم</th>
                            <th>الرقم العسكري</th>
                            <th>الفرقة</th>
                            <th>الوحدة</th>
                            <th>الموقع الجغرافي</th>
                            <th>آخر تحديث</th>
                        </tr>
                    </thead>
                    <tbody>
                `;

                for (const row of rows) {

                    const lat =
                        Number(row.location_latitude);

                    const lng =
                        Number(row.location_longitude);

                    const hasLocation =
                        Number.isFinite(lat) &&
                        Number.isFinite(lng) &&
                        lat >= -90 &&
                        lat <= 90 &&
                        lng >= -180 &&
                        lng <= 180;

                    let locationHtml =
                        `<span>لا يوجد موقع مسجل</span>`;

                    let locationTime =
                        "غير متوفر";

                    if (hasLocation) {

                        const mapUrl =
                            "https://www.openstreetmap.org/?mlat=" +
                            encodeURIComponent(lat) +
                            "&mlon=" +
                            encodeURIComponent(lng) +
                            "#map=17/" +
                            encodeURIComponent(lat) +
                            "/" +
                            encodeURIComponent(lng);

                        const accuracy =
                            Number(row.location_accuracy);

                        const accuracyText =
                            Number.isFinite(accuracy)
                                ? `<small>الدقة: ${pdEscape(
                                    String(Math.round(accuracy))
                                )} م</small>`
                                : "";

                        locationHtml = `
                            <div>
                                <strong>متاح</strong>

                                <div style="
                                    direction:ltr;
                                    text-align:center;
                                    margin:4px 0;
                                    white-space:nowrap;
                                ">
                                    ${pdEscape(lat.toFixed(6))},
                                    ${pdEscape(lng.toFixed(6))}
                                </div>

                                ${accuracyText}

                                <br>

                                <a
                                    href="${mapUrl}"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="secondary"
                                    style="
                                        display:inline-block;
                                        margin-top:5px;
                                        text-decoration:none;
                                        padding:6px 10px;
                                    "
                                >
                                    <i class="fa-solid fa-map-location-dot"></i>
                                    فتح الخريطة
                                </a>
                            </div>
                        `;

                        locationTime =
                            row.location_captured_at ||
                            row.location_created_at ||
                            "غير متوفر";
                    }

                    html += `
                        <tr>
                            <td>${pdEscape(row.name)}</td>

                            <td>${pdEscape(
                                row.military_number
                            )}</td>

                            <td>${pdEscape(
                                row.division
                            )}</td>

                            <td>${pdEscape(
                                row.unit
                            )}</td>

                            <td>${locationHtml}</td>

                            <td>${pdEscape(
                                locationTime
                            )}</td>
                        </tr>
                    `;
                }

                html += `
                    </tbody>
                </table>
                `;
            }

            if (resultBox) {
                resultBox.innerHTML = html;
            }

        } catch (error) {

            console.error(
                "LOAD_USER_REPORT_ERROR:",
                error
            );

            if (resultBox) {

                resultBox.innerHTML =
                    `<div class="error-message">
                        تعذر تحميل التقرير.
                    </div>`;
            }
        }
    }


    
function openMapPage(mapUrl) {

    if (!mapUrl) {
        alert("لا توجد إحداثيات صالحة لهذا المستخدم.");
        return;
    }

    const page = document.createElement("div");

    page.id = "standaloneMapPage";

    page.style.cssText =
        "position:fixed;" +
        "inset:0;" +
        "z-index:999999;" +
        "display:flex;" +
        "flex-direction:column;" +
        "background:#080d09;" +
        "color:#fff;" +
        "font-family:Cairo,Arial,sans-serif;";

    page.innerHTML =
        '<div style="' +
            'height:60px;' +
            'min-height:60px;' +
            'display:flex;' +
            'align-items:center;' +
            'gap:12px;' +
            'padding:8px 12px;' +
            'box-sizing:border-box;' +
            'background:#075e54;' +
        '">' +

            '<button id="standaloneMapBack" type="button" ' +
                'style="' +
                    'border:0;' +
                    'background:#ffffff22;' +
                    'color:#fff;' +
                    'border-radius:8px;' +
                    'padding:10px 16px;' +
                    'font-size:16px;' +
                    'font-weight:700;' +
                '">' +
                '<i class="fa-solid fa-arrow-right"></i> عودة' +
            '</button>' +

            '<div style="' +
                'flex:1;' +
                'text-align:center;' +
                'font-size:18px;' +
                'font-weight:700;' +
            '">' +
                'موقع المستخدم' +
            '</div>' +

        '</div>' +

        '<div style="flex:1;min-height:0;background:#222;">' +

            '<iframe ' +
                'src="' + mapUrl + '" ' +
                'title="خريطة موقع المستخدم" ' +
                'style="width:100%;height:100%;border:0;display:block;" ' +
                'loading="eager" ' +
                'allowfullscreen>' +
            '</iframe>' +

        '</div>' +

        '<div style="' +
            'padding:10px;' +
            'text-align:center;' +
            'background:#111b21;' +
            'color:#8696a0;' +
            'font-size:12px;' +
        '">' +
            'خريطة موقع المستخدم' +
        '</div>';

    document.body.appendChild(page);

    document
        .getElementById("standaloneMapBack")
        ?.addEventListener("click", function () {

            page.remove();

        });
}

function printUserReport() {

        const resultBox =
            document.getElementById(
                "userReportResult"
            );

        if (!resultBox ||
            !resultBox.innerHTML.trim()) {

            alert(
                "قم بإجراء البحث أولاً."
            );

            return;
        }

        const title =
            document.getElementById(
                "modalTitle"
            )?.textContent ||
            "تقرير المستخدمين";

        const printWindow =
            window.open(
                "",
                "_blank",
                "width=1000,height=700"
            );

        if (!printWindow) {

            alert(
                "تعذر فتح نافذة الطباعة."
            );

            return;
        }

        printWindow.document.write(`
            <!doctype html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="utf-8">
                <title>${pdEscape(title)}</title>

                <style>
                    body {
                        font-family: Arial, sans-serif;
                        direction: rtl;
                        padding: 30px;
                    }

                    h1 {
                        text-align: center;
                        margin-bottom: 25px;
                    }

                    table {
                        width: 100%;
                        border-collapse: collapse;
                    }

                    th, td {
                        border: 1px solid #222;
                        padding: 10px;
                        text-align: right;
                    }

                    th {
                        font-weight: bold;
                    }

                    @media print {
                        body {
                            padding: 10px;
                        }
                    }
                </style>
            </head>

            <body>

                <h1>${pdEscape(title)}</h1>

                ${resultBox.innerHTML}

            </body>
            </html>
        `);

        printWindow.document.close();

        setTimeout(() => {

            printWindow.focus();
            printWindow.print();

        }, 300);
    }


    document.addEventListener(
        "DOMContentLoaded",
        () => {

            document
                .getElementById("personalDataBtn")
                ?.addEventListener(
                    "click",
                    openPersonalDataForm
                );

            document
                .getElementById("userReportsBtn")
                ?.addEventListener(
                    "click",
                    () => openUserReport("unit")
                );

            document
                .getElementById("credentialsReportBtn")
                ?.addEventListener(
                    "click",
                    () => openUserReport("credentials")
                );
        }
    );

})();

})();





/* SECURE MESSENGER - ADMIN DATA PAGES */

(function () {
  "use strict";

  function el(id) {
    return document.getElementById(id);
  }

  function adminPanelVisible() {
    return isAdmin();
  }

  function setActiveButton(activeId) {

    const messages = el("messagesPageBtn");
    const admin = el("adminDataPageBtn");

    [messages, admin].forEach(function (button) {

      if (!button) {
        return;
      }

      button.style.borderColor = "";
      button.style.boxShadow = "";
      button.style.color = "";

    });

    const active = el(activeId);

    if (active) {
      active.style.borderColor = "#00ff80";
      active.style.boxShadow =
        "0 0 12px rgba(0,255,128,.20)";
      active.style.color = "#00ff80";
    }
  }

  function updatePagesVisibility() {

    const nav = el("mainPagesNav");
    const adminButton = el("adminDataPageBtn");

    if (!nav) {
      return;
    }

    /*
      لا يظهر شريط الصفحات إلا بعد ظهور التطبيق.
      ولا يظهر زر بيانات المشرف إلا إذا كان الحساب
      مشرفاً وفقاً لحالة adminPanel الحالية.
    */

    const app = el("appPage");

    /*
     * mainPagesNav أصبح داخل appPage،
     * لذلك لا نحتاج إلى الاعتماد على class hidden هنا.
     */
    if (nav && app) {
      nav.classList.remove("hidden");
    }

    if (adminButton) {

      if (adminPanelVisible()) {
        adminButton.classList.remove("hidden");
      } else {
        adminButton.classList.add("hidden");
      }

    }
  }

  function openMessagesPage() {

    const app = el("appPage");
    const adminPage = el("adminDataPage");

    if (!app || !adminPage) {
      return;
    }

    /* إعادة لوحة المشرف إلى موضعها الأصلي */
    const panel = el("adminPanel");

    if (
      panel &&
      window.__adminPanelOriginalSlot &&
      window.__adminPanelOriginalSlot.parentElement
    ) {
      const slot = window.__adminPanelOriginalSlot;

      if (panel.parentElement !== slot.parentElement) {
        slot.parentElement.insertBefore(panel, slot.nextSibling);
      }
    }

    app.classList.remove("hidden");
    adminPage.classList.add("hidden");

    setActiveButton("messagesPageBtn");

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  function openAdminDataPage() {

    const app = el("appPage");
    const adminPage = el("adminDataPage");
    const adminContent = el("adminDataPageContent");
    const panel = el("adminPanel");

    if (
      !app ||
      !adminPage ||
      !adminContent ||
      !panel
    ) {
      return;
    }

    /*
      حماية الواجهة:
      الحساب العادي لا يستطيع فتح الصفحة.
      والصلاحيات الحقيقية تبقى محمية من الخادم.
    */

    if (!adminPanelVisible()) {

      alert(
        "هذه الصفحة مخصصة لمشرف النظام فقط."
      );

      return;
    }

    /*
      نقل نفس عنصر adminPanel،
      وليس نسخة منه.

      بذلك تبقى جميع الأزرار والوظائف
      الحالية مرتبطة بنفس العناصر.
    */


    /* حفظ الموضع الأصلي للوحة المشرف */
    if (!window.__adminPanelOriginalSlot) {
      const slot = document.createElement("span");
      slot.id = "adminPanelOriginalSlot";
      slot.style.display = "none";
      panel.parentElement.insertBefore(slot, panel);
      window.__adminPanelOriginalSlot = slot;
    }

    if (panel.parentElement !== adminContent) {
      adminContent.appendChild(panel);
    }

    app.classList.add("hidden");
    adminPage.classList.remove("hidden");

    setActiveButton("adminDataPageBtn");

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  function installAdminPages() {

    const messagesButton = el("messagesPageBtn");
    const adminButton = el("adminDataPageBtn");
    const backButton = el("adminDataBackBtn");

    if (
      messagesButton &&
      !messagesButton.dataset.pagesReady
    ) {

      messagesButton.dataset.pagesReady = "1";

      messagesButton.addEventListener(
        "click",
        openMessagesPage
      );

    }

    if (
      adminButton &&
      !adminButton.dataset.pagesReady
    ) {

      adminButton.dataset.pagesReady = "1";

      adminButton.addEventListener(
        "click",
        openAdminDataPage
      );

    }

    if (
      backButton &&
      !backButton.dataset.pagesReady
    ) {

      backButton.dataset.pagesReady = "1";

      backButton.addEventListener(
        "click",
        openMessagesPage
      );

    }

    updatePagesVisibility();

    const panel = el("adminPanel");

    if (
      panel &&
      !panel.dataset.pagesObserver
    ) {

      panel.dataset.pagesObserver = "1";

      const observer =
        new MutationObserver(function () {

          updatePagesVisibility();

        });

      observer.observe(panel, {
        attributes: true,
        attributeFilter: [
          "class",
          "style"
        ]
      });

    }

    /*
      بعد تسجيل الدخول وتهيئة التطبيق،
      نعيد فحص الصلاحيات.
    */

    [300, 800, 1500, 3000].forEach(
      function (delay) {

        setTimeout(
          updatePagesVisibility,
          delay
        );

      }
    );

  }

  if (
    document.readyState === "loading"
  ) {

    document.addEventListener(
      "DOMContentLoaded",
      installAdminPages,
      { once: true }
    );

  } else {

    installAdminPages();

  }

  window.openMessagesPage =
    openMessagesPage;

  window.openAdminDataPage =
    openAdminDataPage;

})();


/* =========================================================
   SECURE MESSENGER - KEYBOARD COMPOSER V4
   Android keyboard / Visual Viewport
   لا ينقل sendForm ولا يغيّر منطق الإرسال
========================================================= */

(function () {

  "use strict";

  let input = null;
  let composer = null;
  let messages = null;
  let viewport = null;

  let installed = false;
  let rafId = 0;

  function getElements() {
    input = document.getElementById("messageInput");
    composer = document.getElementById("sendForm");
    messages = document.getElementById("messages");
    viewport = window.visualViewport || null;
  }

  function setKeyboardHeight() {

    if (!viewport) {
      document.documentElement.style.setProperty(
        "--keyboard-height",
        "0px"
      );
      return;
    }

    const keyboardHeight = Math.max(
      0,
      Math.round(
        window.innerHeight -
        viewport.height -
        viewport.offsetTop
      )
    );

    document.documentElement.style.setProperty(
      "--keyboard-height",
      keyboardHeight + "px"
    );
  }

  function resizeInput() {

    if (!input) return;

    input.style.setProperty(
      "height",
      "auto",
      "important"
    );

    const min = 52;
    const max = 150;

    const wanted = Math.max(
      min,
      Math.min(input.scrollHeight, max)
    );

    input.style.setProperty(
      "height",
      wanted + "px",
      "important"
    );

    input.style.setProperty(
      "min-height",
      min + "px",
      "important"
    );

    input.style.setProperty(
      "max-height",
      max + "px",
      "important"
    );

    input.style.setProperty(
      "resize",
      "none",
      "important"
    );

    input.style.setProperty(
      "overflow-y",
      input.scrollHeight > max ? "auto" : "hidden",
      "important"
    );
  }

  function keepCaretVisible() {

    if (!input) return;

    try {
      input.scrollTop = input.scrollHeight;
    } catch (e) {}
  }

  function updateLayout() {

    if (!installed) return;

    setKeyboardHeight();
    resizeInput();

    /*
     * لا نستخدم scrollIntoView.
     * لا نغيّر focus.
     * لا ننقل sendForm.
     */

    cancelAnimationFrame(rafId);

    rafId = requestAnimationFrame(function () {

      if (
        document.activeElement === input &&
        viewport &&
        viewport.height < window.innerHeight
      ) {
        keepCaretVisible();
      }

    });
  }

  function install() {

    getElements();

    if (!input || !composer) {
      setTimeout(install, 500);
      return;
    }

    if (input.dataset.secureKeyboardV4 === "1") {
      return;
    }

    input.dataset.secureKeyboardV4 = "1";
    installed = true;

    /*
     * Composer نفسه يبقى داخل chat.
     * لا نستخدم position: fixed.
     * لا نستخدم transform على body.
     */

    input.addEventListener(
      "input",
      function () {
        resizeInput();
      },
      { passive: true }
    );

    input.addEventListener(
      "focus",
      function () {

        setTimeout(function () {
          updateLayout();
        }, 50);

        setTimeout(function () {
          updateLayout();
        }, 180);

      },
      { passive: true }
    );

    input.addEventListener(
      "blur",
      function () {

        setTimeout(function () {
          setKeyboardHeight();
        }, 100);

      },
      { passive: true }
    );

    input.addEventListener(
      "click",
      function () {
        setTimeout(keepCaretVisible, 50);
      },
      { passive: true }
    );

    input.addEventListener(
      "touchend",
      function () {
        setTimeout(updateLayout, 80);
      },
      { passive: true }
    );

    if (viewport) {

      viewport.addEventListener(
        "resize",
        updateLayout,
        { passive: true }
      );

      viewport.addEventListener(
        "scroll",
        updateLayout,
        { passive: true }
      );

    }

    window.addEventListener(
      "resize",
      updateLayout,
      { passive: true }
    );

    window.addEventListener(
      "orientationchange",
      function () {
        setTimeout(updateLayout, 150);
      },
      { passive: true }
    );

    resizeInput();
    setKeyboardHeight();
  }

  function start() {

    install();

    [500, 1000, 2000, 3000, 5000].forEach(
      function (delay) {
        setTimeout(install, delay);
      }
    );
  }

  if (document.readyState === "loading") {

    document.addEventListener(
      "DOMContentLoaded",
      start,
      { once: true }
    );

  } else {

    start();

  }

})();

/* REQUIRED_PERMISSIONS_AUDIO_GPS_V1 */
(function () {
  "use strict";

  let permissionsReady = false;
  let audioContext = null;
  let audioStream = null;

  function permissionEl(id) {
    return document.getElementById(id);
  }

  function setPermissionStatus(id, text, ok) {
    const el = permissionEl(id);
    if (!el) return;

    const span = el.querySelector("span");
    if (span) {
      span.textContent = text;
      span.style.color = ok ? "#00ff80" : "#ff334b";
    }
  }

  function showPermissionGate(show) {
    const gate = permissionEl("requiredPermissionsGate");
    if (!gate) return;

    gate.classList.toggle("hidden", !show);
    gate.style.display = show ? "flex" : "none";
  }

  async function requestGPS() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        setPermissionStatus(
          "permissionGpsStatus",
          "غير مدعوم في هذا الجهاز",
          false
        );
        resolve(false);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        function (position) {
          window.secureMessengerGPS = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: Date.now()
          };

          setPermissionStatus(
            "permissionGpsStatus",
            "تم السماح بالموقع",
            true
          );

          resolve(true);
        },
        function (error) {
          console.warn("GPS permission:", error);

          setPermissionStatus(
            "permissionGpsStatus",
            "لم يتم السماح بالموقع",
            false
          );

          resolve(false);
        },
        {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0
        }
      );
    });
  }

  async function requestMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setPermissionStatus(
        "permissionMicStatus",
        "الميكروفون غير مدعوم",
        false
      );
      return false;
    }

    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      });

      window.secureMessengerAudioStream = audioStream;

      setPermissionStatus(
        "permissionMicStatus",
        "تم السماح بالميكروفون",
        true
      );

      return true;
    } catch (error) {
      console.warn("Microphone permission:", error);

      setPermissionStatus(
        "permissionMicStatus",
        "لم يتم السماح بالميكروفون",
        false
      );

      return false;
    }
  }

  async function prepareAudio() {
    try {
      const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContextClass) {
        setPermissionStatus(
          "permissionAudioStatus",
          "الصوت غير مدعوم",
          false
        );
        return false;
      }

      audioContext = new AudioContextClass();

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      window.secureMessengerAudioContext = audioContext;

      setPermissionStatus(
        "permissionAudioStatus",
        "الصوت والسماعة جاهزان",
        true
      );

      return true;
    } catch (error) {
      console.warn("Audio initialization:", error);

      setPermissionStatus(
        "permissionAudioStatus",
        "تعذر تهيئة الصوت",
        false
      );

      return false;
    }
  }

  async function enableRequiredPermissions() {
    const button = permissionEl("requestRequiredPermissionsBtn");
    const error = permissionEl("permissionError");

    if (button) {
      button.disabled = true;
      button.style.opacity = "0.6";
      button.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> جارٍ التفعيل...';
    }

    if (error) {
      error.textContent = "";
    }

    const gpsOK = await requestGPS();
    const micOK = await requestMicrophone();
    const audioOK = await prepareAudio();

    permissionsReady = gpsOK && micOK && audioOK;

    if (permissionsReady) {
      window.secureMessengerPermissionsReady = true;
      showPermissionGate(false);

      if (button) {
        button.disabled = false;
        button.style.opacity = "1";
        button.innerHTML =
          '<i class="fa-solid fa-check"></i> تم التفعيل';
      }

      return true;
    }

    if (error) {
      error.textContent =
        "يجب السماح بالموقع والميكروفون وتفعيل الصوت للمتابعة.";
    }

    if (button) {
      button.disabled = false;
      button.style.opacity = "1";
      button.innerHTML =
        '<i class="fa-solid fa-rotate-right"></i> المحاولة مرة أخرى';
    }

    return false;
  }

  function installRequiredPermissions() {
    const button =
      permissionEl("requestRequiredPermissionsBtn");

    if (!button) return;

    button.addEventListener(
      "click",
      enableRequiredPermissions,
      { passive: true }
    );

    /*
     * إظهار البوابة عند فتح التطبيق لأول مرة
     * إذا لم تكن الأذونات قد جهزت.
     */
    if (!window.secureMessengerPermissionsReady) {
      showPermissionGate(true);
    }
  }

  window.secureMessengerRequestPermissions =
    enableRequiredPermissions;

  window.secureMessengerPermissionsReady =
    false;

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      installRequiredPermissions,
      { once: true }
    );
  } else {
    installRequiredPermissions();
  }
})();
