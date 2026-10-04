"use strict";

/*
 * AsdServer System Upgrades 2026-10-04
 * Safe additive server extension.
 * It does not replace existing routes; it registers new, namespaced routes.
 */

function installSystemUpgrades(ctx) {
  const {
    app,
    io,
    run,
    all,
    one,
    now,
    saveDatabase,
    audit,
    requireAuth,
    requireAdmin,
    emitToUser,
    sessions
  } = ctx || {};

  if (!app || !run || !all || !one || !now || !saveDatabase || !requireAuth || !requireAdmin) {
    throw new Error("SYSTEM_UPGRADES_CONTEXT_INVALID");
  }

  const TABLES = new Set([
    "users",
    "messages",
    "locations",
    "location_status",
    "warnings",
    "audit",
    "user_personal_data",
    "system_state",
    "sessions"
  ]);

  function tableExists(name) {
    if (!TABLES.has(name)) return false;
    try {
      return Boolean(one(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [name]
      ));
    } catch (_) {
      return false;
    }
  }

  function columnExists(table, column) {
    if (!TABLES.has(table)) return false;
    try {
      return all(`PRAGMA table_info(${table})`).some(row => row.name === column);
    } catch (_) {
      return false;
    }
  }

  function ensureSchema() {
    run(`
      CREATE TABLE IF NOT EXISTS user_capabilities (
        user_id INTEGER PRIMARY KEY,
        gps_status TEXT NOT NULL DEFAULT 'unknown',
        microphone_status TEXT NOT NULL DEFAULT 'unknown',
        speaker_status TEXT NOT NULL DEFAULT 'unknown',
        voiceprint_status TEXT NOT NULL DEFAULT 'not_enrolled',
        updated_at TEXT NOT NULL
      )
    `);

    run(`
      CREATE TABLE IF NOT EXISTS violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT DEFAULT '',
        name TEXT DEFAULT '',
        device_serial TEXT DEFAULT '',
        kind TEXT NOT NULL DEFAULT '',
        details TEXT DEFAULT '',
        gps_status TEXT DEFAULT '',
        microphone_status TEXT DEFAULT '',
        speaker_status TEXT DEFAULT '',
        auto_frozen INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);

    run(`
      CREATE TABLE IF NOT EXISTS system_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_user_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'system',
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        metadata TEXT DEFAULT '',
        read_at TEXT DEFAULT NULL,
        created_at TEXT NOT NULL
      )
    `);

    run(`
      CREATE TABLE IF NOT EXISTS voiceprints (
        user_id INTEGER PRIMARY KEY,
        signature TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        enrolled_at TEXT NOT NULL
      )
    `);

    run(`
      CREATE TABLE IF NOT EXISTS broadcast_reads (
        user_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY(user_id, message_id)
      )
    `);

    if (tableExists("messages") && !columnExists("messages", "read_at")) {
      run("ALTER TABLE messages ADD COLUMN read_at TEXT DEFAULT NULL");
    }

    if (tableExists("messages") && !columnExists("messages", "system_generated")) {
      run("ALTER TABLE messages ADD COLUMN system_generated INTEGER NOT NULL DEFAULT 0");
    }

    saveDatabase();
  }

  function cleanText(value, max = 2000) {
    return String(value == null ? "" : value).trim().slice(0, max);
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value == null ? {} : value).slice(0, 12000);
    } catch (_) {
      return "{}";
    }
  }

  function userData(userId) {
    const user = one(
      `SELECT id,username,name,role,is_admin,status,device_serial,created_at,updated_at
       FROM users WHERE id=?`,
      [userId]
    );

    if (!user) return null;

    let personal = null;
    if (tableExists("user_personal_data")) {
      try {
        personal = one("SELECT * FROM user_personal_data WHERE user_id=?", [userId]);
      } catch (_) {
        personal = null;
      }
    }

    return { user, personal };
  }

  function notifyUser(recipientUserId, type, title, body, metadata = {}) {
    const createdAt = now();
    run(
      `INSERT INTO system_notifications
       (recipient_user_id,type,title,body,metadata,created_at)
       VALUES(?,?,?,?,?,?)`,
      [
        Number(recipientUserId),
        cleanText(type, 80) || "system",
        cleanText(title, 250),
        cleanText(body, 4000),
        safeJson(metadata),
        createdAt
      ]
    );

    const row = one(
      "SELECT * FROM system_notifications WHERE id=last_insert_rowid()"
    );

    // Also create an internal message so the manager receives the violation
    // through the existing messenger flow (and its normal unread/ring logic).
    const offenderId = Number(metadata?.user_id || 0);
    if (tableExists("messages") && offenderId > 0 && offenderId !== Number(recipientUserId)) {
      try {
        run(
          `INSERT INTO messages
           (sender_id,receiver_id,group_id,message,message_type,attachment_name,attachment_data,created_at,system_generated)
           VALUES(?, ?, NULL, ?, 'system_violation', '', '', ?, 1)`,
          [
            offenderId,
            Number(recipientUserId),
            cleanText(body, 4000),
            createdAt
          ]
        );
      } catch (_) {
        // Some legacy databases may not have the optional system_generated column.
        try {
          run(
            `INSERT INTO messages
             (sender_id,receiver_id,group_id,message,message_type,attachment_name,attachment_data,created_at)
             VALUES(?, ?, NULL, ?, 'system_violation', '', '', ?)`,
            [
              offenderId,
              Number(recipientUserId),
              cleanText(body, 4000),
              createdAt
            ]
          );
        } catch (_) {}
      }
    }

    if (typeof emitToUser === "function") {
      try {
        emitToUser(
          recipientUserId,
          "system_notification",
          row || {
            recipient_user_id: Number(recipientUserId),
            type,
            title,
            body,
            metadata,
            created_at: createdAt
          }
        );
      } catch (_) {}
    }

    return row;
  }

  function systemManagers() {
    return all(
      `SELECT id,username,name,role,is_admin
       FROM users
       WHERE is_admin=1 OR role='system_manager' OR role='admin'
       ORDER BY id ASC`
    );
  }

  function freezeSessions(userId) {
    if (!sessions || typeof sessions.entries !== "function") return;
    for (const [token, session] of sessions.entries()) {
      if (Number(session?.user_id) === Number(userId)) {
        sessions.delete(token);
      }
    }
  }

  function registerViolation(req, payload = {}) {
    const userId = Number(req?.user?.id || payload.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new Error("INVALID_USER_ID");
    }

    const details = userData(userId);
    if (!details?.user) throw new Error("USER_NOT_FOUND");

    const kind = cleanText(payload.kind || "capability_violation", 120) || "capability_violation";
    const gpsStatus = cleanText(payload.gps_status, 40);
    const microphoneStatus = cleanText(payload.microphone_status, 40);
    const speakerStatus = cleanText(payload.speaker_status, 40);
    const reason = cleanText(payload.details || "رفض أحد متطلبات تشغيل النظام.", 3000);

    const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recent = one(
      `SELECT id FROM violations
       WHERE user_id=? AND kind=? AND created_at >= ?
       ORDER BY id DESC LIMIT 1`,
      [userId, kind, cutoff]
    );

    if (recent) {
      return one("SELECT * FROM violations WHERE id=?", [recent.id]);
    }

    run(
      `INSERT INTO violations
       (user_id,username,name,device_serial,kind,details,gps_status,microphone_status,speaker_status,auto_frozen,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId,
        details.user.username || "",
        details.user.name || "",
        details.user.device_serial || "",
        kind,
        reason,
        gpsStatus,
        microphoneStatus,
        speakerStatus,
        1,
        now()
      ]
    );

    const violation = one("SELECT * FROM violations WHERE id=last_insert_rowid()");

    try {
      run(
        `UPDATE users SET status='frozen', updated_at=? WHERE id=?`,
        [now(), userId]
      );
      freezeSessions(userId);
    } catch (_) {}

    const metadata = {
      violation_id: Number(violation?.id || 0),
      user_id: userId,
      user: details.user,
      personal_data: details.personal || null,
      gps_status: gpsStatus,
      microphone_status: microphoneStatus,
      speaker_status: speakerStatus,
      auto_frozen: true
    };

    const p = details.personal || {};
    const identity = [
      p.full_name ? `الاسم الكامل: ${p.full_name}` : "",
      p.military_number ? `الرقم العسكري: ${p.military_number}` : "",
      p.division ? `الفرقة: ${p.division}` : "",
      p.unit ? `الوحدة: ${p.unit}` : "",
      details.user.username ? `اسم المستخدم: ${details.user.username}` : "",
      details.user.device_serial ? `معرف الجهاز: ${details.user.device_serial}` : ""
    ].filter(Boolean).join("؛ ");

    const title = "مخالفة لقواعد تشغيل النظام";
    const body =
      `تم تسجيل مخالفة للمستخدم ${details.user.name || details.user.username || userId}. ` +
      `${identity ? `بيانات الشخص: ${identity}. ` : ""}` +
      `السبب: ${reason}. تم تجميد الحساب تلقائياً.`;

    for (const manager of systemManagers()) {
      notifyUser(manager.id, "violation", title, body, metadata);
    }

    try {
      if (typeof audit === "function") {
        audit(userId, "system_violation_auto_freeze", safeJson(metadata));
      }
    } catch (_) {}

    saveDatabase();

    return violation;
  }

  function statusValue(value) {
    const s = cleanText(value, 40).toLowerCase();
    return ["active", "denied", "unavailable", "unknown", "not_enrolled"].includes(s)
      ? s
      : "unknown";
  }

  ensureSchema();

  app.get(
    "/api/system/capabilities",
    requireAuth,
    (req, res) => {
      const row = one("SELECT * FROM user_capabilities WHERE user_id=?", [req.user.id]);
      res.json({ ok: true, capabilities: row || {
        user_id: req.user.id,
        gps_status: "unknown",
        microphone_status: "unknown",
        speaker_status: "unknown",
        voiceprint_status: "not_enrolled"
      }});
    }
  );

  app.post(
    "/api/system/capabilities",
    requireAuth,
    (req, res) => {
      const current = one("SELECT * FROM user_capabilities WHERE user_id=?", [req.user.id]);
      const gps = Object.prototype.hasOwnProperty.call(req.body || {}, "gps_status")
        ? statusValue(req.body?.gps_status)
        : statusValue(current?.gps_status || "unknown");
      const microphone = Object.prototype.hasOwnProperty.call(req.body || {}, "microphone_status")
        ? statusValue(req.body?.microphone_status)
        : statusValue(current?.microphone_status || "unknown");
      const speaker = Object.prototype.hasOwnProperty.call(req.body || {}, "speaker_status")
        ? statusValue(req.body?.speaker_status)
        : statusValue(current?.speaker_status || "unknown");
      const voiceprint = Object.prototype.hasOwnProperty.call(req.body || {}, "voiceprint_status")
        ? statusValue(req.body?.voiceprint_status)
        : statusValue(current?.voiceprint_status || "not_enrolled");

      run(
        `INSERT INTO user_capabilities
         (user_id,gps_status,microphone_status,speaker_status,voiceprint_status,updated_at)
         VALUES(?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           gps_status=excluded.gps_status,
           microphone_status=excluded.microphone_status,
           speaker_status=excluded.speaker_status,
           voiceprint_status=excluded.voiceprint_status,
           updated_at=excluded.updated_at`,
        [req.user.id, gps, microphone, speaker, voiceprint, now()]
      );

      const denied = [gps, microphone, speaker].some(x => x === "denied");
      let violation = null;

      if (denied) {
        const kinds = [];
        if (gps === "denied") kinds.push("gps_denied");
        if (microphone === "denied") kinds.push("microphone_denied");
        if (speaker === "denied") kinds.push("speaker_denied");
        violation = registerViolation(req, {
          kind: kinds.join("+") || "capability_denied",
          details: `الحالة: GPS=${gps}, الميكروفون=${microphone}, السماعة=${speaker}`,
          gps_status: gps,
          microphone_status: microphone,
          speaker_status: speaker
        });
      }

      saveDatabase();

      res.json({
        ok: true,
        capabilities: one("SELECT * FROM user_capabilities WHERE user_id=?", [req.user.id]),
        violation,
        frozen: Boolean(violation)
      });
    }
  );

  app.post(
    "/api/system/violation",
    requireAuth,
    (req, res) => {
      try {
        const violation = registerViolation(req, {
          kind: req.body?.kind,
          details: req.body?.details,
          gps_status: req.body?.gps_status,
          microphone_status: req.body?.microphone_status,
          speaker_status: req.body?.speaker_status
        });

        res.json({ ok: true, violation, frozen: true });
      } catch (error) {
        res.status(400).json({ ok: false, message: error.message });
      }
    }
  );

  app.get(
    "/api/admin/system-notifications",
    requireAuth,
    requireAdmin,
    (req, res) => {
      const unreadOnly = String(req.query?.unread || "") === "1";
      const rows = all(
        `SELECT * FROM system_notifications
         WHERE recipient_user_id=? ${unreadOnly ? "AND read_at IS NULL" : ""}
         ORDER BY id DESC LIMIT 500`,
        [req.user.id]
      );
      res.json({ ok: true, notifications: rows });
    }
  );

  app.post(
    "/api/admin/system-notifications/:id/read",
    requireAuth,
    requireAdmin,
    (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ ok: false, message: "معرف الإشعار غير صحيح." });
      }
      run(
        `UPDATE system_notifications SET read_at=? WHERE id=? AND recipient_user_id=?`,
        [now(), id, req.user.id]
      );
      saveDatabase();
      res.json({ ok: true });
    }
  );

  app.get(
    "/api/admin/violations",
    requireAuth,
    requireAdmin,
    (req, res) => {
      const rows = all(
        `SELECT v.* FROM violations v ORDER BY v.id DESC LIMIT 1000`
      );
      res.json({ ok: true, violations: rows });
    }
  );

  app.get(
    "/api/admin/user-map",
    requireAuth,
    requireAdmin,
    (req, res) => {
      let rows = [];
      if (tableExists("locations")) {
        rows = all(`
          SELECT
            l.user_id,
            l.latitude,
            l.longitude,
            l.accuracy,
            l.captured_at,
            l.created_at,
            u.username,
            u.name,
            u.device_serial,
            COALESCE((
              SELECT ls.status FROM location_status ls
              WHERE ls.user_id=l.user_id ORDER BY ls.id DESC LIMIT 1
            ), 'unknown') AS gps_status,
            COALESCE((
              SELECT ls.captured_at FROM location_status ls
              WHERE ls.user_id=l.user_id ORDER BY ls.id DESC LIMIT 1
            ), l.captured_at) AS last_update
          FROM locations l
          INNER JOIN users u ON u.id=l.user_id
          WHERE l.id IN (SELECT MAX(id) FROM locations GROUP BY user_id)
          ORDER BY l.id DESC
        `);
      }

      rows = rows.filter(row =>
        row.latitude !== null && row.longitude !== null &&
        ["active", "unknown"].includes(String(row.gps_status || "unknown"))
      );

      res.json({ ok: true, users: rows, count: rows.length });
    }
  );

  app.get(
    "/api/admin/reports",
    requireAuth,
    requireAdmin,
    (req, res) => {
      const type = cleanText(req.query?.type || "summary", 40) || "summary";
      const from = cleanText(req.query?.from, 40) || "2000-01-01";
      const to = cleanText(req.query?.to, 40) || "2999-12-31";
      const search = cleanText(req.query?.search, 200);

      const dateClause = `date(created_at)>=date(?) AND date(created_at)<=date(?)`;

      if (type === "summary") {
        const users = one("SELECT COUNT(*) AS count FROM users") || { count: 0 };
        const activeUsers = one("SELECT COUNT(*) AS count FROM users WHERE status='active'") || { count: 0 };
        const frozenUsers = one("SELECT COUNT(*) AS count FROM users WHERE status='frozen'") || { count: 0 };
        const messages = one(`SELECT COUNT(*) AS count FROM messages WHERE ${dateClause}`, [from, to]) || { count: 0 };
        const violations = one(`SELECT COUNT(*) AS count FROM violations WHERE ${dateClause}`, [from, to]) || { count: 0 };
        const locations = one(`SELECT COUNT(*) AS count FROM locations WHERE ${dateClause}`, [from, to]) || { count: 0 };
        res.json({ ok: true, type, data: {
          users: Number(users.count || 0),
          active_users: Number(activeUsers.count || 0),
          frozen_users: Number(frozenUsers.count || 0),
          messages: Number(messages.count || 0),
          violations: Number(violations.count || 0),
          locations: Number(locations.count || 0),
          from,
          to
        }});
        return;
      }

      if (type === "users") {
        const like = `%${search}%`;
        const data = all(
          `SELECT id,username,name,role,is_admin,status,device_serial,created_at,updated_at
           FROM users
           WHERE (username LIKE ? OR name LIKE ? OR device_serial LIKE ? OR ?='')
           ORDER BY id DESC LIMIT 2000`,
          [like, like, like, search]
        );
        res.json({ ok: true, type, data });
        return;
      }

      if (type === "messages") {
        const data = all(
          `SELECT m.id,m.sender_id,m.receiver_id,m.group_id,m.message,m.message_type,
                  m.attachment_name,m.created_at,m.read_at,
                  su.username AS sender_username,su.name AS sender_name,
                  ru.username AS receiver_username,ru.name AS receiver_name
           FROM messages m
           LEFT JOIN users su ON su.id=m.sender_id
           LEFT JOIN users ru ON ru.id=m.receiver_id
           WHERE ${dateClause}
           ORDER BY m.id DESC LIMIT 3000`,
          [from, to]
        );
        res.json({ ok: true, type, data });
        return;
      }

      if (type === "locations") {
        const data = all(
          `SELECT l.*,u.username,u.name,u.device_serial,
             COALESCE((SELECT ls.status FROM location_status ls WHERE ls.user_id=l.user_id ORDER BY ls.id DESC LIMIT 1),'unknown') AS gps_status
           FROM locations l LEFT JOIN users u ON u.id=l.user_id
           WHERE ${dateClause}
           ORDER BY l.id DESC LIMIT 5000`,
          [from, to]
        );
        res.json({ ok: true, type, data });
        return;
      }

      if (type === "violations") {
        const data = all(
          `SELECT * FROM violations WHERE ${dateClause} ORDER BY id DESC LIMIT 3000`,
          [from, to]
        );
        res.json({ ok: true, type, data });
        return;
      }

      if (type === "audit") {
        const data = all(
          `SELECT a.*,u.username,u.name FROM audit a LEFT JOIN users u ON u.id=a.user_id
           WHERE ${dateClause.replace(/created_at/g, "a.created_at")} ORDER BY a.id DESC LIMIT 3000`,
          [from, to]
        );
        res.json({ ok: true, type, data });
        return;
      }

      if (type === "notifications") {
        const data = all(
          `SELECT * FROM system_notifications
           WHERE ${dateClause} ORDER BY id DESC LIMIT 3000`,
          [from, to]
        );
        res.json({ ok: true, type, data });
        return;
      }

      if (type === "full") {
        const summary = {
          users: Number(one("SELECT COUNT(*) AS count FROM users")?.count || 0),
          messages: Number(one(`SELECT COUNT(*) AS count FROM messages WHERE ${dateClause}`, [from, to])?.count || 0),
          locations: Number(one(`SELECT COUNT(*) AS count FROM locations WHERE ${dateClause}`, [from, to])?.count || 0),
          violations: Number(one(`SELECT COUNT(*) AS count FROM violations WHERE ${dateClause}`, [from, to])?.count || 0)
        };
        res.json({
          ok: true,
          type,
          data: {
            summary,
            users: all("SELECT id,username,name,role,status,device_serial,created_at,updated_at FROM users ORDER BY id DESC LIMIT 5000"),
            messages: all(`SELECT id,sender_id,receiver_id,group_id,message,message_type,created_at,read_at FROM messages WHERE ${dateClause} ORDER BY id DESC LIMIT 5000`, [from, to]),
            locations: all(`SELECT * FROM locations WHERE ${dateClause} ORDER BY id DESC LIMIT 5000`, [from, to]),
            violations: all(`SELECT * FROM violations WHERE ${dateClause} ORDER BY id DESC LIMIT 5000`, [from, to]),
            notifications: all(`SELECT * FROM system_notifications WHERE ${dateClause} ORDER BY id DESC LIMIT 5000`, [from, to]),
            from,
            to
          }
        });
        return;
      }

      res.status(400).json({ ok: false, message: "نوع التقرير غير معروف." });
    }
  );

  app.get(
    "/api/messages/unread-summary",
    requireAuth,
    (req, res) => {
      const directRows = all(
        `SELECT sender_id,COUNT(*) AS count,MAX(id) AS last_message_id
         FROM messages
         WHERE receiver_id=? AND read_at IS NULL
         GROUP BY sender_id`,
        [req.user.id]
      );

      const broadcastRows = all(
        `SELECT m.sender_id,COUNT(*) AS count,MAX(m.id) AS last_message_id
         FROM messages m
         LEFT JOIN broadcast_reads br
           ON br.user_id=? AND br.message_id=m.id
         WHERE m.group_id='ALL'
           AND m.sender_id<>?
           AND br.message_id IS NULL
         GROUP BY m.sender_id`,
        [req.user.id, req.user.id]
      );

      const merged = new Map();
      for (const row of [...directRows, ...broadcastRows]) {
        const key = String(row.sender_id);
        const previous = merged.get(key);
        if (!previous) {
          merged.set(key, { ...row, count: Number(row.count || 0) });
        } else {
          previous.count += Number(row.count || 0);
          previous.last_message_id = Math.max(Number(previous.last_message_id || 0), Number(row.last_message_id || 0));
        }
      }

      const rows = [...merged.values()].sort((a,b) => Number(b.last_message_id || 0) - Number(a.last_message_id || 0));
      res.json({
        ok: true,
        total: rows.reduce((n, r) => n + Number(r.count || 0), 0),
        by_sender: rows
      });
    }
  );

  app.post(
    "/api/messages/:userId/read",
    requireAuth,
    (req, res) => {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, message: "معرف المستخدم غير صحيح." });
      }
      if (!columnExists("messages", "read_at")) {
        return res.json({ ok: true, marked: 0 });
      }
      const readAt = now();
      run(
        `UPDATE messages SET read_at=? WHERE sender_id=? AND receiver_id=? AND read_at IS NULL`,
        [readAt, userId, req.user.id]
      );

      if (tableExists("messages")) {
        const broadcasts = all(
          `SELECT id FROM messages
           WHERE sender_id=? AND group_id='ALL'
           ORDER BY id ASC`,
          [userId]
        );
        for (const broadcast of broadcasts) {
          run(
            `INSERT OR IGNORE INTO broadcast_reads(user_id,message_id,read_at) VALUES(?,?,?)`,
            [req.user.id, Number(broadcast.id), readAt]
          );
        }
      }

      saveDatabase();
      res.json({ ok: true });
    }
  );

  function validateFeatures(features) {
    if (!Array.isArray(features) || features.length < 16 || features.length > 128) {
      throw new Error("VOICE_FEATURES_INVALID");
    }
    const values = features.map(Number);
    if (values.some(v => !Number.isFinite(v))) {
      throw new Error("VOICE_FEATURES_INVALID");
    }
    const norm = Math.hypot(...values);
    if (!Number.isFinite(norm) || norm <= 1e-9) {
      throw new Error("VOICE_FEATURES_EMPTY");
    }
    return values.map(v => v / norm);
  }

  function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na <= 0 || nb <= 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  app.get(
    "/api/voiceprint/status",
    requireAuth,
    (req, res) => {
      const row = one("SELECT user_id,updated_at,enrolled_at FROM voiceprints WHERE user_id=?", [req.user.id]);
      res.json({ ok: true, enrolled: Boolean(row), voiceprint: row || null });
    }
  );

  app.post(
    "/api/voiceprint/enroll",
    requireAuth,
    (req, res) => {
      try {
        const signature = validateFeatures(req.body?.features);
        const updatedAt = now();
        const existing = one("SELECT enrolled_at FROM voiceprints WHERE user_id=?", [req.user.id]);

        run(
          `INSERT INTO voiceprints(user_id,signature,updated_at,enrolled_at)
           VALUES(?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET signature=excluded.signature,updated_at=excluded.updated_at`,
          [req.user.id, JSON.stringify(signature), updatedAt, existing?.enrolled_at || updatedAt]
        );

        run(
          `INSERT INTO user_capabilities(user_id,voiceprint_status,updated_at)
           VALUES(?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET voiceprint_status=excluded.voiceprint_status,updated_at=excluded.updated_at`,
          [req.user.id, "active", updatedAt]
        );

        saveDatabase();
        res.json({ ok: true, enrolled: true, updated_at: updatedAt });
      } catch (error) {
        res.status(400).json({ ok: false, message: error.message });
      }
    }
  );

  app.post(
    "/api/voiceprint/verify",
    requireAuth,
    (req, res) => {
      try {
        const stored = one("SELECT signature FROM voiceprints WHERE user_id=?", [req.user.id]);
        if (!stored) {
          return res.json({ ok: true, enrolled: false, verified: false, score: 0 });
        }
        const candidate = validateFeatures(req.body?.features);
        const original = validateFeatures(JSON.parse(stored.signature));
        const score = cosine(original, candidate);
        const threshold = Math.min(0.99, Math.max(0.50, Number(process.env.VOICEPRINT_THRESHOLD || 0.88)));
        res.json({ ok: true, enrolled: true, verified: score >= threshold, score, threshold });
      } catch (error) {
        res.status(400).json({ ok: false, message: error.message });
      }
    }
  );

  const COMMANDS = [
    { key: "open_reports", aliases: ["التقارير", "تقرير", "reports", "report"] },
    { key: "open_user_map", aliases: ["خريطة المستخدمين", "الخريطة", "user map", "map"] },
    { key: "open_violations", aliases: ["المخالفات", "الانتهاكات", "violations", "violation"] },
    { key: "speaker_test", aliases: ["اختبار السماعة", "اختبار الصوت", "speaker test", "test speaker"] },
    { key: "emergency_stop", aliases: ["إيقاف الطوارئ", "ايقاف الطوارئ", "stop emergency", "emergency stop"] },
    { key: "emergency_start", aliases: ["تفعيل الطوارئ", "تشغيل الطوارئ", "start emergency", "emergency start"] }
  ];

  function matchCommand(command) {
    const normalized = cleanText(command, 300).toLowerCase();
    return COMMANDS.find(item => item.aliases.some(alias => normalized.includes(alias.toLowerCase()))) || null;
  }

  app.post(
    "/api/voice-command",
    requireAuth,
    async (req, res) => {
      try {
        const command = cleanText(req.body?.command, 300);
        const matched = matchCommand(command);
        if (!matched) {
          return res.status(400).json({ ok: false, message: "الأمر الصوتي غير معروف." });
        }

        const suppliedScore = Number(req.body?.score);
        let verified = false;
        if (Number.isFinite(suppliedScore)) {
          const threshold = Math.min(0.99, Math.max(0.50, Number(process.env.VOICEPRINT_THRESHOLD || 0.88)));
          verified = suppliedScore >= threshold;
        }

        if (!verified) {
          const stored = one("SELECT signature FROM voiceprints WHERE user_id=?", [req.user.id]);
          if (stored && Array.isArray(req.body?.features)) {
            try {
              const candidate = validateFeatures(req.body.features);
              const original = validateFeatures(JSON.parse(stored.signature));
              verified = cosine(original, candidate) >= Math.min(0.99, Math.max(0.50, Number(process.env.VOICEPRINT_THRESHOLD || 0.88)));
            } catch (_) {}
          }
        }

        if (!verified) {
          return res.status(403).json({ ok: false, message: "البصمة الصوتية غير مؤكدة.", command: matched.key });
        }

        if (["emergency_start", "emergency_stop"].includes(matched.key) &&
            !(req.user.is_admin === 1 || req.user.role === "admin" || req.user.role === "system_manager")) {
          return res.status(403).json({ ok: false, message: "أمر الطوارئ متاح للمشرف فقط." });
        }

        if (matched.key === "emergency_start") {
          run("UPDATE system_state SET alert_mode=1,updated_at=? WHERE id=1", [now()]);
          saveDatabase();
          try { audit(req.user.id, "voice_emergency_start", command); } catch (_) {}
        }

        if (matched.key === "emergency_stop") {
          run("UPDATE system_state SET alert_mode=0,updated_at=? WHERE id=1", [now()]);
          saveDatabase();
          try { audit(req.user.id, "voice_emergency_stop", command); } catch (_) {}
        }

        res.json({ ok: true, verified: true, action: matched.key, command });
      } catch (error) {
        res.status(400).json({ ok: false, message: error.message });
      }
    }
  );

  app.post(
    "/api/admin/audio-broadcast",
    requireAuth,
    requireAdmin,
    (req, res) => {
      const audioBase64 = String(req.body?.audio_base64 || "");
      const mimeType = cleanText(req.body?.mime_type || "audio/webm", 120);
      const messageText = cleanText(req.body?.message || "بث صوتي من مدير النظام", 500);

      if (!audioBase64 || audioBase64.length < 100) {
        return res.status(400).json({ ok: false, message: "المقطع الصوتي فارغ." });
      }
      if (audioBase64.length > 12_000_000) {
        return res.status(413).json({ ok: false, message: "المقطع الصوتي أكبر من الحد المسموح." });
      }

      const recipients = all(
        `SELECT id FROM users WHERE id<>? AND status='active'`,
        [req.user.id]
      );

      const createdAt = now();
      const dataUrl = audioBase64.startsWith("data:")
        ? audioBase64
        : `data:${mimeType};base64,${audioBase64}`;

      run(
        `INSERT INTO messages
         (sender_id,receiver_id,group_id,message,message_type,attachment_name,attachment_data,created_at)
         VALUES(?,NULL,'ALL',?,?,?,?,?)`,
        [
          req.user.id,
          messageText,
          "audio",
          `broadcast-${createdAt.replace(/[^0-9]/g, "")}.audio`,
          dataUrl,
          createdAt
        ]
      );

      const saved = one(`
        SELECT m.*,u.username AS sender_username,u.name AS sender_name
        FROM messages m LEFT JOIN users u ON u.id=m.sender_id
        WHERE m.id=last_insert_rowid()
      `);

      for (const recipient of recipients) {
        try {
          emitToUser?.(recipient.id, "broadcast_message", saved);
          emitToUser?.(recipient.id, "new_message", saved);
        } catch (_) {}
      }

      try { audit(req.user.id, "audio_broadcast", `recipients=${recipients.length},message_id=${Number(saved?.id || 0)}`); } catch (_) {}
      saveDatabase();

      res.json({ ok: true, count: recipients.length, message_id: Number(saved?.id || 0), message: "تم إرسال البث الصوتي للمستخدمين النشطين." });
    }
  );

  app.post(
    "/api/admin/emergency-stop",
    requireAuth,
    requireAdmin,
    (req, res) => {
      run(
        `UPDATE system_state SET alert_mode=0,updated_at=? WHERE id=1`,
        [now()]
      );
      try { audit(req.user.id, "emergency_stop", "manual stop button"); } catch (_) {}
      saveDatabase();
      res.json({ ok: true, alert_mode: false, message: "تم إيقاف إنذار الطوارئ." });
    }
  );

  if (io && typeof io.emit === "function") {
    try {
      io.emit("system_upgrades_ready", { ok: true });
    } catch (_) {}
  }
}

module.exports = { installSystemUpgrades };
