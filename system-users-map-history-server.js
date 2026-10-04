"use strict";

function installUsersMapHistory({
  app, run, all, one, now, saveDatabase, audit,
  requireAuth, requireAdmin, authenticate, admin, sessions
}) {
  const auth = requireAuth || authenticate;
  const isAdmin = requireAdmin || admin;
  if (!app || !run || !all || !one || !now || !saveDatabase || !auth || !isAdmin) {
    throw new Error("Users Map History integration arguments are incomplete");
  }

  run(`CREATE TABLE IF NOT EXISTS map_history_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_at TEXT NOT NULL,
    saved_by INTEGER,
    title TEXT NOT NULL DEFAULT '',
    center_lat REAL,
    center_lng REAL,
    zoom INTEGER,
    point_count INTEGER NOT NULL DEFAULT 0
  )`);

  run(`CREATE TABLE IF NOT EXISTS map_history_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    employee_number TEXT NOT NULL DEFAULT '',
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    accuracy REAL NOT NULL DEFAULT 0,
    online INTEGER NOT NULL DEFAULT 0,
    captured_at TEXT NOT NULL DEFAULT ''
  )`);

  const clean = (v, max=200) => String(v == null ? '' : v).trim().slice(0, max);
  const coord = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };

  function idFromSessionValue(v) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\\d+$/.test(v)) return Number(v);
    if (!v || typeof v !== 'object') return null;
    for (const c of [v.user_id, v.userId, v.id, v.user?.id, v.user?.user_id]) {
      const n = Number(c);
      if (Number.isInteger(n) && n > 0) return n;
    }
    return null;
  }

  function online(userId) {
    const target = Number(userId);
    if (!sessions) return false;
    if (sessions instanceof Map) {
      for (const [k,v] of sessions.entries()) if (idFromSessionValue(k) === target || idFromSessionValue(v) === target) return true;
      return false;
    }
    if (typeof sessions === 'object') {
      for (const [k,v] of Object.entries(sessions)) if (idFromSessionValue(k) === target || idFromSessionValue(v) === target) return true;
    }
    return false;
  }

  function liveRows() {
    const rows = all(`
      SELECT l.*, u.username, u.name, u.nickname, u.employee_number
      FROM locations l JOIN users u ON u.id=l.user_id
      WHERE l.id=(SELECT MAX(l2.id) FROM locations l2 WHERE l2.user_id=l.user_id)
      ORDER BY u.name, u.username
    `);
    return rows.map(r => ({
      user_id:Number(r.user_id), username:String(r.username||''), name:String(r.name||''), nickname:String(r.nickname||''),
      employee_number:String(r.employee_number||''), latitude:Number(r.latitude), longitude:Number(r.longitude),
      accuracy:Number(r.accuracy||0), online:online(r.user_id)?1:0, captured_at:String(r.captured_at||'')
    })).filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && p.latitude>=-90 && p.latitude<=90 && p.longitude>=-180 && p.longitude<=180);
  }

  app.get('/api/admin/users-map/live', auth, isAdmin, (req,res) => {
    const points = liveRows();
    res.json({ success:true, saved_at:now(), points, online_count:points.filter(p=>p.online).length, total_with_location:points.length });
  });

  app.post('/api/admin/users-map/history', auth, isAdmin, (req,res) => {
    try {
      const b = req.body || {};
      const raw = Array.isArray(b.points) ? b.points.slice(0,1000) : [];
      const title = clean(b.title,160) || 'خريطة المستخدمين';
      const centerLat = coord(b.center_lat,-90,90), centerLng = coord(b.center_lng,-180,180);
      const z = Number(b.zoom), zoom = Number.isInteger(z) && z>=1 && z<=22 ? z : null;
      const savedAt = now();
      const points = raw.map(p => ({
        user_id:Number.isInteger(Number(p.user_id))?Number(p.user_id):null,
        username:clean(p.username,120), name:clean(p.name,180), nickname:clean(p.nickname,180), employee_number:clean(p.employee_number,80),
        latitude:coord(p.latitude,-90,90), longitude:coord(p.longitude,-180,180),
        accuracy:Number.isFinite(Number(p.accuracy))?Math.max(0,Number(p.accuracy)):0, online:p.online?1:0, captured_at:clean(p.captured_at,80)
      })).filter(p=>p.latitude!==null&&p.longitude!==null);
      run(`INSERT INTO map_history_snapshots (saved_at,saved_by,title,center_lat,center_lng,zoom,point_count) VALUES (?,?,?,?,?,?,?)`,
        [savedAt, req.user?.id||null, title, centerLat, centerLng, zoom, points.length]);
      const snap = one(`SELECT id FROM map_history_snapshots WHERE saved_at=? ORDER BY id DESC LIMIT 1`,[savedAt]);
      const sid = Number(snap?.id||0); if (!sid) throw new Error('snapshot insert failed');
      for (const p of points) run(`INSERT INTO map_history_points
        (snapshot_id,user_id,username,name,nickname,employee_number,latitude,longitude,accuracy,online,captured_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [sid,p.user_id,p.username,p.name,p.nickname,p.employee_number,p.latitude,p.longitude,p.accuracy,p.online,p.captured_at]);
      saveDatabase();
      if (typeof audit==='function') audit(req.user?.id||null,'users_map_snapshot_saved',JSON.stringify({snapshot_id:sid,title,point_count:points.length,saved_at:savedAt}));
      res.json({success:true,snapshot_id:sid,saved_at:savedAt,point_count:points.length});
    } catch (e) {
      console.error('[Users Map History] save:',e);
      res.status(500).json({success:false,message:'تعذر حفظ خريطة المستخدمين.'});
    }
  });

  app.get('/api/admin/users-map/history', auth, isAdmin, (req,res) => {
    const from=clean(req.query?.from,60), to=clean(req.query?.to,60), q=clean(req.query?.q,160);
    const ln=Math.min(200,Math.max(1,Number.isInteger(Number(req.query?.limit))?Number(req.query.limit):100));
    const c=[],p=[];
    if(from){c.push('s.saved_at >= ?');p.push(from);} if(to){c.push('s.saved_at <= ?');p.push(to);}
    if(q){c.push(`(s.title LIKE ? OR EXISTS (SELECT 1 FROM map_history_points hp2 WHERE hp2.snapshot_id=s.id AND (hp2.name LIKE ? OR hp2.nickname LIKE ? OR hp2.username LIKE ?)))`);const x=`%${q}%`;p.push(x,x,x,x);}
    const where=c.length?'WHERE '+c.join(' AND '):'';
    const rows=all(`SELECT s.id,s.saved_at,s.saved_by,s.title,s.center_lat,s.center_lng,s.zoom,s.point_count,COALESCE(u.username,'') saved_by_username
      FROM map_history_snapshots s LEFT JOIN users u ON u.id=s.saved_by ${where} ORDER BY s.id DESC LIMIT ${ln}`,p);
    res.json({success:true,snapshots:rows});
  });

  app.get('/api/admin/users-map/history/:id', auth, isAdmin, (req,res) => {
    const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0) return res.status(400).json({success:false,message:'معرف السجل غير صحيح.'});
    const snapshot=one(`SELECT s.id,s.saved_at,s.saved_by,s.title,s.center_lat,s.center_lng,s.zoom,s.point_count,COALESCE(u.username,'') saved_by_username
      FROM map_history_snapshots s LEFT JOIN users u ON u.id=s.saved_by WHERE s.id=?`,[id]);
    if(!snapshot) return res.status(404).json({success:false,message:'سجل الخريطة غير موجود.'});
    const points=all(`SELECT id,snapshot_id,user_id,username,name,nickname,employee_number,latitude,longitude,accuracy,online,captured_at
      FROM map_history_points WHERE snapshot_id=? ORDER BY online DESC,name,username`,[id]);
    res.json({success:true,snapshot,points});
  });

  app.delete('/api/admin/users-map/history/:id', auth, isAdmin, (req,res) => {
    const id=Number(req.params.id); if(!Number.isInteger(id)||id<=0) return res.status(400).json({success:false,message:'معرف السجل غير صحيح.'});
    if(!one('SELECT id FROM map_history_snapshots WHERE id=?',[id])) return res.status(404).json({success:false,message:'السجل غير موجود.'});
    run('DELETE FROM map_history_points WHERE snapshot_id=?',[id]); run('DELETE FROM map_history_snapshots WHERE id=?',[id]); saveDatabase();
    if(typeof audit==='function') audit(req.user?.id||null,'users_map_snapshot_deleted',String(id));
    res.json({success:true});
  });
}
module.exports = { installUsersMapHistory };
