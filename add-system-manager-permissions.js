const fs = require("fs");

const file = "server.js";
let code = fs.readFileSync(file, "utf8");

const marker = `function requireAdmin(
    req,
    res,
    next
) {`;

if (!code.includes(marker)) {
    throw new Error("MARKER_REQUIRE_ADMIN_NOT_FOUND");
}

/* لا نكرر التعديل */
if (code.includes("function requireSystemManager(")) {
    throw new Error("SYSTEM_MANAGER_ALREADY_EXISTS");
}

/*
 * إضافة صلاحية مدير النظام بجانب requireAdmin.
 * requireAdmin نفسها لن يتم تغييرها.
 */
const insertAfter = `}

/* =========================================================
   فحص الخادم
========================================================= */`;

const addition = `}

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
========================================================= */`;

if (!code.includes(insertAfter)) {
    throw new Error("INSERT_POINT_NOT_FOUND");
}

code = code.replace(insertAfter, addition);

/*
 * إضافة مسارات إدارة المشرفين قبل قسم
 * فتح رسالة مؤقتة مرة واحدة.
 */
const routesMarker = `/* =========================================================
   فتح رسالة مؤقتة مرة واحدة
========================================================= */`;

const routes = `/* =========================================================
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
            \`INSERT INTO users
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
             VALUES(?,?,?,?,?,?,?,?,?)\`,
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
                \`SELECT
                    id,
                    username,
                    name,
                    role,
                    is_admin,
                    status
                 FROM users
                 WHERE id=?\`,
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
========================================================= */`;

if (!code.includes(routesMarker)) {
    throw new Error("ROUTES_INSERT_POINT_NOT_FOUND");
}

code = code.replace(routesMarker, routes);

fs.writeFileSync(file, code, "utf8");

console.log("SYSTEM_MANAGER_PERMISSIONS_ADDED");
