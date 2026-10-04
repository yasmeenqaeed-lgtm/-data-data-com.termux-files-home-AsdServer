







const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { Server } = require("socket.io");

let webauthnServer = null;

async function getWebAuthnServer() {
    if (!webauthnServer) {
        webauthnServer = await import("@simplewebauthn/server");
    }
    return webauthnServer;
}

const app = express();
const httpServer = http.createServer(app);
const CORS_ORIGIN = String(
    process.env.CORS_ORIGIN || "*"
).trim();

const io = new Server(httpServer, {
    cors: {
        origin: CORS_ORIGIN,
        credentials: true
    }
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const SERVER_MODE = process.env.SERVER_MODE || "local";

/*
   WebAuthn / Passkey
   RP_ID هو اسم النطاق فقط بدون https:// أو المنفذ.
   ORIGIN هو عنوان الموقع الكامل.
*/
const WEBAUTHN_RP_NAME =
    process.env.WEBAUTHN_RP_NAME ||
    "نظام المراسلة العسكرية المشفر";

const WEBAUTHN_RP_ID =
    process.env.WEBAUTHN_RP_ID || "";

const WEBAUTHN_ORIGIN =
    process.env.WEBAUTHN_ORIGIN || "";

const ADMIN_USERNAME =
    process.env.ADMIN_USERNAME || "";

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || "";

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

const DATA_DIR =
    process.env.DATA_DIR ||
    path.join(
        ROOT,
        SERVER_MODE === "internet"
            ? "data-internet"
            : "data-local"
    );

const DB_FILE =
    path.join(DATA_DIR, "secure-messenger.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

app.disable("x-powered-by");

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({
    extended: true,
    limit: "25mb"
}));

let SQL;
let db;
let initialized = false;

const sessions = new Map();

/* =========================================================
   الاتصال الفوري عبر Socket.IO
========================================================= */

const userSockets = new Map();

/* =========================================================
   البث الصوتي المباشر Live Audio / Push-To-Talk
   قناة بث واحدة في الوقت نفسه.
========================================================= */

let liveAudioBroadcaster = null;

function stopLiveAudioBroadcast(reason = "stopped") {
    const broadcaster = liveAudioBroadcaster;

    if (!broadcaster) {
        return;
    }

    liveAudioBroadcaster = null;

    try {
        io.emit("live_audio_stopped", {
            ok: true,
            reason,
            user_id: Number(broadcaster.userId)
        });
    } catch (error) {
        console.warn(
            "Live audio stop emit error:",
            error.message
        );
    }
}

function isLiveAudioBroadcaster(socket) {
    return Boolean(
        liveAudioBroadcaster &&
        liveAudioBroadcaster.socketId === socket.id
    );
}

function getSocketById(socketId) {
    if (!socketId) return null;

    const socket = io.sockets.sockets.get(
        String(socketId)
    );

    return socket || null;
}

function relayLiveAudioSignal(socket, event, payload) {
    const targetId = String(payload?.to || "");

    if (!targetId) {
        return false;
    }

    const target = getSocketById(targetId);

    if (!target) {
        return false;
    }

    target.emit(event, {
        ...payload,
        from: socket.id,
        from_user_id: Number(socket.data.userId)
    });

    return true;
}

function addUserSocket(userId, socketId) {
    const id = Number(userId);
    if (!Number.isInteger(id)) return;

    if (!userSockets.has(id)) {
        userSockets.set(id, new Set());
    }

    userSockets.get(id).add(socketId);
}

function removeUserSocket(userId, socketId) {
    const id = Number(userId);
    const sockets = userSockets.get(id);

    if (!sockets) return;

    sockets.delete(socketId);

    if (sockets.size === 0) {
        userSockets.delete(id);
    }
}

function emitToUser(userId, event, payload) {
    const id = Number(userId);
    const sockets = userSockets.get(id);

    if (!sockets || sockets.size === 0) {
        return false;
    }

    for (const socketId of sockets) {
        io.to(socketId).emit(event, payload);
    }

    return true;
}

io.use((socket, next) => {
    try {
        const authToken = String(
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.replace(
                /^Bearer\\s+/i,
                ""
            ) ||
            ""
        ).trim();

        if (!authToken) {
            return next(new Error("UNAUTHORIZED"));
        }

        let session = sessions.get(authToken);

        /*
         * استرجاع الجلسة من قاعدة البيانات عند عدم وجودها
         * في ذاكرة Node، خصوصًا بعد إعادة تشغيل Railway.
         */
        if (!session) {
            const storedSession = one(
                `SELECT
                    token,
                    user_id,
                    device_serial,
                    created_at,
                    last_seen
                 FROM sessions
                 WHERE token=?
                 LIMIT 1`,
                [authToken]
            );

            if (!storedSession) {
                return next(new Error("UNAUTHORIZED"));
            }

            session = {
                user_id: Number(storedSession.user_id),
                device_serial: String(
                    storedSession.device_serial || ""
                ),
                created_at: storedSession.created_at,
                last_seen: storedSession.last_seen
            };

            sessions.set(authToken, session);
        }

        const user = one(
            "SELECT * FROM users WHERE id=?",
            [session.user_id]
        );

        if (!user) {
            sessions.delete(authToken);
            return next(new Error("UNAUTHORIZED"));
        }

        if (user.status === "blocked") {
            sessions.delete(authToken);
            return next(new Error("BLOCKED"));
        }

        if (user.status === "frozen") {
            return next(new Error("FROZEN"));
        }

        socket.data.userId = Number(user.id);
        socket.data.token = authToken;
        socket.data.user = user;

        session.last_seen = now();

        return next();

    } catch (error) {
        console.error(
            "Socket auth error:",
            error.message
        );

        return next(
            new Error("UNAUTHORIZED")
        );
    }
});

io.on("connection", (socket) => {

    const userId = Number(
        socket.data.userId
    );

    addUserSocket(
        userId,
        socket.id
    );

    socket.emit("authenticated", {
        ok: true,
        user_id: userId
    });

    /* =====================================================
       المكالمات الصوتية الفردية Voice Call / WebRTC
       مستقلة تماماً عن live_audio_*.
    ===================================================== */

    function getVoiceCallTargetUserId(payload) {
        const value =
            payload?.target_user_id ??
            payload?.user_id ??
            null;

        const id = Number(value);

        return Number.isInteger(id) && id > 0
            ? id
            : null;
    }

    function getUserByVoiceNumber(number) {
        const normalized =
            String(number || "").trim();

        if (!/^\d{9}$/.test(normalized)) {
            return null;
        }

        return one(
            `
            SELECT
                id,
                username,
                name,
                status,
                voice_call_number
            FROM users
            WHERE voice_call_number=?
            LIMIT 1
            `,
            [normalized]
        );
    }

    socket.on("voice_call_request", payload => {
        try {
            const targetUserId =
                getVoiceCallTargetUserId(payload);

            let targetUser = null;

            if (targetUserId) {
                targetUser = one(
                    `
                    SELECT
                        id,
                        username,
                        name,
                        status,
                        voice_call_number
                    FROM users
                    WHERE id=?
                    LIMIT 1
                    `,
                    [targetUserId]
                );
            } else {
                targetUser =
                    getUserByVoiceNumber(
                        payload?.voice_call_number
                    );
            }

            if (!targetUser) {
                socket.emit("voice_call_error", {
                    message: "المستخدم المطلوب غير موجود"
                });
                return;
            }

            if (Number(targetUser.id) === userId) {
                socket.emit("voice_call_error", {
                    message: "لا يمكنك الاتصال بنفسك"
                });
                return;
            }

            if (String(targetUser.status || "") === "blocked" ||
                String(targetUser.status || "") === "frozen") {
                socket.emit("voice_call_error", {
                    message: "المستخدم غير متاح للاتصال"
                });
                return;
            }

            const delivered =
                emitToUser(
                    targetUser.id,
                    "voice_call_incoming",
                    {
                        ok: true,
                        call_id: String(
                            payload?.call_id || crypto.randomUUID()
                        ),
                        from_user_id: userId,
                        from_name:
                            String(socket.data.user?.name || ""),
                        from_username:
                            String(socket.data.user?.username || ""),
                        from_voice_call_number:
                            String(
                                socket.data.user?.voice_call_number || ""
                            ),
                        target_user_id:
                            Number(targetUser.id)
                    }
                );

            if (!delivered) {
                socket.emit("voice_call_unavailable", {
                    message: "المستخدم غير متصل حاليًا",
                    target_user_id:
                        Number(targetUser.id)
                });
                return;
            }

            socket.emit("voice_call_ringing", {
                ok: true,
                call_id: String(
                    payload?.call_id || ""
                ),
                target_user_id:
                    Number(targetUser.id),
                target_name:
                    String(targetUser.name || ""),
                target_voice_call_number:
                    String(
                        targetUser.voice_call_number || ""
                    )
            });

        } catch (error) {
            console.error(
                "voice_call_request error:",
                error.message
            );

            socket.emit("voice_call_error", {
                message: "تعذر بدء الاتصال"
            });
        }
    });

    socket.on("voice_call_accept", payload => {
        const fromUserId =
            Number(payload?.from_user_id);

        if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
            return;
        }

        emitToUser(
            fromUserId,
            "voice_call_accepted",
            {
                ok: true,
                call_id:
                    String(payload?.call_id || ""),
                from_user_id: userId,
                from_name:
                    String(socket.data.user?.name || "")
            }
        );
    });

    socket.on("voice_call_reject", payload => {
        const fromUserId =
            Number(payload?.from_user_id);

        if (!Number.isInteger(fromUserId) || fromUserId <= 0) {
            return;
        }

        emitToUser(
            fromUserId,
            "voice_call_rejected",
            {
                ok: true,
                call_id:
                    String(payload?.call_id || ""),
                from_user_id: userId,
                reason:
                    String(payload?.reason || "rejected")
            }
        );
    });

    socket.on("voice_call_offer", payload => {
        const targetUserId =
            getVoiceCallTargetUserId(payload);

        if (!targetUserId) return;

        emitToUser(
            targetUserId,
            "voice_call_offer",
            {
                ok: true,
                call_id:
                    String(payload?.call_id || ""),
                from_user_id: userId,
                from_name:
                    String(socket.data.user?.name || ""),
                offer: payload?.offer || null
            }
        );
    });

    socket.on("voice_call_answer", payload => {
        const targetUserId =
            getVoiceCallTargetUserId(payload);

        if (!targetUserId) return;

        emitToUser(
            targetUserId,
            "voice_call_answer",
            {
                ok: true,
                call_id:
                    String(payload?.call_id || ""),
                from_user_id: userId,
                answer: payload?.answer || null
            }
        );
    });

    socket.on("voice_call_ice", payload => {
        const targetUserId =
            getVoiceCallTargetUserId(payload);

        if (!targetUserId) return;

        emitToUser(
            targetUserId,
            "voice_call_ice",
            {
                ok: true,
                call_id:
                    String(payload?.call_id || ""),
                from_user_id: userId,
                candidate: payload?.candidate || null
            }
        );
    });

    socket.on("voice_call_end", payload => {
        const targetUserId =
            getVoiceCallTargetUserId(payload);

        if (!targetUserId) return;

        emitToUser(
            targetUserId,
            "voice_call_ended",
            {
                ok: true,
                call_id:
                    String(payload?.call_id || ""),
                from_user_id: userId,
                reason:
                    String(payload?.reason || "ended")
            }
        );
    });

    /* =====================================================
       بدء البث الصوتي
    ===================================================== */

    socket.on("live_audio_start", () => {

        /* البث الصوتي مسموح لمدير النظام والمشرف فقط */
        const socketRole = String(
            socket.data.user?.role || ""
        ).trim().toLowerCase();

        const canBroadcast =
            socketRole === "system_manager" ||
            socketRole === "admin";

        if (!canBroadcast) {
            socket.emit("live_audio_error", {
                message: "البث الصوتي متاح لمدير النظام والمشرف فقط"
            });
            return;
        }

        if (
            liveAudioBroadcaster &&
            liveAudioBroadcaster.socketId !== socket.id
        ) {
            socket.emit("live_audio_error", {
                message: "يوجد بث صوتي نشط حالياً"
            });
            return;
        }

        liveAudioBroadcaster = {
            socketId: socket.id,
            userId
        };

        socket.data.liveAudioBroadcaster = true;

        io.emit("live_audio_started", {
            ok: true,
            user_id: userId,
            socket_id: socket.id,
            started_at: now()
        });
    });

    /* =====================================================
       انضمام مستخدم للاستماع
    ===================================================== */

    socket.on("live_audio_join", () => {

        if (!liveAudioBroadcaster) {
            socket.emit("live_audio_unavailable", {
                message: "لا يوجد بث صوتي نشط"
            });
            return;
        }

        if (
            liveAudioBroadcaster.socketId === socket.id
        ) {
            return;
        }

        socket.data.liveAudioListener = true;

        const broadcaster =
            getSocketById(
                liveAudioBroadcaster.socketId
            );

        if (!broadcaster) {
            stopLiveAudioBroadcast("broadcaster_disconnected");
            return;
        }

        broadcaster.emit(
            "live_audio_listener_joined",
            {
                listener_socket_id: socket.id,
                listener_user_id: userId
            }
        );
    });

    /* =====================================================
       WebRTC offer
    ===================================================== */

    socket.on("live_audio_offer", payload => {

        if (
            !isLiveAudioBroadcaster(socket)
        ) {
            return;
        }

        relayLiveAudioSignal(
            socket,
            "live_audio_offer",
            payload
        );
    });

    /* =====================================================
       WebRTC answer
    ===================================================== */

    socket.on("live_audio_answer", payload => {

        if (!socket.data.liveAudioListener) {
            return;
        }

        relayLiveAudioSignal(
            socket,
            "live_audio_answer",
            payload
        );
    });

    /* =====================================================
       WebRTC ICE
    ===================================================== */

    socket.on("live_audio_ice", payload => {

        if (
            !isLiveAudioBroadcaster(socket) &&
            !socket.data.liveAudioListener
        ) {
            return;
        }

        relayLiveAudioSignal(
            socket,
            "live_audio_ice",
            payload
        );
    });

    /* =====================================================
       إيقاف البث
    ===================================================== */

    socket.on("live_audio_stop", () => {

        if (!isLiveAudioBroadcaster(socket)) {
            return;
        }

        socket.data.liveAudioBroadcaster = false;

        stopLiveAudioBroadcast("stopped");
    });

    socket.on("disconnect", () => {

        if (isLiveAudioBroadcaster(socket)) {
            stopLiveAudioBroadcast(
                "broadcaster_disconnected"
            );
        }

        removeUserSocket(
            userId,
            socket.id
        );
    });
});

/* =========================================================
   الأدوات الأساسية
========================================================= */

function now() {
    return new Date().toISOString();
}

function hashPassword(password) {
    return crypto
        .createHash("sha256")
        .update(String(password))
        .digest("hex");
}

function savePasskeyChallenge(
    userId,
    purpose,
    challenge,
    expiresAt
) {

    run(
        `DELETE FROM user_passkey_challenges
         WHERE user_id=? AND purpose=?`,
        [
            userId,
            purpose
        ]
    );

    run(
        `INSERT INTO user_passkey_challenges
         (
            user_id,
            purpose,
            challenge,
            expires_at,
            created_at
         )
         VALUES(?,?,?,?,?)`,
        [
            userId,
            purpose,
            challenge,
            expiresAt,
            now()
        ]
    );

    saveDatabase();
}

function getPasskeyChallenge(
    userId,
    purpose
) {

    return one(
        `SELECT
            id,
            user_id,
            purpose,
            challenge,
            expires_at,
            created_at
         FROM user_passkey_challenges
         WHERE user_id=? AND purpose=?
         ORDER BY id DESC
         LIMIT 1`,
        [
            userId,
            purpose
        ]
    );
}

function deletePasskeyChallenge(
    userId,
    purpose
) {

    run(
        `DELETE FROM user_passkey_challenges
         WHERE user_id=? AND purpose=?`,
        [
            userId,
            purpose
        ]
    );

    saveDatabase();
}

function createPasskeySession(user, deviceSerial) {

    const token =
        randomToken();

    const createdAt =
        now();

    const lastSeen =
        now();

    sessions.set(
        token,
        {
            user_id: user.id,
            device_serial: deviceSerial,
            created_at: createdAt,
            last_seen: lastSeen
        }
    );

    run(
        `INSERT OR REPLACE INTO sessions
         (
            token,
            user_id,
            device_serial,
            created_at,
            last_seen
         )
         VALUES(?,?,?,?,?)`,
        [
            token,
            user.id,
            deviceSerial,
            createdAt,
            lastSeen
        ]
    );

    return token;
}

function randomToken() {
    return crypto.randomBytes(32).toString("hex");
}

function deviceIdFromRequest(req) {

    const supplied =
        req.headers["x-device-id"] ||
        req.headers["x-device-serial"] ||
        req.body?.device_id ||
        req.body?.device_serial;

    if (supplied) {
        return String(supplied).slice(0, 200);
    }

    const raw = [
        req.headers["user-agent"] || "",
        req.ip || "",
        req.headers["accept-language"] || ""
    ].join("|");

    return crypto
        .createHash("sha256")
        .update(raw)
        .digest("hex")
        .slice(0, 32);
}

/* =========================================================
   قاعدة البيانات
========================================================= */

function saveDatabase() {

    const data = db.export();

    fs.writeFileSync(
        DB_FILE,
        Buffer.from(data)
    );
}

function run(sql, params = []) {

    db.run(sql, params);
}

function all(sql, params = []) {

    const stmt = db.prepare(sql);

    stmt.bind(params);

    const rows = [];

    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }

    stmt.free();

    return rows;
}

function one(sql, params = []) {

    const rows = all(sql, params);

    return rows[0] || null;
}

function columnExists(table, column) {

    const rows = all(
        `PRAGMA table_info(${table})`
    );

    return rows.some(
        row => row.name === column
    );
}

function ensureColumn(
    table,
    column,
    definition
) {

    if (!columnExists(table, column)) {

        run(
            `ALTER TABLE ${table}
             ADD COLUMN ${column} ${definition}`
        );
    }
}

/* =========================================================
   صلاحيات المشرفين - مدير النظام
   يجب أن تكون خارج initDatabase حتى تستخدمها مسارات API.
========================================================= */

const ADMIN_PERMISSIONS = [
    "add_user",
    "block_user",
    "freeze_user",
    "release_user",
    "app_lock",
    "clear_chat",
    "backup",
    "locations",
    "warnings",
    "broadcast",
    "manage_users",
    "user_reports",
    "credentials_report",
    "channels",
    "audit",
    "update_database",
    "alert_mode",
    "network_off",
    "network_restart",
    "prevent_screenshot"
];

function ensureUserPermissions(userId) {

    const id = Number(userId);

    if (!Number.isInteger(id) || id <= 0) {
        return;
    }

    const user = one(
        "SELECT id, role FROM users WHERE id=?",
        [id]
    );

    if (!user) {
        return;
    }

    for (const permission of ADMIN_PERMISSIONS) {

        const existing =
            one(
                `SELECT id, permission, permission_key, allowed
                 FROM user_permissions
                 WHERE user_id=?
                   AND (
                       permission=?
                       OR permission_key=?
                   )
                 LIMIT 1`,
                [
                    id,
                    permission,
                    permission
                ]
            );

        if (existing) {

            /*
             * لا نغيّر allowed هنا.
             *
             * القيمة التي حفظها مدير النظام يجب أن تبقى
             * كما هي:
             *
             * 1 = True
             * 0 = False
             */
            run(
                `UPDATE user_permissions
                 SET permission=?,
                     permission_key=?
                 WHERE id=?`,
                [
                    permission,
                    permission,
                    existing.id
                ]
            );

        } else {

            /*
             * الصلاحية الجديدة فقط تحصل على القيمة الافتراضية.
             * منع التقاط الشاشة يبدأ False.
             */
            run(
                `INSERT INTO user_permissions
                 (user_id, permission, allowed, updated_at, permission_key, created_at)
                 VALUES(?,?,?,?,?,?)`,
                [
                    id,
                    permission,
                    permission === "prevent_screenshot" ? 0 : 1,
                    now(),
                    permission,
                    now()
                ]
            );
        }
    }
}

function ensureAllSupervisorPermissions() {

    const supervisors = all(
        `SELECT id
         FROM users
         WHERE role='admin'
           AND is_admin=1`
    );

    for (const supervisor of supervisors) {
        ensureUserPermissions(supervisor.id);
    }
}

/* =========================================================
   إنشاء قاعدة البيانات
========================================================= */

/* =========================================================
   نظام أرقام الاتصال الصوتي الداخلي
   مستقل عن voice_call_number و phone
========================================================= */

/* =========================================================
   رقم الاتصال الصوتي الرسمي
   يتم تخصيصه فقط عند أول تسجيل دخول ناجح.
   999111111 محجوز لمدير النظام.
========================================================= */

const OFFICIAL_VOICE_NUMBER_START = 999111111;
const OFFICIAL_VOICE_NUMBER_END = 999999999;
const OFFICIAL_VOICE_MANAGER_NUMBER = "999111111";

function assignVoiceCallNumberOnSuccessfulLogin(userId) {

    const id = Number(userId);

    if (!Number.isInteger(id) || id <= 0) {
        return "";
    }

    const user = one(
        `SELECT id, role, voice_call_number
         FROM users
         WHERE id=?
         LIMIT 1`,
        [id]
    );

    if (!user) {
        return "";
    }

    const existing =
        String(user.voice_call_number || "").trim();

    /*
     * الرقم الموجود مسبقاً يبقى ثابتاً.
     */
    if (
        /^\d{9}$/.test(existing) &&
        Number(existing) >= OFFICIAL_VOICE_NUMBER_START &&
        Number(existing) <= OFFICIAL_VOICE_NUMBER_END
    ) {
        return existing;
    }

    /*
     * مدير النظام يحصل على الرقم المحجوز.
     */
    if (
        String(user.role || "").trim() ===
        "system_manager"
    ) {
        const managerNumber =
            OFFICIAL_VOICE_MANAGER_NUMBER;

        const occupied = one(
            `SELECT id
             FROM users
             WHERE voice_call_number=?
               AND id<>?
             LIMIT 1`,
            [managerNumber, id]
        );

        if (!occupied) {
            run(
                `UPDATE users
                 SET voice_call_number=?,
                     updated_at=?
                 WHERE id=?`,
                [
                    managerNumber,
                    now(),
                    id
                ]
            );

            return managerNumber;
        }
    }

    /*
     * أول رقم متاح بعد أعلى رقم محفوظ.
     * 999111111 محجوز لمدير النظام.
     */
    const row = one(`
        SELECT MAX(
            CAST(voice_call_number AS INTEGER)
        ) AS max_number
        FROM users
        WHERE voice_call_number IS NOT NULL
          AND TRIM(voice_call_number) <> ''
          AND CAST(voice_call_number AS INTEGER)
              BETWEEN ? AND ?
    `, [
        OFFICIAL_VOICE_NUMBER_START,
        OFFICIAL_VOICE_NUMBER_END
    ]);

    let nextNumber =
        Number(row?.max_number || 0);

    if (
        nextNumber <
        OFFICIAL_VOICE_NUMBER_START
    ) {
        nextNumber =
            OFFICIAL_VOICE_NUMBER_START;
    } else {
        nextNumber++;
    }

    /*
     * الرقم 999111111 محجوز لمدير النظام.
     */
    if (
        nextNumber ===
        OFFICIAL_VOICE_MANAGER_NUMBER
    ) {
        nextNumber++;
    }

    while (nextNumber <= OFFICIAL_VOICE_NUMBER_END) {

        const occupied = one(
            `SELECT id
             FROM users
             WHERE voice_call_number=?
             LIMIT 1`,
            [String(nextNumber)]
        );

        if (!occupied) {
            break;
        }

        nextNumber++;
    }

    if (
        nextNumber >
        OFFICIAL_VOICE_NUMBER_END
    ) {
        throw new Error(
            "لا توجد أرقام اتصال صوتي متاحة."
        );
    }

    const assigned =
        String(nextNumber);

    run(
        `UPDATE users
         SET voice_call_number=?,
             updated_at=?
         WHERE id=?`,
        [
            assigned,
            now(),
            id
        ]
    );

    return assigned;
}

function getNextInternalVoiceNumber() {

    const row = one(`
        SELECT MAX(
            CAST(internal_voice_number AS INTEGER)
        ) AS max_number
        FROM users
        WHERE internal_voice_number IS NOT NULL
          AND TRIM(internal_voice_number) <> ''
          AND internal_voice_number <> '999111111'
    `);

    let nextNumber =
        Number(row?.max_number || 999111111) + 1;

    /*
     * الرقم 999111111 محجوز لمدير النظام.
     */
    if (nextNumber <= 999111111) {
        nextNumber = 999111112;
    }

    /*
     * التأكد من عدم وجود الرقم.
     */
    while (
        one(
            `SELECT id
             FROM users
             WHERE internal_voice_number=?`,
            [String(nextNumber)]
        )
    ) {
        nextNumber++;
    }

    return String(nextNumber);
}

function assignInternalVoiceNumber(userId) {

    if (!userId) {
        return "";
    }

    const user = one(
        `SELECT id, role, internal_voice_number
         FROM users
         WHERE id=?`,
        [Number(userId)]
    );

    if (!user) {
        return "";
    }

    /*
     * مدير النظام يحصل دائماً على الرقم المحجوز.
     */
    if (String(user.role || "").trim() === "system_manager") {

        run(
            `UPDATE users
             SET internal_voice_number=?
             WHERE id=?`,
            [
                "999111111",
                Number(user.id)
            ]
        );

        return "999111111";
    }

    /*
     * إذا كان لديه رقم صالح، لا نغيره.
     */
    const current =
        String(user.internal_voice_number || "").trim();

    if (/^\d{9}$/.test(current)) {
        return current;
    }

    const nextNumber =
        getNextInternalVoiceNumber();

    run(
        `UPDATE users
         SET internal_voice_number=?
         WHERE id=?`,
        [
            nextNumber,
            Number(user.id)
        ]
    );

    return nextNumber;
}

function assignMissingInternalVoiceNumbers() {

    /*
     * مدير النظام أولاً.
     */
    const manager = one(`
        SELECT id
        FROM users
        WHERE role='system_manager'
        LIMIT 1
    `);

    if (manager) {
        assignInternalVoiceNumber(
            Number(manager.id)
        );
    }

    /*
     * جميع الحسابات الأخرى التي ليس لديها رقم.
     */
    const users = all(`
        SELECT id
        FROM users
        WHERE role <> 'system_manager'
          AND (
              internal_voice_number IS NULL
              OR TRIM(internal_voice_number)=''
          )
        ORDER BY id ASC
    `);

    for (const user of users) {
        assignInternalVoiceNumber(
            Number(user.id)
        );
    }
}

async function initDatabase() {

    SQL = await require("sql.js")({

        locateFile: file => {

            return path.join(
                ROOT,
                "node_modules",
                "sql.js",
                "dist",
                file
            );
        }

    });

    if (fs.existsSync(DB_FILE)) {

        db = new SQL.Database(
            new Uint8Array(
                fs.readFileSync(DB_FILE)
            )
        );

    } else {

        db = new SQL.Database();
    }

    /* USERS */

    run(`
        CREATE TABLE IF NOT EXISTS users (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            username TEXT UNIQUE NOT NULL,

            name TEXT NOT NULL DEFAULT '',

            password_hash TEXT NOT NULL,

            role TEXT NOT NULL DEFAULT 'user',

            is_admin INTEGER NOT NULL DEFAULT 0,

            status TEXT NOT NULL DEFAULT 'active',

            device_serial TEXT DEFAULT '',

            created_at TEXT NOT NULL,

            updated_at TEXT NOT NULL
        )
    `);


    /* =========================================================
       صلاحيات المشرفين - مدير النظام
    ========================================================= */

    run(`
        CREATE TABLE IF NOT EXISTS user_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            permission_key TEXT NOT NULL,
            allowed INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            UNIQUE(user_id, permission_key),
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);

    /* =========================================================
       رقم الاتصال الصوتي الداخلي
       هذا الحقل مستقل تماماً عن:
       voice_call_number
       phone
       device_serial
    ========================================================= */

    ensureColumn(
        "users",
        "internal_voice_number",
        "TEXT DEFAULT ''"
    );

    /* رقم مدير النظام ثابت ومحجوز */
    const INTERNAL_VOICE_MANAGER_NUMBER = "999111111";
    const INTERNAL_VOICE_START_NUMBER = 999111111;

    /* توافق مع قاعدة البيانات الحالية */
    ensureColumn(
        "users",
        "profile_image",
        "TEXT DEFAULT ''"
    );

    ensureColumn(
        "user_permissions",
        "permission_key",
        "TEXT NOT NULL DEFAULT ''"
    );

    /* توافق مع النسخ التي تستخدم permission بدلاً من permission_key */
    ensureColumn(
        "user_permissions",
        "permission",
        "TEXT NOT NULL DEFAULT ''"
    );

    /* مزامنة العمود الجديد مع البيانات القديمة */
    run(`
        UPDATE user_permissions
        SET permission = permission_key
        WHERE permission IS NULL
           OR permission = ''
    `);

    ensureColumn(
        "user_permissions",
        "created_at",
        "TEXT NOT NULL DEFAULT ''"
    );

    /* =========================================================
       أرقام الاتصال الصوتي الداخلية
       تبدأ من 999111111 وتبقى ثابتة لكل مستخدم
    ========================================================= */

    ensureColumn(
        "users",
        "voice_call_number",
        "TEXT"
    );

    /*
     * أرقام الاتصال الصوتي لا يتم إنشاؤها أثناء تشغيل الخادم.
     *
     * يتم إنشاء voice_call_number فقط بعد أول تسجيل دخول
     * ناجح للحساب، ثم يبقى ثابتاً في قاعدة البيانات.
     */
    run(`
        CREATE UNIQUE INDEX IF NOT EXISTS
        idx_users_voice_call_number
        ON users(voice_call_number)
        WHERE voice_call_number IS NOT NULL
          AND TRIM(voice_call_number) <> ''
    `);

    /* SESSIONS */



    run(`
        CREATE TABLE IF NOT EXISTS sessions (

            token TEXT PRIMARY KEY,

            user_id INTEGER NOT NULL,

            device_serial TEXT DEFAULT '',

            created_at TEXT NOT NULL,

            last_seen TEXT NOT NULL
        )
    `);

    /* DEVICE INFO */

    run(`
        CREATE TABLE IF NOT EXISTS user_device_info (
            user_id INTEGER PRIMARY KEY,
            device_id TEXT NOT NULL DEFAULT '',
            user_agent TEXT NOT NULL DEFAULT '',
            platform TEXT NOT NULL DEFAULT '',
            language TEXT NOT NULL DEFAULT '',
            screen TEXT NOT NULL DEFAULT '',
            timezone TEXT NOT NULL DEFAULT '',
            online INTEGER NOT NULL DEFAULT 0,
            connection_type TEXT NOT NULL DEFAULT '',
            effective_type TEXT NOT NULL DEFAULT '',
            downlink REAL,
            rtt REAL,
            save_data INTEGER NOT NULL DEFAULT 0,
            battery_level INTEGER,
            battery_charging INTEGER,
            battery_charging_time REAL,
            battery_discharging_time REAL,
            sim_status TEXT NOT NULL DEFAULT 'غير متاح من المتصفح',
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);



    /* =========================================================
       أمان ملف المستخدم - Passkey / WebAuthn + نقش الحماية
       لا يتم تخزين البصمة أو النقش الخام.
    ========================================================= */

    run(`
        CREATE TABLE IF NOT EXISTS user_passkeys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            credential_id TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL,
            counter INTEGER NOT NULL DEFAULT 0,
            device_type TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            last_used_at TEXT DEFAULT '',
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);

    run(`
        CREATE TABLE IF NOT EXISTS user_pattern_security (
            user_id INTEGER PRIMARY KEY,
            pattern_hash TEXT NOT NULL DEFAULT '',
            salt TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);

    /*
       WebAuthn challenges
       تحفظ فقط لفترة قصيرة حتى يتم التحقق من الاستجابة.
       لا يتم تخزين أي بصمة أو بيانات بيومترية.
    */
    run(`
        CREATE TABLE IF NOT EXISTS user_passkey_challenges (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            purpose TEXT NOT NULL,
            challenge TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);

    /* MESSAGES */

    run(`
        CREATE TABLE IF NOT EXISTS messages (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            sender_id INTEGER NOT NULL,

            receiver_id INTEGER,

            group_id TEXT,

            message TEXT NOT NULL DEFAULT '',

            message_type TEXT NOT NULL DEFAULT 'text',

            attachment_name TEXT DEFAULT '',

            attachment_data TEXT DEFAULT '',

            created_at TEXT NOT NULL
        )
    `);

    /*
     * تشفير الرسائل الخاصة - E2EE
     * لا نحذف أو نغير أي أعمدة موجودة.
     * الرسائل القديمة تبقى قابلة للقراءة.
     */
    /*
     * مفاتيح تشفير الأجهزة - E2EE
     * المفتاح الخاص يبقى على جهاز المستخدم ولا يُخزّن في الخادم.
     */
    db.run(`
        CREATE TABLE IF NOT EXISTS encryption_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(user_id, device_id)
        )
    `);

    ensureColumn(
        "messages",
        "is_encrypted",
        "INTEGER NOT NULL DEFAULT 0"
    );

    ensureColumn(
        "messages",
        "encryption_iv",
        "TEXT DEFAULT ''"
    );

    ensureColumn(
        "messages",
        "encryption_version",
        "TEXT DEFAULT ''"
    );

    ensureColumn(
        "messages",
        "encryption_sender_key",
        "TEXT DEFAULT ''"
    );

    /* =========================================================
       GROUPS - المحادثات الجماعية
    ========================================================= */

    run(`
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            created_by INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    `);

    run(`
        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            joined_at TEXT NOT NULL,
            UNIQUE(group_id, user_id)
        )
    `);


    /* أعمدة الرسائل المؤقتة */

    ensureColumn(
        "messages",
        "view_once",
        "INTEGER NOT NULL DEFAULT 0"
    );

    ensureColumn(
        "messages",
        "viewed_at",
        "TEXT DEFAULT NULL"
    );

    ensureColumn(
        "messages",
        "delivered_at",
        "TEXT DEFAULT NULL"
    );

    /* LOCATIONS */

    run(`
        CREATE TABLE IF NOT EXISTS locations (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            latitude REAL,

            longitude REAL,

            accuracy REAL,

            captured_at TEXT,

            created_at TEXT NOT NULL
        )
    `);

    /* LOCATION STATUS */

    run(`
        CREATE TABLE IF NOT EXISTS location_status (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER NOT NULL,

            status TEXT NOT NULL,

            captured_at TEXT,

            created_at TEXT NOT NULL
        )
    `);

    /* WARNINGS */

    run(`
        CREATE TABLE IF NOT EXISTS warnings (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER,

            username TEXT DEFAULT '',

            name TEXT DEFAULT '',

            device_serial TEXT DEFAULT '',

            message TEXT DEFAULT '',

            created_at TEXT NOT NULL
        )
    `);

    /* AUDIT */

    run(`
        CREATE TABLE IF NOT EXISTS audit (

            id INTEGER PRIMARY KEY AUTOINCREMENT,

            user_id INTEGER,

            action TEXT NOT NULL,

            details TEXT DEFAULT '',

            created_at TEXT NOT NULL
        )
    `);

    /* TEAM */

    run(`
        CREATE TABLE IF NOT EXISTS team (

            id INTEGER PRIMARY KEY CHECK(id = 1),

            name TEXT NOT NULL DEFAULT '',

            mission TEXT NOT NULL DEFAULT '',

            updated_at TEXT NOT NULL
        )
    `);

    /* SYSTEM */

    run(`
        CREATE TABLE IF NOT EXISTS system_state (

            id INTEGER PRIMARY KEY CHECK(id = 1),

            alert_mode INTEGER NOT NULL DEFAULT 0,

            network_mode TEXT NOT NULL DEFAULT 'local',

            network_name TEXT NOT NULL DEFAULT '',

            app_lock INTEGER NOT NULL DEFAULT 0,

            updated_at TEXT NOT NULL
        )
    `);

    /* توافق مع قواعد قديمة */

    ensureColumn(
        "system_state",
        "app_lock",
        "INTEGER NOT NULL DEFAULT 0"
    );

    ensureColumn(
        "users",
        "device_serial",
        "TEXT DEFAULT ''"
    );

    ensureColumn(
        "users",
        "status",
        "TEXT NOT NULL DEFAULT 'active'"
    );

    ensureColumn(
        "users",
        "role",
        "TEXT NOT NULL DEFAULT 'user'"
    );

    ensureColumn(
        "users",
        "is_admin",
        "INTEGER NOT NULL DEFAULT 0"
    );

    /* الفريق */

    if (!one(
        "SELECT id FROM team WHERE id=1"
    )) {

        run(
            `INSERT INTO team
             (id,name,mission,updated_at)
             VALUES(1,?,?,?)`,
            [
                "Secure Messenger",
                "نظام مراسلة آمن",
                now()
            ]
        );
    }

    /* حالة النظام */

    if (!one(
        "SELECT id FROM system_state WHERE id=1"
    )) {

        run(
            `INSERT INTO system_state
             (id,alert_mode,network_mode,network_name,updated_at)
             VALUES(1,0,'local','',?)`,
            [now()]
        );
    }

    /* حساب المشرف */

    let admin = one(
        "SELECT * FROM users WHERE username=?",
        [ADMIN_USERNAME]
    );

    if (!admin) {

        run(
            `INSERT INTO users
             (
                username,
                name,
                password_hash,
                role,
                is_admin,
                status,
                device_serial,
                created_at,
                updated_at
             )
             VALUES(?,?,?,?,?,?,?,?,?)`,
            [
                ADMIN_USERNAME,
                "المشرف",
                hashPassword(ADMIN_PASSWORD),
                "admin",
                1,
                "active",
                "",
                now(),
                now()
            ]
        );

    } else if (!admin.is_admin) {

        run(
            `UPDATE users
             SET
                is_admin=1,
                role='admin',
                updated_at=?
             WHERE id=?`,
            [
                now(),
                admin.id
            ]
        );
    }

    /* حساب مدير النظام */

    const SYSTEM_MANAGER_USERNAME = "khaldoon20262026";
    const SYSTEM_MANAGER_PASSWORD_HASH =
        "7142b3c38f4721c2971e0d4a45a73a7d70a6d7eedb3a2421140d14df8f21f4ab";

    let systemManager = one(
        "SELECT * FROM users WHERE username=?",
        [SYSTEM_MANAGER_USERNAME]
    );

    if (!systemManager) {

        run(
            `INSERT INTO users
             (
                username,
                name,
                password_hash,
                role,
                is_admin,
                status,
                device_serial,
                created_at,
                updated_at
             )
             VALUES(?,?,?,?,?,?,?,?,?)`,
            [
                SYSTEM_MANAGER_USERNAME,
                "مدير النظام",
                SYSTEM_MANAGER_PASSWORD_HASH,
                "system_manager",
                1,
                "active",
                "",
                now(),
                now()
            ]
        );

    } else {

        run(
            `UPDATE users
             SET
                name=?,
                role='system_manager',
                is_admin=1,
                status='active',
                updated_at=?
             WHERE username=?`,
            [
                "مدير النظام",
                now(),
                SYSTEM_MANAGER_USERNAME
            ]
        );
    }

    /*
     * إنشاء وحفظ أرقام الاتصال الصوتي الداخلي
     * للحسابات الموجودة مسبقاً.
     */
    /*
     * لا يتم تخصيص أرقام الاتصال عند بدء الخادم.
     * التخصيص يتم فقط بعد تسجيل دخول ناجح.
     */

    initialized = true;

    saveDatabase();

    console.log(
        "Database ready:",
        DB_FILE
    );

    
    /* =====================================================
       جدول البيانات الشخصية للمستخدمين
       ===================================================== */

    run(`
        CREATE TABLE IF NOT EXISTS user_personal_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            full_name TEXT NOT NULL DEFAULT '',
            military_number TEXT NOT NULL DEFAULT '',
            division TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )
    `);

    /* =====================================================
       ترقية جدول البيانات الشخصية بدون حذف البيانات الحالية
    ===================================================== */

    const personalColumns = [
        ["nickname", "TEXT NOT NULL DEFAULT ''"],
        ["national_id", "TEXT NOT NULL DEFAULT ''"],
        ["job_title", "TEXT NOT NULL DEFAULT ''"],
        ["military_rank", "TEXT NOT NULL DEFAULT ''"],
        ["birth_date", "TEXT NOT NULL DEFAULT ''"],
        ["birthplace", "TEXT NOT NULL DEFAULT ''"],
        ["education", "TEXT NOT NULL DEFAULT ''"],
        ["phone", "TEXT NOT NULL DEFAULT ''"],
        ["current_residence", "TEXT NOT NULL DEFAULT ''"],
        ["personal_id_card_image", "TEXT NOT NULL DEFAULT ''"],
        ["military_id_card_image", "TEXT NOT NULL DEFAULT ''"],
        ["organization", "TEXT NOT NULL DEFAULT ''"],
        ["notes", "TEXT NOT NULL DEFAULT ''"]
    ];

    const existingPersonalColumns =
        all("PRAGMA table_info(user_personal_data)")
            .map(row => row.name);

    for (const [column, definition] of personalColumns) {

        if (!existingPersonalColumns.includes(column)) {

            run(
                `ALTER TABLE user_personal_data
                 ADD COLUMN ${column} ${definition}`
            );

            console.log(
                "PERSONAL_COLUMN_ADDED:",
                column
            );
        }
    }

    saveDatabase();
}

/* =========================================================
   تسجيل العمليات
========================================================= */

function audit(
    userId,
    action,
    details = ""
) {

    run(
        `INSERT INTO audit
         (user_id,action,details,created_at)
         VALUES(?,?,?,?)`,
        [
            userId || null,
            action,
            details,
            now()
        ]
    );

    saveDatabase();
}

/* =========================================================
   التحقق من المستخدم
========================================================= */

function requireAuth(
    req,
    res,
    next
) {

    const header =
        req.headers.authorization || "";

    const token =
        header.startsWith("Bearer ")
            ? header.slice(7).trim()
            : "";

    if (!token || !sessions.has(token)) {

        return res.status(401).json({

            error: "UNAUTHORIZED",

            message:
                "انتهت الجلسة أو لم يتم تسجيل الدخول."
        });
    }

    const session =
        sessions.get(token);

    const user =
        one(
            "SELECT * FROM users WHERE id=?",
            [session.user_id]
        );

    if (!user) {

        sessions.delete(token);

        return res.status(401).json({

            error: "UNAUTHORIZED",

            message:
                "المستخدم غير موجود."
        });
    }

    if (user.status === "blocked") {

        sessions.delete(token);

        return res.status(403).json({

            error: "BLOCKED",

            message:
                "هذا الحساب محظور."
        });
    }

    if (user.status === "frozen") {

        return res.status(403).json({

            error: "FROZEN",

            message:
                "هذا الحساب مجمد من قبل المشرف."
        });
    }

    session.last_seen = now();

    try {
        run(
            `UPDATE sessions
             SET last_seen=?
             WHERE token=?`,
            [
                session.last_seen,
                token
            ]
        );
    } catch (presenceError) {
        console.error(
            "Presence last_seen update failed:",
            presenceError.message
        );
    }

    req.user = user;

    req.token = token;

    req.deviceSerial =
        session.device_serial || "";

    next();
}


/* =========================================================
   ربط نقش الحماية بملف المستخدم
   لا يتم تخزين النقش الخام.
========================================================= */


app.post(
    "/api/profile/pattern/login",
    (req, res) => {
        try {
            const username =
                String(
                    req.body?.username || ""
                ).trim();

            const pattern =
                String(
                    req.body?.pattern || ""
                ).trim();

            const deviceSerial =
                deviceIdFromRequest(req);

            if (!username || !pattern) {
                return res.status(400).json({
                    ok: false,
                    error: "PATTERN_LOGIN_REQUIRED",
                    message: "أدخل اسم المستخدم وارسم نقش الحماية."
                });
            }

            if (pattern.length < 4 || pattern.length > 100) {
                return res.status(401).json({
                    ok: false,
                    error: "INVALID_PATTERN",
                    message: "اسم المستخدم أو نقش الحماية غير صحيح."
                });
            }

            const user =
                one(
                    "SELECT * FROM users WHERE username=?",
                    [username]
                );

            if (!user) {
                return res.status(401).json({
                    ok: false,
                    error: "INVALID_PATTERN_LOGIN",
                    message: "اسم المستخدم أو نقش الحماية غير صحيح."
                });
            }

            if (user.status === "blocked") {
                return res.status(403).json({
                    ok: false,
                    error: "BLOCKED",
                    message: "الحساب محظور."
                });
            }

            if (user.status === "frozen") {
                return res.status(403).json({
                    ok: false,
                    error: "FROZEN",
                    message: "الحساب مجمد."
                });
            }

            const security =
                one(
                    `SELECT pattern_hash, salt, enabled
                     FROM user_pattern_security
                     WHERE user_id=?`,
                    [Number(user.id)]
                );

            if (
                !security ||
                Number(security.enabled) !== 1 ||
                !security.pattern_hash ||
                !security.salt
            ) {
                return res.status(401).json({
                    ok: false,
                    error: "PATTERN_NOT_ENABLED",
                    message: "نقش الحماية غير مفعّل لهذا الحساب."
                });
            }

            const calculatedHash =
                crypto
                    .createHash("sha256")
                    .update(
                        String(security.salt) +
                        ":" +
                        pattern
                    )
                    .digest("hex");

            if (
                calculatedHash !==
                String(security.pattern_hash)
            ) {
                return res.status(401).json({
                    ok: false,
                    error: "INVALID_PATTERN",
                    message: "اسم المستخدم أو نقش الحماية غير صحيح."
                });
            }

            /*
              نفس سياسة الجهاز المستخدمة في تسجيل الدخول بكلمة المرور.
              تسجيل الدخول بالنقش لا يلغي أو يمنع تسجيل الدخول بكلمة المرور.
            */
            if (!user.device_serial) {
                run(
                    `UPDATE users
                     SET
                        device_serial=?,
                        updated_at=?
                     WHERE id=?`,
                    [
                        deviceSerial,
                        now(),
                        user.id
                    ]
                );

                user.device_serial =
                    deviceSerial;

                saveDatabase();

            } else if (
                user.device_serial !==
                deviceSerial
            ) {
                run(
                    `UPDATE users
                     SET
                        device_serial=?,
                        updated_at=?
                     WHERE id=?`,
                    [
                        deviceSerial,
                        now(),
                        user.id
                    ]
                );

                user.device_serial =
                    deviceSerial;

                saveDatabase();
            }

            const token =
                randomToken();

            sessions.set(
                token,
                {
                    user_id: user.id,
                    device_serial: deviceSerial,
                    created_at: now(),
                    last_seen: now()
                }
            );

            run(
                `INSERT OR REPLACE INTO sessions
                 (
                    token,
                    user_id,
                    device_serial,
                    created_at,
                    last_seen
                 )
                 VALUES(?,?,?,?,?)`,
                [
                    token,
                    user.id,
                    deviceSerial,
                    now(),
                    now()
                ]
            );

            audit(
                user.id,
                "pattern_login",
                "تسجيل دخول ناجح باستخدام نقش الحماية"
            );

            return res.json({
                ok: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    name: user.name,
                    role: user.role,
                    is_admin: user.is_admin,
                    status: user.status,
                    device_serial: user.device_serial
                }
            });

        } catch (error) {
            console.error(
                "Pattern login failed:",
                error
            );

            return res.status(500).json({
                ok: false,
                error: "PATTERN_LOGIN_ERROR",
                message: "تعذر تسجيل الدخول باستخدام نقش الحماية."
            });
        }
    }
);


app.post(
    "/api/profile/pattern/bind",
    requireAuth,
    (req, res) => {
        try {
            const pattern = String(req.body?.pattern || "").trim();

            if (!pattern) {
                return res.status(400).json({
                    ok: false,
                    error: "PATTERN_REQUIRED",
                    message: "نقش الحماية مطلوب."
                });
            }

            if (pattern.length < 4 || pattern.length > 100) {
                return res.status(400).json({
                    ok: false,
                    error: "INVALID_PATTERN",
                    message: "نقش الحماية غير صالح."
                });
            }

            const userId = Number(req.user.id);
            const salt = crypto.randomBytes(32).toString("hex");
            const patternHash = crypto
                .createHash("sha256")
                .update(salt + ":" + pattern)
                .digest("hex");
            const timestamp = now();

            run(
                `INSERT INTO user_pattern_security
                    (user_id, pattern_hash, salt, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, 1, ?, ?)
                 ON CONFLICT(user_id)
                 DO UPDATE SET
                    pattern_hash=excluded.pattern_hash,
                    salt=excluded.salt,
                    enabled=1,
                    updated_at=excluded.updated_at`,
                [
                    userId,
                    patternHash,
                    salt,
                    timestamp,
                    timestamp
                ]
            );

            saveDatabase();

            return res.json({
                ok: true,
                enabled: true,
                message: "تم ربط نقش الحماية بالحساب بنجاح."
            });

        } catch (error) {
            console.error(
                "Pattern bind failed:",
                error.message
            );

            return res.status(500).json({
                ok: false,
                error: "PATTERN_BIND_FAILED",
                message: "تعذر ربط نقش الحماية."
            });
        }
    }
);

app.post(
    "/api/profile/pattern/verify",
    requireAuth,
    (req, res) => {
        try {
            const pattern = String(req.body?.pattern || "").trim();

            if (!pattern) {
                return res.status(400).json({
                    ok: false,
                    error: "PATTERN_REQUIRED",
                    message: "نقش الحماية مطلوب."
                });
            }

            const security = one(
                `SELECT pattern_hash, salt, enabled
                 FROM user_pattern_security
                 WHERE user_id=?`,
                [Number(req.user.id)]
            );

            if (
                !security ||
                Number(security.enabled) !== 1 ||
                !security.pattern_hash ||
                !security.salt
            ) {
                return res.json({
                    ok: false,
                    enabled: false,
                    verified: false,
                    message: "نقش الحماية غير مفعّل."
                });
            }

            const calculatedHash = crypto
                .createHash("sha256")
                .update(
                    String(security.salt) +
                    ":" +
                    pattern
                )
                .digest("hex");

            const verified =
                calculatedHash ===
                String(security.pattern_hash);

            return res.json({
                ok: verified,
                enabled: true,
                verified,
                message: verified
                    ? "تم التحقق من نقش الحماية."
                    : "نقش الحماية غير صحيح."
            });

        } catch (error) {
            console.error(
                "Pattern verify failed:",
                error.message
            );

            return res.status(500).json({
                ok: false,
                error: "PATTERN_VERIFY_FAILED",
                message: "تعذر التحقق من نقش الحماية."
            });
        }
    }
);

/* =========================================================
   تغيير كلمة مرور مدير النظام
   متاح لمدير النظام فقط.
========================================================= */

app.put(
    "/api/profile/change-password",
    requireAuth,
    (req, res) => {

        try {

            if (
                !req.user ||
                String(req.user.role || "").trim() !==
                    "system_manager"
            ) {
                return res.status(403).json({
                    ok: false,
                    error: "SYSTEM_MANAGER_ONLY",
                    message:
                        "تغيير كلمة المرور متاح لمدير النظام فقط."
                });
            }

            const currentUsername =
                String(
                    req.body?.currentUsername || ""
                ).trim();

            const oldPassword =
                String(
                    req.body?.oldPassword || ""
                );

            const newPassword =
                String(
                    req.body?.newPassword || ""
                );

            const confirmPassword =
                String(
                    req.body?.confirmPassword || ""
                );

            if (
                !currentUsername ||
                !oldPassword ||
                !newPassword ||
                !confirmPassword
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "PASSWORD_FIELDS_REQUIRED",
                    message:
                        "جميع حقول كلمة المرور مطلوبة."
                });
            }

            if (
                currentUsername !==
                String(req.user.username || "")
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "USERNAME_MISMATCH",
                    message:
                        "اسم المستخدم الحالي غير مطابق للحساب."
                });
            }

            if (newPassword !== confirmPassword) {
                return res.status(400).json({
                    ok: false,
                    error: "PASSWORD_CONFIRM_MISMATCH",
                    message:
                        "تأكيد كلمة المرور الجديدة غير مطابق."
                });
            }

            if (newPassword.length < 8) {
                return res.status(400).json({
                    ok: false,
                    error: "PASSWORD_TOO_SHORT",
                    message:
                        "كلمة المرور الجديدة يجب أن تكون 8 أحرف أو أكثر."
                });
            }

            if (newPassword === oldPassword) {
                return res.status(400).json({
                    ok: false,
                    error: "PASSWORD_UNCHANGED",
                    message:
                        "كلمة المرور الجديدة يجب أن تختلف عن السابقة."
                });
            }

            const user =
                one(
                    "SELECT id, username, password_hash, role, status FROM users WHERE id=?",
                    [req.user.id]
                );

            if (!user) {
                return res.status(401).json({
                    ok: false,
                    error: "USER_NOT_FOUND",
                    message:
                        "المستخدم غير موجود."
                });
            }

            if (
                String(user.role || "").trim() !==
                    "system_manager"
            ) {
                return res.status(403).json({
                    ok: false,
                    error: "SYSTEM_MANAGER_ONLY",
                    message:
                        "هذه العملية متاحة لمدير النظام فقط."
                });
            }

            if (
                String(user.password_hash || "") !==
                    hashPassword(oldPassword)
            ) {
                return res.status(400).json({
                    ok: false,
                    error: "OLD_PASSWORD_INVALID",
                    message:
                        "كلمة المرور السابقة غير صحيحة."
                });
            }

            run(
                `UPDATE users
                 SET password_hash=?,
                     updated_at=?
                 WHERE id=?`,
                [
                    hashPassword(newPassword),
                    now(),
                    user.id
                ]
            );

            audit(
                user.id,
                "change_system_manager_password",
                "تم تغيير كلمة مرور مدير النظام بنجاح."
            );

            return res.json({
                ok: true,
                message:
                    "تم تغيير كلمة المرور وحفظها في قاعدة البيانات بنجاح."
            });

        } catch (error) {

            console.error(
                "Change password error:",
                error.message
            );

            return res.status(500).json({
                ok: false,
                error: "PASSWORD_CHANGE_FAILED",
                message:
                    "تعذر حفظ تغيير كلمة المرور."
            });
        }
    }
);

/* =========================================================
   صلاحية المشرف
========================================================= */

function adminPermissionForRequest(req) {

    const pathName =
        String(req.path || "");

    const method =
        String(req.method || "GET").toUpperCase();

    if (
        pathName === "/api/admin/users" &&
        method === "POST"
    ) {
        return "add_user";
    }

    if (
        pathName === "/api/admin/users" &&
        method === "GET"
    ) {
        return "manage_users";
    }

    if (pathName.includes("/block")) {
        return "block_user";
    }

    if (pathName.includes("/freeze")) {
        return "freeze_user";
    }

    if (pathName.includes("/release")) {
        return "release_user";
    }

    if (pathName.includes("/clear")) {
        return "clear_chat";
    }

    if (
        pathName.includes("/backup") ||
        pathName.includes("/backup-conversations")
    ) {
        return "backup";
    }

    if (
        pathName.includes("/location") ||
        pathName.includes("/locations")
    ) {
        return "locations";
    }

    if (
        pathName.includes("/warning") ||
        pathName.includes("/warnings")
    ) {
        return "warnings";
    }

    if (pathName.includes("/broadcast")) {
        return "broadcast";
    }

    if (
        pathName.includes("/report") ||
        pathName.includes("/reports")
    ) {
        return "user_reports";
    }

    if (
        pathName.includes("/credentials")
    ) {
        return "credentials_report";
    }

    if (pathName.includes("/channel")) {
        return "channels";
    }

    if (pathName.includes("/audit")) {
        return "audit";
    }

    if (
        pathName.includes("/database") ||
        pathName.includes("/update")
    ) {
        return "update_database";
    }

    if (
        pathName.includes("/alert") ||
        pathName.includes("/alert-mode")
    ) {
        return "alert_mode";
    }

    if (
        pathName.includes("/network-off") ||
        pathName.includes("/network/off")
    ) {
        return "network_off";
    }

    if (
        pathName.includes("/restart") ||
        pathName.includes("/network-restart")
    ) {
        return "network_restart";
    }

    if (
        pathName.includes("/lock") ||
        pathName.includes("/app-lock")
    ) {
        return "app_lock";
    }

    return null;
}

function hasAdminPermission(userId, permission) {

    const user =
        one(
            "SELECT id, role, is_admin FROM users WHERE id=?",
            [Number(userId)]
        );

    if (!user) {
        return false;
    }

    /* مدير النظام يمتلك كل الصلاحيات */

    if (
        user.role === "system_manager"
    ) {
        return true;
    }

    if (
        user.role !== "admin" ||
        Number(user.is_admin) !== 1
    ) {
        return false;
    }

    if (!permission) {
        return true;
    }

    ensureUserPermissions(user.id);

    const row =
        one(
            `SELECT allowed
             FROM user_permissions
             WHERE user_id=?
               AND (
                   permission_key=?
                   OR permission=?
               )
             ORDER BY
               CASE
                   WHEN permission_key=? THEN 0
                   WHEN permission=? THEN 1
                   ELSE 2
               END,
               id
             LIMIT 1`,
            [
                user.id,
                permission,
                permission,
                permission,
                permission
            ]
        );

    return !!(
        row &&
        Number(row.allowed) === 1
    );
}

function requireAdmin(
    req,
    res,
    next
) {

    if (!req.user) {

        return res.status(403).json({

            error: "ADMIN_ONLY",

            message:
                "هذه العملية تتطلب صلاحيات إدارية."
        });
    }

    const isSupervisor =
        req.user.role === "admin" &&
        Number(req.user.is_admin) === 1;

    const isSystemManager =
        req.user.role === "system_manager";

    if (
        !isSupervisor &&
        !isSystemManager
    ) {

        return res.status(403).json({

            error: "ADMIN_ONLY",

            message:
                "هذه العملية متاحة للمشرف أو مدير النظام فقط."
        });
    }

    const permission =
        adminPermissionForRequest(req);

    if (
        isSupervisor &&
        permission &&
        !hasAdminPermission(
            req.user.id,
            permission
        )
    ) {

        return res.status(403).json({

            ok: false,

            error: "PERMISSION_DENIED",

            permission,

            message:
                "لا تملك الصلاحية لتنفيذ هذا الأمر."
        });
    }

    next();
}

/* =========================================================
   صلاحية مدير النظام
   أعلى من المشرف
========================================================= */

function requireSystemManager(
    req,
    res,
    next
) {

    if (
        !req.user ||
        req.user.role !== "system_manager"
    ) {

        return res.status(403).json({

            error: "SYSTEM_MANAGER_ONLY",

            message:
                "هذا الأمر متاح لمدير النظام فقط."
        });
    }

    next();
}

/* =========================================================
   فحص الخادم
========================================================= */

app.get(
    "/api/health",
    (req, res) => {

        const state =
            one(
                "SELECT * FROM system_state WHERE id=1"
            );

        res.json({

            ok: true,

            status: "online",

            server:
                "Secure Messenger V5.2",

            networkMode:
                SERVER_MODE === "internet"
                    ? "internet"
                    : (state?.network_mode || "local"),

            networkName:
                state?.network_name || "",

            time: now()
        });
    }
);

/* =========================================================
   تسجيل الدخول
========================================================= */

app.post(
    "/api/login",
    (req, res) => {

        const username =
            String(
                req.body?.username || ""
            ).trim();

        const password =
            String(
                req.body?.password || ""
            );

        const deviceSerial =
            deviceIdFromRequest(req);

        if (!username || !password) {

            return res.status(400).json({

                error:
                    "LOGIN_REQUIRED",

                message:
                    "أدخل اسم المستخدم وكلمة المرور."
            });
        }

        const user =
            one(
                "SELECT * FROM users WHERE username=?",
                [username]
            );

        if (
            !user ||
            user.password_hash !==
            hashPassword(password)
        ) {

            return res.status(401).json({

                error:
                    "INVALID_LOGIN",

                message:
                    "اسم المستخدم أو كلمة المرور غير صحيحة."
            });
        }

        if (user.status === "blocked") {

            return res.status(403).json({

                error: "BLOCKED",

                message:
                    "الحساب محظور."
            });
        }

        if (user.status === "frozen") {

            return res.status(403).json({

                error: "FROZEN",

                message:
                    "الحساب مجمد."
            });
        }

        /*
          أول جهاز يصبح الجهاز المعتمد
        */

        if (!user.device_serial) {

            run(
                `UPDATE users
                 SET
                    device_serial=?,
                    updated_at=?
                 WHERE id=?`,
                [
                    deviceSerial,
                    now(),
                    user.id
                ]
            );

            user.device_serial =
                deviceSerial;

            saveDatabase();

        } else if (
            user.device_serial !==
            deviceSerial
        ) {

            run(
                `UPDATE users
                 SET
                    device_serial=?,
                    updated_at=?
                 WHERE id=?`,
                [
                    deviceSerial,
                    now(),
                    user.id
                ]
            );

            user.device_serial =
                deviceSerial;

            saveDatabase();
        }

        /*
         * تخصيص رقم الاتصال الرسمي فقط بعد نجاح
         * اسم المستخدم وكلمة المرور والتحقق من حالة الحساب.
         */
        let voiceCallNumber = "";

        try {
            voiceCallNumber =
                assignVoiceCallNumberOnSuccessfulLogin(
                    user.id
                );

            saveDatabase();
        } catch (error) {
            console.error(
                "VOICE NUMBER ASSIGNMENT ERROR:",
                error.message
            );

            return res.status(500).json({
                error:
                    "VOICE_NUMBER_ASSIGNMENT_FAILED",
                message:
                    "تعذر تخصيص رقم الاتصال الصوتي."
            });
        }

        const token =
            randomToken();

        sessions.set(
            token,
            {
                user_id: user.id,
                device_serial: deviceSerial,
                created_at: now(),
                last_seen: now()
            }
        );

        run(
            `INSERT OR REPLACE INTO sessions
             (
                token,
                user_id,
                device_serial,
                created_at,
                last_seen
             )
             VALUES(?,?,?,?,?)`,
            [
                token,
                user.id,
                deviceSerial,
                now(),
                now()
            ]
        );

        audit(
            user.id,
            "login",
            "تسجيل دخول ناجح"
        );

        res.json({

            ok: true,

            token,

            user: {

                id: user.id,

                username:
                    user.username,

                name:
                    user.name,

                role:
                    user.role,

                is_admin:
                    user.is_admin,

                status:
                    user.status,

                device_serial:
                    user.device_serial,

                voice_call_number:
                    voiceCallNumber
            }
        });
    }
);


/* =========================================================
   WebAuthn / Passkey
   بدء تسجيل مفتاح مرور للمستخدم الحالي
========================================================= */

/*
   WebAuthn / Passkey Login - Options
   تسجيل الدخول باستخدام Passkey مع الإبقاء على كلمة المرور والنمط.
*/
app.post(
    "/api/passkey/login/options",
    async (req, res) => {
        try {
            if (!WEBAUTHN_RP_ID || !WEBAUTHN_ORIGIN) {
                return res.status(503).json({
                    ok: false,
                    error: "WEBAUTHN_NOT_CONFIGURED"
                });
            }

            const username =
                String(req.body?.username || "").trim();

            if (!username) {
                return res.status(400).json({
                    ok: false,
                    error: "USERNAME_REQUIRED"
                });
            }

            const user = one(
                `SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status,
                    device_serial
                 FROM users
                 WHERE username=?
                 LIMIT 1`,
                [username]
            );

            if (!user) {
                return res.status(401).json({
                    ok: false,
                    error: "INVALID_LOGIN"
                });
            }

            const status =
                String(user.status || "").toLowerCase();

            if (status === "blocked") {
                return res.status(403).json({
                    ok: false,
                    error: "ACCOUNT_BLOCKED"
                });
            }

            if (status === "frozen") {
                return res.status(403).json({
                    ok: false,
                    error: "ACCOUNT_FROZEN"
                });
            }

            const passkeys = all(
                `SELECT credential_id
                 FROM user_passkeys
                 WHERE user_id=?`,
                [user.id]
            );

            if (!passkeys.length) {
                return res.status(404).json({
                    ok: false,
                    error: "NO_PASSKEY"
                });
            }

            const w = await getWebAuthnServer();

            const options =
                await w.generateAuthenticationOptions({
                    rpID: WEBAUTHN_RP_ID,
                    allowCredentials:
                        passkeys.map(item => ({
                            id: item.credential_id
                        })),
                    userVerification: "required"
                });

            savePasskeyChallenge(
                user.id,
                "authentication",
                options.challenge,
                Date.now() + (5 * 60 * 1000)
            );

            return res.json({
                ok: true,
                options
            });
        } catch (error) {
            console.error(
                "PASSKEY LOGIN OPTIONS ERROR:",
                error
            );

            return res.status(500).json({
                ok: false,
                error: "PASSKEY_LOGIN_OPTIONS_FAILED"
            });
        }
    }
);

/*
   WebAuthn / Passkey Login - Verify
   التحقق من المفتاح العام والعداد ثم إنشاء جلسة.
*/
app.post(
    "/api/passkey/login/verify",
    async (req, res) => {
        try {
            if (!WEBAUTHN_RP_ID || !WEBAUTHN_ORIGIN) {
                return res.status(503).json({
                    ok: false,
                    error: "WEBAUTHN_NOT_CONFIGURED"
                });
            }

            const username =
                String(req.body?.username || "").trim();

            const response = req.body?.response;

            if (!username || !response) {
                return res.status(400).json({
                    ok: false,
                    error: "INVALID_PASSKEY_REQUEST"
                });
            }

            const user = one(
                `SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status,
                    device_serial
                 FROM users
                 WHERE username=?
                 LIMIT 1`,
                [username]
            );

            if (!user) {
                return res.status(401).json({
                    ok: false,
                    error: "INVALID_LOGIN"
                });
            }

            const status =
                String(user.status || "").toLowerCase();

            if (status === "blocked") {
                return res.status(403).json({
                    ok: false,
                    error: "ACCOUNT_BLOCKED"
                });
            }

            if (status === "frozen") {
                return res.status(403).json({
                    ok: false,
                    error: "ACCOUNT_FROZEN"
                });
            }

            const challenge =
                getPasskeyChallenge(
                    user.id,
                    "authentication"
                );

            if (!challenge) {
                return res.status(400).json({
                    ok: false,
                    error: "PASSKEY_CHALLENGE_MISSING"
                });
            }

            if (
                Number(challenge.expires_at) <
                Date.now()
            ) {
                deletePasskeyChallenge(
                    user.id,
                    "authentication"
                );

                return res.status(400).json({
                    ok: false,
                    error: "PASSKEY_CHALLENGE_EXPIRED"
                });
            }

            const credential = one(
                `SELECT
                    id,
                    user_id,
                    credential_id,
                    public_key,
                    counter,
                    device_type,
                    created_at,
                    last_used_at
                 FROM user_passkeys
                 WHERE user_id=?
                   AND credential_id=?
                 LIMIT 1`,
                [
                    user.id,
                    String(response.id || "")
                ]
            );

            if (!credential) {
                return res.status(401).json({
                    ok: false,
                    error: "PASSKEY_NOT_REGISTERED"
                });
            }

            const w = await getWebAuthnServer();

            const verification =
                await w.verifyAuthenticationResponse({
                    response,
                    expectedChallenge:
                        challenge.challenge,
                    expectedOrigin:
                        WEBAUTHN_ORIGIN,
                    expectedRPID:
                        WEBAUTHN_RP_ID,
                    credential: {
                        id:
                            credential.credential_id,
                        publicKey:
                            Buffer.from(
                                credential.public_key,
                                "base64"
                            ),
                        counter:
                            Number(
                                credential.counter || 0
                            )
                    },
                    requireUserVerification: true
                });

            deletePasskeyChallenge(
                user.id,
                "authentication"
            );

            if (!verification.verified) {
                return res.status(401).json({
                    ok: false,
                    error: "PASSKEY_VERIFICATION_FAILED"
                });
            }

            const authenticationInfo =
                verification.authenticationInfo;

            const newCounter =
                Number(
                    authenticationInfo.newCounter || 0
                );

            run(
                `UPDATE user_passkeys
                 SET counter=?,
                     last_used_at=?
                 WHERE id=?`,
                [
                    newCounter,
                    now(),
                    credential.id
                ]
            );

            const deviceSerial =
                deviceIdFromRequest(req);

            if (
                deviceSerial &&
                String(user.device_serial || "") !==
                    String(deviceSerial)
            ) {
                run(
                    `UPDATE users
                     SET device_serial=?
                     WHERE id=?`,
                    [deviceSerial, user.id]
                );
            }

            /*
             * Passkey يعتبر أيضاً تسجيل دخول ناجحاً.
             * لذلك يحصل الحساب على رقمه عند أول دخول
             * ناجح بالمفتاح، إن لم يكن لديه رقم سابق.
             */
            let voiceCallNumber = "";

            try {
                voiceCallNumber =
                    assignVoiceCallNumberOnSuccessfulLogin(
                        user.id
                    );
            } catch (error) {
                console.error(
                    "PASSKEY VOICE NUMBER ASSIGNMENT ERROR:",
                    error.message
                );

                return res.status(500).json({
                    ok: false,
                    error:
                        "VOICE_NUMBER_ASSIGNMENT_FAILED"
                });
            }

            const token =
                createPasskeySession(
                    { id: user.id },
                    deviceSerial
                );

            run(
                `INSERT INTO audit
                 (user_id,action,details,created_at)
                 VALUES(?,?,?,?)`,
                [
                    user.id,
                    "passkey_login",
                    "تسجيل دخول ناجح باستخدام مفتاح المرور",
                    now()
                ]
            );

            saveDatabase();

            return res.json({
                ok: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    name: user.name,
                    role: user.role,
                    is_admin: user.is_admin,
                    status: user.status,
                    device_serial: deviceSerial,
                    voice_call_number:
                        voiceCallNumber
                }
            });
        } catch (error) {
            console.error(
                "PASSKEY LOGIN VERIFY ERROR:",
                error
            );

            return res.status(401).json({
                ok: false,
                error: "PASSKEY_VERIFICATION_FAILED"
            });
        }
    }
);

app.post(
    "/api/passkey/register/options",
    requireAuth,
    async (req, res) => {

        try {

            if (!WEBAUTHN_RP_ID || !WEBAUTHN_ORIGIN) {
                return res.status(503).json({
                    ok: false,
                    error: "WEBAUTHN_NOT_CONFIGURED",
                    message:
                        "إعدادات WebAuthn غير مكتملة."
                });
            }

            const user = one(
                `SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status,
                    device_serial
                 FROM users
                 WHERE id=?`,
                [req.user.id]
            );

            if (!user) {
                return res.status(404).json({
                    ok: false,
                    error: "USER_NOT_FOUND",
                    message:
                        "المستخدم غير موجود."
                });
            }

            const {
                generateRegistrationOptions
            } = await getWebAuthnServer();

            const existingPasskeys = all(
                `SELECT
                    credential_id
                 FROM user_passkeys
                 WHERE user_id=?`,
                [user.id]
            );

            const options =
                await generateRegistrationOptions({
                    rpName:
                        WEBAUTHN_RP_NAME,

                    rpID:
                        WEBAUTHN_RP_ID,

                    userName:
                        String(user.username),

                    userDisplayName:
                        String(
                            user.name ||
                            user.username
                        ),

                    userID:
                        new Uint8Array(
                            Buffer.from(
                                String(user.id),
                                "utf8"
                            )
                        ),

                    excludeCredentials:
                        existingPasskeys.map(
                            (item) => ({
                                id:
                                    item.credential_id
                            })
                        ),

                    authenticatorSelection: {
                        residentKey:
                            "preferred",

                        userVerification:
                            "required"
                    },

                    attestationType:
                        "none"
                });

            const expiresAt =
                Date.now() + (5 * 60 * 1000);

            savePasskeyChallenge(
                user.id,
                "registration",
                options.challenge,
                expiresAt
            );

            res.json({
                ok: true,
                options
            });

        } catch (error) {

            console.error(
                "WebAuthn registration options error:",
                error
            );

            res.status(500).json({
                ok: false,
                error:
                    "WEBAUTHN_REGISTRATION_OPTIONS_FAILED",
                message:
                    "تعذر إنشاء خيارات تسجيل البصمة."
            });
        }
    }
);


/* =========================================================
   WebAuthn / Passkey
   التحقق من تسجيل مفتاح المرور
========================================================= */

app.post(
    "/api/passkey/register/verify",
    requireAuth,
    async (req, res) => {

        try {

            if (!WEBAUTHN_RP_ID || !WEBAUTHN_ORIGIN) {
                return res.status(503).json({
                    ok: false,
                    error: "WEBAUTHN_NOT_CONFIGURED",
                    message:
                        "إعدادات WebAuthn غير مكتملة."
                });
            }

            const response =
                req.body?.response;

            if (!response) {
                return res.status(400).json({
                    ok: false,
                    error: "INVALID_PASSKEY_RESPONSE",
                    message:
                        "استجابة Passkey غير موجودة."
                });
            }

            const challenge =
                getPasskeyChallenge(
                    req.user.id,
                    "registration"
                );

            if (!challenge) {
                return res.status(400).json({
                    ok: false,
                    error: "PASSKEY_CHALLENGE_NOT_FOUND",
                    message:
                        "انتهت جلسة تسجيل البصمة. أعد المحاولة."
                });
            }

            if (
                Number(challenge.expires_at) <
                Date.now()
            ) {

                deletePasskeyChallenge(
                    req.user.id,
                    "registration"
                );

                return res.status(400).json({
                    ok: false,
                    error: "PASSKEY_CHALLENGE_EXPIRED",
                    message:
                        "انتهت صلاحية تسجيل البصمة. أعد المحاولة."
                });
            }

            const {
                verifyRegistrationResponse
            } = await getWebAuthnServer();

            const verification =
                await verifyRegistrationResponse({
                    response,

                    expectedChallenge:
                        challenge.challenge,

                    expectedOrigin:
                        WEBAUTHN_ORIGIN,

                    expectedRPID:
                        WEBAUTHN_RP_ID,

                    requireUserVerification:
                        true
                });

            deletePasskeyChallenge(
                req.user.id,
                "registration"
            );

            if (!verification.verified) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "PASSKEY_REGISTRATION_FAILED",
                    message:
                        "تعذر التحقق من تسجيل البصمة."
                });
            }

            const registrationInfo =
                verification.registrationInfo;

            const credential =
                registrationInfo.credential;

            const existing =
                one(
                    `SELECT
                        id
                     FROM user_passkeys
                     WHERE credential_id=?`,
                    [credential.id]
                );

            if (existing) {
                return res.status(409).json({
                    ok: false,
                    error:
                        "PASSKEY_ALREADY_REGISTERED",
                    message:
                        "مفتاح المرور مسجل مسبقاً."
                });
            }

            const publicKey =
                Buffer.from(
                    credential.publicKey
                ).toString("base64");

            run(
                `INSERT INTO user_passkeys
                 (
                    user_id,
                    credential_id,
                    public_key,
                    counter,
                    device_type,
                    created_at,
                    last_used_at
                 )
                 VALUES(?,?,?,?,?,?,?)`,
                [
                    req.user.id,
                    credential.id,
                    publicKey,
                    Number(
                        credential.counter || 0
                    ),
                    String(
                        registrationInfo.credentialDeviceType ||
                        ""
                    ),
                    now(),
                    ""
                ]
            );

            saveDatabase();

            audit(
                req.user.id,
                "passkey_register",
                "تم تسجيل مفتاح مرور جديد"
            );

            res.json({
                ok: true,
                message:
                    "تم تسجيل البصمة بنجاح."
            });

        } catch (error) {

            console.error(
                "WebAuthn registration verify error:",
                error
            );

            res.status(400).json({
                ok: false,
                error:
                    "WEBAUTHN_REGISTRATION_VERIFY_FAILED",
                message:
                    "تعذر التحقق من تسجيل البصمة."
            });
        }
    }
);


/* =========================================================
   المستخدم الحالي
========================================================= */

app.get(
    "/api/me",
    requireAuth,
    (req, res) => {
        const user = one(
            `SELECT
                id,
                username,
                name,
                role,
                is_admin,
                status,
                device_serial,
                profile_image
             FROM users
             WHERE id=?`,
            [req.user.id]
        );

        if (!user) {
            return res.status(401).json({
                error: "UNAUTHORIZED",
                message: "المستخدم غير موجود."
            });
        }

        res.json({
            ok: true,
            user
        });
    }
);

/* =========================================================
   تحديث صورة البروفايل
========================================================= */

app.put(
    "/api/me/profile-image",
    requireAuth,
    (req, res) => {
        try {
            const image = String(req.body?.profile_image || "");

            if (!image) {
                run(
                    `UPDATE users
                     SET profile_image='', updated_at=?
                     WHERE id=?`,
                    [now(), req.user.id]
                );

                saveDatabase();

                return res.json({
                    ok: true,
                    profile_image: ""
                });
            }

            if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(image)) {
                return res.status(400).json({
                    error: "INVALID_IMAGE",
                    message: "صيغة الصورة غير مدعومة."
                });
            }

            if (image.length > 5 * 1024 * 1024) {
                return res.status(400).json({
                    error: "IMAGE_TOO_LARGE",
                    message: "حجم صورة البروفايل كبير جداً. الحد الأقصى 5MB."
                });
            }

            run(
                `UPDATE users
                 SET profile_image=?, updated_at=?
                 WHERE id=?`,
                [image, now(), req.user.id]
            );

            saveDatabase();

            res.json({
                ok: true,
                profile_image: image
            });

        } catch (err) {
            console.error("PROFILE_IMAGE_UPDATE_ERROR:", err);

            res.status(500).json({
                error: "PROFILE_IMAGE_UPDATE_FAILED",
                message: "تعذر حفظ صورة البروفايل."
            });
        }
    }
);

/* =========================================================
   تسجيل الخروج
========================================================= */

app.post(
    "/api/logout",
    requireAuth,
    (req, res) => {

        sessions.delete(
            req.token
        );

        run(
            "DELETE FROM sessions WHERE token=?",
            [req.token]
        );

        try {
            saveDatabase();
        } catch (logoutSaveError) {
            console.error(
                "Logout database save failed:",
                logoutSaveError.message
            );
        }

        audit(
            req.user.id,
            "logout",
            "تسجيل خروج"
        );

        res.json({
            ok: true,
            message:
                "تم تسجيل الخروج."
        });
    }
);

/* =========================================================
   المستخدمون
========================================================= */

app.get(
    "/api/users",
    requireAuth,
    (req, res) => {

        const users =
            all(
                `
                SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status,
                    profile_image,
                    internal_voice_number,
                    voice_call_number
                FROM users
                WHERE id<>?
                ORDER BY name,username
                `,
                [req.user.id]
            );

        const ONLINE_WINDOW_MS = 60 * 1000;
        const currentTime = Date.now();

        const onlineIds = new Set();

        for (const session of sessions.values()) {

            if (!session || !session.user_id) {
                continue;
            }

            const lastSeen =
                Date.parse(
                    String(session.last_seen || "")
                );

            if (
                Number.isFinite(lastSeen) &&
                currentTime - lastSeen <= ONLINE_WINDOW_MS
            ) {
                onlineIds.add(
                    Number(session.user_id)
                );
            }
        }

        const usersWithPresence =
            users.map(user => ({
                ...user,
                online:
                    onlineIds.has(
                        Number(user.id)
                    )
            }));

        res.json({
            users: usersWithPresence,
            online_ids:
                Array.from(onlineIds)
        });
    }
);

/* =========================================================
   إنشاء مستخدم
========================================================= */

app.post(
    "/api/admin/users",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const username =
            String(
                req.body?.username || ""
            ).trim();

        const name =
            String(
                req.body?.name || ""
            ).trim();

        const password =
            String(
                req.body?.password || ""
            );

        if (!username || !password) {

            return res.status(400).json({

                message:
                    "اسم المستخدم وكلمة المرور مطلوبان."
            });
        }

        if (
            one(
                "SELECT id FROM users WHERE username=?",
                [username]
            )
        ) {

            return res.status(409).json({

                message:
                    "اسم المستخدم موجود مسبقاً."
            });
        }

        run(
            `INSERT INTO users
             (
                username,
                name,
                password_hash,
                role,
                is_admin,
                status,
                device_serial,
                created_at,
                updated_at
             )
             VALUES(?,?,?,?,?,?,?,?,?)`,
            [
                username,
                name,
                hashPassword(password),
                "user",
                0,
                "active",
                "",
                now(),
                now()
            ]
        );

        /*
         * لا يتم تخصيص رقم الاتصال عند إنشاء الحساب.
         *
         * سيتم تخصيص voice_call_number عند أول
         * تسجيل دخول ناجح فقط.
         */

        saveDatabase();

        audit(
            req.user.id,
            "create_user",
            username
        );

        res.json({

            ok: true,

            message:
                "تم إنشاء المستخدم بنجاح."
        });
    }
);

/* =========================================================
   إدارة المستخدمين
========================================================= */

app.get(
    "/api/admin/users",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const users =
            all(
                `
                SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status,
                    device_serial,
                    created_at,
                    updated_at
                FROM users
                ORDER BY id ASC
                `
            );

        res.json({
            users
        });
    }
);

/* حظر */

app.post(
    "/api/admin/users/:id/block",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const id =
            Number(req.params.id);

        const user =
            one(
                "SELECT * FROM users WHERE id=?",
                [id]
            );

        if (!user) {

            return res.status(404).json({

                message:
                    "المستخدم غير موجود."
            });
        }

        if (user.is_admin) {

            return res.status(400).json({

                message:
                    "لا يمكن حظر حساب المشرف."
            });
        }

        run(
            `UPDATE users
             SET
                status='blocked',
                updated_at=?
             WHERE id=?`,
            [
                now(),
                id
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "block_user",
            String(id)
        );

        res.json({

            ok: true,

            message:
                "تم حظر المستخدم."
        });
    }
);

/* تجميد */

app.post(
    "/api/admin/users/:id/freeze",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const id =
            Number(req.params.id);

        const user =
            one(
                "SELECT * FROM users WHERE id=?",
                [id]
            );

        if (!user) {

            return res.status(404).json({

                message:
                    "المستخدم غير موجود."
            });
        }

        if (user.is_admin) {

            return res.status(400).json({

                message:
                    "لا يمكن تجميد حساب المشرف."
            });
        }

        run(
            `UPDATE users
             SET
                status='frozen',
                updated_at=?
             WHERE id=?`,
            [
                now(),
                id
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "freeze_user",
            String(id)
        );

        res.json({

            ok: true,

            message:
                "تم تجميد المستخدم."
        });
    }
);

/* إطلاق */

app.post(
    "/api/admin/users/:id/release",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const id =
            Number(req.params.id);

        const user =
            one(
                "SELECT * FROM users WHERE id=?",
                [id]
            );

        if (!user) {

            return res.status(404).json({

                message:
                    "المستخدم غير موجود."
            });
        }

        run(
            `UPDATE users
             SET
                status='active',
                updated_at=?
             WHERE id=?`,
            [
                now(),
                id
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "release_user",
            String(id)
        );

        res.json({

            ok: true,

            message:
                "تم إطلاق المستخدم وفك التجميد."
        });
    }
);

/* =========================================================
   إدارة المشرفين - مدير النظام فقط
========================================================= */

/* إضافة مشرف */

app.post(
    "/api/system-manager/supervisors",
    requireAuth,
    requireSystemManager,
    (req, res) => {

        const username =
            String(
                req.body?.username || ""
            ).trim();

        const name =
            String(
                req.body?.name || ""
            ).trim();

        const password =
            String(
                req.body?.password || ""
            );

        if (!username || !password) {

            return res.status(400).json({
                ok: false,
                message:
                    "اسم المستخدم وكلمة المرور مطلوبان."
            });
        }

        if (
            one(
                "SELECT id FROM users WHERE username=?",
                [username]
            )
        ) {

            return res.status(409).json({
                ok: false,
                message:
                    "اسم المستخدم موجود مسبقاً."
            });
        }

        run(
            `INSERT INTO users
             (
                username,
                name,
                password_hash,
                role,
                is_admin,
                status,
                device_serial,
                created_at,
                updated_at
             )
             VALUES(?,?,?,?,?,?,?,?,?)`,
            [
                username,
                name,
                hashPassword(password),
                "admin",
                1,
                "active",
                "",
                now(),
                now()
            ]
        );

        /*
         * لا يتم تخصيص رقم الاتصال عند إنشاء المشرف.
         * سيتم تخصيصه عند أول تسجيل دخول ناجح فقط.
         */

        saveDatabase();

        audit(
            req.user.id,
            "create_supervisor",
            username
        );

        res.json({
            ok: true,
            message:
                "تم إنشاء المشرف بنجاح."
        });
    }
);



/* =========================================================
   صلاحيات المشرف الحالي
   هذا المسار يسمح للمشرف بقراءة صلاحياته فقط.
   مدير النظام يمتلك جميع الصلاحيات.
========================================================= */

app.get(
    "/api/admin/my-permissions",
    requireAuth,
    (req, res) => {

        if (!req.user) {
            return res.status(401).json({
                ok: false,
                message: "غير مصادق."
            });
        }

        const userId =
            Number(req.user.id);

        const user =
            one(
                `SELECT id, username, name, role, is_admin, status
                 FROM users
                 WHERE id=?`,
                [userId]
            );

        if (!user) {
            return res.status(404).json({
                ok: false,
                message: "المستخدم غير موجود."
            });
        }

        /*
         * مدير النظام يمتلك جميع الصلاحيات.
         */
        if (user.role === "system_manager") {

            const permissions =
                ADMIN_PERMISSIONS.map(
                    permission => ({
                        permission,
                        allowed: 1
                    })
                );

            return res.json({
                ok: true,
                user,
                permissions
            });
        }

        /*
         * المشرف العادي فقط.
         */
        if (
            user.role !== "admin" ||
            Number(user.is_admin) !== 1
        ) {
            return res.status(403).json({
                ok: false,
                message:
                    "هذا المسار متاح للمشرفين فقط."
            });
        }

        ensureUserPermissions(userId);

        const permissions =
            all(
                `SELECT
                     CASE
                         WHEN permission_key IS NOT NULL
                              AND permission_key <> ''
                         THEN permission_key
                         ELSE permission
                     END AS permission,
                     allowed
                 FROM user_permissions
                 WHERE user_id=?
                   AND (
                       (permission_key IS NOT NULL AND permission_key <> '')
                       OR
                       (permission IS NOT NULL AND permission <> '')
                   )
                 ORDER BY permission`,
                [userId]
            );

        res.json({
            ok: true,
            user,
            permissions
        });
    }
);

/* =========================================================
   صلاحيات المشرفين
========================================================= */

app.get(
    "/api/system-manager/supervisors/:id/permissions",
    requireAuth,
    requireSystemManager,
    (req, res) => {

        const userId =
            Number(req.params.id);

        const user =
            one(
                `SELECT id, username, name, role, is_admin, status
                 FROM users
                 WHERE id=?`,
                [userId]
            );

        if (!user) {
            return res.status(404).json({
                ok: false,
                message: "المشرف غير موجود."
            });
        }

        if (
            user.role !== "admin" ||
            Number(user.is_admin) !== 1
        ) {
            return res.status(400).json({
                ok: false,
                message: "الحساب المحدد ليس مشرفاً."
            });
        }

        ensureUserPermissions(userId);

        const permissions =
            all(
                `SELECT permission_key AS permission, allowed
                 FROM user_permissions
                 WHERE user_id=?
                 ORDER BY permission_key`,
                [userId]
            );

        res.json({
            ok: true,
            user,
            permissions
        });
    }
);

app.put(
    "/api/system-manager/supervisors/:id/permissions",
    requireAuth,
    requireSystemManager,
    (req, res) => {

        const userId =
            Number(req.params.id);

        const user =
            one(
                `SELECT id, username, name, role, is_admin
                 FROM users
                 WHERE id=?`,
                [userId]
            );

        if (!user) {
            return res.status(404).json({
                ok: false,
                message: "المشرف غير موجود."
            });
        }

        if (
            user.role !== "admin" ||
            Number(user.is_admin) !== 1
        ) {
            return res.status(400).json({
                ok: false,
                message: "يمكن تعديل صلاحيات المشرفين فقط."
            });
        }

        const incoming =
            Array.isArray(req.body?.permissions)
                ? req.body.permissions
                : [];

        const allowedNames = new Set(
            ADMIN_PERMISSIONS
        );

        for (const item of incoming) {

            const permission =
                String(
                    item?.permission || ""
                );

            if (!allowedNames.has(permission)) {
                continue;
            }

            const allowed =
                item?.allowed ? 1 : 0;

            const existingPermission =
                one(
                    `SELECT id
                     FROM user_permissions
                     WHERE user_id=?
                       AND (
                           permission_key=?
                           OR permission=?
                       )
                     LIMIT 1`,
                    [
                        userId,
                        permission,
                        permission
                    ]
                );

            if (existingPermission) {

                run(
                    `UPDATE user_permissions
                     SET permission=?,
                         permission_key=?,
                         allowed=?,
                         updated_at=?
                     WHERE id=?`,
                    [
                        permission,
                        permission,
                        allowed,
                        now(),
                        existingPermission.id
                    ]
                );

            } else {

                run(
                    `INSERT INTO user_permissions
                     (user_id, permission, allowed, updated_at, permission_key, created_at)
                     VALUES(?,?,?,?,?,?)`,
                    [
                        userId,
                        permission,
                        allowed,
                        now(),
                        permission,
                        now()
                    ]
                );
            }
        }

        ensureUserPermissions(userId);

        saveDatabase();

        audit(
            req.user.id,
            "update_supervisor_permissions",
            String(userId)
        );

        res.json({
            ok: true,
            message:
                "تم حفظ صلاحيات المشرف بنجاح."
        });
    }
);

/* حذف مشرف */

app.delete(
    "/api/system-manager/supervisors/:id",
    requireAuth,
    requireSystemManager,
    (req, res) => {

        const id =
            Number(req.params.id);

        if (
            !Number.isInteger(id) ||
            id <= 0
        ) {

            return res.status(400).json({
                ok: false,
                message:
                    "معرف المستخدم غير صحيح."
            });
        }

        if (id === Number(req.user.id)) {

            return res.status(403).json({
                ok: false,
                message:
                    "لا يمكن لمدير النظام حذف حسابه."
            });
        }

        const target =
            one(
                `SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status
                 FROM users
                 WHERE id=?`,
                [id]
            );

        if (!target) {

            return res.status(404).json({
                ok: false,
                message:
                    "المستخدم غير موجود."
            });
        }

        if (target.role === "system_manager") {

            return res.status(403).json({
                ok: false,
                message:
                    "لا يمكن حذف مدير النظام."
            });
        }

        if (
            target.role !== "admin" ||
            Number(target.is_admin) !== 1
        ) {

            return res.status(400).json({
                ok: false,
                message:
                    "هذا المسار مخصص لحذف المشرفين فقط."
            });
        }

        run(
            "DELETE FROM users WHERE id=?",
            [id]
        );

        saveDatabase();

        audit(
            req.user.id,
            "delete_supervisor",
            String(target.username)
        );

        res.json({
            ok: true,
            message:
                "تم حذف المشرف بنجاح."
        });
    }
);

/* =========================================================
   فتح رسالة مؤقتة مرة واحدة
========================================================= */

app.post(
    "/api/messages/:id/view-once",
    requireAuth,
    (req, res) => {

        const id =
            Number(req.params.id);

        if (!Number.isInteger(id)) {

            return res.status(400).json({
                message:
                    "معرف الرسالة غير صحيح."
            });
        }

        const message =
            one(
                "SELECT * FROM messages WHERE id=?",
                [id]
            );

        if (!message) {

            return res.status(404).json({
                message:
                    "الرسالة غير موجودة."
            });
        }

        if (
            Number(message.receiver_id) !==
            Number(req.user.id)
        ) {

            return res.status(403).json({
                message:
                    "لا يمكنك فتح هذه الرسالة."
            });
        }

        if (
            Number(message.view_once) !== 1
        ) {

            return res.status(400).json({
                message:
                    "هذه ليست رسالة مؤقتة."
            });
        }

        if (message.viewed_at) {

            return res.json({
                ok: true,
                already_viewed: true
            });
        }

        const viewedAt = now();

        run(
            `UPDATE messages
             SET viewed_at=?
             WHERE id=?`,
            [
                viewedAt,
                id
            ]
        );

        saveDatabase();

        res.json({
            ok: true,
            viewed_at: viewedAt
        });
    }
);

/* =========================================================
   المحادثات الجماعية
========================================================= */

app.get(
    "/api/groups",
    requireAuth,
    (req, res) => {

        try {

            const groups = all(
                `
                SELECT
                    g.id,
                    g.name,
                    g.description,
                    g.created_by,
                    g.created_at,
                    g.updated_at,
                    gm.role
                FROM groups g
                INNER JOIN group_members gm
                    ON gm.group_id = g.id
                WHERE gm.user_id=?
                ORDER BY g.updated_at DESC, g.id DESC
                `,
                [req.user.id]
            );

            res.json({
                ok: true,
                groups
            });

        } catch (error) {

            console.error(
                "[GROUPS] تعذر تحميل المجموعات:",
                error
            );

            res.status(500).json({
                ok: false,
                message:
                    "تعذر تحميل المحادثات الجماعية."
            });
        }
    }
);


/* =========================================================
   أعضاء المحادثة الجماعية
========================================================= */

app.get(
    "/api/groups/:groupId/members",
    requireAuth,
    (req, res) => {

        try {

            const groupId =
                String(req.params.groupId || "").trim();

            if (!groupId) {

                return res.status(400).json({
                    ok: false,
                    message:
                        "معرف المجموعة غير صحيح."
                });
            }

            const member =
                one(
                    `
                    SELECT id
                    FROM group_members
                    WHERE group_id=?
                      AND user_id=?
                    LIMIT 1
                    `,
                    [
                        groupId,
                        req.user.id
                    ]
                );

            if (!member) {

                return res.status(403).json({
                    ok: false,
                    message:
                        "ليس لديك صلاحية الوصول إلى أعضاء هذه المجموعة."
                });
            }

            const members =
                all(
                    `
                    SELECT
                        u.id,
                        u.username,
                        u.name,
                        u.status,
                        gm.role
                    FROM group_members gm
                    INNER JOIN users u
                        ON u.id = gm.user_id
                    WHERE gm.group_id=?
                    ORDER BY
                        CASE
                            WHEN gm.role='owner' THEN 0
                            WHEN gm.role='admin' THEN 1
                            ELSE 2
                        END,
                        u.name ASC,
                        u.username ASC
                    `,
                    [groupId]
                );

            res.json({
                ok: true,
                group_id: groupId,
                members
            });

        } catch (error) {

            console.error(
                "[GROUP MEMBERS] تعذر تحميل أعضاء المجموعة:",
                error
            );

            res.status(500).json({
                ok: false,
                message:
                    "تعذر تحميل أعضاء المجموعة."
            });
        }
    }
);


/* =========================================================
   إدارة المحادثات الجماعية
========================================================= */

/* إنشاء مجموعة */

app.post(
    "/api/groups",
    requireAuth,
    (req, res) => {

        try {

            const name =
                String(req.body?.name || "").trim();

            const description =
                String(req.body?.description || "").trim();

            if (!name) {
                return res.status(400).json({
                    ok: false,
                    message: "اسم المجموعة مطلوب."
                });
            }

            if (name.length > 100) {
                return res.status(400).json({
                    ok: false,
                    message: "اسم المجموعة طويل جدًا."
                });
            }

            const groupId =
                randomToken();

            const createdAt = now();

            run(
                `INSERT INTO groups
                 (
                    id,
                    name,
                    description,
                    created_by,
                    created_at,
                    updated_at
                 )
                 VALUES(?,?,?,?,?,?)`,
                [
                    groupId,
                    name,
                    description,
                    req.user.id,
                    createdAt,
                    createdAt
                ]
            );

            run(
                `INSERT INTO group_members
                 (
                    group_id,
                    user_id,
                    role,
                    joined_at
                 )
                 VALUES(?,?,?,?)`,
                [
                    groupId,
                    req.user.id,
                    "owner",
                    createdAt
                ]
            );

            audit(
                req.user.id,
                "group_create",
                `إنشاء مجموعة: ${name}`
            );

            saveDatabase();

            res.status(201).json({
                ok: true,
                group: {
                    id: groupId,
                    name,
                    description,
                    created_by: req.user.id,
                    role: "owner",
                    created_at: createdAt,
                    updated_at: createdAt
                }
            });

        } catch (error) {

            console.error(
                "[GROUP CREATE] تعذر إنشاء المجموعة:",
                error
            );

            res.status(500).json({
                ok: false,
                message: "تعذر إنشاء المجموعة."
            });
        }
    }
);


/* إضافة عضو إلى مجموعة */

app.post(
    "/api/groups/:groupId/members",
    requireAuth,
    (req, res) => {

        try {

            const groupId =
                String(req.params.groupId || "").trim();

            const userId =
                Number(req.body?.user_id);

            if (!groupId || !Number.isInteger(userId)) {
                return res.status(400).json({
                    ok: false,
                    message: "بيانات المجموعة أو العضو غير صحيحة."
                });
            }

            const requester =
                one(
                    `SELECT role
                     FROM group_members
                     WHERE group_id=?
                       AND user_id=?
                     LIMIT 1`,
                    [
                        groupId,
                        req.user.id
                    ]
                );

            if (
                !requester ||
                !["owner", "admin"].includes(requester.role)
            ) {
                return res.status(403).json({
                    ok: false,
                    message: "ليس لديك صلاحية إضافة أعضاء."
                });
            }

            const group =
                one(
                    `SELECT id, name
                     FROM groups
                     WHERE id=?
                     LIMIT 1`,
                    [groupId]
                );

            if (!group) {
                return res.status(404).json({
                    ok: false,
                    message: "المجموعة غير موجودة."
                });
            }

            const user =
                one(
                    `SELECT
                        id,
                        username,
                        name,
                        status
                     FROM users
                     WHERE id=?
                     LIMIT 1`,
                    [userId]
                );

            if (!user) {
                return res.status(404).json({
                    ok: false,
                    message: "المستخدم غير موجود."
                });
            }

            if (
                user.status === "blocked" ||
                user.status === "frozen"
            ) {
                return res.status(403).json({
                    ok: false,
                    message: "لا يمكن إضافة هذا المستخدم حاليًا."
                });
            }

            const existing =
                one(
                    `SELECT id
                     FROM group_members
                     WHERE group_id=?
                       AND user_id=?
                     LIMIT 1`,
                    [
                        groupId,
                        userId
                    ]
                );

            if (existing) {
                return res.status(409).json({
                    ok: false,
                    message: "المستخدم موجود بالفعل في المجموعة."
                });
            }

            const joinedAt = now();

            run(
                `INSERT INTO group_members
                 (
                    group_id,
                    user_id,
                    role,
                    joined_at
                 )
                 VALUES(?,?,?,?)`,
                [
                    groupId,
                    userId,
                    "member",
                    joinedAt
                ]
            );

            run(
                `UPDATE groups
                 SET updated_at=?
                 WHERE id=?`,
                [
                    joinedAt,
                    groupId
                ]
            );

            audit(
                req.user.id,
                "group_add_member",
                `إضافة المستخدم ${userId} إلى المجموعة ${groupId}`
            );

            saveDatabase();

            res.status(201).json({
                ok: true,
                member: {
                    id: user.id,
                    username: user.username,
                    name: user.name,
                    status: user.status,
                    role: "member",
                    joined_at: joinedAt
                }
            });

        } catch (error) {

            console.error(
                "[GROUP ADD MEMBER] تعذر إضافة العضو:",
                error
            );

            res.status(500).json({
                ok: false,
                message: "تعذر إضافة العضو."
            });
        }
    }
);


/* حذف عضو من مجموعة */

app.delete(
    "/api/groups/:groupId/members/:userId",
    requireAuth,
    (req, res) => {

        try {

            const groupId =
                String(req.params.groupId || "").trim();

            const userId =
                Number(req.params.userId);

            if (!groupId || !Number.isInteger(userId)) {
                return res.status(400).json({
                    ok: false,
                    message: "بيانات المجموعة أو العضو غير صحيحة."
                });
            }

            const requester =
                one(
                    `SELECT role
                     FROM group_members
                     WHERE group_id=?
                       AND user_id=?
                     LIMIT 1`,
                    [
                        groupId,
                        req.user.id
                    ]
                );

            if (
                !requester ||
                !["owner", "admin"].includes(requester.role)
            ) {
                return res.status(403).json({
                    ok: false,
                    message: "ليس لديك صلاحية حذف أعضاء."
                });
            }

            const target =
                one(
                    `SELECT
                        id,
                        role
                     FROM group_members
                     WHERE group_id=?
                       AND user_id=?
                     LIMIT 1`,
                    [
                        groupId,
                        userId
                    ]
                );

            if (!target) {
                return res.status(404).json({
                    ok: false,
                    message: "العضو غير موجود في المجموعة."
                });
            }

            if (target.role === "owner") {
                return res.status(403).json({
                    ok: false,
                    message: "لا يمكن حذف مالك المجموعة."
                });
            }

            if (
                requester.role === "admin" &&
                target.role === "admin"
            ) {
                return res.status(403).json({
                    ok: false,
                    message: "المشرف لا يستطيع حذف مشرف آخر."
                });
            }

            run(
                `DELETE FROM group_members
                 WHERE group_id=?
                   AND user_id=?`,
                [
                    groupId,
                    userId
                ]
            );

            run(
                `UPDATE groups
                 SET updated_at=?
                 WHERE id=?`,
                [
                    now(),
                    groupId
                ]
            );

            audit(
                req.user.id,
                "group_remove_member",
                `حذف المستخدم ${userId} من المجموعة ${groupId}`
            );

            saveDatabase();

            res.json({
                ok: true,
                message: "تم حذف العضو من المجموعة."
            });

        } catch (error) {

            console.error(
                "[GROUP REMOVE MEMBER] تعذر حذف العضو:",
                error
            );

            res.status(500).json({
                ok: false,
                message: "تعذر حذف العضو."
            });
        }
    }
);


/* =========================================================
   الرسائل
========================================================= */



app.get(
    "/api/messages/:userId",
    requireAuth,
    (req, res) => {

        const otherId =
            Number(req.params.userId);

        if (!Number.isInteger(otherId)) {

            return res.status(400).json({

                message:
                    "معرف المستخدم غير صحيح."
            });
        }

        const messages =
            all(
                `
                SELECT *
                FROM messages
                WHERE
                    (
                        sender_id=?
                        AND
                        receiver_id=?
                    )
                    OR
                    (
                        sender_id=?
                        AND
                        receiver_id=?
                    )
                    OR
                    (
                        group_id='ALL'
                        AND
                        message_type='broadcast'
                    )
                ORDER BY id ASC
                `,
                [
                    req.user.id,
                    otherId,
                    otherId,
                    req.user.id
                ]
            );

        const safeMessages =
            messages.map(message => {

                if (
                    Number(message.view_once) === 1 &&
                    message.viewed_at
                ) {

                    return {
                        ...message,
                        message:
                            "تم فتح الرسالة المؤقتة.",
                        attachment_name: "",
                        attachment_data: ""
                    };
                }

                return message;
            });

        res.json({
            messages: safeMessages
        });
    }
);


/* تسجيل تسليم الرسالة */

app.post(
    "/api/messages/:id/delivered",
    requireAuth,
    (req, res) => {

        const messageId =
            Number(req.params.id);

        if (!Number.isInteger(messageId)) {

            return res.status(400).json({
                message:
                    "معرف الرسالة غير صحيح."
            });
        }

        const message =
            one(
                `SELECT
                    id,
                    sender_id,
                    receiver_id,
                    delivered_at
                 FROM messages
                 WHERE id=?`,
                [messageId]
            );

        if (!message) {

            return res.status(404).json({
                message:
                    "الرسالة غير موجودة."
            });
        }

        if (
            Number(message.receiver_id) !==
            Number(req.user.id)
        ) {

            return res.status(403).json({
                message:
                    "غير مصرح بتسجيل تسليم هذه الرسالة."
            });
        }

        if (!message.delivered_at) {

            const deliveredAt = now();

            run(
                `UPDATE messages
                 SET delivered_at=?
                 WHERE id=?
                   AND receiver_id=?
                   AND delivered_at IS NULL`,
                [
                    deliveredAt,
                    messageId,
                    req.user.id
                ]
            );

            saveDatabase();
        }

        const updated =
            one(
                `SELECT
                    id,
                    sender_id,
                    receiver_id,
                    delivered_at
                 FROM messages
                 WHERE id=?`,
                [messageId]
            );

        res.json({
            ok: true,
            message: updated
        });
    }
);

/* =========================================================
   مفاتيح التشفير الطرفي E2EE
   المفتاح الخاص لا يصل إلى الخادم.
   الخادم يحتفظ بالمفتاح العام فقط.
========================================================= */

app.post(
    "/api/encryption-keys",
    requireAuth,
    (req, res) => {
        try {
            const publicKey =
                String(req.body?.public_key || "").trim();

            const deviceId =
                String(
                    req.body?.device_id ||
                    deviceIdFromRequest(req) ||
                    ""
                ).trim().slice(0, 200);

            if (!publicKey) {
                return res.status(400).json({
                    ok: false,
                    message: "المفتاح العام مطلوب."
                });
            }

            if (!deviceId) {
                return res.status(400).json({
                    ok: false,
                    message: "معرف الجهاز مطلوب."
                });
            }

            if (publicKey.length > 10000) {
                return res.status(400).json({
                    ok: false,
                    message: "المفتاح العام غير صالح."
                });
            }

            const existing =
                one(
                    `SELECT id
                     FROM encryption_keys
                     WHERE user_id=? AND device_id=?`,
                    [
                        req.user.id,
                        deviceId
                    ]
                );

            const updatedAt = now();

            if (existing) {
                run(
                    `UPDATE encryption_keys
                     SET public_key=?,
                         updated_at=?
                     WHERE user_id=? AND device_id=?`,
                    [
                        publicKey,
                        updatedAt,
                        req.user.id,
                        deviceId
                    ]
                );
            } else {
                run(
                    `INSERT INTO encryption_keys
                     (
                        user_id,
                        device_id,
                        public_key,
                        created_at,
                        updated_at
                     )
                     VALUES(?,?,?,?,?)`,
                    [
                        req.user.id,
                        deviceId,
                        publicKey,
                        updatedAt,
                        updatedAt
                    ]
                );
            }

            saveDatabase();

            return res.json({
                ok: true,
                message: "تم تسجيل مفتاح التشفير العام."
            });

        } catch (error) {
            console.error(
                "[E2EE] register public key:",
                error
            );

            return res.status(500).json({
                ok: false,
                message: "تعذر تسجيل مفتاح التشفير."
            });
        }
    }
);

app.get(
    "/api/encryption-keys/:userId",
    requireAuth,
    (req, res) => {
        try {
            const userId =
                Number(req.params.userId);

            if (!Number.isInteger(userId) || userId <= 0) {
                return res.status(400).json({
                    ok: false,
                    message: "معرف المستخدم غير صالح."
                });
            }

            const user =
                one(
                    `SELECT id
                     FROM users
                     WHERE id=?`,
                    [userId]
                );

            if (!user) {
                return res.status(404).json({
                    ok: false,
                    message: "المستخدم غير موجود."
                });
            }

            const keys =
                all(
                    `SELECT
                        device_id,
                        public_key,
                        updated_at
                     FROM encryption_keys
                     WHERE user_id=?
                     ORDER BY updated_at DESC`,
                    [userId]
                );

            return res.json({
                ok: true,
                keys
            });

        } catch (error) {
            console.error(
                "[E2EE] get public keys:",
                error
            );

            return res.status(500).json({
                ok: false,
                message: "تعذر جلب مفتاح التشفير."
            });
        }
    }
);

app.post(
    "/api/messages",
    requireAuth,
    (req, res) => {

        const receiverId =
            Number(
                req.body?.receiver_id
            );

        const groupId =
            String(
                req.body?.group_id || ""
            ).trim();

        const message =
            String(
                req.body?.message || ""
            );

        const type =
            String(
                req.body?.message_type ||
                "text"
            );

        const viewOnce =
            req.body?.view_once === true ||
            req.body?.view_once === 1 ||
            req.body?.view_once === "1"
                ? 1
                : 0;

        /*
         * E2EE اختياري:
         * التشفير الفعلي يتم في جهاز المستخدم.
         * الخادم يحفظ النص المشفر فقط.
         */
        const isEncrypted =
            req.body?.is_encrypted === true ||
            req.body?.is_encrypted === 1 ||
            req.body?.is_encrypted === "1"
                ? 1
                : 0;

        const encryptionIv =
            String(
                req.body?.encryption_iv || ""
            ).trim();

        const encryptionVersion =
            String(
                req.body?.encryption_version || ""
            ).trim();

        const encryptionSenderKey =
            String(
                req.body?.encryption_sender_key || ""
            ).trim();

        if (isEncrypted && groupId) {
            return res.status(400).json({
                message:
                    "الرسائل المشفرة الاختيارية متاحة للمحادثات الخاصة فقط."
            });
        }

        if (
            isEncrypted &&
            (
                type !== "text" ||
                !encryptionIv ||
                !encryptionVersion ||
                !encryptionSenderKey
            )
        ) {
            return res.status(400).json({
                message:
                    "بيانات الرسالة المشفرة غير مكتملة."
            });
        }

        if (
            (!Number.isInteger(receiverId) && !groupId) ||
            !message.trim()
        ) {

            return res.status(400).json({
                message:
                    groupId
                        ? "الرسالة مطلوبة."
                        : "المستلم والرسالة مطلوبان."
            });
        }

        if (
            Number.isInteger(receiverId) &&
            groupId
        ) {

            return res.status(400).json({
                message:
                    "حدد مستخدماً أو مجموعة فقط."
            });
        }

        let receiver = null;

        if (groupId) {

            const group =
                one(
                    "SELECT * FROM groups WHERE id=?",
                    [groupId]
                );

            if (!group) {

                return res.status(404).json({
                    message:
                        "المجموعة غير موجودة."
                });
            }

            const member =
                one(
                    `SELECT id
                     FROM group_members
                     WHERE group_id=?
                       AND user_id=?
                     LIMIT 1`,
                    [
                        groupId,
                        req.user.id
                    ]
                );

            if (!member) {

                return res.status(403).json({
                    message:
                        "ليس لديك صلاحية الإرسال إلى هذه المجموعة."
                });
            }

        } else {

            receiver =
                one(
                    "SELECT * FROM users WHERE id=?",
                    [receiverId]
                );

            if (!receiver) {

                return res.status(404).json({
                    message:
                        "المستخدم المستلم غير موجود."
                });
            }

            if (
                receiver.status !==
                "active"
            ) {

                return res.status(403).json({
                    message:
                        "لا يمكن إرسال الرسالة إلى مستخدم غير نشط."
                });
            }
        }

        const createdAt = now();

        run(
            `INSERT INTO messages
             (
                sender_id,
                receiver_id,
                group_id,
                message,
                message_type,
                view_once,
                viewed_at,
                created_at,
                is_encrypted,
                encryption_iv,
                encryption_version,
                encryption_sender_key
             )
             VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?)`,
            [
                req.user.id,
                groupId
                    ? null
                    : receiverId,
                groupId || null,
                message,
                type,
                viewOnce,
                createdAt,
                isEncrypted,
                isEncrypted ? encryptionIv : "",
                isEncrypted ? encryptionVersion : "",
                isEncrypted ? encryptionSenderKey : ""
            ]
        );

        saveDatabase();

        let savedMessage;

        if (groupId) {

            savedMessage =
                one(
                    `SELECT
                        m.id,
                        m.sender_id,
                        m.receiver_id,
                        m.group_id,
                        m.message,
                        m.message_type,
                        m.view_once,
                        m.viewed_at,
                        m.delivered_at,
                        m.created_at,
                        u.username AS sender_username,
                        u.name AS sender_name
                     FROM messages m
                     INNER JOIN users u
                        ON u.id=m.sender_id
                     WHERE m.sender_id=?
                       AND m.group_id=?
                       AND m.message=?
                       AND m.message_type=?
                       AND m.created_at=?
                     ORDER BY m.id DESC
                     LIMIT 1`,
                    [
                        req.user.id,
                        groupId,
                        message,
                        type,
                        createdAt
                    ]
                );

        } else {

            savedMessage =
                one(
                    `SELECT
                        id,
                        sender_id,
                        receiver_id,
                        group_id,
                        message,
                        message_type,
                        view_once,
                        viewed_at,
                        delivered_at,
                        created_at,
                        is_encrypted,
                        encryption_iv,
                        encryption_version,
                        encryption_sender_key
                     FROM messages
                     WHERE sender_id=?
                       AND receiver_id=?
                       AND message=?
                       AND message_type=?
                       AND created_at=?
                     ORDER BY id DESC
                     LIMIT 1`,
                    [
                        req.user.id,
                        receiverId,
                        message,
                        type,
                        createdAt
                    ]
                );

            if (!savedMessage) {

                savedMessage =
                    one(
                        `SELECT
                            id,
                            sender_id,
                            receiver_id,
                            group_id,
                            message,
                            message_type,
                            created_at,
                            is_encrypted,
                            encryption_iv,
                            encryption_version,
                            encryption_sender_key
                         FROM messages
                         WHERE sender_id=?
                           AND receiver_id=?
                         ORDER BY id DESC
                         LIMIT 1`,
                        [
                            req.user.id,
                            receiverId
                        ]
                    );
            }
        }

        if (!savedMessage) {

            return res.status(500).json({
                message:
                    "تم حفظ الرسالة ولكن تعذر قراءة بياناتها بعد الحفظ."
            });
        }

        res.status(201).json({

            ok: true,

            message:
                savedMessage,

            data:
                savedMessage
        });
    }
);

/* =========================================================
   رسائل المحادثة الجماعية
========================================================= */

app.get(
    "/api/groups/:groupId/messages",
    requireAuth,
    (req, res) => {

        try {

            const groupId =
                String(
                    req.params.groupId || ""
                ).trim();

            if (!groupId) {

                return res.status(400).json({
                    ok: false,
                    message:
                        "معرف المجموعة غير صحيح."
                });
            }

            const member =
                one(
                    `SELECT id
                     FROM group_members
                     WHERE group_id=?
                       AND user_id=?
                     LIMIT 1`,
                    [
                        groupId,
                        req.user.id
                    ]
                );

            if (!member) {

                return res.status(403).json({
                    ok: false,
                    message:
                        "ليس لديك صلاحية الوصول إلى هذه المجموعة."
                });
            }

            const messages =
                all(
                    `SELECT
                        m.*,
                        u.username AS sender_username,
                        u.name AS sender_name
                     FROM messages m
                     INNER JOIN users u
                        ON u.id=m.sender_id
                     WHERE m.group_id=?
                     ORDER BY m.id ASC
                     LIMIT 500`,
                    [groupId]
                );

            res.json({
                ok: true,
                group_id: groupId,
                messages
            });

        } catch (error) {

            console.error(
                "[GROUP MESSAGES]",
                error
            );

            res.status(500).json({
                ok: false,
                message:
                    "تعذر تحميل رسائل المجموعة."
            });
        }
    }
);

/* =========================================================
   حفظ الموقع
========================================================= */

app.post(
    "/api/location",
    requireAuth,
    (req, res) => {

        const latitude =
            Number(
                req.body?.latitude
            );

        const longitude =
            Number(
                req.body?.longitude
            );

        const accuracy =
            Number(
                req.body?.accuracy || 0
            );

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude)
        ) {

            return res.status(400).json({

                message:
                    "إحداثيات الموقع غير صحيحة."
            });
        }

        run(
            `INSERT INTO locations
             (
                user_id,
                latitude,
                longitude,
                accuracy,
                captured_at,
                created_at
             )
             VALUES(?,?,?,?,?,?)`,
            [
                req.user.id,
                latitude,
                longitude,
                Number.isFinite(accuracy)
                    ? accuracy
                    : null,
                req.body?.captured_at ||
                    now(),
                now()
            ]
        );

        saveDatabase();

        res.json({

            ok: true,

            message:
                "تم حفظ الموقع."
        });
    }
);

/* =========================================================
   مواقع المستخدمين للمشرف
========================================================= */



  /* =========================================================
     معلومات أجهزة المستخدمين
  ========================================================= */

  app.post(
      "/api/device-info",
      requireAuth,
      (req, res) => {

          try {

              const body = req.body || {};
              const connection = body.connection || {};
              const battery = body.battery || {};

              const deviceId =
                  String(
                      body.device_id ||
                      req.deviceSerial ||
                      ""
                  ).slice(0, 300);

              const userAgent =
                  String(
                      body.user_agent || ""
                  ).slice(0, 1000);

              const platform =
                  String(
                      body.platform || ""
                  ).slice(0, 300);

              const language =
                  String(
                      body.language || ""
                  ).slice(0, 100);

              const screen =
                  String(
                      body.screen || ""
                  ).slice(0, 100);

              const timezone =
                  String(
                      body.timezone || ""
                  ).slice(0, 150);

              const online =
                  body.online ? 1 : 0;

              const connectionType =
                  String(
                      connection.type || ""
                  ).slice(0, 100);

              const effectiveType =
                  String(
                      connection.effectiveType || ""
                  ).slice(0, 100);

              const downlinkValue =
                  Number(connection.downlink);

              const downlink =
                  Number.isFinite(downlinkValue)
                      ? downlinkValue
                      : null;

              const rttValue =
                  Number(connection.rtt);

              const rtt =
                  Number.isFinite(rttValue)
                      ? rttValue
                      : null;

              const saveData =
                  connection.saveData ? 1 : 0;

              let batteryLevel = null;

              if (
                  battery.level !== null &&
                  battery.level !== undefined &&
                  battery.level !== ""
              ) {

                  const value =
                      Number(battery.level);

                  if (Number.isFinite(value)) {
                      batteryLevel =
                          Math.max(
                              0,
                              Math.min(
                                  100,
                                  Math.round(value)
                              )
                          );
                  }
              }

              let batteryCharging = null;

              if (
                  typeof battery.charging ===
                  "boolean"
              ) {
                  batteryCharging =
                      battery.charging ? 1 : 0;
              }

              const chargingTime =
                  Number(
                      battery.chargingTime
                  );

              const dischargingTime =
                  Number(
                      battery.dischargingTime
                  );

              const batteryChargingTime =
                  Number.isFinite(chargingTime)
                      ? chargingTime
                      : null;

              const batteryDischargingTime =
                  Number.isFinite(dischargingTime)
                      ? dischargingTime
                      : null;

              const updatedAt = now();

              run(
                  `
                  INSERT INTO user_device_info (
                      user_id,
                      device_id,
                      user_agent,
                      platform,
                      language,
                      screen,
                      timezone,
                      online,
                      connection_type,
                      effective_type,
                      downlink,
                      rtt,
                      save_data,
                      battery_level,
                      battery_charging,
                      battery_charging_time,
                      battery_discharging_time,
                      sim_status,
                      updated_at
                  )
                  VALUES (
                      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                      ?, ?, ?, ?, ?, ?, ?, ?, ?
                  )
                  ON CONFLICT(user_id)
                  DO UPDATE SET
                      device_id =
                          excluded.device_id,
                      user_agent =
                          excluded.user_agent,
                      platform =
                          excluded.platform,
                      language =
                          excluded.language,
                      screen =
                          excluded.screen,
                      timezone =
                          excluded.timezone,
                      online =
                          excluded.online,
                      connection_type =
                          excluded.connection_type,
                      effective_type =
                          excluded.effective_type,
                      downlink =
                          excluded.downlink,
                      rtt =
                          excluded.rtt,
                      save_data =
                          excluded.save_data,
                      battery_level =
                          excluded.battery_level,
                      battery_charging =
                          excluded.battery_charging,
                      battery_charging_time =
                          excluded.battery_charging_time,
                      battery_discharging_time =
                          excluded.battery_discharging_time,
                      sim_status =
                          excluded.sim_status,
                      updated_at =
                          excluded.updated_at
                  `,
                  [
                      req.user.id,
                      deviceId,
                      userAgent,
                      platform,
                      language,
                      screen,
                      timezone,
                      online,
                      connectionType,
                      effectiveType,
                      downlink,
                      rtt,
                      saveData,
                      batteryLevel,
                      batteryCharging,
                      batteryChargingTime,
                      batteryDischargingTime,
                      "غير متاح من المتصفح",
                      updatedAt
                  ]
              );

              saveDatabase();

              res.json({
                  ok: true,
                  updated_at: updatedAt
              });

          } catch (error) {

              console.error(
                  "DEVICE_INFO_SAVE_ERROR:",
                  error
              );

              res.status(500).json({
                  ok: false,
                  error: "DEVICE_INFO_SAVE_FAILED",
                  message:
                      "تعذر حفظ معلومات الجهاز."
              });
          }
      }
  );


  app.get(
      "/api/admin/users/:id/device-info",
      requireAuth,
      requireAdmin,
      (req, res) => {

          try {

              const userId =
                  Number(req.params.id);

              if (
                  !Number.isInteger(userId) ||
                  userId <= 0
              ) {

                  return res.status(400).json({
                      ok: false,
                      message:
                          "معرف المستخدم غير صحيح."
                  });
              }

              const user =
                  one(
                      `
                      SELECT
                          id,
                          username,
                          name,
                          role,
                          is_admin,
                          status,
                          device_serial,
                          created_at,
                          updated_at
                      FROM users
                      WHERE id=?
                      `,
                      [userId]
                  );

              if (!user) {

                  return res.status(404).json({
                      ok: false,
                      message:
                          "المستخدم غير موجود."
                  });
              }

              const device =
                  one(
                      `
                      SELECT *
                      FROM user_device_info
                      WHERE user_id=?
                      `,
                      [userId]
                  );

              res.json({
                  ok: true,
                  user,
                  device: device || null
              });

          } catch (error) {

              console.error(
                  "DEVICE_INFO_ADMIN_ERROR:",
                  error
              );

              res.status(500).json({
                  ok: false,
                  error:
                      "DEVICE_INFO_ADMIN_FAILED",
                  message:
                      "تعذر جلب معلومات الجهاز."
              });
          }
      }
  );


/* =========================================================
   حالة GPS للمستخدم
========================================================= */

app.post(
    "/api/location/status",
    requireAuth,
    (req, res) => {

        const allowedStatuses = [
            "active",
            "denied",
            "unavailable"
        ];

        const status =
            String(
                req.body?.status || ""
            ).trim();

        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                ok: false,
                message:
                    "حالة GPS غير صحيحة."
            });
        }

        run(
            `INSERT INTO location_status
             (
                user_id,
                status,
                captured_at,
                created_at
             )
             VALUES(?,?,?,?)`,
            [
                req.user.id,
                status,
                req.body?.captured_at ||
                    now(),
                now()
            ]
        );

        saveDatabase();

        res.json({
            ok: true,
            status
        });
    }
);


app.get(
    "/api/admin/locations",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const rows =
            all(
                `
                SELECT
                    l.id,
                    l.user_id,
                    l.latitude,
                    l.longitude,
                    l.accuracy,
                    l.captured_at,
                    l.created_at,
                    u.username,
                    u.name,
                    u.device_serial,
                    (
                        SELECT ls.status
                        FROM location_status ls
                        WHERE ls.user_id=l.user_id
                        ORDER BY ls.id DESC
                        LIMIT 1
                    ) AS gps_status,
                    (
                        SELECT ls.captured_at
                        FROM location_status ls
                        WHERE ls.user_id=l.user_id
                        ORDER BY ls.id DESC
                        LIMIT 1
                    ) AS gps_status_captured_at
                FROM locations l
                LEFT JOIN users u
                    ON u.id=l.user_id
                WHERE l.id IN
                    (
                        SELECT MAX(id)
                        FROM locations
                        GROUP BY user_id
                    )
                ORDER BY l.id DESC
                `
            );

        res.json({
            locations: rows
        });
    }
);

/* =========================================================
   التحذيرات
========================================================= */

app.get(
    "/api/admin/warnings",
    requireAuth,
    requireAdmin,
    (req, res) => {

        res.json({

            warnings:
                all(
                    `
                    SELECT *
                    FROM warnings
                    ORDER BY id DESC
                    `
                )
        });
    }
);

/* =========================================================
   حذف محادثة
========================================================= */

app.delete(
    "/api/admin/conversations/:id",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const id =
            Number(req.params.id);

        if (!Number.isInteger(id)) {

            return res.status(400).json({

                message:
                    "معرف المستخدم غير صحيح."
            });
        }

        run(
            `
            DELETE FROM messages
            WHERE
                sender_id=?
                OR
                receiver_id=?
            `,
            [
                id,
                id
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "delete_conversation",
            String(id)
        );

        res.json({

            ok: true,

            message:
                "تم مسح محادثة المستخدم."
        });
    }
);

/* =========================================================
   النسخ الاحتياطي TXT
========================================================= */

app.get(
    "/api/admin/backup/conversations",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const rows =
            all(
                `
                SELECT
                    m.id,
                    m.sender_id,
                    m.receiver_id,
                    m.group_id,
                    m.message,
                    m.message_type,
                    m.attachment_name,
                    m.created_at,
                    su.username
                        AS sender_username,
                    ru.username
                        AS receiver_username
                FROM messages m
                LEFT JOIN users su
                    ON su.id=m.sender_id
                LEFT JOIN users ru
                    ON ru.id=m.receiver_id
                ORDER BY m.id ASC
                `
            );

        let output = "";

        output +=
            "SECURE MESSENGER V5.2 - CONVERSATIONS BACKUP\n";

        output +=
            "Generated: " +
            now() +
            "\n";

        output +=
            "============================================\n\n";

        for (const row of rows) {

            output +=
                `[${row.created_at}] ` +
                `${row.sender_username || row.sender_id} -> ` +
                `${row.receiver_username || row.receiver_id || row.group_id || "group"}\n`;

            output +=
                `Type: ${row.message_type}\n`;

            output +=
                `Message: ${row.message}\n`;

            if (row.attachment_name) {

                output +=
                    `Attachment: ${row.attachment_name}\n`;
            }

            output +=
                "--------------------------------------------\n";
        }

        audit(
            req.user.id,
            "backup_conversations",
            "TXT"
        );

        res
            .type("text/plain; charset=utf-8")
            .send(output);
    }
);

/* =========================================================
   بيانات الفريق
========================================================= */

app.get(
    "/api/admin/team",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const team =
            one(
                "SELECT * FROM team WHERE id=1"
            );

        const usersCount =
            one(
                `
                SELECT COUNT(*) AS count
                FROM users
                WHERE is_admin=0
                `
            );

        const totalCount =
            one(
                `
                SELECT COUNT(*) AS count
                FROM users
                `
            );

        res.json({

            team,

            users_count:
                Number(
                    usersCount?.count || 0
                ),

            total_count:
                Number(
                    totalCount?.count || 0
                )
        });
    }
);

/* تحديث بيانات الفريق */

app.put(
    "/api/admin/team",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const name =
            String(
                req.body?.name || ""
            ).trim();

        const mission =
            String(
                req.body?.mission || ""
            ).trim();

        run(
            `
            UPDATE team
            SET
                name=?,
                mission=?,
                updated_at=?
            WHERE id=1
            `,
            [
                name,
                mission,
                now()
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "update_team",
            name
        );

        res.json({

            ok: true,

            message:
                "تم حفظ بيانات الفريق."
        });
    }
);

/* =========================================================
   تحديث قاعدة البيانات
========================================================= */

app.post(
    "/api/admin/database/update",
    requireAuth,
    requireAdmin,
    (req, res) => {

        saveDatabase();

        audit(
            req.user.id,
            "database_update",
            "manual save"
        );

        res.json({

            ok: true,

            message:
                "تم تحديث وحفظ قاعدة البيانات."
        });
    }
);

/* =========================================================
   وضع التأهب
========================================================= */

/* =========================================================
   قفل التطبيق العام — المشرف فقط للتحكم
========================================================= */

app.get(
    "/api/app-lock",
    requireAuth,
    (req, res) => {
        const state = one(
            `SELECT app_lock FROM system_state WHERE id=1`
        );

        res.json({
            ok: true,
            app_lock: Number(state?.app_lock || 0) === 1
        });
    }
);

app.post(
    "/api/admin/app-lock",
    requireAuth,
    requireAdmin,
    (req, res) => {
        const locked =
            req.body?.locked === true ||
            req.body?.locked === 1 ||
            req.body?.locked === "1";

        run(
            `UPDATE system_state
             SET app_lock=?,
                 updated_at=?
             WHERE id=1`,
            [
                locked ? 1 : 0,
                now()
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            locked ? "app_lock_enabled" : "app_lock_disabled",
            locked ? "1" : "0"
        );

        res.json({
            ok: true,
            app_lock: locked,
            message: locked
                ? "تم قفل التطبيق للمستخدمين العاديين."
                : "تم إطلاق التطبيق وفك القفل."
        });
    }
);

app.get(
    "/api/alert-mode",
    requireAuth,
    (req, res) => {
        const state =
            one(
                `
                SELECT alert_mode
                FROM system_state
                WHERE id=1
                `
            );

        res.json({
            ok: true,
            alert_mode: Number(state?.alert_mode || 0) === 1
        });
    }
);

app.post(
    "/api/admin/alert-mode",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const current =
            one(
                `
                SELECT alert_mode
                FROM system_state
                WHERE id=1
                `
            );

        const next =
            current?.alert_mode
                ? 0
                : 1;

        run(
            `
            UPDATE system_state
            SET
                alert_mode=?,
                updated_at=?
            WHERE id=1
            `,
            [
                next,
                now()
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "alert_mode",
            String(next)
        );

        res.json({

            ok: true,

            alert_mode:
                next,

            message:
                next
                    ? "تم تفعيل وضع التأهب."
                    : "تم إيقاف وضع التأهب."
        });
    }
);

/* =========================================================
   الشبكة
========================================================= */

app.post(
    "/api/admin/network/off",
    requireAuth,
    requireAdmin,
    (req, res) => {

        run(
            `
            UPDATE system_state
            SET
                network_mode='offline',
                updated_at=?
            WHERE id=1
            `,
            [now()]
        );

        saveDatabase();

        audit(
            req.user.id,
            "network_off",
            ""
        );

        res.json({

            ok: true,

            message:
                "تم وضع النظام في حالة شبكة متوقفة."
        });
    }
);

/* إعادة تشغيل حالة النظام */

app.post(
    "/api/admin/system/restart",
    requireAuth,
    requireAdmin,
    (req, res) => {

        run(
            `
            UPDATE system_state
            SET
                network_mode='local',
                updated_at=?
            WHERE id=1
            `,
            [now()]
        );

        saveDatabase();

        audit(
            req.user.id,
            "system_restart_request",
            ""
        );

        res.json({

            ok: true,

            message:
                "تمت إعادة تهيئة حالة الشبكة. لا يتم إيقاف عملية Node تلقائياً."
        });
    }
);

/* =========================================================
   سجل العمليات
========================================================= */

app.get(
    "/api/admin/audit",
    requireAuth,
    requireAdmin,
    (req, res) => {

        res.json({

            audit:
                all(
                    `
                    SELECT
                        a.*,
                        u.username,
                        u.name
                    FROM audit a
                    LEFT JOIN users u
                        ON u.id=a.user_id
                    ORDER BY a.id DESC
                    LIMIT 1000
                    `
                )
        });
    }
);

/* =========================================================
   إرسال للجميع
========================================================= */

app.post(
    "/api/admin/broadcast",
    requireAuth,
    requireAdmin,
    (req, res) => {

        const message =
            String(
                req.body?.message || ""
            ).trim();

        if (!message) {

            return res.status(400).json({

                message:
                    "الرسالة فارغة."
            });
        }

        run(
            `INSERT INTO messages
             (
                sender_id,
                receiver_id,
                group_id,
                message,
                message_type,
                created_at
             )
             VALUES(?,NULL,'ALL',?,'broadcast',?)`,
            [
                req.user.id,
                message,
                now()
            ]
        );

        saveDatabase();

        audit(
            req.user.id,
            "broadcast",
            message.slice(0, 200)
        );

        res.json({

            ok: true,

            message:
                "تم تسجيل رسالة الإرسال للجميع."
        });
    }
);

/* =========================================================
   خدمة الواجهة
========================================================= */

app.use(
    express.static(PUBLIC_DIR)
);

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "index.html"
            )
        );
    }
);


/* =========================================================
   المرفقات: صور وصوت
========================================================= */

app.post(
    "/api/attachments",
    requireAuth,
    (req, res) => {

        try {

            const messageId =
                Number(
                    req.body?.message_id
                );

            const filename =
                String(
                    req.body?.filename || ""
                ).trim();

            const mimeType =
                String(
                    req.body?.mime_type ||
                    "application/octet-stream"
                ).trim();

            const dataBase64 =
                String(
                    req.body?.data_base64 || ""
                ).trim();

            if (
                !Number.isInteger(messageId) ||
                messageId <= 0
            ) {

                return res.status(400).json({
                    message:
                        "معرف الرسالة غير صحيح."
                });
            }

            if (!dataBase64) {

                return res.status(400).json({
                    message:
                        "بيانات المرفق فارغة."
                });
            }

            const message =
                one(
                    `SELECT
                        id,
                        sender_id,
                        receiver_id,
                        message_type
                     FROM messages
                     WHERE id=?`,
                    [messageId]
                );

            if (!message) {

                return res.status(404).json({
                    message:
                        "الرسالة غير موجودة."
                });
            }

            if (
                Number(message.sender_id) !==
                Number(req.user.id)
            ) {

                return res.status(403).json({
                    message:
                        "لا يسمح لك بتعديل هذا المرفق."
                });
            }

            let cleanBase64 =
                dataBase64;

            const commaIndex =
                cleanBase64.indexOf(",");

            if (commaIndex >= 0) {
                cleanBase64 =
                    cleanBase64.slice(
                        commaIndex + 1
                    );
            }

            run(
                `UPDATE messages
                 SET
                    attachment_name=?,
                    attachment_data=?
                 WHERE id=?`,
                [
                    filename.slice(0, 255),
                    cleanBase64,
                    messageId
                ]
            );

            saveDatabase();

            const saved =
                one(
                    `SELECT
                        id,
                        sender_id,
                        receiver_id,
                        group_id,
                        message,
                        message_type,
                        attachment_name,
                        created_at
                     FROM messages
                     WHERE id=?`,
                    [messageId]
                );

            res.json({
                ok: true,
                message:
                    "تم حفظ المرفق بنجاح.",
                data: saved
            });

        } catch (error) {

            console.error(
                "POST /api/attachments:",
                error
            );

            res.status(500).json({
                message:
                    "تعذر حفظ المرفق."
            });
        }
    }
);

/* =========================================================
   البيانات الشخصية للمستخدمين + تقارير المشرف
   إضافة مستقلة - لا تحذف أو تعطل أي وظيفة موجودة
========================================================= */



/* ---------------------------------------------------------
   بيانات المستخدم الشخصية
--------------------------------------------------------- */

app.get(
    "/api/me/personal-data",
    requireAuth,
    (req, res) => {

        try {

            const data = one(
                `
                SELECT
                    full_name,
                    military_number,
                    division,
                    unit,
                    nickname,
                    national_id,
                    job_title,
                    military_rank,
                    birth_date,
                    birthplace,
                    education,
                    phone,
                    current_residence,
                    personal_id_card_image,
                    military_id_card_image,
                    organization,
                    notes,
                    updated_at
                FROM user_personal_data
                WHERE user_id = ?
                `,
                [req.user.id]
            );

            res.json({
                ok: true,
                data: data || {
                    full_name: req.user.name || "",
                    military_number: "",
                    division: "",
                    unit: "",
                    nickname: "",
                    national_id: "",
                    job_title: "",
                    military_rank: "",
                    birth_date: "",
                    birthplace: "",
                    education: "",
                    phone: "",
                    current_residence: "",
                    personal_id_card_image: "",
                    military_id_card_image: "",
                    organization: "",
                    notes: "",
                    updated_at: null
                }
            });

        } catch (error) {

            console.error(
                "PERSONAL_DATA_GET_ERROR:",
                error
            );

            res.status(500).json({
                error: "PERSONAL_DATA_GET_FAILED",
                message: "تعذر تحميل البيانات الشخصية."
            });
        }
    }
);


/* ---------------------------------------------------------
   حفظ / تحديث بيانات المستخدم الشخصية
--------------------------------------------------------- */

app.post(
    "/api/me/personal-data",
    requireAuth,
    (req, res) => {

        try {

            const fullName =
                String(req.body?.full_name || "").trim();

            const militaryNumber =
                String(req.body?.military_number || "").trim();

            const division =
                String(req.body?.division || "").trim();

            const unit =
                String(req.body?.unit || "").trim();

            const nickname =
                String(req.body?.nickname || "").trim();

            const nationalId =
                String(req.body?.national_id || "").trim();

            const jobTitle =
                String(req.body?.job_title || "").trim();

            const militaryRank =
                String(req.body?.military_rank || "").trim();

            const birthDate =
                String(req.body?.birth_date || "").trim();

            const birthplace =
                String(req.body?.birthplace || "").trim();

            const education =
                String(req.body?.education || "").trim();

            const phone =
                String(req.body?.phone || "").trim();

            const currentResidence =
                String(req.body?.current_residence || "").trim();

            const personalIdCardImage =
                String(req.body?.personal_id_card_image || "");

            const militaryIdCardImage =
                String(req.body?.military_id_card_image || "");

            const organization =
                String(req.body?.organization || "").trim();

            const notes =
                String(req.body?.notes || "").trim();

            if (!fullName) {

                return res.status(400).json({
                    error: "FULL_NAME_REQUIRED",
                    message: "الاسم مطلوب."
                });
            }

            const updatedAt = now();

            const existing = one(
                `
                SELECT id
                FROM user_personal_data
                WHERE user_id = ?
                `,
                [req.user.id]
            );

            if (existing) {

                run(
                    `
                    UPDATE user_personal_data
                    SET
                        full_name = ?,
                        military_number = ?,
                        division = ?,
                        unit = ?,
                        nickname = ?,
                        national_id = ?,
                        job_title = ?,
                        military_rank = ?,
                        birth_date = ?,
                        birthplace = ?,
                        education = ?,
                        phone = ?,
                        current_residence = ?,
                        personal_id_card_image = ?,
                        military_id_card_image = ?,
                        organization = ?,
                        notes = ?,
                        updated_at = ?
                    WHERE user_id = ?
                    `,
                    [
                        fullName,
                        militaryNumber,
                        division,
                        unit,
                        nickname,
                        nationalId,
                        jobTitle,
                        militaryRank,
                        birthDate,
                        birthplace,
                        education,
                        phone,
                        currentResidence,
                        personalIdCardImage,
                        militaryIdCardImage,
                        organization,
                        notes,
                        updatedAt,
                        req.user.id
                    ]
                );

            } else {

                run(
                    `
                    INSERT INTO user_personal_data
                    (
                        user_id,
                        full_name,
                        military_number,
                        division,
                        unit,
                        nickname,
                        national_id,
                        job_title,
                        military_rank,
                        birth_date,
                        birthplace,
                        education,
                        phone,
                        current_residence,
                        personal_id_card_image,
                        military_id_card_image,
                        organization,
                        notes,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
                    [
                        req.user.id,
                        fullName,
                        militaryNumber,
                        division,
                        unit,
                        nickname,
                        nationalId,
                        jobTitle,
                        militaryRank,
                        birthDate,
                        birthplace,
                        education,
                        phone,
                        currentResidence,
                        personalIdCardImage,
                        militaryIdCardImage,
                        organization,
                        notes,
                        updatedAt
                    ]
                );
            }

            saveDatabase();

            res.json({
                ok: true,
                message: "تم حفظ البيانات الشخصية بنجاح.",
                data: {
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
                    personal_id_card_image: personalIdCardImage,
                    military_id_card_image: militaryIdCardImage,
                    organization: organization,
                    notes: notes,
                    updated_at: updatedAt
                }
            });

        } catch (error) {

            console.error(
                "PERSONAL_DATA_SAVE_ERROR:",
                error
            );

            res.status(500).json({
                error: "PERSONAL_DATA_SAVE_FAILED",
                message: "تعذر حفظ البيانات الشخصية."
            });
        }
    }
);


/* ---------------------------------------------------------
   تقرير بيانات المستخدمين - للمشرف فقط
--------------------------------------------------------- */

app.get(
    "/api/admin/user-reports",
    requireAuth,
    requireAdmin,
    (req, res) => {

        try {

            const type =
                String(req.query?.type || "all").trim();

            const search =
                String(req.query?.search || "").trim();

            const searchField =
                String(req.query?.searchField || "all").trim();

            const status =
                String(req.query?.status || "").trim();

            const role =
                String(req.query?.role || "").trim();

            const division =
                String(req.query?.division || "").trim();

            const unit =
                String(req.query?.unit || "").trim();

            const like = `%${search}%`;

            const conditions = [];
            const params = [];

            if (search) {

                if (searchField === "name") {

                    conditions.push(`
                        (
                            COALESCE(u.name, '') LIKE ?
                            OR COALESCE(p.full_name, '') LIKE ?
                        )
                    `);

                    params.push(like, like);

                } else if (searchField === "username") {

                    conditions.push(
                        `COALESCE(u.username, '') LIKE ?`
                    );

                    params.push(like);

                } else if (searchField === "military_number") {

                    conditions.push(
                        `COALESCE(p.military_number, '') LIKE ?`
                    );

                    params.push(like);

                } else if (searchField === "division") {

                    conditions.push(
                        `COALESCE(p.division, '') LIKE ?`
                    );

                    params.push(like);

                } else if (searchField === "unit") {

                    conditions.push(
                        `COALESCE(p.unit, '') LIKE ?`
                    );

                    params.push(like);

                } else {

                    conditions.push(`
                        (
                            COALESCE(u.name, '') LIKE ?
                            OR COALESCE(p.full_name, '') LIKE ?
                            OR COALESCE(u.username, '') LIKE ?
                            OR COALESCE(p.military_number, '') LIKE ?
                            OR COALESCE(p.division, '') LIKE ?
                            OR COALESCE(p.unit, '') LIKE ?
                        )
                    `);

                    params.push(
                        like,
                        like,
                        like,
                        like,
                        like,
                        like
                    );
                }
            }

            if (status) {

                conditions.push(
                    `COALESCE(u.status, 'active') = ?`
                );

                params.push(status);
            }

            if (role) {

                conditions.push(
                    `COALESCE(u.role, 'user') = ?`
                );

                params.push(role);
            }

            if (division) {

                conditions.push(
                    `COALESCE(p.division, '') = ?`
                );

                params.push(division);
            }

            if (unit) {

                conditions.push(
                    `COALESCE(p.unit, '') = ?`
                );

                params.push(unit);
            }

            const where =
                conditions.length
                    ? `WHERE ${conditions.join(" AND ")}`
                    : "";

            let rows = [];

            if (type === "credentials") {

                rows = all(
                    `
                    SELECT
                        u.id AS id,
                        u.name AS name,
                        u.username AS username,
                        u.status AS status,
                        u.role AS role,
                        u.created_at AS created_at,
                        CASE
                            WHEN u.password_hash IS NOT NULL
                                 AND u.password_hash <> ''
                            THEN 'محفوظة بشكل آمن'
                            ELSE 'غير متوفرة'
                        END AS password_status,

                        loc.latitude AS location_latitude,
                        loc.longitude AS location_longitude,
                        loc.accuracy AS location_accuracy,
                        loc.captured_at AS location_captured_at,
                        loc.created_at AS location_created_at

                    FROM users u

                    LEFT JOIN user_personal_data p
                        ON p.user_id = u.id

                    LEFT JOIN locations loc
                        ON loc.id = (
                            SELECT MAX(l2.id)
                            FROM locations l2
                            WHERE l2.user_id = u.id
                        )

                    ${where}
                    ORDER BY
                        COALESCE(u.name, ''),
                        COALESCE(u.username, '')
                    `,
                    params
                );

            } else {

                rows = all(
                    `
                    SELECT
                        u.id AS id,
                        COALESCE(
                            NULLIF(p.full_name, ''),
                            u.name,
                            ''
                        ) AS name,
                        u.username AS username,
                        COALESCE(
                            p.military_number,
                            ''
                        ) AS military_number,
                        COALESCE(
                            p.division,
                            ''
                        ) AS division,
                        COALESCE(
                            p.unit,
                            ''
                        ) AS unit,
                        COALESCE(
                            u.status,
                            'active'
                        ) AS status,
                        COALESCE(
                            u.role,
                            'user'
                        ) AS role,
                        u.created_at AS created_at,

                        loc.latitude AS location_latitude,
                        loc.longitude AS location_longitude,
                        loc.accuracy AS location_accuracy,
                        loc.captured_at AS location_captured_at,
                        loc.created_at AS location_created_at

                    FROM users u

                    LEFT JOIN user_personal_data p
                        ON p.user_id = u.id

                    LEFT JOIN locations loc
                        ON loc.id = (
                            SELECT MAX(l2.id)
                            FROM locations l2
                            WHERE l2.user_id = u.id
                        )

                    ${where}
                    ORDER BY
                        COALESCE(p.division, ''),
                        COALESCE(p.unit, ''),
                        COALESCE(p.full_name, ''),
                        COALESCE(u.name, ''),
                        COALESCE(u.username, '')
                    `,
                    params
                );
            }

            const divisions = all(
                `
                SELECT DISTINCT
                    TRIM(p.division) AS value
                FROM user_personal_data p
                WHERE TRIM(COALESCE(p.division, '')) <> ''
                ORDER BY value
                `
            )
                .map(row => row.value)
                .filter(Boolean);

            const units = all(
                `
                SELECT DISTINCT
                    TRIM(p.unit) AS value
                FROM user_personal_data p
                WHERE TRIM(COALESCE(p.unit, '')) <> ''
                ORDER BY value
                `
            )
                .map(row => row.value)
                .filter(Boolean);

            const statistics = {

                total:
                    one(
                        `SELECT COUNT(*) AS count FROM users`
                    )?.count || 0,

                active:
                    one(
                        `SELECT COUNT(*) AS count FROM users WHERE status = 'active'`
                    )?.count || 0,

                frozen:
                    one(
                        `SELECT COUNT(*) AS count FROM users WHERE status = 'frozen'`
                    )?.count || 0,

                blocked:
                    one(
                        `SELECT COUNT(*) AS count FROM users WHERE status = 'blocked'`
                    )?.count || 0,

                admins:
                    one(
                        `SELECT COUNT(*) AS count FROM users WHERE is_admin = 1 OR role = 'admin'`
                    )?.count || 0
            };

            res.json({
                ok: true,
                type,
                search,
                searchField,
                status,
                role,
                division,
                unit,
                count: rows.length,
                rows,
                divisions,
                units,
                statistics
            });

        } catch (error) {

            console.error(
                "ADMIN_USER_REPORT_ERROR:",
                error
            );

            res.status(500).json({
                error: "USER_REPORT_FAILED",
                message: "تعذر إنشاء التقرير."
            });
        }
    }
);

/* =========================================================
   حفظ قاعدة البيانات عند الإيقاف
========================================================= */

process.on(
    "SIGINT",
    () => {

        try {

            if (db) {
                saveDatabase();
            }

        } finally {

            process.exit(0);
        }
    }
);

process.on(
    "SIGTERM",
    () => {

        try {

            if (db) {
                saveDatabase();
            }

        } finally {

            process.exit(0);
        }
    }
);



/* =========================================================
   DUAL SERVER SYNC EXPORT
========================================================= */

app.get(
    "/api/internal/sync/export",
    (req, res) => {

        if (!syncAuthorized(req)) {
            return res.status(401).json({
                ok: false,
                error: "SYNC_UNAUTHORIZED"
            });
        }

        try {
            const payload = {
                ok: true,
                serverMode: SERVER_MODE,
                exportedAt: now(),

                users: all(`
                    SELECT
                        id,
                        username,
                        name,
                        password_hash,
                        role,
                        is_admin,
                        status,
                        device_serial,
                        created_at,
                        updated_at
                    FROM users
                    ORDER BY id
                `),

                messages: all(`
                    SELECT
                        id,
                        sender_id,
                        receiver_id,
                        group_id,
                        message,
                        message_type,
                        attachment_name,
                        attachment_data,
                        created_at,
                        view_once,
                        viewed_at
                    FROM messages
                    ORDER BY id
                `),

                locations: all(`
                    SELECT
                        id,
                        user_id,
                        latitude,
                        longitude,
                        accuracy,
                        captured_at,
                        created_at
                    FROM locations
                    ORDER BY id
                `),

                warnings: all(`
                    SELECT
                        id,
                        user_id,
                        username,
                        name,
                        device_serial,
                        message,
                        created_at
                    FROM warnings
                    ORDER BY id
                `),

                audit: all(`
                    SELECT
                        id,
                        user_id,
                        action,
                        details,
                        created_at
                    FROM audit
                    ORDER BY id
                `),

                team: all(`
                    SELECT
                        id,
                        name,
                        mission,
                        updated_at
                    FROM team
                    WHERE id = 1
                `),

                system_state: all(`
                    SELECT
                        id,
                        alert_mode,
                        network_mode,
                        network_name,
                        app_lock,
                        updated_at
                    FROM system_state
                    WHERE id = 1
                `),

                user_personal_data: all(`
                    SELECT
                        id,
                        user_id,
                        full_name,
                        military_number,
                        division,
                        unit,
                        updated_at
                    FROM user_personal_data
                    ORDER BY id
                `),

                groups: all(`
                    SELECT
                        id,
                        name,
                        description,
                        created_by,
                        created_at,
                        updated_at
                    FROM groups
                    ORDER BY id
                `),

                group_members: all(`
                    SELECT
                        id,
                        group_id,
                        user_id,
                        role,
                        joined_at
                    FROM group_members
                    ORDER BY id
                `),

            };

            return res.json(payload);

        } catch (error) {

            console.error(
                "SYNC EXPORT ERROR:",
                error
            );

            return res.status(500).json({
                ok: false,
                error: "SYNC_EXPORT_FAILED"
            });
        }
    }
);


/* =========================================================
   DUAL SERVER SYNC IMPORT
========================================================= */

app.post(
    "/api/internal/sync/import",
    express.json({ limit: "50mb" }),
    (req, res) => {

        if (!syncAuthorized(req)) {
            return res.status(401).json({
                ok: false,
                error: "SYNC_UNAUTHORIZED"
            });
        }

        const data = req.body;

        if (!data || data.ok !== true) {
            return res.status(400).json({
                ok: false,
                error: "INVALID_SYNC_PAYLOAD"
            });
        }

        try {

            const userMap = new Map();

            /*
             * المستخدمون:
             * المطابقة الأساسية بواسطة username
             */
            for (const sourceUser of data.users || []) {

                const existing = one(
                    "SELECT id FROM users WHERE username = ?",
                    [sourceUser.username]
                );

                if (existing) {

                    userMap.set(
                        Number(sourceUser.id),
                        Number(existing.id)
                    );

                    run(
                        `UPDATE users
                         SET name = ?,
                             password_hash = ?,
                             role = ?,
                             is_admin = ?,
                             status = ?,
                             device_serial = ?,
                             updated_at = ?
                         WHERE id = ?`,
                        [
                            sourceUser.name || "",
                            sourceUser.password_hash || "",
                            sourceUser.role || "user",
                            Number(sourceUser.is_admin || 0),
                            sourceUser.status || "active",
                            sourceUser.device_serial || "",
                            sourceUser.updated_at || now(),
                            Number(existing.id)
                        ]
                    );

                } else {

                    const result = run(
                        `INSERT INTO users (
                            username,
                            name,
                            password_hash,
                            role,
                            is_admin,
                            status,
                            device_serial,
                            created_at,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            sourceUser.username,
                            sourceUser.name || "",
                            sourceUser.password_hash || "",
                            sourceUser.role || "user",
                            Number(sourceUser.is_admin || 0),
                            sourceUser.status || "active",
                            sourceUser.device_serial || "",
                            sourceUser.created_at || now(),
                            sourceUser.updated_at || now()
                        ]
                    );

                    const created = one(
                        "SELECT id FROM users WHERE username = ?",
                        [sourceUser.username]
                    );

                    userMap.set(
                        Number(sourceUser.id),
                        Number(
                            created?.id ||
                            result?.lastInsertRowid ||
                            0
                        )
                    );
                }
            }

            /*
             * الرسائل
             */
            for (const m of data.messages || []) {

                const senderId =
                    userMap.get(Number(m.sender_id));

                if (!senderId) continue;

                const receiverId =
                    m.receiver_id == null
                        ? null
                        : (
                            userMap.get(
                                Number(m.receiver_id)
                            ) || null
                        );

                const duplicate = one(
                    `SELECT id
                     FROM messages
                     WHERE sender_id = ?
                       AND (
                           receiver_id = ?
                           OR (
                               receiver_id IS NULL
                               AND ? IS NULL
                           )
                       )
                       AND COALESCE(group_id, '') = COALESCE(?, '')
                       AND message = ?
                       AND created_at = ?
                     LIMIT 1`,
                    [
                        senderId,
                        receiverId,
                        receiverId,
                        m.group_id || "",
                        m.message || "",
                        m.created_at || ""
                    ]
                );

                if (duplicate) continue;

                run(
                    `INSERT INTO messages (
                        sender_id,
                        receiver_id,
                        group_id,
                        message,
                        message_type,
                        attachment_name,
                        attachment_data,
                        created_at,
                        view_once,
                        viewed_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        senderId,
                        receiverId,
                        m.group_id || null,
                        m.message || "",
                        m.message_type || "text",
                        m.attachment_name || "",
                        m.attachment_data || "",
                        m.created_at || now(),
                        Number(m.view_once || 0),
                        m.viewed_at || null
                    ]
                );
            }

            /*
             * المواقع
             */
            for (const item of data.locations || []) {

                const userId =
                    userMap.get(Number(item.user_id));

                if (!userId) continue;

                const duplicate = one(
                    `SELECT id
                     FROM locations
                     WHERE user_id = ?
                       AND latitude = ?
                       AND longitude = ?
                       AND created_at = ?
                     LIMIT 1`,
                    [
                        userId,
                        item.latitude,
                        item.longitude,
                        item.created_at || ""
                    ]
                );

                if (duplicate) continue;

                run(
                    `INSERT INTO locations (
                        user_id,
                        latitude,
                        longitude,
                        accuracy,
                        captured_at,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        item.latitude,
                        item.longitude,
                        item.accuracy,
                        item.captured_at || null,
                        item.created_at || now()
                    ]
                );
            }

            /*
             * التحذيرات
             */
            for (const item of data.warnings || []) {

                const userId =
                    item.user_id == null
                        ? null
                        : (
                            userMap.get(
                                Number(item.user_id)
                            ) || null
                        );

                const duplicate = one(
                    `SELECT id
                     FROM warnings
                     WHERE COALESCE(user_id, 0) = COALESCE(?, 0)
                       AND message = ?
                       AND created_at = ?
                     LIMIT 1`,
                    [
                        userId,
                        item.message || "",
                        item.created_at || ""
                    ]
                );

                if (duplicate) continue;

                run(
                    `INSERT INTO warnings (
                        user_id,
                        username,
                        name,
                        device_serial,
                        message,
                        created_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        item.username || "",
                        item.name || "",
                        item.device_serial || "",
                        item.message || "",
                        item.created_at || now()
                    ]
                );
            }

            /*
             * السجل الإداري
             */
            for (const item of data.audit || []) {

                const userId =
                    item.user_id == null
                        ? null
                        : (
                            userMap.get(
                                Number(item.user_id)
                            ) || null
                        );

                const duplicate = one(
                    `SELECT id
                     FROM audit
                     WHERE COALESCE(user_id, 0) = COALESCE(?, 0)
                       AND action = ?
                       AND details = ?
                       AND created_at = ?
                     LIMIT 1`,
                    [
                        userId,
                        item.action || "",
                        item.details || "",
                        item.created_at || ""
                    ]
                );

                if (duplicate) continue;

                run(
                    `INSERT INTO audit (
                        user_id,
                        action,
                        details,
                        created_at
                    )
                    VALUES (?, ?, ?, ?)`,
                    [
                        userId,
                        item.action || "",
                        item.details || "",
                        item.created_at || now()
                    ]
                );
            }

            /*
             * البيانات الشخصية
             */
            for (const item of data.user_personal_data || []) {

                const userId =
                    userMap.get(Number(item.user_id));

                if (!userId) continue;

                const existing = one(
                    `SELECT id
                     FROM user_personal_data
                     WHERE user_id = ?`,
                    [userId]
                );

                if (existing) {

                    run(
                        `UPDATE user_personal_data
                         SET full_name = ?,
                             military_number = ?,
                             division = ?,
                             unit = ?,
                             updated_at = ?
                         WHERE user_id = ?`,
                        [
                            item.full_name || "",
                            item.military_number || "",
                            item.division || "",
                            item.unit || "",
                            item.updated_at || now(),
                            userId
                        ]
                    );

                } else {

                    run(
                        `INSERT INTO user_personal_data (
                            user_id,
                            full_name,
                            military_number,
                            division,
                            unit,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            userId,
                            item.full_name || "",
                            item.military_number || "",
                            item.division || "",
                            item.unit || "",
                            item.updated_at || now()
                        ]
                    );
                }
            }

            /*
             * المجموعات
             */
            for (const group of data.groups || []) {

                const creatorId =
                    userMap.get(Number(group.created_by));

                if (!creatorId) continue;

                const existingGroup = one(
                    "SELECT id FROM groups WHERE id = ?",
                    [String(group.id)]
                );

                if (existingGroup) {

                    run(
                        `UPDATE groups
                         SET name = ?,
                             description = ?,
                             created_by = ?,
                             created_at = ?,
                             updated_at = ?
                         WHERE id = ?`,
                        [
                            group.name || "",
                            group.description || "",
                            creatorId,
                            group.created_at || now(),
                            group.updated_at || now(),
                            String(group.id)
                        ]
                    );

                } else {

                    run(
                        `INSERT INTO groups (
                            id,
                            name,
                            description,
                            created_by,
                            created_at,
                            updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            String(group.id),
                            group.name || "",
                            group.description || "",
                            creatorId,
                            group.created_at || now(),
                            group.updated_at || now()
                        ]
                    );
                }
            }

            /*
             * أعضاء المجموعات
             */
            for (const member of data.group_members || []) {

                const mappedUserId =
                    userMap.get(Number(member.user_id));

                if (!mappedUserId) continue;

                const existingMember = one(
                    `SELECT id
                     FROM group_members
                     WHERE group_id = ?
                       AND user_id = ?
                     LIMIT 1`,
                    [
                        String(member.group_id),
                        mappedUserId
                    ]
                );

                if (existingMember) {

                    run(
                        `UPDATE group_members
                         SET role = ?,
                             joined_at = ?
                         WHERE group_id = ?
                           AND user_id = ?`,
                        [
                            member.role || "member",
                            member.joined_at || now(),
                            String(member.group_id),
                            mappedUserId
                        ]
                    );

                } else {

                    run(
                        `INSERT INTO group_members (
                            group_id,
                            user_id,
                            role,
                            joined_at
                        )
                        VALUES (?, ?, ?, ?)`,
                        [
                            String(member.group_id),
                            mappedUserId,
                            member.role || "member",
                            member.joined_at || now()
                        ]
                    );
                }
            }

            /*
             * حالة النظام
             */
            if (
                Array.isArray(data.system_state) &&
                data.system_state.length
            ) {

                const state = data.system_state[0];

                run(
                    `INSERT INTO system_state (
                        id,
                        alert_mode,
                        network_mode,
                        network_name,
                        app_lock,
                        updated_at
                    )
                    VALUES (1, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        alert_mode = excluded.alert_mode,
                        network_mode = excluded.network_mode,
                        network_name = excluded.network_name,
                        app_lock = excluded.app_lock,
                        updated_at = excluded.updated_at`,
                    [
                        Number(state.alert_mode || 0),
                        state.network_mode || "local",
                        state.network_name || "",
                        Number(state.app_lock || 0),
                        state.updated_at || now()
                    ]
                );
            }

            /*
             * الفريق
             */
            if (
                Array.isArray(data.team) &&
                data.team.length
            ) {

                const team = data.team[0];

                const localTeam = one(
                    "SELECT updated_at FROM team WHERE id = 1"
                );

                if (
                    !localTeam ||
                    String(team.updated_at || "") >
                    String(localTeam.updated_at || "")
                ) {

                    run(
                        `INSERT INTO team (
                            id,
                            name,
                            mission,
                            updated_at
                        )
                        VALUES (1, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            name = excluded.name,
                            mission = excluded.mission,
                            updated_at = excluded.updated_at`,
                        [
                            team.name || "",
                            team.mission || "",
                            team.updated_at || now()
                        ]
                    );
                }
            }

            saveDatabase();

            return res.json({
                ok: true,
                serverMode: SERVER_MODE,
                importedAt: now(),
                users: (data.users || []).length,
                messages: (data.messages || []).length,
                locations: (data.locations || []).length,
                warnings: (data.warnings || []).length,
                audit: (data.audit || []).length,
                userPersonalData:
                    (data.user_personal_data || []).length
            });

        } catch (error) {

            console.error(
                "SYNC IMPORT ERROR:",
                error
            );

            return res.status(500).json({
                ok: false,
                error: "SYNC_IMPORT_FAILED",
                message: error.message
            });
        }
    }
);


/* =========================================================
   ADMIN DUAL SERVER SYNC
========================================================= */

app.post(
    "/api/admin/sync",
    requireAuth,
    requireAdmin,
    async (req, res) => {

        if (!SYNC_SECRET) {
            return res.status(500).json({
                ok: false,
                error: "SYNC_SECRET_NOT_CONFIGURED"
            });
        }

        const remoteUrl =
            SERVER_MODE === "local"
                ? INTERNET_URL
                : LOCAL_URL;

        const localUrl =
            SERVER_MODE === "local"
                ? LOCAL_URL
                : INTERNET_URL;

        try {

            /*
             * تصدير بيانات السيرفر الحالي
             */
            const localExportResponse =
                await fetch(
                    `${localUrl}/api/internal/sync/export`,
                    {
                        method: "GET",
                        headers: {
                            "x-sync-secret": SYNC_SECRET
                        }
                    }
                );

            if (!localExportResponse.ok) {
                throw new Error(
                    `LOCAL_EXPORT_${localExportResponse.status}`
                );
            }

            const localData =
                await localExportResponse.json();

            /*
             * تصدير بيانات السيرفر الآخر
             */
            const remoteExportResponse =
                await fetch(
                    `${remoteUrl}/api/internal/sync/export`,
                    {
                        method: "GET",
                        headers: {
                            "x-sync-secret": SYNC_SECRET
                        }
                    }
                );

            if (!remoteExportResponse.ok) {
                throw new Error(
                    `REMOTE_EXPORT_${remoteExportResponse.status}`
                );
            }

            const remoteData =
                await remoteExportResponse.json();

            /*
             * إرسال بيانات السيرفر الحالي
             * إلى السيرفر الآخر
             */
            const pushLocalResponse =
                await fetch(
                    `${remoteUrl}/api/internal/sync/import`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-sync-secret": SYNC_SECRET
                        },
                        body: JSON.stringify(localData)
                    }
                );

            if (!pushLocalResponse.ok) {
                throw new Error(
                    `REMOTE_IMPORT_${pushLocalResponse.status}`
                );
            }

            const pushLocalResult =
                await pushLocalResponse.json();

            /*
             * إرسال بيانات السيرفر الآخر
             * إلى السيرفر الحالي
             */
            const pushRemoteResponse =
                await fetch(
                    `${localUrl}/api/internal/sync/import`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "x-sync-secret": SYNC_SECRET
                        },
                        body: JSON.stringify(remoteData)
                    }
                );

            if (!pushRemoteResponse.ok) {
                throw new Error(
                    `LOCAL_IMPORT_${pushRemoteResponse.status}`
                );
            }

            const pushRemoteResult =
                await pushRemoteResponse.json();

            audit(
                req.user.id,
                "dual_server_sync",
                JSON.stringify({
                    serverMode: SERVER_MODE,
                    remoteUrl,
                    localImport: pushRemoteResult,
                    remoteImport: pushLocalResult
                })
            );

            return res.json({
                ok: true,
                serverMode: SERVER_MODE,
                remoteServer:
                    remoteData.serverMode || "",
                syncedAt: now(),
                localImport:
                    pushRemoteResult,
                remoteImport:
                    pushLocalResult
            });

        } catch (error) {

            console.error(
                "ADMIN SYNC ERROR:",
                error
            );

            return res.status(500).json({
                ok: false,
                error: "DUAL_SERVER_SYNC_FAILED",
                message: error.message
            });
        }
    }
);

/* API غير موجود */

app.use(
    "/api",
    (req, res) => {

        res.status(404).json({

            error:
                "NOT_FOUND",

            message:
                "مسار API غير موجود."
        });
    
    
    
}
);

/* =========================================================
   تشغيل السيرفر
========================================================= */

async function start() {

    try {

        await initDatabase();

        httpServer.listen(
            PORT,
            HOST,
            () => {

                console.log("");
                console.log(
                    "=============================================="
                );

                console.log(
                    " Secure Messenger V5.2"
                );

                console.log(
                    " Server: http://" +
                    HOST +
                    ":" +
                    PORT
                );

                console.log(
                    " Local:  http://127.0.0.1:" +
                    PORT
                );

                console.log(
                    " Health: http://127.0.0.1:" +
                    PORT +
                    "/api/health"
                );

                console.log(
                    "=============================================="
                );

                console.log(
                    "Admin account:",
                    ADMIN_USERNAME
                );

                console.log("");
            }
        );

    } catch (error) {

        console.error(
            "SERVER START ERROR:",
            error
        );

        process.exit(1);
    }
}




/* =========================================================
   DUAL SERVER SYNC CONFIG
========================================================= */

const SYNC_SECRET_FILE =
    process.env.SYNC_SECRET_FILE ||
    path.join(ROOT, ".sync-secret");

let SYNC_SECRET =
    process.env.SYNC_SECRET || "";

try {
    if (!SYNC_SECRET && fs.existsSync(SYNC_SECRET_FILE)) {
        SYNC_SECRET = fs.readFileSync(
            SYNC_SECRET_FILE,
            "utf8"
        ).trim();
    }
} catch (error) {
    console.error(
        "SYNC SECRET READ ERROR:",
        error.message
    );
}

const LOCAL_URL =
    process.env.LOCAL_URL ||
    "http://127.0.0.1:3001";

const INTERNET_URL =
    process.env.INTERNET_URL ||
    "http://127.0.0.1:3002";

function syncAuthorized(req) {
    return Boolean(
        SYNC_SECRET &&
        req.get("x-sync-secret") === SYNC_SECRET
    );
}

start();
