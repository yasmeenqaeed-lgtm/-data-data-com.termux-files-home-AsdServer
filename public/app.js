



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

  // قائمة المستخدمين الحالية المستخدمة في البحث
  let currentUsersList = [];

  /*
   * حماية من تعارض تسجيل الدخول مع restoreSession.
   * كل عملية مصادقة جديدة تحصل على رقم إصدار جديد.
   */
  let authGeneration = 0;
  let selectedUser = null;
  let selectedGroup = null;
  let selectedAdminUser = null;
  let onlineUsers = new Set();

  /* =======================================================
     SOCKET.IO / المزامنة الفورية لرسالة للجميع
  ======================================================= */

  let messengerSocket = null;


  /* =========================================================
     ONE-TO-ONE VOICE CALL / WEBRTC
     مستقل تماماً عن Live Audio Broadcast
     ========================================================= */

  let voiceCallPeer = null;
  let voiceCallStream = null;
  let voiceCallRemoteAudio = null;
  let voiceCallTargetUserId = null;
  let voiceCallTargetNumber = "";
  let voiceCallDirection = "";
  let voiceCallId = "";
  let voiceCallIceQueue = [];

  async function voiceCallFlushIceQueue() {
    if (
      !voiceCallPeer ||
      !voiceCallPeer.remoteDescription ||
      !voiceCallIceQueue.length
    ) {
      return;
    }

    const queued = voiceCallIceQueue.splice(
      0,
      voiceCallIceQueue.length
    );

    for (const candidate of queued) {
      try {
        await voiceCallPeer.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      } catch (error) {
        console.warn(
          "[VOICE CALL] queued ICE error:",
          error?.message || error
        );
      }
    }
  }

  function voiceCallSetStatus(message) {
    const el = document.getElementById("voiceCallStatus");
    if (el) el.textContent = String(message || "");
  }

  function voiceCallSetButtons(active) {
    const start = document.getElementById("voiceCallStartBtn");
    const end = document.getElementById("voiceCallEndBtn");

    if (start) start.disabled = !!active;
    if (end) end.disabled = !active;
  }

  function voiceCallCleanupPeer() {
    try {
      if (voiceCallPeer) {
        voiceCallPeer.onicecandidate = null;
        voiceCallPeer.ontrack = null;
        voiceCallPeer.onconnectionstatechange = null;
        voiceCallPeer.close();
      }
    } catch (_) {}

    voiceCallPeer = null;
  }

  function voiceCallCleanupMedia() {
    try {
      if (voiceCallStream) {
        voiceCallStream.getTracks().forEach(track => {
          try { track.stop(); } catch (_) {}
        });
      }
    } catch (_) {}

    voiceCallStream = null;

    if (voiceCallRemoteAudio) {
      try {
        voiceCallRemoteAudio.pause();
        voiceCallRemoteAudio.srcObject = null;
        voiceCallRemoteAudio.remove();
      } catch (_) {}
    }

    voiceCallRemoteAudio = null;
  }

  function voiceCallResetState() {
    voiceCallCleanupPeer();
    voiceCallCleanupMedia();

    voiceCallTargetUserId = null;
    voiceCallTargetNumber = "";
    voiceCallDirection = "";
    voiceCallId = "";
    voiceCallIceQueue = [];

    try {
      if (typeof callActive !== "undefined") {
        callActive = false;
      }
    } catch (_) {}

    voiceCallSetButtons(false);
  }

  function voiceCallEnd(sendSignal = true) {
    if (
      sendSignal &&
      messengerSocket &&
      messengerSocket.connected &&
      voiceCallTargetUserId
    ) {
      try {
        messengerSocket.emit("voice_call_end", {
          target_user_id: voiceCallTargetUserId,
          voice_call_number: voiceCallTargetNumber,
          call_id: voiceCallId,
          reason: "ended"
        });
      } catch (error) {
        console.warn(
          "[VOICE CALL] end signal:",
          error.message
        );
      }
    }

    voiceCallResetState();
  }

  async function voiceCallGetMicrophone() {
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      throw new Error("المتصفح لا يدعم الميكروفون");
    }

    if (!voiceCallStream) {
      voiceCallStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });
    }

    return voiceCallStream;
  }

  function voiceCallCreatePeer() {
    voiceCallCleanupPeer();

    voiceCallPeer =
      new RTCPeerConnection({
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" }
        ]
      });

    if (voiceCallStream) {
      voiceCallStream.getTracks().forEach(track => {
        voiceCallPeer.addTrack(
          track,
          voiceCallStream
        );
      });
    }

    voiceCallPeer.onicecandidate = event => {
      if (
        !event.candidate ||
        !messengerSocket ||
        !messengerSocket.connected ||
        !voiceCallTargetUserId
      ) {
        return;
      }

      messengerSocket.emit(
        "voice_call_ice",
        {
          target_user_id:
            voiceCallTargetUserId,
          call_id:
            voiceCallId,
          candidate:
            event.candidate
        }
      );
    };

    voiceCallPeer.ontrack = event => {
      try {
        if (!voiceCallRemoteAudio) {
          voiceCallRemoteAudio =
            document.createElement("audio");

          voiceCallRemoteAudio.autoplay = true;
          voiceCallRemoteAudio.playsInline = true;
          voiceCallRemoteAudio.style.display = "none";

          document.body.appendChild(
            voiceCallRemoteAudio
          );
        }

        const remoteStream =
          event.streams &&
          event.streams[0]
            ? event.streams[0]
            : null;

        if (remoteStream) {
          voiceCallRemoteAudio.srcObject =
            remoteStream;

          const result =
            voiceCallRemoteAudio.play();

          if (
            result &&
            typeof result.catch === "function"
          ) {
            result.catch(error => {
              console.warn(
                "[VOICE CALL] audio play:",
                error.message
              );
            });
          }
        }
      } catch (error) {
        console.warn(
          "[VOICE CALL] remote track:",
          error.message
        );
      }
    };

    voiceCallPeer.onconnectionstatechange =
      () => {
        if (!voiceCallPeer) return;

        const state =
          voiceCallPeer.connectionState;

        if (state === "connected") {
          voiceCallSetStatus(
            "تم الاتصال الصوتي"
          );
        } else if (state === "connecting") {
          voiceCallSetStatus(
            "جاري إنشاء الاتصال الصوتي..."
          );
        } else if (
          state === "failed" ||
          state === "disconnected"
        ) {
          voiceCallSetStatus(
            "انقطع الاتصال الصوتي"
          );
        }
      };

    return voiceCallPeer;
  }

  function setupVoiceCallSocketHandlers(socket) {
    if (
      !socket ||
      socket.__voiceCallHandlersInstalled
    ) {
      return;
    }

    socket.__voiceCallHandlersInstalled =
      true;

    socket.on(
      "voice_call_ringing",
      data => {
        console.log(
          "[VOICE CALL] ringing",
          data
        );

        voiceCallSetStatus(
          "جاري انتظار رد المستخدم..."
        );
      }
    );

    socket.on(
      "voice_call_unavailable",
      data => {
        voiceCallSetStatus(
          data?.message ||
          "المستخدم غير متاح حالياً"
        );

        voiceCallResetState();
      }
    );

    socket.on(
      "voice_call_incoming",
      async data => {
        if (!data) return;

        console.log(
          "[VOICE CALL] incoming",
          data
        );

        const callerId =
          data.from_user_id ?? null;

        const callerName =
          data.from_name ||
          data.from_username ||
          "مستخدم";

        const callerNumber =
          data.from_voice_call_number ||
          "";

        voiceCallId =
          String(data.call_id || "");

        if (!callerId) {
          console.warn(
            "[VOICE CALL] missing caller id"
          );
          return;
        }

        if (voiceCallTargetUserId) {
          socket.emit(
            "voice_call_reject",
            {
              from_user_id: callerId,
              call_id: voiceCallId,
              reason: "busy"
            }
          );
          return;
        }

        const answer =
          window.confirm(
            "مكالمة صوتية واردة من " +
            callerName +
            "\n\nهل تريد الرد؟"
          );

        if (!answer) {
          socket.emit(
            "voice_call_reject",
            {
              from_user_id: callerId,
              voice_call_number:
                callerNumber,
              call_id: voiceCallId,
              reason: "rejected"
            }
          );
          return;
        }

        try {
          voiceCallTargetUserId =
            callerId;

          voiceCallTargetNumber =
            String(callerNumber || "");

          voiceCallDirection =
            "incoming";

          try {
            if (typeof callActive !== "undefined") {
              callActive = true;
            }
          } catch (_) {}

          voiceCallSetButtons(true);

          voiceCallSetStatus(
            "جاري الرد على " +
            callerName +
            "..."
          );

          await voiceCallGetMicrophone();

          socket.emit(
            "voice_call_accept",
            {
              from_user_id:
                callerId,
              voice_call_number:
                callerNumber,
              call_id:
                voiceCallId
            }
          );

        } catch (error) {
          console.error(
            "[VOICE CALL] microphone:",
            error
          );

          socket.emit(
            "voice_call_reject",
            {
              from_user_id:
                callerId,
              voice_call_number:
                callerNumber,
              call_id:
                voiceCallId,
              reason:
                "microphone_error"
            }
          );

          voiceCallResetState();

          voiceCallSetStatus(
            "تعذر تشغيل الميكروفون"
          );
        }
      }
    );

    socket.on(
      "voice_call_accepted",
      async data => {
        if (
          voiceCallDirection !==
          "outgoing"
        ) {
          return;
        }

        try {
          if (
            data?.from_user_id &&
            !voiceCallTargetUserId
          ) {
            voiceCallTargetUserId =
              Number(data.from_user_id);
          }

          if (data?.call_id) {
            voiceCallId =
              String(data.call_id);
          }

          await voiceCallGetMicrophone();

          const peer =
            voiceCallCreatePeer();

          const offer =
            await peer.createOffer({
              offerToReceiveAudio: true
            });

          await peer.setLocalDescription(
            offer
          );

          socket.emit(
            "voice_call_offer",
            {
              target_user_id:
                voiceCallTargetUserId,
              call_id:
                voiceCallId,
              offer:
                peer.localDescription
            }
          );

          voiceCallSetStatus(
            "جاري بدء الاتصال الصوتي..."
          );

        } catch (error) {
          console.error(
            "[VOICE CALL] offer:",
            error
          );

          voiceCallEnd(false);

          voiceCallSetStatus(
            "تعذر إنشاء الاتصال الصوتي"
          );
        }
      }
    );

    socket.on(
      "voice_call_error",
      data => {
        console.warn(
          "[VOICE CALL] server error:",
          data
        );

        voiceCallSetStatus(
          data?.message ||
          "تعذر بدء الاتصال الصوتي"
        );

        callActive = false;
        voiceCallResetState();

        try {
          if (
            typeof updateButtons === "function"
          ) {
            updateButtons();
          }
        } catch (_) {}
      }
    );

    socket.on(
      "voice_call_rejected",
      data => {
        voiceCallSetStatus(
          data?.message ||
          "تم رفض المكالمة"
        );

        voiceCallResetState();
      }
    );

    socket.on(
      "voice_call_offer",
      async data => {
        if (
          !data ||
          !data.offer
        ) {
          return;
        }

        try {
          await voiceCallGetMicrophone();

          const peer =
            voiceCallCreatePeer();

          await peer.setRemoteDescription(
            new RTCSessionDescription(
              data.offer
            )
          );

          await voiceCallFlushIceQueue();

          const answer =
            await peer.createAnswer({
              offerToReceiveAudio: true
            });

          await peer.setLocalDescription(
            answer
          );

          socket.emit(
            "voice_call_answer",
            {
              target_user_id:
                voiceCallTargetUserId,
              call_id:
                voiceCallId,
              answer:
                peer.localDescription
            }
          );

          voiceCallSetStatus(
            "تم الرد، جاري الاتصال..."
          );

        } catch (error) {
          console.error(
            "[VOICE CALL] offer handling:",
            error
          );

          voiceCallSetStatus(
            "تعذر استقبال الاتصال الصوتي"
          );
        }
      }
    );

    socket.on(
      "voice_call_answer",
      async data => {
        if (
          !voiceCallPeer ||
          !data?.answer
        ) {
          return;
        }

        try {
          await voiceCallPeer.setRemoteDescription(
            new RTCSessionDescription(
              data.answer
            )
          );

          await voiceCallFlushIceQueue();

          voiceCallSetStatus(
            "جاري إكمال الاتصال الصوتي..."
          );

        } catch (error) {
          console.error(
            "[VOICE CALL] answer:",
            error
          );
        }
      }
    );

    socket.on(
      "voice_call_ice",
      async data => {
        if (
          !data?.candidate
        ) {
          return;
        }

        if (
          !voiceCallPeer ||
          !voiceCallPeer.remoteDescription
        ) {
          voiceCallIceQueue.push(
            data.candidate
          );

          return;
        }

        try {
          await voiceCallPeer.addIceCandidate(
            new RTCIceCandidate(
              data.candidate
            )
          );
        } catch (error) {
          console.warn(
            "[VOICE CALL] ICE error:",
            error?.message || error
          );
        }
      }
    );

    socket.on(
      "voice_call_ended",
      () => {
        voiceCallResetState();

        voiceCallSetStatus(
          "أنهى الطرف الآخر الاتصال"
        );
      }
    );
  }

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
      messengerSocket = io({
        auth: {
          token: token
        }
      });

      setupLiveAudioSocketHandlers(
        messengerSocket
      );

      setupVoiceCallSocketHandlers(
        messengerSocket
      );

      installLiveAudioButton();

      updateLiveAudioButtonVisibility();

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
     LIVE AUDIO BROADCAST / البث الصوتي المباشر
  ======================================================= */

  let liveAudioStream = null;
  let liveAudioBroadcasting = false;
  let liveAudioListening = false;
  let liveAudioPeers = new Map();

  const liveAudioRtcConfig = {
    iceServers: [
      {
        urls: "stun:stun.l.google.com:19302"
      },
      {
        urls: "stun:stun1.l.google.com:19302"
      }
    ]
  };

  function closeLiveAudioPeer(socketId) {
    const peer = liveAudioPeers.get(socketId);

    if (!peer) {
      return;
    }

    try {
      peer.close();
    } catch (_) {}

    liveAudioPeers.delete(socketId);
  }

  function closeAllLiveAudioPeers() {
    for (const [socketId, peer] of liveAudioPeers) {
      try {
        peer.close();
      } catch (_) {}

      liveAudioPeers.delete(socketId);
    }
  }

  function stopLiveAudioLocalStream() {
    if (!liveAudioStream) {
      return;
    }

    try {
      liveAudioStream.getTracks().forEach(
        track => track.stop()
      );
    } catch (_) {}

    liveAudioStream = null;
  }

  function setLiveAudioButtonState(active) {

    const button = $("liveAudioBtn");

    if (!button) {
      return;
    }

    if (active) {

      button.title = "إيقاف البث الصوتي";

      button.style.color = "#22c55e";

      button.innerHTML =
        '<i class="fa-solid fa-stop"></i>';

    } else {

      button.title = "بث صوتي مباشر";

      button.style.color = "#ef4444";

      button.innerHTML =
        '<i class="fa-solid fa-tower-broadcast"></i>';
    }
  }

  function createLiveAudioPeerForListener(
    listenerSocketId
  ) {

    if (
      !messengerSocket ||
      !messengerSocket.connected ||
      !liveAudioStream
    ) {
      return;
    }

    closeLiveAudioPeer(listenerSocketId);

    const peer =
      new RTCPeerConnection(
        liveAudioRtcConfig
      );

    liveAudioPeers.set(
      listenerSocketId,
      peer
    );

    for (
      const track of
      liveAudioStream.getTracks()
    ) {

      peer.addTrack(
        track,
        liveAudioStream
      );
    }

    peer.onicecandidate = event => {

      if (
        !event.candidate ||
        !messengerSocket ||
        !messengerSocket.connected
      ) {
        return;
      }

      messengerSocket.emit(
        "live_audio_ice",
        {
          to: listenerSocketId,
          candidate: event.candidate
        }
      );
    };

    peer.onconnectionstatechange = () => {

      const state =
        peer.connectionState;

      if (
        state === "failed" ||
        state === "closed" ||
        state === "disconnected"
      ) {
        closeLiveAudioPeer(
          listenerSocketId
        );
      }
    };

    peer.createOffer({
      offerToReceiveAudio: false
    })
      .then(offer =>
        peer.setLocalDescription(offer)
      )
      .then(() => {

        messengerSocket.emit(
          "live_audio_offer",
          {
            to: listenerSocketId,
            sdp: peer.localDescription
          }
        );

      })
      .catch(error => {

        console.warn(
          "[LIVE AUDIO] offer error:",
          error.message
        );

        closeLiveAudioPeer(
          listenerSocketId
        );
      });
  }

  async function startLiveAudioBroadcast() {

    if (
      !messengerSocket ||
      !messengerSocket.connected
    ) {
      alert("الاتصال بالخادم غير متاح حالياً.");
      return;
    }

    if (liveAudioBroadcasting) {
      stopLiveAudioBroadcast();
      return;
    }

    try {

      liveAudioStream =
        await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false
        });

      liveAudioBroadcasting = true;

      setLiveAudioButtonState(true);

      messengerSocket.emit(
        "live_audio_start"
      );

      console.log(
        "[LIVE AUDIO] broadcast started"
      );

    } catch (error) {

      stopLiveAudioLocalStream();

      liveAudioBroadcasting = false;

      setLiveAudioButtonState(false);

      if (
        error &&
        (
          error.name ===
            "NotAllowedError" ||
          error.name ===
            "PermissionDeniedError"
        )
      ) {
        alert(
          "يجب السماح باستخدام الميكروفون لبدء البث الصوتي."
        );
      } else {
        alert(
          "تعذر تشغيل الميكروفون للبث الصوتي."
        );
      }

      console.warn(
        "[LIVE AUDIO] microphone error:",
        error
      );
    }
  }

  function stopLiveAudioBroadcast() {

    if (
      liveAudioBroadcasting &&
      messengerSocket &&
      messengerSocket.connected
    ) {
      messengerSocket.emit(
        "live_audio_stop"
      );
    }

    liveAudioBroadcasting = false;

    closeAllLiveAudioPeers();

    stopLiveAudioLocalStream();

    setLiveAudioButtonState(false);

    console.log(
      "[LIVE AUDIO] broadcast stopped"
    );
  }

  async function joinLiveAudioBroadcast() {

    if (
      liveAudioBroadcasting ||
      liveAudioListening
    ) {
      return;
    }

    if (
      !messengerSocket ||
      !messengerSocket.connected
    ) {
      return;
    }

    liveAudioListening = true;

    messengerSocket.emit(
      "live_audio_join"
    );

    console.log(
      "[LIVE AUDIO] joining broadcast"
    );
  }

  function setupLiveAudioSocketHandlers(socket) {

    if (!socket) {
      return;
    }

    socket.on(
      "live_audio_started",
      data => {

        if (
          !data ||
          Number(data.user_id) ===
            Number(me?.id)
        ) {
          return;
        }

        joinLiveAudioBroadcast();

        // مؤشر بصري فقط للمستمعين — لا يتم حفظ الصوت
        let liveIndicator =
          document.getElementById("liveAudioIndicator");

        if (!liveIndicator) {
          liveIndicator =
            document.createElement("div");

          liveIndicator.id =
            "liveAudioIndicator";

          liveIndicator.innerHTML =
            '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#ef4444;margin-left:7px;box-shadow:0 0 8px rgba(239,68,68,.8);"></span>' +
            '<span>بث مباشر الآن</span>';

          liveIndicator.style.cssText =
            "position:fixed;" +
            "top:12px;" +
            "left:50%;" +
            "transform:translateX(-50%);" +
            "z-index:99999;" +
            "display:flex;" +
            "align-items:center;" +
            "gap:4px;" +
            "padding:8px 16px;" +
            "border-radius:20px;" +
            "background:#ffffff;" +
            "color:#111827;" +
            "font-size:14px;" +
            "font-weight:700;" +
            "box-shadow:0 4px 14px rgba(0,0,0,.18);" +
            "direction:rtl;";

          document.body.appendChild(
            liveIndicator
          );
        }

        liveIndicator.style.display = "flex";

        console.log(
          "[LIVE AUDIO] broadcast available:",
          data.user_id
        );
      }
    );

    socket.on(
      "live_audio_listener_joined",
      data => {

        if (
          !liveAudioBroadcasting ||
          !data ||
          !data.listener_socket_id
        ) {
          return;
        }

        createLiveAudioPeerForListener(
          data.listener_socket_id
        );
      }
    );

    socket.on(
      "live_audio_offer",
      async data => {

        if (
          liveAudioBroadcasting ||
          !data ||
          !data.from ||
          !data.sdp
        ) {
          return;
        }

        try {

          closeLiveAudioPeer(
            data.from
          );

          const peer =
            new RTCPeerConnection(
              liveAudioRtcConfig
            );

          liveAudioPeers.set(
            data.from,
            peer
          );

          peer.ontrack = event => {

            const stream =
              event.streams &&
              event.streams[0];

            if (!stream) {
              return;
            }

            let audio =
              document.getElementById(
                "liveAudioRemote"
              );

            if (!audio) {

              audio =
                document.createElement(
                  "audio"
                );

              audio.id =
                "liveAudioRemote";

              audio.autoplay = true;

              audio.playsInline = true;

              audio.style.display =
                "none";

              document.body.appendChild(
                audio
              );
            }

            audio.srcObject =
              stream;

            audio.play().catch(
              error => {
                console.warn(
                  "[LIVE AUDIO] autoplay blocked:",
                  error.message
                );
              }
            );
          };

          peer.onicecandidate =
            event => {

              if (
                !event.candidate ||
                !messengerSocket ||
                !messengerSocket.connected
              ) {
                return;
              }

              messengerSocket.emit(
                "live_audio_ice",
                {
                  to: data.from,
                  candidate:
                    event.candidate
                }
              );
            };

          peer.onconnectionstatechange =
            () => {

              const state =
                peer.connectionState;

              if (
                state === "failed" ||
                state === "closed" ||
                state === "disconnected"
              ) {
                closeLiveAudioPeer(
                  data.from
                );
              }
            };

          await peer.setRemoteDescription(
            new RTCSessionDescription(
              data.sdp
            )
          );

          const answer =
            await peer.createAnswer();

          await peer.setLocalDescription(
            answer
          );

          socket.emit(
            "live_audio_answer",
            {
              to: data.from,
              sdp: peer.localDescription
            }
          );

        } catch (error) {

          console.warn(
            "[LIVE AUDIO] offer handling:",
            error.message
          );

          closeLiveAudioPeer(
            data.from
          );
        }
      }
    );

    socket.on(
      "live_audio_answer",
      async data => {

        if (
          !liveAudioBroadcasting ||
          !data ||
          !data.from ||
          !data.sdp
        ) {
          return;
        }

        const peer =
          liveAudioPeers.get(
            data.from
          );

        if (!peer) {
          return;
        }

        try {

          await peer.setRemoteDescription(
            new RTCSessionDescription(
              data.sdp
            )
          );

        } catch (error) {

          console.warn(
            "[LIVE AUDIO] answer error:",
            error.message
          );
        }
      }
    );

    socket.on(
      "live_audio_ice",
      async data => {

        if (
          !data ||
          !data.from ||
          !data.candidate
        ) {
          return;
        }

        const peer =
          liveAudioPeers.get(
            data.from
          );

        if (!peer) {
          return;
        }

        try {

          await peer.addIceCandidate(
            new RTCIceCandidate(
              data.candidate
            )
          );

        } catch (error) {

          console.warn(
            "[LIVE AUDIO] ICE error:",
            error.message
          );
        }
      }
    );

    socket.on(
      "live_audio_stopped",
      () => {

        closeAllLiveAudioPeers();

        stopLiveAudioLocalStream();

        liveAudioBroadcasting = false;

        liveAudioListening = false;

        setLiveAudioButtonState(
          false
        );

        const audio =
          document.getElementById(
            "liveAudioRemote"
          );

        if (audio) {

          try {
            audio.pause();
          } catch (_) {}

          audio.srcObject = null;
        }

        const liveIndicator =
          document.getElementById(
            "liveAudioIndicator"
          );

        if (liveIndicator) {
          liveIndicator.style.display =
            "none";
        }

        console.log(
          "[LIVE AUDIO] broadcast stopped remotely"
        );
      }
    );

    socket.on(
      "live_audio_unavailable",
      data => {

        liveAudioListening = false;

        console.log(
          "[LIVE AUDIO] unavailable:",
          data?.message || ""
        );
      }
    );

    socket.on(
      "live_audio_error",
      data => {

        liveAudioBroadcasting = false;

        closeAllLiveAudioPeers();

        stopLiveAudioLocalStream();

        setLiveAudioButtonState(
          false
        );

        alert(
          data?.message ||
          "تعذر بدء البث الصوتي."
        );
      }
    );
  }

  function canBroadcastLiveAudio() {

    const role =
      String(
        me?.role ||
        ""
      ).trim().toLowerCase();

    return (
      role === "system_manager" ||
      role === "admin"
    );
  }

  function updateLiveAudioButtonVisibility() {

    const button =
      $("liveAudioBtn");

    if (!button) {
      return;
    }

    const allowed =
      canBroadcastLiveAudio();

    button.style.display =
      allowed ? "" : "none";

    button.setAttribute(
      "aria-hidden",
      allowed ? "false" : "true"
    );
  }

  function installLiveAudioButton() {

    const button =
      $("liveAudioBtn");

    if (!button) {
      return;
    }

    updateLiveAudioButtonVisibility();

    if (
      button.dataset.liveAudioInstalled ===
      "1"
    ) {
      return;
    }

    button.dataset.liveAudioInstalled =
      "1";

    button.addEventListener(
      "click",
      () => {

        if (!canBroadcastLiveAudio()) {
          return;
        }

        if (liveAudioBroadcasting) {
          stopLiveAudioBroadcast();
        } else {
          startLiveAudioBroadcast();
        }

      }
    );

    setLiveAudioButtonState(false);
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

  // إتاحة api لمسارات تسجيل الدخول الموجودة داخل IIFE أخرى
  window.api = api;

  function getCurrentUser() {
    return me;
  }

  function isAdmin() {
    return !!(
      me &&
      (
        me.is_admin === 1 ||
        me.is_admin === true ||
        me.role === "admin" ||
        me.role === "system_manager"
      )
    );
  }

  function isSystemManager() {
    return !!(
      me &&
      me.role === "system_manager"
    );
  }


  /*
   * صلاحيات أزرار المشرف
   *
   * مدير النظام:
   *   يمتلك جميع الصلاحيات.
   *
   * المشرف:
   *   يتم تحميل صلاحياته من قاعدة البيانات.
   *   allowed = 1  -> الزر ظاهر
   *   allowed = 0  -> الزر مخفي
   */
  const ADMIN_PERMISSION_BUTTONS = {
    add_user: ["addUserBtn"],
    block_user: ["blockUserBtn"],
    freeze_user: ["freezeUserBtn"],
    release_user: ["releaseUserBtn"],
    app_lock: ["appLockBtn"],
    clear_chat: ["clearChatBtn"],
    backup: ["backupBtn"],
    locations: ["locationsBtn", "interactiveUsersMapBtn"],
    interactive_users_map: ["interactiveUsersMapBtn"],
    warnings: ["warningsBtn"],
    broadcast: ["broadcastBtn"],
    manage_users: ["manageUsersBtn"],
    user_reports: ["userReportsBtn"],
    credentials_report: ["credentialsReportBtn"],
    channels: ["channelsBtn"],
    audit: ["auditBtn"],
    update_database: ["updateDatabaseBtn"],
    alert_mode: ["alertModeBtn"],
    network_off: ["networkOffBtn"],
    network_restart: ["networkRestartBtn"]
  };

  let currentAdminPermissions = {};

  function applyAdminPermissionVisibility() {

    /*
     * إذا لم يكن المستخدم مشرفاً فلا نتدخل
     * في بقية الواجهة.
     */
    if (!isAdmin()) {
      return;
    }

    /*
     * مدير النظام لديه كل الصلاحيات.
     */
    if (isSystemManager()) {

      Object.values(
        ADMIN_PERMISSION_BUTTONS
      ).flat().forEach(function(id) {

        const button = $(id);

        if (button) {
          button.classList.remove("hidden");
        }

      });

      return;
    }

    /*
     * المشرف العادي:
     * نعرض فقط الصلاحيات التي قيمتها 1.
     */
    Object.entries(
      ADMIN_PERMISSION_BUTTONS
    ).forEach(function([permission, ids]) {

      const allowed =
        currentAdminPermissions[permission] === true;

      ids.forEach(function(id) {

        const button = $(id);

        if (!button) {
          return;
        }

        button.classList.toggle(
          "hidden",
          !allowed
        );

      });

    });
  }

  async function loadCurrentAdminPermissions() {

    /*
     * مدير النظام لا يحتاج إلى استدعاء API.
     */
    if (!isAdmin()) {
      currentAdminPermissions = {};
      return;
    }

    if (isSystemManager()) {

      currentAdminPermissions = {};

      Object.keys(
        ADMIN_PERMISSION_BUTTONS
      ).forEach(function(permission) {
        currentAdminPermissions[permission] = true;
      });

      applyAdminPermissionVisibility();
      return;
    }

    /*
     * نبدأ بحالة مغلقة حتى لا تظهر الأزرار
     * أثناء انتظار نتيجة السيرفر.
     */
    currentAdminPermissions = {};

    applyAdminPermissionVisibility();

    try {

      const data =
        await api(
          "/api/admin/my-permissions"
        );

      const list =
        Array.isArray(data?.permissions)
          ? data.permissions
          : [];

      list.forEach(function(item) {

        const permission =
          String(
            item?.permission ||
            item?.permission_key ||
            ""
          );

        if (!permission) {
          return;
        }

        currentAdminPermissions[permission] =
          Number(item?.allowed) === 1;

      });

    } catch (error) {

      console.error(
        "loadCurrentAdminPermissions:",
        error
      );

      /*
       * في حالة فشل تحميل الصلاحيات:
       * لا نعطي المشرف صلاحيات إضافية من الواجهة.
       */
      currentAdminPermissions = {};

    }

    applyAdminPermissionVisibility();
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

    /*
     * عرض اسم المستخدم وهويته فوراً.
     * مدير النظام / مشرف / مستخدم
     */
    if (me) {
      const roleLabel =
        isSystemManager()
          ? "مدير النظام"
          : isAdmin()
            ? "مشرف"
            : "مستخدم";

      const displayName =
        me.name ||
        me.username ||
        "مستخدم";

      setText(
        "identity",
        `${roleLabel} • ${displayName}`
      );
    }
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

    /*
     * تسجيل دخول جديد يلغي أي عملية restoreSession
     * كانت بدأت بجلسة أقدم.
     */
    const loginGeneration = ++authGeneration;

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

      console.log(
        "[AUTH_DEBUG] LOGIN_RESPONSE",
        {
          ok: data?.ok,
          user: data?.user,
          username: data?.user?.username,
          name: data?.user?.name,
          role: data?.user?.role,
          user_id: data?.user?.id
        }
      );

      if (
        !data.ok ||
        !data.token
      ) {
        throw new Error(
          data.message ||
          "فشل تسجيل الدخول."
        );
      }

      /*
       * تأكد أن هذه النتيجة تخص آخر عملية تسجيل دخول.
       * إذا سبقتها عملية مصادقة أخرى فلا نسمح لها بتغيير الهوية.
       */
      if (loginGeneration !== authGeneration) {
        console.warn(
          "[AUTH] تم تجاهل نتيجة تسجيل دخول قديمة."
        );
        return false;
      }

      token = data.token;
      me = data.user || {};

      // تهيئة مفتاح E2EE بعد نجاح تسجيل الدخول دون تعطيل الدخول
      void initializeE2EEKeys();

      /* مزامنة صورة البروفايل مع بيانات المستخدم */
      window.currentProfileImage =
        me.profile_image || "";

      const currentProfileAvatar =
        document.getElementById("currentProfileAvatar");

      if (currentProfileAvatar) {
        if (me.profile_image) {
          currentProfileAvatar.innerHTML = "";

          const img =
            document.createElement("img");

          img.src = me.profile_image;
          img.alt = "صورة البروفايل";
          img.style.cssText = `
            width:100%;
            height:100%;
            object-fit:cover;
            border-radius:50%;
            display:block;
          `;

          currentProfileAvatar.appendChild(img);
        } else {
          currentProfileAvatar.innerHTML =
            '<i class="fa-solid fa-user"></i>';
        }
      }

      /*
       * تحميل صلاحيات المشرف قبل تشغيل بقية التطبيق.
       */
      await loadCurrentAdminPermissions();

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

      /*
       * تشغيل اتصال Socket.IO بعد اكتمال تسجيل الدخول
       * لتفعيل البث الصوتي المباشر وأحداثه.
       */
      connectMessengerSocket();

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


  async function loginWithPattern() {
    const errorBox = $("loginError");

    if (errorBox) {
      errorBox.textContent = "";
    }

    const username =
      ($("loginUsername")?.value || "").trim();

    if (!username) {
      if (errorBox) {
        errorBox.textContent =
          "أدخل اسم المستخدم أولاً.";
      }
      return false;
    }

    const oldOverlay =
      document.getElementById("loginPatternDrawingOverlay");

    if (oldOverlay) {
      oldOverlay.remove();
    }

    const overlay = document.createElement("div");
    overlay.id = "loginPatternDrawingOverlay";

    overlay.style.cssText = `
      position:fixed;
      inset:0;
      z-index:99999;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:20px;
      box-sizing:border-box;
      background:rgba(0,0,0,.58);
    `;

    overlay.innerHTML = `
      <div
        style="
          width:min(420px,100%);
          background:var(--bg-secondary,#fff);
          border:1px solid var(--border-color,#ddd);
          border-radius:20px;
          padding:22px;
          box-sizing:border-box;
          text-align:center;
          box-shadow:0 15px 50px rgba(0,0,0,.30);
          direction:rtl;
        "
      >
        <div style="font-size:21px;font-weight:800;margin-bottom:8px;">
          <i
            class="fa-solid fa-shield-halved"
            style="color:#00A878;margin-left:7px;"
          ></i>
          الدخول بنقش الحماية
        </div>

        <div
          id="loginPatternDrawingMessage"
          style="margin:8px 0 16px;line-height:1.8;font-size:15px;"
        >
          ارسم نقش الحماية المرتبط بالحساب.
        </div>

        <div
          id="loginPatternGrid"
          style="
            width:min(290px,82vw);
            aspect-ratio:1;
            margin:0 auto 18px;
            display:grid;
            grid-template-columns:repeat(3,1fr);
            gap:22px;
            padding:24px;
            box-sizing:border-box;
            touch-action:none;
            user-select:none;
          "
        >
          ${Array.from({length:9}, (_,i) => `
            <button
              type="button"
              data-login-pattern-node="${i}"
              aria-label="نقطة ${i + 1}"
              style="
                width:100%;
                aspect-ratio:1;
                max-width:62px;
                margin:auto;
                border-radius:50%;
                border:3px solid #00A878;
                background:rgba(0,168,120,.10);
                box-shadow:0 0 0 7px rgba(0,168,120,.07);
                padding:0;
                touch-action:none;
              "
            ></button>
          `).join("")}
        </div>

        <div style="display:flex;gap:10px;justify-content:center;">
          <button
            id="loginPatternCancelBtn"
            type="button"
            class="secondary"
            style="min-height:44px;flex:1;"
          >
            إلغاء
          </button>

          <button
            id="loginPatternClearBtn"
            type="button"
            class="secondary"
            style="min-height:44px;flex:1;"
          >
            مسح
          </button>

          <button
            id="loginPatternSubmitBtn"
            type="button"
            style="min-height:44px;flex:1;font-weight:700;"
          >
            دخول
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const grid =
      document.getElementById("loginPatternGrid");

    const message =
      document.getElementById("loginPatternDrawingMessage");

    const nodes =
      Array.from(
        overlay.querySelectorAll(
          "[data-login-pattern-node]"
        )
      );

    const selected = [];

    function setNodeState(node, active) {
      node.style.background =
        active
          ? "#00A878"
          : "rgba(0,168,120,.10)";

      node.style.transform =
        active ? "scale(1.08)" : "scale(1)";

      node.style.boxShadow =
        active
          ? "0 0 0 8px rgba(0,168,120,.20)"
          : "0 0 0 7px rgba(0,168,120,.07)";
    }

    function selectNode(index) {
      if (selected.includes(index)) {
        return;
      }

      selected.push(index);
      setNodeState(nodes[index], true);

      message.textContent =
        selected.length >= 4
          ? "تم رسم النقش. اضغط «دخول» للتحقق."
          : "اختر " +
            (4 - selected.length) +
            " نقاط إضافية على الأقل.";
    }

    function nodeFromPoint(clientX, clientY) {
      for (let i = 0; i < nodes.length; i++) {
        const rect = nodes[i].getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const radius =
          Math.max(rect.width, rect.height) * 0.75;

        const distance =
          Math.hypot(
            clientX - cx,
            clientY - cy
          );

        if (distance <= radius) {
          return i;
        }
      }

      return -1;
    }

    let drawing = false;

    grid.addEventListener("pointerdown", function(event) {
      drawing = true;

      try {
        grid.setPointerCapture(event.pointerId);
      } catch (_) {}

      const index =
        nodeFromPoint(
          event.clientX,
          event.clientY
        );

      if (index >= 0) {
        selectNode(index);
      }

      event.preventDefault();
    });

    grid.addEventListener("pointermove", function(event) {
      if (!drawing) {
        return;
      }

      const index =
        nodeFromPoint(
          event.clientX,
          event.clientY
        );

      if (index >= 0) {
        selectNode(index);
      }

      event.preventDefault();
    });

    grid.addEventListener("pointerup", function() {
      drawing = false;
    });

    grid.addEventListener("pointercancel", function() {
      drawing = false;
    });

    document
      .getElementById("loginPatternClearBtn")
      .addEventListener("click", function() {
        selected.length = 0;

        nodes.forEach(function(node) {
          setNodeState(node, false);
        });

        message.textContent =
          "ارسم نقش الحماية المرتبط بالحساب.";
      });

    document
      .getElementById("loginPatternCancelBtn")
      .addEventListener("click", function() {
        overlay.remove();
      });

    document
      .getElementById("loginPatternSubmitBtn")
      .addEventListener("click", async function() {
        if (selected.length < 4) {
          message.textContent =
            "يجب اختيار 4 نقاط على الأقل.";
          return;
        }

        const submitButton =
          document.getElementById(
            "loginPatternSubmitBtn"
          );

        submitButton.disabled = true;
        submitButton.textContent = "جارٍ التحقق...";

        try {
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

          if (errorBox) {
            errorBox.textContent =
              "جاري التحقق من نقش الحماية...";
          }

          const response = await fetch(
            "/api/profile/pattern/login",
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json"
              },
              body: JSON.stringify({
                username,
                pattern: selected.join("-"),
                device_id: deviceId
              })
            }
          );

          const data =
            await response.json();

          if (!response.ok || !data.ok || !data.token) {
            throw new Error(
              data.message ||
              "اسم المستخدم أو نقش الحماية غير صحيح."
            );
          }

          token = data.token;
          me = data.user || {};

          // تهيئة مفتاح E2EE بعد نجاح نقش الحماية دون تعطيل الدخول
          void initializeE2EEKeys();

          window.currentProfileImage =
            me.profile_image || "";


          localStorage.setItem(
            "sm_token",
            token
          );

          localStorage.setItem(
            "sm_user",
            JSON.stringify(me)
          );

          await loadCurrentAdminPermissions();

          overlay.remove();

          if (errorBox) {
            errorBox.textContent = "";
          }

          showApp();

          await boot();

          connectMessengerSocket();

          return true;

        } catch (error) {
          console.error(
            "Pattern login failed:",
            error
          );

          message.textContent =
            error.message ||
            "تعذر تسجيل الدخول باستخدام نقش الحماية.";

          if (errorBox) {
            errorBox.textContent =
              error.message ||
              "تعذر تسجيل الدخول باستخدام نقش الحماية.";
          }

          submitButton.disabled = false;
          submitButton.textContent = "دخول";
        }
      });
  }

  const patternLoginBtn =
    $("patternLoginBtn");

  if (
    patternLoginBtn &&
    !patternLoginBtn.dataset.patternLoginHandlerInstalled
  ) {
    patternLoginBtn.dataset.patternLoginHandlerInstalled = "1";

    patternLoginBtn.addEventListener(
      "click",
      function() {
        loginWithPattern();
      }
    );
  }

  window.login = login;
  window.api = api;
  window.getCurrentUser =
    getCurrentUser;
  window.isAdmin = isAdmin;
  window.isSystemManager =
    isSystemManager;
  window.ensureAdmin =
    ensureAdmin;
  window.adminStatus =
    adminStatus;
  window.connectionNotice =
    connectionNotice;

  /*
   * إتاحة دوال الجلسة والتشغيل لوحدات/IIFE الأخرى
   * مثل Passkey، بدون تغيير منطق الدوال.
   */
  window.loadCurrentAdminPermissions =
    loadCurrentAdminPermissions;
  window.showApp =
    showApp;
  window.boot =
    boot;
  window.connectMessengerSocket =
    connectMessengerSocket;

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

      /*
       * صندوق البحث
       */
      const searchBox =
        document.createElement("div");

      searchBox.style.cssText = `
        position:sticky;
        top:0;
        z-index:10;
        padding:8px 0 10px 0;
        background:var(--bg-primary,#080d09);
      `;

      searchBox.innerHTML = `
        <div style="
          position:relative;
          width:100%;
        ">

          <i
            class="fa-solid fa-magnifying-glass"
            style="
              position:absolute;
              right:12px;
              top:50%;
              transform:translateY(-50%);
              color:var(--accent-green,#00ff80);
              pointer-events:none;
            "
          ></i>

          <input
            id="usersSearchInput"
            type="search"
            autocomplete="off"
            placeholder="بحث عن اسم أو حساب..."
            aria-label="بحث عن مستخدم"
            style="
              width:100%;
              box-sizing:border-box;
              min-height:44px;
              padding:9px 40px 9px 12px;
              border-radius:10px;
              border:1px solid rgba(0,255,128,.25);
              background:rgba(0,0,0,.28);
              color:#111b21 !important;
              font-family:'Cairo',sans-serif;
              font-size:14px;
              outline:none;
            "
          >

        </div>

        <div
          id="usersSearchResultCount"
          style="
            margin-top:5px;
            padding:0 4px;
            font-family:'Cairo',sans-serif;
            font-size:11px;
            color:#667781 !important;
          "
        ></div>
      `;

      list.appendChild(searchBox);

      /*
       * حاوية نتائج البحث
       */
      const usersContainer =
        document.createElement("div");

      usersContainer.id =
        "usersSearchResults";

      list.appendChild(usersContainer);

      /*
       * رسم المستخدمين
       */
      function renderUsers(searchText = "") {

        usersContainer.innerHTML = "";

        const query =
          String(searchText || "")
            .trim()
            .toLowerCase();

        const filteredUsers =
          query
            ? users.filter(user => {

                const name =
                  String(
                    user.name ||
                    ""
                  ).toLowerCase();

                const username =
                  String(
                    user.username ||
                    ""
                  ).toLowerCase();

                const label =
                  String(
                    userDisplayLabel(user) ||
                    ""
                  ).toLowerCase();

                return (
                  name.includes(query) ||
                  username.includes(query) ||
                  label.includes(query)
                );
              })
            : users;

        const resultCount =
          $("usersSearchResultCount");

        if (resultCount) {
          resultCount.textContent =
            query
              ? `نتائج البحث: ${filteredUsers.length}`
              : `إجمالي المستخدمين: ${users.length}`;
        }

        if (!filteredUsers.length) {

          const empty =
            document.createElement("div");

          empty.style.cssText = `
            padding:18px 8px;
            text-align:center;
            color:#667781 !important;
            font-family:'Cairo',sans-serif;
            font-size:13px;
          `;

          empty.innerHTML = `
            <i class="fa-solid fa-user-slash"></i>
            <div style="margin-top:6px">
              لا يوجد مستخدم مطابق للبحث
            </div>
          `;

          usersContainer.appendChild(empty);

          return;
        }

        filteredUsers.forEach(user => {

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

          /* الصفة الرسمية القادمة من /api/users */
          const roleValue =
            String(
              user.role || "user"
            ).trim().toLowerCase();

          let roleLabel = "مستخدم";

          if (roleValue === "system_manager") {
            roleLabel = "مدير النظام";
          } else if (roleValue === "admin") {
            roleLabel = "مشرف";
          }

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
                color:#111b21 !important;
              "
            >${escapeHtml(
              label
            )}</b>

            <div
              class="username-display"
              style="
                margin-top:1px;
                font-family:'Cairo',sans-serif;
                font-size:12px;
                font-weight:500;
                color:#667781 !important;
                direction:ltr;
                text-align:right;
              "
            >@${escapeHtml(
              String(user.username || "")
            )}</div>

            <div
              class="user-role-display"
              style="
                margin-top:1px;
                font-family:'Cairo',sans-serif;
                font-size:11px;
                font-weight:600;
                color:#54656f !important;
              "
            >${escapeHtml(
              roleLabel
            )}</div>

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

            /* الانتقال من شاشة المستخدمين إلى المحادثة */
            $("appPage")?.classList.remove("users-home");

            selectedUser =
              user;

            selectedGroup =
              null;

            setText(
              "chatTitle",
              label
            );

            const chatAvatar =
              $("chatProfileAvatar");

            if (chatAvatar) {
              if (user.profile_image) {
                chatAvatar.innerHTML = "";

                const img =
                  document.createElement("img");

                img.src =
                  user.profile_image;

                img.alt =
                  "صورة البروفايل";

                img.style.cssText = `
                  width:100%;
                  height:100%;
                  object-fit:cover;
                  border-radius:50%;
                  display:block;
                `;

                chatAvatar.appendChild(img);

              } else {
                chatAvatar.innerHTML =
                  '<i class="fa-solid fa-user"></i>';
              }
            }

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

          usersContainer.appendChild(
            div
          );

        });
      }

      /*
       * البحث الفوري
       */
      const searchInput =
        $("usersSearchInput");

      if (searchInput) {

        searchInput.addEventListener(
          "input",
          function() {

            renderUsers(
              this.value
            );

          }
        );
      }

      renderUsers();

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

      /*
       * فك تشفير الرسائل الخاصة المشفرة على الجهاز فقط.
       * الرسائل العادية لا تتأثر.
       */
      for (const message of window.messages) {
        if (
          Number(message?.is_encrypted) !== 1 ||
          !message?.encryption_iv ||
          !message?.encryption_sender_key
        ) {
          continue;
        }

        try {
          message._decrypted_body =
            await e2eeDecryptMessage(message);
        } catch (error) {
          console.warn(
            "[E2EE] تعذر فك رسالة:",
            message?.id,
            error
          );

          message._e2ee_error = true;
        }
      }

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

  /* =========================================================
     E2EE DEVICE KEY
     المفتاح الخاص يبقى داخل الجهاز ولا يتم إرساله للخادم.
  ========================================================= */

  const E2EE_DB_NAME = "AsdServer-E2EE";
  const E2EE_DB_VERSION = 1;
  const E2EE_STORE = "keys";

  function e2eeDeviceId() {
    let id =
      localStorage.getItem("sm_device_id");

    if (!id) {
      if (
        window.crypto &&
        typeof window.crypto.randomUUID === "function"
      ) {
        id = window.crypto.randomUUID();
      } else {
        id =
          "sm-" +
          Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2);
      }

      localStorage.setItem(
        "sm_device_id",
        id
      );
    }

    return id;
  }

  function e2eeOpenDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(
          new Error(
            "المتصفح لا يدعم التخزين الآمن للمفتاح."
          )
        );
        return;
      }

      const request =
        indexedDB.open(
          E2EE_DB_NAME,
          E2EE_DB_VERSION
        );

      request.onupgradeneeded = () => {
        const db = request.result;

        if (
          !db.objectStoreNames.contains(
            E2EE_STORE
          )
        ) {
          db.createObjectStore(
            E2EE_STORE
          );
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(
          request.error ||
          new Error(
            "تعذر فتح مخزن مفاتيح التشفير."
          )
        );
      };
    });
  }

  async function e2eeStorePrivateKey(
    privateKey
  ) {
    const db =
      await e2eeOpenDatabase();

    return new Promise(
      (resolve, reject) => {
        const tx =
          db.transaction(
            E2EE_STORE,
            "readwrite"
          );

        tx.objectStore(
          E2EE_STORE
        ).put(
          privateKey,
          e2eeDeviceId()
        );

        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };

        tx.onerror = () => {
          db.close();
          reject(
            tx.error ||
            new Error(
              "تعذر حفظ مفتاح التشفير."
            )
          );
        };
      }
    );
  }

  async function e2eeLoadPrivateKey() {
    const db =
      await e2eeOpenDatabase();

    return new Promise(
      (resolve, reject) => {
        const tx =
          db.transaction(
            E2EE_STORE,
            "readonly"
          );

        const request =
          tx.objectStore(
            E2EE_STORE
          ).get(
            e2eeDeviceId()
          );

        request.onsuccess = () => {
          db.close();
          resolve(
            request.result || null
          );
        };

        request.onerror = () => {
          db.close();
          reject(
            request.error ||
            new Error(
              "تعذر قراءة مفتاح التشفير."
            )
          );
        };
      }
    );
  }

  function e2eeBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;

    for (
      let i = 0;
      i < bytes.length;
      i += chunkSize
    ) {
      binary += String.fromCharCode(
        ...bytes.subarray(
          i,
          Math.min(
            i + chunkSize,
            bytes.length
          )
        )
      );
    }

    return btoa(binary);
  }

  async function e2eeStorePublicKey(publicKeyBase64) {
    const db = await e2eeOpenDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(E2EE_STORE, "readwrite");

      tx.objectStore(E2EE_STORE).put(
        String(publicKeyBase64 || ""),
        "public:" + e2eeDeviceId()
      );

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };

      tx.onerror = () => {
        db.close();
        reject(
          tx.error ||
          new Error("تعذر حفظ المفتاح العام.")
        );
      };
    });
  }

  async function e2eeLoadPublicKey() {
    const db = await e2eeOpenDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(E2EE_STORE, "readonly");

      const request = tx.objectStore(E2EE_STORE).get(
        "public:" + e2eeDeviceId()
      );

      request.onsuccess = () => {
        db.close();
        resolve(request.result || "");
      };

      request.onerror = () => {
        db.close();
        reject(
          request.error ||
          new Error("تعذر قراءة المفتاح العام.")
        );
      };
    });
  }

  function e2eeFromBase64(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  }

  async function e2eeImportPublicKey(publicKeyBase64) {
    return crypto.subtle.importKey(
      "spki",
      e2eeFromBase64(publicKeyBase64),
      {
        name: "ECDH",
        namedCurve: "P-256"
      },
      false,
      []
    );
  }

  async function e2eeCreateDeviceKeys() {
    if (
      !window.crypto ||
      !window.crypto.subtle
    ) {
      throw new Error(
        "المتصفح لا يدعم التشفير الآمن."
      );
    }

    let privateKey =
      await e2eeLoadPrivateKey();

    let publicKeyBase64 =
      await e2eeLoadPublicKey();

    /*
     * إذا كان لدينا المفتاح الخاص والمفتاح العام
     * محلياً، نستخدمهما كما هما.
     */
    if (privateKey && publicKeyBase64) {
      /*
       * إعادة تسجيل المفتاح العام عند الحاجة.
       * هذا مهم بعد إعادة إنشاء قاعدة بيانات الخادم.
       */
      await api(
        "/api/encryption-keys",
        {
          method: "POST",
          body: JSON.stringify({
            device_id:
              e2eeDeviceId(),
            public_key:
              publicKeyBase64
          })
        }
      );

      return privateKey;
    }

    /*
     * في حالة وجود مفتاح خاص قديم بدون مفتاح عام محلي،
     * ننشئ زوجاً جديداً متطابقاً ونحفظهما معاً.
     */
    const pair =
      await crypto.subtle.generateKey(
        {
          name: "ECDH",
          namedCurve: "P-256"
        },
        true,
        ["deriveBits"]
      );

    const publicKey =
      await crypto.subtle.exportKey(
        "spki",
        pair.publicKey
      );

    const privateKeyData =
      await crypto.subtle.exportKey(
        "pkcs8",
        pair.privateKey
      );

    privateKey =
      await crypto.subtle.importKey(
        "pkcs8",
        privateKeyData,
        {
          name: "ECDH",
          namedCurve: "P-256"
        },
        false,
        ["deriveBits"]
      );

    publicKeyBase64 =
      e2eeBase64(
        new Uint8Array(publicKey)
      );

    await e2eeStorePrivateKey(
      privateKey
    );

    await e2eeStorePublicKey(
      publicKeyBase64
    );

    await api(
      "/api/encryption-keys",
      {
        method: "POST",
        body: JSON.stringify({
          device_id:
            e2eeDeviceId(),
          public_key:
            publicKeyBase64
        })
      }
    );

    return privateKey;
  }

  /*
   * اشتقاق مفتاح تغليف الرسالة من ECDH + HKDF.
   * المفتاح الخاص لا يغادر الجهاز.
   */

  /*
   * E2EE: بصمة المفتاح العام والتحقق من الثقة.
   * هذه الإضافة لا تغيّر نظام الرسائل العادية.
   */

  async function e2eeFingerprint(publicKeyBase64) {
    const digest =
      await crypto.subtle.digest(
        "SHA-256",
        e2eeFromBase64(publicKeyBase64)
      );

    const bytes = new Uint8Array(digest);

    const hex = Array.from(bytes)
      .map(
        byte =>
          byte.toString(16).padStart(2, "0")
      )
      .join("");

    return hex
      .match(/.{1,4}/g)
      .join(" ")
      .toUpperCase();
  }

  function e2eeTrustKey(
    userId,
    deviceId
  ) {
    return [
      "sm_e2ee_trust",
      String(userId),
      String(deviceId)
    ].join(":");
  }

  async function e2eeLoadTrustedFingerprint(
    userId,
    deviceId
  ) {
    const db =
      await e2eeOpenDatabase();

    return new Promise(
      (resolve, reject) => {
        const tx =
          db.transaction(
            E2EE_STORE,
            "readonly"
          );

        const request =
          tx.objectStore(
            E2EE_STORE
          ).get(
            e2eeTrustKey(
              userId,
              deviceId
            )
          );

        request.onsuccess = () => {
          db.close();
          resolve(
            request.result || null
          );
        };

        request.onerror = () => {
          db.close();
          reject(
            request.error ||
            new Error(
              "تعذر قراءة بصمة مفتاح التشفير."
            )
          );
        };
      }
    );
  }

  async function e2eeStoreTrustedFingerprint(
    userId,
    deviceId,
    fingerprint,
    publicKey
  ) {
    const db =
      await e2eeOpenDatabase();

    return new Promise(
      (resolve, reject) => {
        const tx =
          db.transaction(
            E2EE_STORE,
            "readwrite"
          );

        tx.objectStore(
          E2EE_STORE
        ).put(
          {
            user_id: String(userId),
            device_id: String(deviceId),
            fingerprint: String(fingerprint),
            public_key: String(publicKey),
            updated_at:
              new Date().toISOString()
          },
          e2eeTrustKey(
            userId,
            deviceId
          )
        );

        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };

        tx.onerror = () => {
          db.close();
          reject(
            tx.error ||
            new Error(
              "تعذر حفظ بصمة مفتاح التشفير."
            )
          );
        };
      }
    );
  }

  async function e2eeEnsureRecipientKeysTrusted(
    receiverId,
    recipientKeys
  ) {
    const pending = [];

    for (
      const device of recipientKeys
    ) {
      if (
        !device ||
        !device.device_id ||
        !device.public_key
      ) {
        continue;
      }

      const deviceId =
        String(device.device_id);

      const publicKey =
        String(device.public_key);

      const fingerprint =
        await e2eeFingerprint(
          publicKey
        );

      const trusted =
        await e2eeLoadTrustedFingerprint(
          receiverId,
          deviceId
        );

      if (!trusted) {
        pending.push({
          deviceId,
          publicKey,
          fingerprint
        });
        continue;
      }

      if (
        String(
          trusted.fingerprint || ""
        ) !== fingerprint
      ) {
        throw new Error(
          [
            "⚠️ تغيّرت بصمة مفتاح التشفير للطرف الآخر.",
            "",
            "الجهاز: " + deviceId,
            "",
            "البصمة المحفوظة:",
            String(
              trusted.fingerprint ||
              "غير متوفرة"
            ),
            "",
            "البصمة الحالية:",
            fingerprint,
            "",
            "تم إيقاف إرسال الرسالة المشفرة.",
            "تحقق من المفتاح مع الطرف الآخر عبر وسيلة موثوقة قبل المتابعة."
          ].join("\n")
        );
      }
    }

    if (!pending.length) {
      return true;
    }

    const fingerprintText =
      pending
        .map(
          (item, index) =>
            "الجهاز " +
            (index + 1) +
            ": " +
            item.deviceId +
            "\n" +
            item.fingerprint
        )
        .join("\n\n");

    const approved =
      window.confirm(
        [
          "🔐 أول تحقق من مفتاح التشفير للطرف الآخر.",
          "",
          "قارن البصمة التالية مع الطرف الآخر عبر وسيلة موثوقة قبل الوثوق بها:",
          "",
          fingerprintText,
          "",
          "إذا تطابقت البصمة، اضغط «موافق» لحفظها على جهازك.",
          "إذا لم تتمكن من المقارنة، اختر «إلغاء».",
          "",
          "هل تريد الوثوق بهذه البصمة؟"
        ].join("\n")
      );

    if (!approved) {
      throw new Error(
        "تم إلغاء التحقق من بصمة مفتاح التشفير. لم يتم إرسال الرسالة."
      );
    }

    for (
      const item of pending
    ) {
      await e2eeStoreTrustedFingerprint(
        receiverId,
        item.deviceId,
        item.fingerprint,
        item.publicKey
      );
    }

    return true;
  }

  async function e2eeDeriveWrapKey(
    privateKey,
    remotePublicKey
  ) {
    const sharedBits =
      await crypto.subtle.deriveBits(
        {
          name: "ECDH",
          public: remotePublicKey
        },
        privateKey,
        256
      );

    const hkdfKey =
      await crypto.subtle.importKey(
        "raw",
        sharedBits,
        "HKDF",
        false,
        ["deriveKey"]
      );

    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt:
          new TextEncoder().encode(
            "AsdServer-E2EE-v1"
          ),
        info:
          new TextEncoder().encode(
            "AsdServer-private-message"
          )
      },
      hkdfKey,
      {
        name: "AES-GCM",
        length: 256
      },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function e2eeEncryptMessage(
    plaintext,
    receiverId
  ) {
    const privateKey =
      await e2eeLoadPrivateKey();

    if (!privateKey) {
      throw new Error(
        "مفتاح التشفير الخاص بهذا الجهاز غير موجود."
      );
    }

    const senderDeviceId =
      e2eeDeviceId();

    const senderPublicKey =
      await e2eeLoadPublicKey();

    if (!senderPublicKey) {
      throw new Error(
        "المفتاح العام للجهاز غير موجود."
      );
    }

    const keysResponse =
      await api(
        `/api/encryption-keys/${encodeURIComponent(
          receiverId
        )}`
      );

    const recipientKeys =
      Array.isArray(keysResponse?.keys)
        ? keysResponse.keys
        : [];

    if (!recipientKeys.length) {
      throw new Error(
        "لا يوجد مفتاح تشفير مسجل لدى الطرف الآخر."
      );
    }

    await e2eeEnsureRecipientKeysTrusted(
      receiverId,
      recipientKeys
    );

    /*
     * مفتاح AES مستقل لكل رسالة.
     */
    const messageKey =
      await crypto.subtle.generateKey(
        {
          name: "AES-GCM",
          length: 256
        },
        true,
        ["encrypt", "decrypt"]
      );

    const messageIv =
      crypto.getRandomValues(
        new Uint8Array(12)
      );

    const plaintextBytes =
      new TextEncoder().encode(
        String(plaintext)
      );

    const ciphertext =
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: messageIv
        },
        messageKey,
        plaintextBytes
      );

    const rawMessageKey =
      new Uint8Array(
        await crypto.subtle.exportKey(
          "raw",
          messageKey
        )
      );

    const recipients = [
      {
        device_id:
          senderDeviceId,
        public_key:
          senderPublicKey
      },
      ...recipientKeys
    ];

    const wrappedKeys = [];

    for (const device of recipients) {
      if (
        !device?.device_id ||
        !device?.public_key
      ) {
        continue;
      }

      const remotePublicKey =
        await e2eeImportPublicKey(
          device.public_key
        );

      const wrapKey =
        await e2eeDeriveWrapKey(
          privateKey,
          remotePublicKey
        );

      const wrapIv =
        crypto.getRandomValues(
          new Uint8Array(12)
        );

      const wrapped =
        await crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: wrapIv
          },
          wrapKey,
          rawMessageKey
        );

      wrappedKeys.push({
        device_id:
          String(device.device_id),
        public_key:
          String(device.public_key),
        wrap_iv:
          e2eeBase64(wrapIv),
        wrapped_key:
          e2eeBase64(
            new Uint8Array(wrapped)
          )
      });
    }

    if (!wrappedKeys.length) {
      throw new Error(
        "تعذر تجهيز مفاتيح الرسالة المشفرة."
      );
    }

    return {
      ciphertext:
        e2eeBase64(
          new Uint8Array(ciphertext)
        ),

      iv:
        e2eeBase64(messageIv),

      envelope: {
        v: 1,
        sender_device_id:
          senderDeviceId,
        sender_public_key:
          senderPublicKey,
        keys:
          wrappedKeys
      }
    };
  }

  async function initializeE2EEKeys() {
    try {
      await e2eeCreateDeviceKeys();

      console.log(
        "[E2EE] مفتاح الجهاز جاهز."
      );

      return true;
    } catch (error) {
      console.error(
        "[E2EE] initialization failed:",
        error
      );

      return false;
    }
  }

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

  /* =========================================================
     E2EE اختياري - زر الرسالة المشفرة
  ========================================================= */

  let encryptedMessageMode = false;

  function updateEncryptedMessageButton() {
    const button =
      document.getElementById("encryptedMessageBtn");

    if (!button) return;

    if (encryptedMessageMode) {
      button.style.background = "rgba(0,168,132,0.15)";
      button.style.border = "2px solid #00a884";
      button.style.borderRadius = "8px";
      button.style.color = "#007a63";
      button.title = "الرسالة المشفرة مفعلة - اضغط للإيقاف";
      button.setAttribute("aria-pressed", "true");
    } else {
      button.style.background = "none";
      button.style.border = "none";
      button.style.borderRadius = "";
      button.style.color = "#00a884";
      button.title = "رسالة مشفرة طرفياً";
      button.setAttribute("aria-pressed", "false");
    }
  }

  function installEncryptedMessageButton() {
    const button =
      document.getElementById("encryptedMessageBtn");

    if (!button) {
      console.warn(
        "[E2EE] زر الرسالة المشفرة غير موجود."
      );
      return;
    }

    if (button.dataset.e2eeBound === "1") {
      updateEncryptedMessageButton();
      return;
    }

    button.dataset.e2eeBound = "1";

    button.addEventListener("click", function () {

      /*
       * التشفير الاختياري للمحادثات الخاصة فقط.
       */
      if (!selectedUser || selectedGroup) {
        encryptedMessageMode = false;
        updateEncryptedMessageButton();

        alert(
          "الرسالة المشفرة الاختيارية متاحة للمحادثات الخاصة فقط."
        );

        return;
      }

      encryptedMessageMode =
        !encryptedMessageMode;

      updateEncryptedMessageButton();

      if (encryptedMessageMode) {
        console.log(
          "[E2EE] تم تفعيل وضع الرسائل المشفرة."
        );
      } else {
        console.log(
          "[E2EE] تم إيقاف وضع الرسائل المشفرة."
        );
      }
    });

    updateEncryptedMessageButton();
  }

  function installViewOnceButton() {
    const button = document.getElementById("viewOnceBtn");

    if (!button) {
      console.warn("[VIEW-ONCE] زر الرسالة المؤقتة غير موجود.");
      return;
    }

    if (button.dataset.viewOnceBound === "1") {
      updateViewOnceButton();
      return;
    }

    button.dataset.viewOnceBound = "1";

    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();

      toggleViewOnceMode();

      console.log(
        "[VIEW-ONCE] mode:",
        viewOnceMode ? "ON" : "OFF"
      );
    });

    updateViewOnceButton();

    console.log("[VIEW-ONCE] زر الرسالة المؤقتة تم ربطه.");
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

  async function e2eeDecryptMessage(message) {
    const privateKey =
      await e2eeLoadPrivateKey();

    if (!privateKey) {
      throw new Error(
        "مفتاح التشفير الخاص بهذا الجهاز غير موجود."
      );
    }

    const envelope =
      typeof message.encryption_sender_key === "string"
        ? JSON.parse(message.encryption_sender_key)
        : message.encryption_sender_key;

    if (
      !envelope ||
      Number(envelope.v) !== 1 ||
      !Array.isArray(envelope.keys) ||
      !envelope.sender_public_key
    ) {
      throw new Error(
        "بيانات الرسالة المشفرة غير صالحة."
      );
    }

    const deviceId =
      e2eeDeviceId();

    const keyEntry =
      envelope.keys.find(
        item =>
          String(item?.device_id || "") ===
          String(deviceId)
      );

    if (!keyEntry) {
      throw new Error(
        "لا يوجد مفتاح لهذه الرسالة على هذا الجهاز."
      );
    }

    const remotePublicKey =
      await e2eeImportPublicKey(
        keyEntry.public_key ||
        envelope.sender_public_key
      );

    const wrapKey =
      await e2eeDeriveWrapKey(
        privateKey,
        remotePublicKey
      );

    const rawMessageKey =
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv:
            e2eeFromBase64(
              keyEntry.wrap_iv
            )
        },
        wrapKey,
        e2eeFromBase64(
          keyEntry.wrapped_key
        )
      );

    const messageKey =
      await crypto.subtle.importKey(
        "raw",
        rawMessageKey,
        {
          name: "AES-GCM"
        },
        false,
        ["decrypt"]
      );

    const plaintext =
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv:
            e2eeFromBase64(
              message.encryption_iv
            )
        },
        messageKey,
        e2eeFromBase64(
          message.message || ""
        )
      );

    return new TextDecoder().decode(
      plaintext
    );
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

      /*
       * اتجاه الرسائل:
       * رسائل المرسل في اليمين
       * رسائل المستلم في اليسار
       */
      div.style.alignSelf =
        mine ? "flex-end" : "flex-start";

      div.style.textAlign =
        mine ? "right" : "left";

      div.style.marginLeft =
        mine ? "auto" : "0";

      div.style.marginRight =
        mine ? "0" : "auto";

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

      const isEncrypted =
        Number(message?.is_encrypted) === 1;

      const body =
        isEncrypted
          ? (
              message._e2ee_error
                ? "رسالة مشفرة — تعذر فكها على هذا الجهاز"
                : (
                    message._decrypted_body ??
                    "رسالة مشفرة — جاري فك التشفير"
                  )
            )
          : (
              message.body ||
              message.message ||
              ""
            );

      const bodyDiv =
        document.createElement("div");

      if (
        isViewOnce &&
        isViewed
      ) {

        // الرسالة المؤقتة المفتوحة لا تعرض محتواها
        // وسيتم إخفاؤها بالكامل من المحادثة أدناه.

        return;

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
          isEncrypted
            ? "🔒 " + body
            : body;
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

      /*
       * حالة الاستلام تظهر للرسائل التي أرسلها المستخدم فقط:
       * ✓✓ أحمر = لم يتم الاستلام
       * ✓✓✓ برتقالي = تم الاستلام
       */
      if (mine && !selectedGroup) {

        const deliveryStatus =
          document.createElement("span");

        deliveryStatus.textContent =
          message.delivered_at
            ? " ✓✓✓"
            : " ✓✓";

        deliveryStatus.style.fontWeight =
          "bold";

        deliveryStatus.style.fontSize =
          "15px";

        deliveryStatus.style.marginRight =
          "5px";

        deliveryStatus.style.display =
          "inline-block";

        deliveryStatus.style.direction =
          "ltr";

        deliveryStatus.style.color =
          message.delivered_at
            ? "#f59e0b"
            : "#ef4444";

        small.appendChild(
          deliveryStatus
        );
      }

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

      /*
       * E2EE اختياري للمحادثات الخاصة فقط.
       * لا نغير نظام الرسائل العادية.
       */
      if (encryptedMessageMode) {

        if (selectedGroup) {
          alert(
            "الرسائل المشفرة الاختيارية متاحة للمحادثات الخاصة فقط."
          );

          return;
        }

        if (viewOnceMode) {
          alert(
            "لا يمكن دمج الرسالة المشفرة مع الرسالة المؤقتة حالياً."
          );

          return;
        }

        const encrypted =
          await e2eeEncryptMessage(
            body,
            Number(selectedUser.id)
          );

        payload.message =
          encrypted.ciphertext;

        payload.is_encrypted =
          1;

        payload.encryption_iv =
          encrypted.iv;

        payload.encryption_version =
          "1";

        payload.encryption_sender_key =
          JSON.stringify(
            encrypted.envelope
          );
      }

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

      if (encryptedMessageMode) {
        encryptedMessageMode = false;
        updateEncryptedMessageButton();
      }

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
     * نحفظ هوية المستخدم التي بدأ بها boot.
     * إذا تغيرت الهوية أثناء تنفيذ boot (مثلاً من
     * جلسة قديمة إلى تسجيل دخول جديد)، سيعاد تشغيل
     * boot بعد انتهاء العملية الحالية حتى لا تبقى
     * الواجهة على المستخدم القديم.
     */
    const bootUserId = Number(me?.id || 0);

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
      isSystemManager()
        ? `مدير النظام • ${
            me.name ||
            me.username ||
            ""
          }`
        : isAdmin()
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
     * إدارة مدير النظام.
     * تظهر فقط للحساب الذي يحمل role=system_manager.
     * المشرف والمستخدم العادي لا تظهر لهما.
     */
    bindSystemManagerControls();

    console.log(
      "[SYSTEM_MANAGER_DEBUG]",
      {
        user: me,
        role: me?.role,
        isAdmin: isAdmin(),
        isSystemManager: isSystemManager(),
        panel: !!$("systemManagerPanel")
      }
    );

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

    /*
     * إذا تغير المستخدم أثناء تشغيل boot، فلا نترك
     * الواجهة على هوية المستخدم القديمة.
     * بعد انتهاء boot الحالي نعيد البناء بالمستخدم الجديد.
     */
    if (
      me &&
      Number(me.id || 0) !== bootUserId
    ) {
      console.log(
        "[BOOT] USER_CHANGED",
        {
          oldUserId: bootUserId,
          newUserId: Number(me.id || 0),
          username: me.username,
          role: me.role
        }
      );

      await boot();
    }
  }

  async function restoreSession() {

    /*
     * حفظ إصدار المصادقة الحالي.
     * إذا بدأ تسجيل دخول جديد أثناء انتظار /api/me،
     * يتم تجاهل نتيجة الجلسة القديمة.
     */
    const restoreGeneration = authGeneration;
    const restoreToken = token;

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

      /*
       * لا تسمح لجلسة قديمة بالكتابة فوق هوية
       * المستخدم الذي سجل دخوله الآن.
       */
      if (
        restoreGeneration !== authGeneration ||
        restoreToken !== token
      ) {
        console.warn(
          "[AUTH] تم تجاهل restoreSession قديمة."
        );
        return;
      }

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

  /* =========================================================
     مدير النظام - إدارة المشرفين
  ========================================================= */

  function systemManagerStatus(message, type = "blue") {

    const box = $("systemManagerStatus");

    if (!box) {
      return;
    }

    box.className =
      "notice " +
      (
        type === "green"
          ? "green"
          : type === "red"
            ? "red"
            : "blue"
      );

    box.textContent = message || "";

    box.classList.remove("hidden");
  }

  function hideSystemManagerStatus() {

    const box = $("systemManagerStatus");

    if (!box) {
      return;
    }

    box.textContent = "";
    box.classList.add("hidden");
  }

  function updateSystemManagerPanelVisibility() {

    const panel =
      $("systemManagerPanel");

    if (!panel) {
      return;
    }

    if (isSystemManager()) {

      panel.classList.remove("hidden");

    } else {

      panel.classList.add("hidden");

    }
  }

  async function loadSystemManagerSupervisors() {

    if (!isSystemManager()) {
      return;
    }

    const list =
      $("systemManagerSupervisorsList");

    if (!list) {
      return;
    }

    list.innerHTML = `
      <div class="notice blue">
        جاري تحميل المشرفين...
      </div>
    `;

    try {

      const data =
        await api("/api/admin/users");

      const users =
        Array.isArray(data?.users)
          ? data.users
          : [];

      const supervisors =
        users.filter(function (user) {

          return (
            user &&
            user.role === "admin" &&
            Number(user.is_admin) === 1
          );

        });

      if (!supervisors.length) {

        list.innerHTML = `
          <div class="notice blue">
            لا يوجد مشرفون مسجلون حالياً.
          </div>
        `;

        return;
      }

      let html = "";

      supervisors.forEach(function (user) {

        const userId =
          Number(user.id);

        const name =
          escapeHtml(
            user.name ||
            user.username ||
            ""
          );

        const username =
          escapeHtml(
            user.username ||
            ""
          );

        const status =
          escapeHtml(
            user.status ||
            "active"
          );

        html += `
          <div
            class="system-item"
            style="
              margin-bottom:8px;
              padding:10px;
              border:1px solid rgba(0,191,255,.18);
              border-radius:7px;
            "
          >

            <b>${name}</b>

            <div style="
              font-size:12px;
              opacity:.85;
              margin-top:4px;
            ">
              اسم المستخدم:
              ${username}
            </div>

            <div style="
              font-size:12px;
              opacity:.85;
              margin-top:3px;
            ">
              الحالة:
              ${status}
            </div>

            <div style="
              margin-top:8px;
            ">

              <button
                type="button"
                class="danger-btn"
                data-system-manager-delete-supervisor="${userId}"
              >
                <i class="fa-solid fa-user-minus"></i>
                حذف المشرف
              </button>

            </div>

          </div>
        `;
      });

      list.innerHTML = html;

    } catch (error) {

      console.error(
        "loadSystemManagerSupervisors:",
        error
      );

      list.innerHTML = `
        <div class="notice red">
          تعذر تحميل قائمة المشرفين.
          ${escapeHtml(
            error?.message || ""
          )}
        </div>
      `;
    }
  }

  async function createSupervisorFromSystemManager() {

    if (!isSystemManager()) {

      systemManagerStatus(
        "هذه العملية متاحة لمدير النظام فقط.",
        "red"
      );

      return;
    }

    const username =
      String(
        $("systemManagerSupervisorUsername")?.value ||
        ""
      ).trim();

    const name =
      String(
        $("systemManagerSupervisorName")?.value ||
        ""
      ).trim();

    const password =
      String(
        $("systemManagerSupervisorPassword")?.value ||
        ""
      );

    if (!username || !password) {

      systemManagerStatus(
        "اسم المستخدم وكلمة المرور مطلوبان.",
        "red"
      );

      return;
    }

    const button =
      $("systemManagerAddSupervisorBtn");

    try {

      if (button) {
        button.disabled = true;
      }

      hideSystemManagerStatus();

      const result =
        await api(
          "/api/system-manager/supervisors",
          {
            method: "POST",
            body: JSON.stringify({
              username,
              name,
              password
            })
          }
        );

      systemManagerStatus(
        result?.message ||
        "تم إنشاء المشرف بنجاح.",
        "green"
      );

      const usernameInput =
        $("systemManagerSupervisorUsername");

      const nameInput =
        $("systemManagerSupervisorName");

      const passwordInput =
        $("systemManagerSupervisorPassword");

      if (usernameInput) {
        usernameInput.value = "";
      }

      if (nameInput) {
        nameInput.value = "";
      }

      if (passwordInput) {
        passwordInput.value = "";
      }

      await loadSystemManagerSupervisors();

    } catch (error) {

      console.error(
        "createSupervisorFromSystemManager:",
        error
      );

      systemManagerStatus(
        error?.message ||
        "تعذر إنشاء المشرف.",
        "red"
      );

    } finally {

      if (button) {
        button.disabled = false;
      }

    }
  }

  async function deleteSupervisorFromSystemManager(id) {

    if (!isSystemManager()) {

      systemManagerStatus(
        "هذه العملية متاحة لمدير النظام فقط.",
        "red"
      );

      return;
    }

    const supervisorId =
      Number(id);

    if (
      !Number.isInteger(supervisorId) ||
      supervisorId <= 0
    ) {

      systemManagerStatus(
        "معرف المشرف غير صحيح.",
        "red"
      );

      return;
    }

    const confirmed =
      confirm(
        "هل أنت متأكد من حذف حساب هذا المشرف؟"
      );

    if (!confirmed) {
      return;
    }

    try {

      const result =
        await api(
          "/api/system-manager/supervisors/" +
          encodeURIComponent(
            String(supervisorId)
          ),
          {
            method: "DELETE"
          }
        );

      systemManagerStatus(
        result?.message ||
        "تم حذف المشرف بنجاح.",
        "green"
      );

      await loadSystemManagerSupervisors();

    } catch (error) {

      console.error(
        "deleteSupervisorFromSystemManager:",
        error
      );

      systemManagerStatus(
        error?.message ||
        "تعذر حذف المشرف.",
        "red"
      );

    }
  }


  const SYSTEM_MANAGER_PERMISSIONS = [
    ["add_user", "إضافة مستخدم"],
    ["block_user", "حظر مستخدم"],
    ["freeze_user", "تجميد مستخدم"],
    ["release_user", "إطلاق وفك التجميد"],
    ["app_lock", "قفل التطبيق"],
    ["clear_chat", "مسح المحادثة"],
    ["backup", "النسخة الاحتياطية"],
    ["locations", "معرفة المواقع"],
    ["warnings", "استعراض تحذيرات النظام"],
    ["broadcast", "رسالة للجميع"],
    ["manage_users", "إدارة الحسابات"],
    ["user_reports", "تقرير الوحدات والفرق"],
    ["credentials_report", "تقرير الحسابات"],
    ["channels", "القنوات"],
    ["audit", "سجل النظام"],
    ["update_database", "تحديث قاعدة البيانات"],
    ["alert_mode", "حالة التأهب"],
    ["network_off", "إطفاء الشبكة"],
    ["network_restart", "إعادة تشغيل النظام"]
  ];

  function renderSystemManagerPermissions(
    permissions
  ) {

    const list =
      $("systemManagerPermissionsList");

    if (!list) {
      return;
    }

    const map = {};

    (Array.isArray(permissions)
      ? permissions
      : []
    ).forEach(function(item) {

      map[
        String(item.permission || "")
      ] = Number(item.allowed) === 1;

    });

    let html = "";

    SYSTEM_MANAGER_PERMISSIONS.forEach(
      function(item) {

        const permission = item[0];
        const label = item[1];

        const checked =
          map[permission] !== false;

        html += `
          <label
            style="
              display:flex;
              align-items:center;
              justify-content:space-between;
              gap:10px;
              padding:10px;
              margin-bottom:7px;
              border:1px solid rgba(0,191,255,.18);
              border-radius:7px;
              cursor:pointer;
            "
          >

            <span>
              ${escapeHtml(label)}
            </span>

            <span
              style="
                display:flex;
                align-items:center;
                gap:7px;
                direction:ltr;
              "
            >

              <input
                type="checkbox"
                class="system-manager-permission"
                data-permission="${escapeHtml(permission)}"
                ${checked ? "checked" : ""}
              >

              <b
                class="system-manager-permission-value"
                data-value-for="${escapeHtml(permission)}"
              >
                ${checked ? "true" : "false"}
              </b>

            </span>

          </label>
        `;
      }
    );

    list.innerHTML = html;

    list
      .querySelectorAll(
        ".system-manager-permission"
      )
      .forEach(function(checkbox) {

        checkbox.addEventListener(
          "change",
          function() {

            const value =
              checkbox.checked;

            const valueBox =
              list.querySelector(
                '[data-value-for="' +
                CSS.escape(
                  checkbox.dataset.permission
                ) +
                '"]'
              );

            if (valueBox) {
              valueBox.textContent =
                value ? "true" : "false";
            }
          }
        );
      });
  }

  async function loadSystemManagerPermissions() {

    if (!isSystemManager()) {
      return;
    }

    const select =
      $("systemManagerPermissionSupervisor");

    const list =
      $("systemManagerPermissionsList");

    if (!select || !list) {
      return;
    }

    const supervisorId =
      Number(select.value || 0);

    if (!supervisorId) {

      list.innerHTML = `
        <div class="notice blue">
          اختر مشرفاً لعرض صلاحياته.
        </div>
      `;

      return;
    }

    list.innerHTML = `
      <div class="notice blue">
        جاري تحميل الصلاحيات...
      </div>
    `;

    try {

      const data =
        await api(
          "/api/system-manager/supervisors/" +
          encodeURIComponent(
            String(supervisorId)
          ) +
          "/permissions"
        );

      renderSystemManagerPermissions(
        data?.permissions || []
      );

    } catch (error) {

      console.error(
        "loadSystemManagerPermissions:",
        error
      );

      list.innerHTML = `
        <div class="notice red">
          تعذر تحميل الصلاحيات.
          ${escapeHtml(
            error?.message || ""
          )}
        </div>
      `;
    }
  }

  async function saveSystemManagerPermissions() {

    if (!isSystemManager()) {

      systemManagerStatus(
        "هذه العملية متاحة لمدير النظام فقط.",
        "red"
      );

      return;
    }

    const select =
      $("systemManagerPermissionSupervisor");

    const supervisorId =
      Number(select?.value || 0);

    if (!supervisorId) {

      systemManagerStatus(
        "اختر المشرف أولاً.",
        "red"
      );

      return;
    }

    const list =
      $("systemManagerPermissionsList");

    if (!list) {
      return;
    }

    const permissions = [];

    list
      .querySelectorAll(
        ".system-manager-permission"
      )
      .forEach(function(checkbox) {

        permissions.push({
          permission:
            checkbox.dataset.permission,

          allowed:
            checkbox.checked
        });

      });

    const button =
      $("systemManagerSavePermissionsBtn");

    try {

      if (button) {
        button.disabled = true;
      }

      const result =
        await api(
          "/api/system-manager/supervisors/" +
          encodeURIComponent(
            String(supervisorId)
          ) +
          "/permissions",
          {
            method: "PUT",

            body: JSON.stringify({
              permissions
            })
          }
        );

      systemManagerStatus(
        result?.message ||
        "تم حفظ الصلاحيات بنجاح.",
        "green"
      );

      await loadSystemManagerPermissions();

    } catch (error) {

      console.error(
        "saveSystemManagerPermissions:",
        error
      );

      systemManagerStatus(
        error?.message ||
        "تعذر حفظ الصلاحيات.",
        "red"
      );

    } finally {

      if (button) {
        button.disabled = false;
      }
    }
  }

  function loadSystemManagerPermissionSupervisors() {

    if (!isSystemManager()) {
      return;
    }

    const select =
      $("systemManagerPermissionSupervisor");

    if (!select) {
      return;
    }

    api("/api/admin/users")
      .then(function(data) {

        const users =
          Array.isArray(data?.users)
            ? data.users
            : [];

        const supervisors =
          users.filter(function(user) {

            return (
              user &&
              user.role === "admin" &&
              Number(user.is_admin) === 1
            );

          });

        const current =
          select.value;

        let html =
          '<option value="">اختر مشرفاً</option>';

        supervisors.forEach(
          function(user) {

            html += `
              <option value="${Number(user.id)}">
                ${escapeHtml(
                  user.name ||
                  user.username ||
                  ""
                )}
                -
                ${escapeHtml(
                  user.username || ""
                )}
              </option>
            `;

          }
        );

        select.innerHTML = html;

        if (
          current &&
          supervisors.some(
            user =>
              String(user.id) ===
              String(current)
          )
        ) {
          select.value = current;
        }

        loadSystemManagerPermissions();

      })
      .catch(function(error) {

        console.error(
          "loadSystemManagerPermissionSupervisors:",
          error
        );

      });
  }

  function bindSystemManagerControls() {

    updateSystemManagerPanelVisibility();

    const permissionSelect =
      $("systemManagerPermissionSupervisor");

    if (
      permissionSelect &&
      !permissionSelect.dataset.permissionsReady
    ) {

      permissionSelect.dataset.permissionsReady =
        "1";

      permissionSelect.addEventListener(
        "change",
        loadSystemManagerPermissions
      );
    }

    const savePermissionsButton =
      $("systemManagerSavePermissionsBtn");

    if (
      savePermissionsButton &&
      !savePermissionsButton.dataset.permissionsReady
    ) {

      savePermissionsButton.dataset.permissionsReady =
        "1";

      savePermissionsButton.addEventListener(
        "click",
        saveSystemManagerPermissions
      );
    }

    const backPermissionsButton =
      $("systemManagerBackPermissionsBtn");

    if (
      backPermissionsButton &&
      !backPermissionsButton.dataset.permissionsReady
    ) {

      backPermissionsButton.dataset.permissionsReady =
        "1";

      backPermissionsButton.addEventListener(
        "click",
        function() {

          const section =
            $("systemManagerPermissionsSection");

          if (section) {
            section.classList.add("hidden");
          }

          const supervisorSection =
            $("systemManagerSupervisorsList")
              ?.closest(".admin-section");

          if (supervisorSection) {
            supervisorSection.scrollIntoView({
              behavior: "smooth",
              block: "start"
            });
          }
        }
      );
    }

    if (isSystemManager()) {
      loadSystemManagerPermissionSupervisors();
    }


    const addButton =
      $("systemManagerAddSupervisorBtn");

    if (
      addButton &&
      !addButton.dataset.systemManagerReady
    ) {

      addButton.dataset.systemManagerReady =
        "1";

      addButton.addEventListener(
        "click",
        createSupervisorFromSystemManager
      );
    }

    const list =
      $("systemManagerSupervisorsList");

    if (
      list &&
      !list.dataset.systemManagerReady
    ) {

      list.dataset.systemManagerReady =
        "1";

      list.addEventListener(
        "click",
        function (event) {

          const button =
            event.target.closest(
              "[data-system-manager-delete-supervisor]"
            );

          if (!button) {
            return;
          }

          deleteSupervisorFromSystemManager(
            button.getAttribute(
              "data-system-manager-delete-supervisor"
            )
          );
        }
      );
    }

    if (isSystemManager()) {
      loadSystemManagerSupervisors();
    }
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

              const nameIcon =
                L.divIcon({
                  className: "user-map-name-marker",
                  html: `
                    <div style="
                      position:relative;
                      transform:translate(-50%,-100%);
                      display:flex;
                      flex-direction:column;
                      align-items:center;
                      width:max-content;
                    ">
                      <div style="
                        background:#ffffff;
                        border:1px solid #2563eb;
                        border-radius:8px;
                        padding:4px 8px;
                        box-shadow:0 2px 7px rgba(0,0,0,.25);
                        color:#111827;
                        font-size:13px;
                        font-weight:700;
                        white-space:nowrap;
                        direction:rtl;
                      ">
                        ${escapeHtml(displayName)}
                      </div>

                      <div style="
                        width:14px;
                        height:14px;
                        margin-top:2px;
                        background:#2563eb;
                        border:2px solid #ffffff;
                        border-radius:50%;
                        box-shadow:0 1px 4px rgba(0,0,0,.35);
                      "></div>
                    </div>
                  `,
                  iconSize: null,
                  iconAnchor: [0, 0]
                });

              const marker =
                L.marker(
                  [
                    lat,
                    lng
                  ],
                  {
                    icon: nameIcon
                  }
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

    const button = $("updateDatabaseBtn");
    const originalHtml = button?.innerHTML;

    try {

      if (button) {
        button.disabled = true;
        button.innerHTML =
          `<i class="fa-solid fa-spinner fa-spin"></i>
           جارٍ تحديث قاعدة البيانات...`;
      }

      /*
       * أولاً:
       * حفظ قاعدة البيانات فعلياً على السيرفر.
       */
      const result =
        await api(
          "/api/admin/database/update",
          {
            method: "POST"
          }
        );

      adminStatus(
        result.message ||
        "تم تحديث وحفظ قاعدة البيانات.",
        "green"
      );

      /*
       * تحديث بيانات الواجهة قبل إعادة تحميل التطبيق.
       */
      try {
        await refreshTeamStats();
      } catch (error) {
        console.warn(
          "[UPDATE] refreshTeamStats:",
          error.message
        );
      }

      try {
        await loadUsers();
      } catch (error) {
        console.warn(
          "[UPDATE] loadUsers:",
          error.message
        );
      }

      try {
        await loadGroups();
      } catch (error) {
        console.warn(
          "[UPDATE] loadGroups:",
          error.message
        );
      }

      /*
       * إعادة تحميل التطبيق بالكامل حتى تُقرأ
       * آخر نسخة من قاعدة البيانات والواجهة.
       *
       * التوكن محفوظ في localStorage، لذلك سيعود
       * المستخدم إلى التطبيق بعد إعادة التحميل.
       */
      setTimeout(() => {
        window.location.reload();
      }, 700);

    } catch (error) {

      console.error(
        "[UPDATE_DATABASE_ERROR]",
        error
      );

      adminStatus(
        "فشل تحديث قاعدة البيانات: " +
        error.message,
        "red"
      );

      if (button) {
        button.disabled = false;

        button.innerHTML =
          originalHtml ||
          `<i class="fa-solid fa-database"></i>
           تحديث قاعدة البيانات`;
      }
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

        if (user.profile_image) {
          const img = document.createElement("img");

          img.src = user.profile_image;
          img.alt = "صورة البروفايل";
          img.style.cssText = `
            width:100%;
            height:100%;
            border-radius:50%;
            object-fit:cover;
            display:block;
          `;

          avatar.innerHTML = "";
          avatar.appendChild(img);
        } else {
          avatar.innerHTML =
            '<i class="fa-solid fa-user"></i>';
        }

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

    $("interactiveUsersMapBtn")
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
        installViewOnceButton();
        console.log("[STARTUP] installViewOnceButton COMPLETE");

        installEncryptedMessageButton();
        console.log("[STARTUP] installEncryptedMessageButton COMPLETE");
      } catch (error) {
        console.error("[STARTUP] installViewOnceButton ERROR:", error);
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
                .getElementById("personalDataPageBtn")
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
    const settings = el("appSettingsPageBtn");
    const profile = el("profileSettingsPageBtn");

    [messages, admin, settings, profile].forEach(function (button) {

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
    const settingsPage = el("appSettingsPage");
    const profilePage = el("profileSettingsPage");

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

    if (settingsPage) {
      settingsPage.classList.add("hidden");
    }

    if (profilePage) {
      profilePage.classList.add("hidden");
    }

    /* عند فتح المحادثات المشفرة نعرض قائمة المستخدمين في الوسط */
    app.classList.add("users-home");

    setActiveButton("messagesPageBtn");

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  function openAdminDataPage() {

    const oldAdminPanel = el("adminPanel");

    if (oldAdminPanel) {
      oldAdminPanel.classList.add("hidden");
      oldAdminPanel.style.display = "none";
    }

    const app = el("appPage");
    const adminPage = el("adminDataPage");
    const settingsPage = el("appSettingsPage");
    const profilePage = el("profileSettingsPage");
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

    if (settingsPage) {
      settingsPage.classList.add("hidden");
    }

    if (profilePage) {
      profilePage.classList.add("hidden");
    }

    setActiveButton("adminDataPageBtn");

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  function openAppSettingsPage() {

    const app = el("appPage");
    const adminPage = el("adminDataPage");
    const settingsPage = el("appSettingsPage");
    const profilePage = el("profileSettingsPage");

    if (!app || !adminPage || !settingsPage) {
      return;
    }

    app.classList.add("hidden");
    adminPage.classList.add("hidden");

    if (profilePage) {
      profilePage.classList.add("hidden");
    }

    settingsPage.classList.remove("hidden");

    setActiveButton("appSettingsPageBtn");

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  function closeAppSettingsPage() {

    const settingsPage = el("appSettingsPage");

    if (!settingsPage) {
      return;
    }

    settingsPage.classList.add("hidden");

    openMessagesPage();
  }

  function openProfileSettingsPage() {

    const app = el("appPage");
    const adminPage = el("adminDataPage");
    const settingsPage = el("appSettingsPage");
    const profilePage = el("profileSettingsPage");

    if (!profilePage) {
      return;
    }

    if (app) {
      app.classList.add("hidden");
    }

    if (adminPage) {
      adminPage.classList.add("hidden");
    }

    if (settingsPage) {
      settingsPage.classList.add("hidden");
    }

    profilePage.classList.remove("hidden");

    /*
     * إعدادات تغيير كلمة المرور:
     * تظهر لمدير النظام فقط.
     * إخفاء الواجهة ليس حماية للخادم؛
     * التحقق الحقيقي سيضاف لاحقاً في server.js.
     */
    const passwordSection = el("systemManagerPasswordSection");

    if (passwordSection) {
      const isSystemManager =
        me &&
        String(me.role || "").trim() === "system_manager";

      if (isSystemManager) {
        passwordSection.classList.remove("hidden");
        passwordSection.style.display = "flex";
      } else {
        passwordSection.classList.add("hidden");
        passwordSection.style.display = "none";
      }
    }

    /*
     * عرض اسم المستخدم الحالي داخل واجهة تغيير كلمة المرور.
     */
    const currentUsername = el("profileCurrentUsername");

    if (currentUsername) {
      currentUsername.value =
        me && me.username
          ? String(me.username)
          : "";
    }

    setActiveButton("profileSettingsPageBtn");

    const avatar = el("profileSettingsAvatar");

    if (avatar && window.currentProfileImage) {
      avatar.innerHTML =
        '<img src="' +
        window.currentProfileImage +
        '" alt="صورة البروفايل" style="width:100%;height:100%;object-fit:cover;">';
    }

    window.scrollTo({
      top: 0,
      behavior: "smooth"
    });
  }

  
async function bindProfilePattern() {
  return new Promise(function (resolve) {
    const oldOverlay =
      document.getElementById("profilePatternDrawingOverlay");

    if (oldOverlay) {
      oldOverlay.remove();
    }

    const overlay = document.createElement("div");
    overlay.id = "profilePatternDrawingOverlay";

    overlay.style.cssText = `
      position:fixed;
      inset:0;
      z-index:99999;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:20px;
      box-sizing:border-box;
      background:rgba(0,0,0,.58);
    `;

    overlay.innerHTML = `
      <div
        style="
          width:min(420px,100%);
          background:var(--bg-secondary,#fff);
          border:1px solid var(--border-color,#ddd);
          border-radius:20px;
          padding:22px;
          box-sizing:border-box;
          text-align:center;
          box-shadow:0 15px 50px rgba(0,0,0,.30);
          direction:rtl;
        "
      >
        <div
          style="
            font-size:21px;
            font-weight:800;
            margin-bottom:8px;
          "
        >
          <i
            class="fa-solid fa-shield-halved"
            style="color:#00A878;margin-left:7px;"
          ></i>
          رسم نقش الحماية
        </div>

        <div
          id="profilePatternDrawingMessage"
          style="
            margin:8px 0 16px;
            line-height:1.8;
            font-size:15px;
          "
        >
          ارسم نقش الحماية على النقاط، ويجب اختيار 4 نقاط على الأقل.
        </div>

        <div
          id="profilePatternGrid"
          style="
            width:min(290px,82vw);
            aspect-ratio:1;
            margin:0 auto 18px;
            display:grid;
            grid-template-columns:repeat(3,1fr);
            gap:22px;
            padding:24px;
            box-sizing:border-box;
            touch-action:none;
            user-select:none;
          "
        >
          ${Array.from({length:9}, (_,i) => `
            <button
              type="button"
              data-pattern-node="${i}"
              aria-label="نقطة ${i + 1}"
              style="
                width:100%;
                aspect-ratio:1;
                max-width:62px;
                margin:auto;
                border-radius:50%;
                border:3px solid #00A878;
                background:rgba(0,168,120,.10);
                box-shadow:0 0 0 7px rgba(0,168,120,.07);
                padding:0;
                touch-action:none;
              "
            ></button>
          `).join("")}
        </div>

        <div
          style="
            display:flex;
            gap:10px;
            justify-content:center;
          "
        >
          <button
            id="profilePatternCancelBtn"
            type="button"
            class="secondary"
            style="min-height:44px;flex:1;"
          >
            إلغاء
          </button>

          <button
            id="profilePatternClearBtn"
            type="button"
            class="secondary"
            style="min-height:44px;flex:1;"
          >
            مسح
          </button>

          <button
            id="profilePatternSaveBtn"
            type="button"
            style="
              min-height:44px;
              flex:1;
              font-weight:700;
            "
          >
            حفظ النقش
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const grid =
      document.getElementById("profilePatternGrid");

    const message =
      document.getElementById(
        "profilePatternDrawingMessage"
      );

    const nodes =
      Array.from(
        overlay.querySelectorAll(
          "[data-pattern-node]"
        )
      );

    const selected = [];

    function setNodeState(node, active) {
      node.style.background =
        active
          ? "#00A878"
          : "rgba(0,168,120,.10)";

      node.style.transform =
        active ? "scale(1.08)" : "scale(1)";

      node.style.boxShadow =
        active
          ? "0 0 0 8px rgba(0,168,120,.20)"
          : "0 0 0 7px rgba(0,168,120,.07)";
    }

    function selectNode(index) {
      if (selected.includes(index)) {
        return;
      }

      selected.push(index);
      setNodeState(nodes[index], true);

      message.textContent =
        selected.length >= 4
          ? "تم رسم النقش. اضغط «حفظ النقش» لإتمام الربط."
          : "اختر " +
            (4 - selected.length) +
            " نقاط إضافية على الأقل.";
    }

    function nodeFromPoint(clientX, clientY) {
      for (let i = 0; i < nodes.length; i++) {
        const rect = nodes[i].getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const radius = Math.max(rect.width, rect.height) * 0.75;

        const distance =
          Math.hypot(
            clientX - cx,
            clientY - cy
          );

        if (distance <= radius) {
          return i;
        }
      }

      return -1;
    }

    let drawing = false;

    grid.addEventListener(
      "pointerdown",
      function (event) {
        drawing = true;

        try {
          grid.setPointerCapture(event.pointerId);
        } catch (_) {}

        const index =
          nodeFromPoint(
            event.clientX,
            event.clientY
          );

        if (index >= 0) {
          selectNode(index);
        }

        event.preventDefault();
      }
    );

    grid.addEventListener(
      "pointermove",
      function (event) {
        if (!drawing) {
          return;
        }

        const index =
          nodeFromPoint(
            event.clientX,
            event.clientY
          );

        if (index >= 0) {
          selectNode(index);
        }

        event.preventDefault();
      }
    );

    grid.addEventListener(
      "pointerup",
      function () {
        drawing = false;
      }
    );

    grid.addEventListener(
      "pointercancel",
      function () {
        drawing = false;
      }
    );

    document
      .getElementById("profilePatternClearBtn")
      .addEventListener(
        "click",
        function () {
          selected.length = 0;

          nodes.forEach(function (node) {
            setNodeState(node, false);
          });

          message.textContent =
            "ارسم نقش الحماية على النقاط، ويجب اختيار 4 نقاط على الأقل.";
        }
      );

    document
      .getElementById("profilePatternCancelBtn")
      .addEventListener(
        "click",
        function () {
          overlay.remove();
          resolve(false);
        }
      );

    document
      .getElementById("profilePatternSaveBtn")
      .addEventListener(
        "click",
        async function () {
          if (selected.length < 4) {
            message.textContent =
              "يجب اختيار 4 نقاط على الأقل قبل الحفظ.";
            return;
          }

          const saveButton =
            document.getElementById(
              "profilePatternSaveBtn"
            );

          saveButton.disabled = true;
          saveButton.textContent = "جارٍ الحفظ...";

          try {
            const response = await fetch(
              "/api/profile/pattern/bind",
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json",
                  "Authorization":
                    "Bearer " +
                    String(
                      localStorage.getItem(
                        "sm_token"
                      ) || ""
                    )
                },
                body: JSON.stringify({
                  pattern:
                    selected.join("-")
                })
              }
            );

            const data =
              await response.json();

            if (!response.ok || !data.ok) {
              throw new Error(
                data.message ||
                "تعذر ربط نقش الحماية."
              );
            }

            const status =
              el(
                "profileDeviceBindingStatus"
              );

            if (status) {
              status.textContent =
                "نقش الحماية مفعّل ومرتبط بهذا الحساب.";
              status.style.color =
                "#00A878";
            }

            overlay.remove();

            alert(
              "تم ربط نقش الحماية بالحساب بنجاح."
            );

            resolve(true);

          } catch (error) {
            console.error(
              "Pattern binding failed:",
              error
            );

            message.textContent =
              error.message ||
              "تعذر ربط نقش الحماية.";

            saveButton.disabled = false;
            saveButton.textContent =
              "حفظ النقش";
          }
        }
      );
  });
}

function closeProfileSettingsPage() {

    const profilePage = el("profileSettingsPage");

    if (profilePage) {
      profilePage.classList.add("hidden");
    }

    openMessagesPage();
  }

  function installAdminPages() {

    /* =========================================================
       تغيير كلمة مرور مدير النظام
       الربط الفعلي مع API الخادم.
    ========================================================= */

    const changePasswordBtn =
        el("profileChangePasswordBtn");

    if (
        changePasswordBtn &&
        !changePasswordBtn.dataset.passwordHandlerInstalled
    ) {

        changePasswordBtn.dataset.passwordHandlerInstalled =
            "1";

        changePasswordBtn.addEventListener(
            "click",
            async () => {

                const currentUsername =
                    String(
                        el("profileCurrentUsername")?.value || ""
                    ).trim();

                const oldPassword =
                    String(
                        el("profileOldPassword")?.value || ""
                    );

                const newPassword =
                    String(
                        el("profileNewPassword")?.value || ""
                    );

                const confirmPassword =
                    String(
                        el("profileConfirmPassword")?.value || ""
                    );

                if (!currentUsername) {
                    alert("اسم المستخدم الحالي غير موجود.");
                    return;
                }

                if (!oldPassword) {
                    alert("أدخل كلمة المرور السابقة.");
                    return;
                }

                if (!newPassword) {
                    alert("أدخل كلمة المرور الجديدة.");
                    return;
                }

                if (newPassword !== confirmPassword) {
                    alert("تأكيد كلمة المرور الجديدة غير مطابق.");
                    return;
                }

                if (newPassword.length < 8) {
                    alert(
                        "كلمة المرور الجديدة يجب أن تكون 8 أحرف أو أكثر."
                    );
                    return;
                }

                if (newPassword === oldPassword) {
                    alert(
                        "كلمة المرور الجديدة يجب أن تختلف عن السابقة."
                    );
                    return;
                }

                const token =
                    localStorage.getItem("sm_token") || "";

                if (!token) {
                    alert("انتهت الجلسة. يرجى تسجيل الدخول من جديد.");
                    return;
                }

                const originalText =
                    changePasswordBtn.innerHTML;

                try {

                    changePasswordBtn.disabled = true;

                    changePasswordBtn.innerHTML =
                        '<i class="fa-solid fa-spinner fa-spin"></i> جارٍ الحفظ...';

                    const response =
                        await fetch(
                            "/api/profile/change-password",
                            {
                                method: "PUT",

                                headers: {
                                    "Content-Type":
                                        "application/json",

                                    "Authorization":
                                        "Bearer " + token
                                },

                                body: JSON.stringify({
                                    currentUsername,
                                    oldPassword,
                                    newPassword,
                                    confirmPassword
                                })
                            }
                        );

                    const data =
                        await response.json()
                            .catch(() => ({}));

                    if (!response.ok || !data.ok) {
                        throw new Error(
                            data.message ||
                            "تعذر تغيير كلمة المرور."
                        );
                    }

                    alert(
                        data.message ||
                        "تم تغيير كلمة المرور وحفظها بنجاح."
                    );

                    const oldPasswordInput =
                        el("profileOldPassword");

                    const newPasswordInput =
                        el("profileNewPassword");

                    const confirmPasswordInput =
                        el("profileConfirmPassword");

                    if (oldPasswordInput) {
                        oldPasswordInput.value = "";
                    }

                    if (newPasswordInput) {
                        newPasswordInput.value = "";
                    }

                    if (confirmPasswordInput) {
                        confirmPasswordInput.value = "";
                    }

                } catch (error) {

                    console.error(
                        "Change password error:",
                        error
                    );

                    alert(
                        error?.message ||
                        "حدث خطأ أثناء حفظ كلمة المرور."
                    );

                } finally {

                    changePasswordBtn.disabled = false;

                    changePasswordBtn.innerHTML =
                        originalText;
                }
            }
        );
    }


    const messagesButton = el("messagesPageBtn");
    const adminButton = el("adminDataPageBtn");
    const backButton = el("adminDataBackBtn");
    const settingsButton = el("appSettingsPageBtn");
    const settingsBackButton = el("appSettingsBackBtn");
    const profileButton = el("profileSettingsPageBtn");
    const profileBackButton = el("profileSettingsBackBtn");
    const personalDataButton = el("personalDataPageBtn");
    const currentProfileAvatar = el("currentProfileAvatar");

    if (
      currentProfileAvatar &&
      !currentProfileAvatar.dataset.profileSettingsReady
    ) {
      currentProfileAvatar.dataset.profileSettingsReady = "1";

      currentProfileAvatar.addEventListener(
        "click",
        openProfileSettingsPage
      );

      currentProfileAvatar.addEventListener(
        "keydown",
        function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openProfileSettingsPage();
          }
        }
      );
    }

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
        function () {
          if (typeof window.openVoiceSimulator === "function") {
            window.openVoiceSimulator();
          } else {
            alert("محاكي الصوت غير متاح حاليًا.");
          }
        }
      );

    }

    if (
      settingsButton &&
      !settingsButton.dataset.pagesReady
    ) {

      settingsButton.dataset.pagesReady = "1";

      settingsButton.addEventListener(
        "click",
        openAppSettingsPage
      );

    }

    if (
      settingsBackButton &&
      !settingsBackButton.dataset.pagesReady
    ) {

      settingsBackButton.dataset.pagesReady = "1";

      settingsBackButton.addEventListener(
        "click",
        closeAppSettingsPage
      );

    }

    const bindPatternButton = el("bindPatternBtn");

    if (
      bindPatternButton &&
      !bindPatternButton.dataset.patternReady
    ) {

      bindPatternButton.dataset.patternReady = "1";

      bindPatternButton.addEventListener(
        "click",
        bindProfilePattern
      );

    }

    if (
      profileButton &&
      !profileButton.dataset.pagesReady
    ) {

      profileButton.dataset.pagesReady = "1";

      profileButton.addEventListener(
        "click",
        openProfileSettingsPage
      );

    }

    if (
      profileBackButton &&
      !profileBackButton.dataset.pagesReady
    ) {

      profileBackButton.dataset.pagesReady = "1";

      profileBackButton.addEventListener(
        "click",
        closeProfileSettingsPage
      );

    }

    if (personalDataButton) {

      if (!personalDataButton.dataset.pagesReady) {
        personalDataButton.dataset.pagesReady = "1";

        personalDataButton.addEventListener(
          "click",
          function () {
            openPersonalDataForm();
          }
        );
      }

    }

    if (backButton) {

      if (!backButton.dataset.pagesReady) {
        backButton.dataset.pagesReady = "1";

        backButton.addEventListener(
          "click",
          function () {
            openMessagesPage();
          }
        );
      }

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

/* =========================================================
   تعديل صورة البروفايل
========================================================= */

async function saveProfileImage(file) {
    if (!file) return;

    if (!file.type.startsWith("image/")) {
        alert("يرجى اختيار صورة فقط.");
        return;
    }

    if (file.size > 4 * 1024 * 1024) {
        alert("حجم الصورة كبير. الحد الأقصى 4MB.");
        return;
    }

    const reader = new FileReader();

    reader.onload = async () => {
        try {
            const token = localStorage.getItem("sm_token");

            const response = await fetch("/api/me/profile-image", {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`
                },
                body: JSON.stringify({
                    profile_image: reader.result
                })
            });

            const data = await response.json();

            if (!response.ok || !data.ok) {
                throw new Error(
                    data.message || "تعذر حفظ صورة البروفايل."
                );
            }

            window.currentProfileImage =
                data.profile_image || "";

            /* تحديث صورة البروفايل الظاهرة فوراً */
            if (typeof me === "object" && me) {
                me.profile_image =
                    window.currentProfileImage;
            }

            const profileSettingsAvatar =
                document.getElementById("profileSettingsAvatar");

            if (profileSettingsAvatar) {
                if (window.currentProfileImage) {
                    profileSettingsAvatar.innerHTML =
                        '<img src="' +
                        window.currentProfileImage +
                        '" alt="صورة البروفايل" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">';
                } else {
                    profileSettingsAvatar.innerHTML =
                        '<i class="fa-solid fa-user"></i>';
                }
            }

            const currentProfileAvatar =
                document.getElementById("currentProfileAvatar");

            if (currentProfileAvatar) {
                if (window.currentProfileImage) {
                    currentProfileAvatar.innerHTML =
                        '<img src="' +
                        window.currentProfileImage +
                        '" alt="صورة البروفايل" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">';
                } else {
                    currentProfileAvatar.innerHTML =
                        '<i class="fa-solid fa-user"></i>';
                }
            }

            alert("تم حفظ صورة البروفايل بنجاح.");

        } catch (err) {
            console.error(
                "PROFILE_IMAGE_ERROR:",
                err
            );

            alert(
                err.message ||
                "تعذر حفظ صورة البروفايل."
            );
        }
    };

    reader.readAsDataURL(file);
}

document
    .getElementById("profileImageBtn")
    ?.addEventListener("click", () => {
        document
            .getElementById("profileImageInput")
            ?.click();
    });

document
    .getElementById("profileImageInput")
    ?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];

        if (file) {
            saveProfileImage(file);
        }

        event.target.value = "";
    });


/* PASSKEY DEVICE BINDING */
(() => {
    const bindFingerprintBtn =
        document.getElementById("bindFingerprintBtn");

    if (!bindFingerprintBtn) {
        console.warn(
            "PASSKEY: bindFingerprintBtn غير موجود."
        );
        return;
    }

    bindFingerprintBtn.addEventListener("click", async () => {
        try {
            if (
                !window.SimpleWebAuthnBrowser ||
                typeof window.SimpleWebAuthnBrowser.startRegistration !== "function"
            ) {
                alert(
                    "ميزة مفتاح المرور غير متاحة في هذا المتصفح."
                );
                return;
            }

            const token =
                localStorage.getItem("sm_token") || "";

            if (!token) {
                alert(
                    "يجب تسجيل الدخول أولاً لربط الجهاز."
                );
                return;
            }

            bindFingerprintBtn.disabled = true;

            const optionsResponse = await fetch(
                "/api/passkey/register/options",
                {
                    method: "POST",
                    headers: {
                        "Authorization":
                            "Bearer " + token,
                        "Content-Type":
                            "application/json"
                    },
                    body: JSON.stringify({})
                }
            );

            const optionsData =
                await optionsResponse.json();

            if (
                !optionsResponse.ok ||
                !optionsData.ok ||
                !optionsData.options
            ) {
                throw new Error(
                    optionsData.error ||
                    "تعذر تجهيز ربط الجهاز."
                );
            }

            const credential =
                await window.SimpleWebAuthnBrowser
                    .startRegistration({
                        optionsJSON:
                            optionsData.options
                    });

            const verifyResponse = await fetch(
                "/api/passkey/register/verify",
                {
                    method: "POST",
                    headers: {
                        "Authorization":
                            "Bearer " + token,
                        "Content-Type":
                            "application/json"
                    },
                    body: JSON.stringify({
                        response: credential
                    })
                }
            );

            const verifyData =
                await verifyResponse.json();

            if (
                !verifyResponse.ok ||
                !verifyData.ok
            ) {
                throw new Error(
                    verifyData.error ||
                    "تعذر إكمال ربط الجهاز."
                );
            }

            alert(
                "تم ربط الجهاز بمفتاح المرور بنجاح."
            );

        } catch (error) {
            console.error(
                "PASSKEY BIND ERROR:",
                error
            );

            if (
                error &&
                (
                    error.name === "NotAllowedError" ||
                    error.name === "AbortError"
                )
            ) {
                alert(
                    "تم إلغاء عملية ربط الجهاز."
                );
            } else {
                alert(
                    error?.message ||
                    "تعذر ربط الجهاز بمفتاح المرور."
                );
            }
        } finally {
            bindFingerprintBtn.disabled = false;
        }
    });


/* PASSKEY LOGIN */
async function loginWithPasskey() {
    const usernameInput =
        document.getElementById("loginUsername");

    const errorBox =
        document.getElementById("loginError");

    const passkeyLoginBtn =
        document.getElementById("passkeyLoginBtn");

    const username =
        String(
            usernameInput?.value || ""
        ).trim();

    if (!username) {
        if (errorBox) {
            errorBox.textContent =
                "أدخل اسم المستخدم أولاً.";
        }

        usernameInput?.focus();
        return;
    }

    if (
        !window.SimpleWebAuthnBrowser ||
        typeof window.SimpleWebAuthnBrowser.startAuthentication !==
            "function"
    ) {
        if (errorBox) {
            errorBox.textContent =
                "ميزة تسجيل الدخول بالبصمة غير متاحة في هذا المتصفح.";
        }

        return;
    }

    try {
        if (errorBox) {
            errorBox.textContent =
                "جاري تجهيز تسجيل الدخول بالبصمة...";
        }

        if (passkeyLoginBtn) {
            passkeyLoginBtn.disabled = true;
        }

        const optionsResponse =
            await fetch(
                "/api/passkey/login/options",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json"
                    },
                    body: JSON.stringify({
                        username
                    })
                }
            );

        const optionsData =
            await optionsResponse.json();

        if (
            !optionsResponse.ok ||
            !optionsData.ok ||
            !optionsData.options
        ) {
            throw new Error(
                optionsData.message ||
                optionsData.error ||
                "تعذر تجهيز تسجيل الدخول بالبصمة."
            );
        }

        if (errorBox) {
            errorBox.textContent =
                "يرجى استخدام البصمة أو وسيلة حماية الجهاز...";
        }

        const credential =
            await window.SimpleWebAuthnBrowser
                .startAuthentication({
                    optionsJSON:
                        optionsData.options
                });

        const verifyResponse =
            await fetch(
                "/api/passkey/login/verify",
                {
                    method: "POST",
                    headers: {
                        "Content-Type":
                            "application/json"
                    },
                    body: JSON.stringify({
                        username,
                        response: credential
                    })
                }
            );

        const data =
            await verifyResponse.json();

        if (
            !verifyResponse.ok ||
            !data.ok ||
            !data.token
        ) {
            throw new Error(
                data.message ||
                data.error ||
                "تعذر تسجيل الدخول باستخدام مفتاح المرور."
            );
        }

        token = data.token;
        me = data.user || {};

        // تهيئة مفتاح E2EE بعد نجاح مفتاح المرور دون تعطيل الدخول
        void initializeE2EEKeys();

        window.currentProfileImage =
            me.profile_image || "";


        localStorage.setItem(
            "sm_token",
            token
        );

        localStorage.setItem(
            "sm_user",
            JSON.stringify(me)
        );

        await window.loadCurrentAdminPermissions();

        if (errorBox) {
            errorBox.textContent = "";
        }

        window.showApp();

        await window.boot();

        window.connectMessengerSocket();

    } catch (error) {
        console.error(
            "Passkey login failed:",
            error
        );

        if (errorBox) {
            if (
                error &&
                (
                    error.name ===
                        "NotAllowedError" ||
                    error.name ===
                        "AbortError"
                )
            ) {
                errorBox.textContent =
                    "تم إلغاء عملية تسجيل الدخول بالبصمة.";
            } else {
                errorBox.textContent =
                    error.message ||
                    "تعذر تسجيل الدخول باستخدام البصمة.";
            }
        }

    } finally {
        if (passkeyLoginBtn) {
            passkeyLoginBtn.disabled = false;
        }
    }
}

const passkeyLoginBtn =
    document.getElementById(
        "passkeyLoginBtn"
    );

if (
    passkeyLoginBtn &&
    !passkeyLoginBtn.dataset.passkeyLoginHandlerInstalled
) {
    passkeyLoginBtn.dataset.passkeyLoginHandlerInstalled =
        "1";

    passkeyLoginBtn.addEventListener(
        "click",
        () => {
            loginWithPasskey();
        }
    );
}

})();

/* =========================================================
   VOICE CALL UI
   المرحلة الأولى: واجهة الاتصال فقط
   لا يوجد WebRTC أو اتصال حقيقي في هذه المرحلة
   ========================================================= */
(function () {
    function initVoiceCallUI() {
        const openBtn = document.getElementById("voiceCallOpenBtn");
        const overlay = document.getElementById("voiceCallOverlay");
        const closeBtn = document.getElementById("voiceCallCloseBtn");
        const searchInput = document.getElementById("voiceCallSearchInput");
        const clearBtn = document.getElementById("voiceCallSearchClearBtn");
        const usersList = document.getElementById("voiceCallUsersList");
        const manualInput = document.getElementById("voiceCallManualNumber");
        const numberStatus = document.getElementById("voiceCallNumberStatus");
        const startBtn = document.getElementById("voiceCallStartBtn");
        const endBtn = document.getElementById("voiceCallEndBtn");
        const status = document.getElementById("voiceCallStatus");

        if (!openBtn || !overlay) {
            console.warn("Voice Call UI: عناصر الواجهة غير موجودة.");
            return;
        }

        let voiceUsers = [];
        let selectedNumber = "";
        let callActive = false;

        async function openVoiceCall() {
            overlay.hidden = false;
            overlay.style.display = "flex";
            document.body.classList.add("voice-call-open");

            if (status) {
                status.textContent = "جاري تحميل المستخدمين...";
            }

            if (searchInput) {
                setTimeout(function () {
                    searchInput.focus();
                }, 100);
            }

            try {

                const data =
                    await api("/api/users");

                voiceUsers =
                    Array.isArray(data)
                        ? data
                        : (
                            Array.isArray(data?.users)
                                ? data.users
                                : []
                        );

                renderUsers("");

                if (status) {
                    status.textContent =
                        "جاهز للاتصال";
                }

            } catch (error) {

                console.error(
                    "VOICE_CALL_USERS_LOAD_ERROR:",
                    error
                );

                voiceUsers = [];

                renderUsers("");

                if (status) {
                    status.textContent =
                        "تعذر تحميل قائمة المستخدمين";
                }
            }
        }

        function closeVoiceCall() {
            if (callActive) {
                endCall();
            }

            overlay.hidden = true;
            overlay.style.display = "none";
            document.body.classList.remove("voice-call-open");
        }

        function renderUsers(query) {
            if (!usersList) return;

            const q = String(query || "").trim();

            const users = voiceUsers
                .filter(function (user) {
                    const name = String(user.name || "").toLowerCase();
                    const username = String(user.username || "").toLowerCase();
                    const search = q.toLowerCase();

                    if (!search) return true;

                    return name.includes(search) ||
                           username.includes(search);
                })
                .sort(function (a, b) {
                    const aq = String(a.name || "").toLowerCase();
                    const bq = String(b.name || "").toLowerCase();
                    const ql = q.toLowerCase();

                    const aStarts = aq.startsWith(ql) ? 0 : 1;
                    const bStarts = bq.startsWith(ql) ? 0 : 1;

                    return aStarts - bStarts;
                });

            if (!users.length) {
                usersList.innerHTML = `
                    <div class="voice-call-empty-state">
                        <i class="fas fa-search"></i>
                        <div>لا يوجد مستخدم مطابق</div>
                        <small>تحقق من اسم المستخدم</small>
                    </div>
                `;
                return;
            }

            usersList.innerHTML = users.map(function (user) {
                return `
                    <div class="voice-call-user-card" data-call-number="${user.voice_call_number || ""}">
                        <div class="voice-call-user-info">
                            <div class="voice-call-user-name">${user.name}</div>
                            <div class="voice-call-user-number">${user.voice_call_number || "بدون رقم"}</div>
                            <div class="voice-call-user-state ${user.online ? "online" : "offline"}">
                                <span></span>
                                ${user.online ? "متصل" : "غير متصل"}
                            </div>
                        </div>
                        <button
                            type="button"
                            class="voice-call-user-btn"
                            data-call-number="${user.voice_call_number || ""}">
                            <i class="fas fa-phone"></i>
                        </button>
                    </div>
                `;
            }).join("");

            usersList.querySelectorAll("[data-call-number]").forEach(function (element) {
                element.addEventListener("click", function () {
                    selectNumber(element.getAttribute("data-call-number"));
                });
            });
        }

        function selectNumber(number) {
            selectedNumber = String(number || "");

            if (manualInput) {
                manualInput.value = selectedNumber;
            }

            if (searchInput) {
                searchInput.value = selectedNumber;
            }

            updateNumberStatus();
            updateButtons();
        }

        function updateNumberStatus() {
            if (!numberStatus) return;

            const number = manualInput
                ? manualInput.value.trim()
                : selectedNumber;

            if (!number) {
                numberStatus.textContent = "";
                return;
            }

            if (!/^\\d{9}$/.test(number)) {
                numberStatus.textContent = "يجب إدخال رقم مكون من 9 أرقام";
                numberStatus.style.color = "#e93345";
                return;
            }

            const user = voiceUsers.find(function (item) {
                return String(item.voice_call_number || "") === number;
            });

            if (!user) {
                numberStatus.textContent = "الرقم غير موجود في قائمة المستخدمين";
                numberStatus.style.color = "#e93345";
                return;
            }

            numberStatus.textContent =
                user.name + " — " + (user.online ? "متصل" : "غير متصل");

            numberStatus.style.color = user.online
                ? "#08b982"
                : "#e93345";
        }

        function updateButtons() {
            if (!startBtn) return;

            const number = manualInput
                ? manualInput.value.trim()
                : selectedNumber;

            const valid = /^\\d{9}$/.test(number);

            startBtn.disabled = !valid || callActive;

            if (endBtn) {
                endBtn.disabled = !callActive;
            }
        }

        function startCall() {
            const number = manualInput
                ? manualInput.value.trim()
                : selectedNumber;

            if (!/^\d{9}$/.test(number)) {
                if (status) {
                    status.textContent =
                        "أدخل رقم اتصال مكونًا من 9 أرقام";
                }
                return;
            }

            const user = voiceUsers.find(function (item) {
                return String(item.voice_call_number || "") === number;
            });

            if (!user) {
                if (status) {
                    status.textContent =
                        "رقم الاتصال غير موجود";
                }
                return;
            }

            if (!user.online) {
                if (status) {
                    status.textContent =
                        "المستخدم غير متصل حاليًا";
                }
                return;
            }

            if (
                typeof messengerSocket === "undefined" ||
                !messengerSocket ||
                !messengerSocket.connected
            ) {
                if (status) {
                    status.textContent =
                        "الاتصال بالخادم غير متاح حاليًا";
                }
                return;
            }

            const targetUserId =
                user.id ??
                user.user_id ??
                user.userId ??
                user.uid ??
                null;

            if (!targetUserId) {
                if (status) {
                    status.textContent =
                        "تعذر تحديد المستخدم المطلوب";
                }
                console.error(
                    "[VOICE CALL] missing target user id",
                    user
                );
                return;
            }

            selectedNumber = number;
            callActive = true;

            voiceCallTargetUserId = Number(targetUserId);
            voiceCallTargetNumber = number;
            voiceCallDirection = "outgoing";

            try {
                voiceCallId =
                    typeof crypto !== "undefined" &&
                    typeof crypto.randomUUID === "function"
                        ? crypto.randomUUID()
                        : "voice-" +
                          Date.now() +
                          "-" +
                          Math.random()
                              .toString(36)
                              .slice(2);
            } catch (_) {
                voiceCallId =
                    "voice-" +
                    Date.now() +
                    "-" +
                    Math.random()
                        .toString(36)
                        .slice(2);
            }

            if (status) {
                status.textContent =
                    "جاري الاتصال بـ " +
                    (user.name || number) +
                    "...";
            }

            updateButtons();

            messengerSocket.emit(
                "voice_call_request",
                {
                    target_user_id:
                        voiceCallTargetUserId,
                    voice_call_number:
                        voiceCallTargetNumber,
                    call_id:
                        voiceCallId
                }
            );
        }

        function endCall() {
            try {
                if (
                    typeof voiceCallEnd === "function"
                ) {
                    voiceCallEnd(true);

                    callActive = false;

                    if (status) {
                        status.textContent =
                            "تم إنهاء الاتصال";
                    }

                    updateButtons();
                } else {
                    callActive = false;

                    if (status) {
                        status.textContent =
                            "تم إنهاء الاتصال";
                    }

                    updateButtons();
                }
            } catch (error) {
                console.warn(
                    "[VOICE CALL] endCall:",
                    error?.message || error
                );

                callActive = false;

                if (status) {
                    status.textContent =
                        "تم إنهاء الاتصال";
                }

                updateButtons();
            }
        }

        openBtn.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            openVoiceCall();
        });

        if (closeBtn) {
            closeBtn.addEventListener("click", function () {
                closeVoiceCall();
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener("click", function () {
                if (searchInput) searchInput.value = "";
                if (manualInput) manualInput.value = "";
                selectedNumber = "";
                if (numberStatus) numberStatus.textContent = "";
                updateButtons();
                renderUsers("");
            });
        }

        if (searchInput) {
            searchInput.addEventListener("input", function () {
                renderUsers(searchInput.value);
            });
        }

        if (manualInput) {
            manualInput.addEventListener("input", function () {
                manualInput.value = manualInput.value
                    .replace(/\\D/g, "")
                    .slice(0, 9);

                selectedNumber = manualInput.value;
                updateNumberStatus();
                updateButtons();
            });
        }

        if (startBtn) {
            startBtn.addEventListener("click", startCall);
        }

        if (endBtn) {
            endBtn.addEventListener("click", endCall);
        }

        overlay.addEventListener("click", function (event) {
            if (event.target === overlay) {
                closeVoiceCall();
            }
        });

        overlay.hidden = true;
        overlay.style.display = "none";

        updateButtons();

        console.log("Voice Call UI initialized successfully.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initVoiceCallUI);
    } else {
        initVoiceCallUI();
    }
})();




/* =========================================================
   تأسيس وإدارة المؤسسات
   المرحلة الأولى: واجهة فقط
   ========================================================= */
function initInstitutionSetupUI() {
  const page = document.getElementById("institutionSetupPage");
  if (!page) return;

  const $i = (id) => document.getElementById(id);

  let generatedCodes = [];
  let currentCodeIndex = -1;

  function randomChar() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return chars[Math.floor(Math.random() * chars.length)];
  }

  function generateRegistrationCode() {
    let code = "";
    for (let i = 0; i < 25; i++) {
      code += randomChar();
    }
    return code;
  }

  function setStatus(message, ok = true) {
    const box = $i("institutionSetupStatus");
    if (!box) return;
    box.textContent = message || "";
    box.style.color = ok ? "" : "#b00020";
  }

  function setCodeStatus(message) {
    const box = $i("institutionCodeStatus");
    if (box) box.textContent = message || "";
  }

  function createLocalIdentity() {
    const now = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();

    const id = "INST-" + now + "-" + random;
    const serial = "SER-" + now + "-" +
      Math.random().toString(36).slice(2, 10).toUpperCase();

    const idBox = $i("institutionId");
    const serialBox = $i("institutionSerial");

    if (idBox && !idBox.value) idBox.value = id;
    if (serialBox && !serialBox.value) serialBox.value = serial;
  }

  function generate200Codes() {
    const unique = new Set();

    while (unique.size < 200) {
      unique.add(generateRegistrationCode());
    }

    generatedCodes = Array.from(unique);
    currentCodeIndex = 0;

    const codeBox = $i("institutionRegistrationCode");
    if (codeBox) codeBox.value = generatedCodes[0];

    const count = $i("institutionCodesAvailable");
    if (count) count.textContent = generatedCodes.length;

    setCodeStatus(
      "تم توليد 200 رقم تسجيل فريد للواجهة. سيتم حفظها في قاعدة البيانات الجديدة لاحقاً."
    );
  }

  function addCode() {
    if (!generatedCodes.length) {
      generate200Codes();
      return;
    }

    currentCodeIndex += 1;

    if (currentCodeIndex >= generatedCodes.length) {
      currentCodeIndex = 0;
    }

    const codeBox = $i("institutionRegistrationCode");
    if (codeBox) codeBox.value = generatedCodes[currentCodeIndex];

    const count = $i("institutionCodesAvailable");
    if (count) {
      count.textContent = String(
        Math.max(0, generatedCodes.length - currentCodeIndex)
      );
    }

    setCodeStatus("تم اختيار رقم تسجيل جديد.");
  }

  function clearForm() {
    [
      "institutionRegistrationCode",
      "institutionName",
      "institutionId",
      "institutionSerial",
      "institutionSystemManagerName",
      "institutionUsername",
      "institutionPassword"
    ].forEach((id) => {
      const el = $i(id);
      if (el) el.value = "";
    });

    currentCodeIndex = -1;
    setStatus("تم تجهيز نموذج مؤسسة جديد.");
    setCodeStatus("");
  }

  function open() {
    createLocalIdentity();

    if (!generatedCodes.length) {
      generate200Codes();
    }

    page.classList.remove("hidden");
    page.setAttribute("aria-hidden", "false");
  }

  function close() {
    page.classList.add("hidden");
    page.setAttribute("aria-hidden", "true");
  }

  $i("institutionGenerateCodeBtn")?.addEventListener(
    "click",
    addCode
  );

  $i("institutionSaveBtn")?.addEventListener("click", () => {
    createLocalIdentity();
    setStatus(
      "تم تجهيز بيانات المؤسسة. الحفظ الفعلي سيُربط بقاعدة البيانات الجديدة في المرحلة التالية."
    );
  });

  $i("institutionRefreshDbBtn")?.addEventListener("click", () => {
    setStatus(
      "تحديث قاعدة البيانات مؤجل حتى إنشاء قاعدة البيانات الجديدة."
    );
  });

  $i("institutionDeleteBtn")?.addEventListener("click", () => {
    setStatus(
      "الحذف الفعلي غير مفعل في الواجهة التجريبية حتى لا يتم حذف أي بيانات."
    );
  });

  $i("institutionEditBtn")?.addEventListener("click", () => {
    setStatus("يمكن الآن تعديل الحقول ثم اعتمادها عند ربط قاعدة البيانات.");
  });

  $i("institutionNextBtn")?.addEventListener("click", () => {
    addCode();
    setStatus("تم الانتقال إلى السجل/كود التسجيل التالي.");
  });

  $i("institutionPreviousBtn")?.addEventListener("click", () => {
    if (!generatedCodes.length) {
      generate200Codes();
      return;
    }

    currentCodeIndex -= 1;

    if (currentCodeIndex < 0) {
      currentCodeIndex = generatedCodes.length - 1;
    }

    const codeBox = $i("institutionRegistrationCode");
    if (codeBox) codeBox.value = generatedCodes[currentCodeIndex];

    setStatus("تم الرجوع إلى السجل/كود التسجيل السابق.");
  });

  $i("institutionDoneBtn")?.addEventListener("click", () => {
    setStatus("تم اعتماد نموذج الشاشة بنجاح — جاهز للمرحلة التالية.");
  });

  $i("institutionSetupExitBtn")?.addEventListener("click", close);
  $i("institutionSetupExitBtn2")?.addEventListener("click", close);

  window.openInstitutionSetupPage = open;
  window.closeInstitutionSetupPage = close;
}

if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    initInstitutionSetupUI,
    { once: true }
  );
} else {
  initInstitutionSetupUI();
}

