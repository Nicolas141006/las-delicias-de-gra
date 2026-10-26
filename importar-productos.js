
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const mysql = require("mysql2/promise");

async function importarProductos() {
    const conexion = await mysql.createConnection({
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "db_proy_integrador"
    });

    try {
        const archivoMenu = path.join(
                __dirname,
                "html",
                "menu.html"
                );

        const html = fs.readFileSync(archivoMenu, "utf8");

        const inicioProductos = html.indexOf("const productos = [");

        if (inicioProductos === -1) {
            throw new Error(
                    "No se encontró el arreglo productos en html/menu.html"
                    );
        }

        const inicioArreglo = html.indexOf("[", inicioProductos);
        const finArreglo = html.indexOf(
                'localStorage.setItem(',
                inicioArreglo
                );

        if (inicioArreglo === -1 || finArreglo === -1) {
            throw new Error("No se pudo localizar el catálogo de productos.");
        }

        const textoProductos = html
                .slice(inicioArreglo, finArreglo)
                .trim()
                .replace(/;\s*$/, "");

        const productos = vm.runInNewContext(
                textoProductos,
                {},
                {timeout: 3000}
        );

       

        if (!Array.isArray(productos) || productos.length === 0) {
            throw new Error("El catálogo está vacío o no es válido.");
        }

        const [existentes] = await conexion.execute(
                "SELECT COUNT(*) AS total FROM productos"
                );

        console.log("Productos encontrados:", productos.length);
        console.log("Productos existentes:", existentes[0].total);

        await conexion.beginTransaction();

        let insertados = 0;
        let actualizados = 0;

        for (const producto of productos) {
            if (
                    !producto.nombre ||
                    !producto.slug ||
                    !producto.categoria ||
                    typeof producto.precio !== "number"
                    ) {
                throw new Error(
                        `Producto con datos incompletos: ${producto.nombre || "sin nombre"}`
                        );
            }

            const imagen = producto.imagen
                    ? `${producto.carpeta || ""}/${producto.imagen}`
                    .replace(/^\/+/, "")
                    : null;

            const detalles = {
                ...(producto.detalles || {}),
                ...(producto.opcionesPresentacion
                        ? {
                                opcionesPresentacion:
                                        producto.opcionesPresentacion
                        }
                : {}),
                ...(producto.cantidadPresentacion
                        ? {
                                cantidadPresentacion:
                                        producto.cantidadPresentacion
                        }
                : {}),
                ...(producto.precioPorUnidad
                        ? {precioPorUnidad: true}
                : {}),
                ...(producto.precioPorUnidadVenta !== undefined
                        ? {
                                precioPorUnidadVenta:
                                        producto.precioPorUnidadVenta
                        }
                : {})
            };

            const presentaciones =
                    producto.presentaciones ||
                    (producto.opcionesPresentacion
                            ? {opciones: producto.opcionesPresentacion}
                    : null);

            const [resultado] = await conexion.execute(
                    `INSERT INTO productos
                (
                    nombre, slug, categoria, descripcion, imagen,
                    precio, disponible, detalles, anticipacion,
                    pedido_minimo, unidad_venta, unidades_por_caja,
                    presentaciones
                )
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    nombre = VALUES(nombre),
                    categoria = VALUES(categoria),
                    descripcion = VALUES(descripcion),
                    imagen = VALUES(imagen),
                    precio = VALUES(precio),
                    detalles = VALUES(detalles),
                    anticipacion = VALUES(anticipacion),
                    pedido_minimo = VALUES(pedido_minimo),
                    unidad_venta = VALUES(unidad_venta),
                    unidades_por_caja = VALUES(unidades_por_caja),
                    presentaciones = VALUES(presentaciones)`,
                    [
                        producto.nombre,
                        producto.slug,
                        producto.categoria,
                        producto.descripcion || null,
                        imagen,
                        producto.precio,
                        JSON.stringify(detalles),
                        producto.anticipacion || null,
                        producto.pedidoMinimo ?? null,
                        producto.unidadVenta || null,
                        producto.unidadesPorCaja ?? null,
                        presentaciones
                                ? JSON.stringify(presentaciones)
                                : null
                    ]
                    );

            if (resultado.affectedRows === 1) {
                insertados++;
            } else {
                actualizados++;
            }
        }

        await conexion.commit();

        const [totales] = await conexion.execute(
                "SELECT COUNT(*) AS total FROM productos"
                );

        console.log("\nImportación terminada.");
        console.log("Productos nuevos:", insertados);
        console.log("Productos ya existentes o actualizados:", actualizados);
        console.log("Total de productos en MySQL:", totales[0].total);
    } catch (error) {
        await conexion.rollback();
        console.error("No se completó la importación:", error.message);
        process.exitCode = 1;
    } finally {
        await conexion.end();
    }
}

importarProductos().catch(error => {
    console.error("Error de conexión:", error.message);
    process.exitCode = 1;
});

