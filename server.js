require("dotenv").config();
const http = require("http");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "db_proy_integrador",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Sesiones temporales en memoria.
const sesiones = new Map();
const DURACION_SESION = 2 * 60 * 60 * 1000;

function responder(res, codigo, datos, cookies = []) {
    res.writeHead(codigo, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
        "Set-Cookie": cookies
    });

    res.end(JSON.stringify(datos));
}

function leerCookies(req) {
    const resultado = {};

    (req.headers.cookie || "").split(";").forEach((parte) => {
        const indice = parte.indexOf("=");

        if (indice > 0) {
            const nombre = parte.slice(0, indice).trim();
            const valor = parte.slice(indice + 1).trim();
            resultado[nombre] = valor;
        }
    });

    return resultado;
}

// Obtener una sesión según el tipo de usuario.
function obtenerSesion(req, tipo = "admin") {
    const nombreCookie =
            tipo === "cliente" ? "sesion_cliente" : "sesion_admin";

    const token = leerCookies(req)[nombreCookie];

    if (!token)
        return null;

    const sesion = sesiones.get(token);

    if (!sesion)
        return null;

    if (sesion.expira < Date.now()) {
        sesiones.delete(token);
        return null;
    }

    if (sesion.rol !== tipo)
        return null;

    return {token, ...sesion};
}

// Permitir el acceso administrativo únicamente a la administradora.
function exigirAdmin(req, res) {
    const sesion = obtenerSesion(req, "admin");

    if (!sesion) {
        responder(res, 401, {
            error: "Debes iniciar sesión como administradora."
        });
        return null;
    }

    return sesion;
}


function leerCuerpo(req) {
    return new Promise((resolve, reject) => {
        let cuerpo = "";
        let tamano = 0;

        req.on("data", (fragmento) => {
            tamano += fragmento.length;

            if (tamano > 10000) {
                reject(new Error("La solicitud es demasiado grande."));
                req.destroy();
                return;
            }

            cuerpo += fragmento;
        });

        req.on("end", () => {
            try {
                resolve(JSON.parse(cuerpo || "{}"));
            } catch {
                reject(new Error("El formato de los datos no es válido."));
            }
        });

        req.on("error", reject);
    });
}

// Crear una cookie diferente para cada rol.
function cookieSesion(token, rol) {
    const nombreCookie =
            rol === "admin" ? "sesion_admin" : "sesion_cliente";

    return `${nombreCookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200`;
}

// Eliminar una cookie específica.
function borrarCookie(nombreCookie) {
    return `${nombreCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function enviarArchivo(req, res, rutaUrl) {
    let ruta;

    try {
        ruta = decodeURIComponent(rutaUrl.split("?")[0]);
    } catch {
        res.writeHead(400);
        res.end("Ruta no válida.");
        return;
    }

    if (ruta === "/")
        ruta = "/inicio.html";

    // No permitir acceso a archivos privados del servidor.
    if (
            ruta.startsWith("/.") ||
            ruta.includes("/.") ||
            /(^|\/)(server\.js|package\.json|package-lock\.json)$/i.test(ruta) ||
            ruta.startsWith("/node_modules/")
            ) {
        res.writeHead(403);
        res.end("Acceso denegado.");
        return;
    }

    const archivo = path.resolve(ROOT, "." + ruta);

    if (!archivo.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end("Acceso denegado.");
        return;
    }

    const tipos = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".woff2": "font/woff2"
    };

    fs.readFile(archivo, (error, contenido) => {
        if (error) {
            res.writeHead(error.code === "ENOENT" ? 404 : 500);
            res.end("No se pudo encontrar el archivo.");
            return;
        }

        res.writeHead(200, {
            "Content-Type":
                    tipos[path.extname(archivo).toLowerCase()] ||
                    "application/octet-stream",
            "X-Content-Type-Options": "nosniff"
        });

        res.end(contenido);
    });
}

const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const ruta = url.pathname;

    try {
        if (req.method === "GET" && ruta === "/api/salud") {
            const [filas] = await pool.query("SELECT DATABASE() AS baseDatos");

            responder(res, 200, {
                estado: "correcto",
                mensaje: "Servidor conectado a MySQL",
                baseDatos: filas[0].baseDatos
            });
            return;
        }

        // Inicio de sesión para administradora y clientes.
        if (req.method === "POST" && ruta === "/api/login") {
            const datos = await leerCuerpo(req);
            const celular = String(datos.celular || "").trim();
            const password = String(datos.password || "");

            if (
                    !/^[0-9]{9,15}$/.test(celular) ||
                    !password ||
                    password.length > 200
                    ) {
                responder(res, 400, {
                    error: "Ingresa un celular y una contraseña válidos."
                });
                return;
            }

            const [usuarios] = await pool.execute(
                    `SELECT id, nombre, celular, password_hash, rol
                 FROM usuarios
                 WHERE celular = ? AND activo = TRUE
                 LIMIT 1`,
                    [celular]
                    );

            const usuario = usuarios[0];

            if (
                    !usuario ||
                    !(await bcrypt.compare(password, usuario.password_hash))
                    ) {
                responder(res, 401, {
                    error: "Celular o contraseña incorrectos."
                });
                return;
            }

            // Eliminar sesiones anteriores del mismo usuario y rol.
            for (const [tokenExistente, sesionExistente] of sesiones) {
                if (
                        sesionExistente.usuarioId === usuario.id &&
                        sesionExistente.rol === usuario.rol
                        ) {
                    sesiones.delete(tokenExistente);
                }
            }

            const token = crypto.randomBytes(32).toString("hex");

            sesiones.set(token, {
                usuarioId: usuario.id,
                nombre: usuario.nombre,
                celular: usuario.celular,
                rol: usuario.rol,
                expira: Date.now() + DURACION_SESION
            });

            responder(
                    res,
                    200,
                    {
                        mensaje: "Inicio de sesión correcto.",
                        usuario: {
                            nombre: usuario.nombre,
                            celular: usuario.celular,
                            rol: usuario.rol
                        }
                    },
                    [cookieSesion(token, usuario.rol)]
                    );
            return;
        }

        // Registrar una nueva cuenta de cliente.
        if (req.method === "POST" && ruta === "/api/registro") {
            const datos = await leerCuerpo(req);

            const nombre = String(datos.nombre || "").trim();
            const celular = String(datos.celular || "").trim();
            const password = String(datos.password || "");

            if (nombre.length < 2 || nombre.length > 100) {
                responder(res, 400, {
                    error: "El nombre debe tener entre 2 y 100 caracteres."
                });
                return;
            }

            if (!/^[0-9]{9}$/.test(celular)) {
                responder(res, 400, {
                    error: "Ingresa un número de celular de 9 dígitos."
                });
                return;
            }

            if (password.length < 8 || password.length > 72) {
                responder(res, 400, {
                    error: "La contraseña debe tener entre 8 y 72 caracteres."
                });
                return;
            }

            const [existentes] = await pool.execute(
                    "SELECT id FROM usuarios WHERE celular = ? LIMIT 1",
                    [celular]
                    );

            if (existentes.length > 0) {
                responder(res, 409, {
                    error: "Este número de celular ya está registrado."
                });
                return;
            }

            const passwordHash = await bcrypt.hash(password, 12);

            await pool.execute(
                    `INSERT INTO usuarios
                    (nombre, celular, password_hash, rol, activo)
                 VALUES (?, ?, ?, 'cliente', TRUE)`,
                    [nombre, celular, passwordHash]
                    );

            responder(res, 201, {
                mensaje: "Cuenta creada correctamente. Ya puedes iniciar sesión."
            });
            return;
        }

        // Consultar la sesión actual de cualquier usuario.
        if (req.method === "GET" && ruta === "/api/sesion") {
            const sesion =
                    obtenerSesion(req, "admin") ||
                    obtenerSesion(req, "cliente");

            if (!sesion) {
                responder(res, 401, {autenticado: false});
                return;
            }

            responder(res, 200, {
                autenticado: true,
                usuario: {
                    nombre: sesion.nombre,
                    celular: sesion.celular,
                    rol: sesion.rol
                }
            });
            return;
        }

        // Cerrar sesión del usuario actual.
        if (req.method === "POST" && ruta === "/api/logout") {
            const sesion =
                    obtenerSesion(req, "admin") ||
                    obtenerSesion(req, "cliente");

            if (sesion) {
                sesiones.delete(sesion.token);
            }

            responder(
                    res,
                    200,
                    {mensaje: "Sesión cerrada."},
                    [
                        borrarCookie("sesion_admin"),
                        borrarCookie("sesion_cliente")
                    ]
                    );
            return;
        }



        // Catálogo público de productos desde MySQL.
        if (req.method === "GET" && ruta === "/api/productos") {
            const [filas] = await pool.query(
                    `SELECT
                    id,
                    nombre,
                    slug,
                    categoria,
                    descripcion,
                    imagen,
                    precio,
                    detalles,
                    anticipacion,
                    pedido_minimo,
                    unidad_venta,
                    unidades_por_caja,
                    presentaciones
                 FROM productos
                 WHERE disponible = TRUE
                 ORDER BY categoria, nombre`
                    );

            const productos = filas.map((producto) => {
                const partesImagen = (producto.imagen || "").split("/");

                return {
                    ...producto,
                    carpeta: partesImagen.length > 1
                            ? partesImagen[0]
                            : "",
                    imagen: partesImagen.length > 1
                            ? partesImagen.slice(1).join("/")
                            : partesImagen[0],
                    detalles: producto.detalles || {},
                    presentaciones: producto.presentaciones || null,
                    precio: producto.precio === null
                            ? null
                            : Number(producto.precio)
                };
            });

            responder(res, 200, {productos});
            return;
        }


        // Registrar un pedido del cliente y sus productos.
        if (req.method === "POST" && ruta === "/api/pedidos") {
            const sesion = obtenerSesion(req, "cliente");

            if (!sesion) {
                responder(res, 401, {
                    error: "Inicia sesión como cliente para realizar tu pedido."
                });
                return;
            }

            const datos = await leerCuerpo(req);
            const items = datos.items;

            if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
                responder(res, 400, {
                    error: "El carrito está vacío o contiene demasiados productos."
                });
                return;
            }

            const conexion = await pool.getConnection();

            try {
                await conexion.beginTransaction();

                const detalles = [];
                let subtotal = 0;

                for (const item of items) {
                    const identificador = String(
                            item.productoId ?? item.slug ?? ""
                            ).trim();
                    const cantidad = Number(item.cantidad);

                    if (
                            !identificador ||
                            !Number.isSafeInteger(cantidad) ||
                            cantidad < 1 ||
                            cantidad > 99
                            ) {
                        throw new Error("Producto o cantidad no válidos.");
                    }

                    const [productos] = await conexion.execute(
                            `SELECT id, nombre, slug, precio, disponible,
            presentaciones, unidad_venta
     FROM productos
     WHERE slug = ? AND disponible = TRUE
     LIMIT 1`,
                            [identificador]
                            );

                    if (productos.length === 0) {
                        throw new Error(
                                "Uno de los productos ya no está disponible."
                                );
                    }

                    const producto = productos[0];
                    const precio = Number(producto.precio);

                    if (!Number.isFinite(precio) || precio < 0) {
                        throw new Error(
                                "No se pudo verificar el precio de un producto."
                                );
                    }

                    const presentacion = String(item.presentacion || "").trim();
                    const importe = Math.round(precio * cantidad * 100) / 100;

                    subtotal += importe;

                    detalles.push({
                        productoId: producto.id,
                        nombre: producto.nombre,
                        presentacion,
                        cantidad,
                        precio,
                        subtotal: importe
                    });
                }

                subtotal = Math.round(subtotal * 100) / 100;

                const [resultadoPedido] = await conexion.execute(
                        `INSERT INTO pedidos
                        (usuario_id, nombre_cliente, celular_cliente,
                         tipo_entrega, direccion_entrega, fecha_solicitada,
                         estado, subtotal, costo_delivery, total, notas)
                     VALUES (?, ?, ?, 'recojo', NULL, NULL,
                             'pendiente', ?, 0.00, ?, NULL)`,
                        [
                            sesion.usuarioId,
                            sesion.nombre,
                            sesion.celular,
                            subtotal,
                            subtotal
                        ]
                        );

                const pedidoId = resultadoPedido.insertId;

                for (const detalle of detalles) {
                    await conexion.execute(
                            `INSERT INTO detalle_pedido
                            (pedido_id, producto_id, nombre_producto,
                             presentacion, cantidad, precio_unitario, subtotal)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            [
                                pedidoId,
                                detalle.productoId,
                                detalle.nombre,
                                detalle.presentacion || null,
                                detalle.cantidad,
                                detalle.precio,
                                detalle.subtotal
                            ]
                            );
                }

                await conexion.commit();

                responder(res, 201, {
                    mensaje: "Pedido registrado correctamente.",
                    pedidoId,
                    cliente: {
                        nombre: sesion.nombre,
                        celular: sesion.celular
                    },
                    subtotal,
                    costoDelivery: 0,
                    total: subtotal,
                    tipoEntrega: "recojo",
                    items: detalles
                });
                return;

            } catch (error) {
                await conexion.rollback();

                const errorCliente = [
                    "Producto o cantidad no válidos.",
                    "Uno de los productos ya no está disponible.",
                    "No se pudo verificar el precio de un producto."
                ].includes(error.message);

                responder(res, errorCliente ? 400 : 500, {
                    error: errorCliente
                            ? error.message
                            : "No se pudo guardar el pedido. Inténtalo nuevamente."
                });
                return;

            } finally {
                conexion.release();
            }
        }

        // Todas las siguientes rutas requieren una sesión de administradora.
        if (ruta.startsWith("/api/admin/")) {
            const sesion = exigirAdmin(req, res);

            if (!sesion)
                return;

            if (req.method === "GET" && ruta === "/api/admin/resumen") {
                const [[productos]] = await pool.query(
                        "SELECT COUNT(*) AS total FROM productos"
                        );

                const [[disponibles]] = await pool.query(
                        "SELECT COUNT(*) AS total FROM productos WHERE disponible = TRUE"
                        );

                const [[pedidos]] = await pool.query(
                        "SELECT COUNT(*) AS total FROM pedidos"
                        );

                const [[pendientes]] = await pool.query(
                        "SELECT COUNT(*) AS total FROM pedidos WHERE estado = 'pendiente'"
                        );

                const [ultimosPedidos] = await pool.query(
                        `SELECT id, nombre_cliente, celular_cliente,
                            total, estado, creado_en
                     FROM pedidos
                     ORDER BY creado_en DESC
                     LIMIT 10`
                        );

                responder(res, 200, {
                    productos: productos.total,
                    productosDisponibles: disponibles.total,
                    pedidos: pedidos.total,
                    pedidosPendientes: pendientes.total,
                    ultimosPedidos
                });
                return;
            }

            if (req.method === "GET" && ruta === "/api/admin/productos") {
                const [productos] = await pool.query(
                        `SELECT id, nombre, categoria, precio, disponible, imagen
                     FROM productos
                     ORDER BY nombre`
                        );

                responder(res, 200, {productos});
                return;
            }

            if (req.method === "GET" && ruta === "/api/admin/pedidos") {
                const [pedidos] = await pool.query(
                        `SELECT id, nombre_cliente, celular_cliente,
                            tipo_entrega, direccion_entrega, fecha_solicitada,
                            estado, subtotal, costo_delivery, total, notas, creado_en
                     FROM pedidos
                     ORDER BY creado_en DESC
                     LIMIT 200`
                        );

                responder(res, 200, {pedidos});
                return;
            }

            // Cambiar estado de un pedido.
            const coincidencia = ruta.match(/^\/api\/admin\/pedidos\/(\d+)\/estado$/);

            if (req.method === "PATCH" && coincidencia) {
                const id = Number(coincidencia[1]);
                const datos = await leerCuerpo(req);
                const estados = ["pendiente", "confirmado", "entregado", "cancelado"];

                if (!estados.includes(datos.estado)) {
                    responder(res, 400, {error: "Estado no válido."});
                    return;
                }

                const [resultado] = await pool.execute(
                        "UPDATE pedidos SET estado = ? WHERE id = ?",
                        [datos.estado, id]
                        );

                if (!resultado.affectedRows) {
                    responder(res, 404, {error: "Pedido no encontrado."});
                    return;
                }

                responder(res, 200, {mensaje: "Estado actualizado."});
                return;
            }

            responder(res, 404, {error: "Ruta administrativa no encontrada."});
            return;
        }

        // Servir las páginas y recursos públicos del proyecto.
        if (req.method === "GET" || req.method === "HEAD") {
            enviarArchivo(req, res, ruta);
            return;
        }

        responder(res, 405, {error: "Método no permitido."});
    } catch (error) {
        console.error("Error del servidor:", error.message);

        if (!res.headersSent) {
            responder(res, 500, {
                error: "Ocurrió un error interno del servidor."
            });
        }
    }
});

servidor.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
