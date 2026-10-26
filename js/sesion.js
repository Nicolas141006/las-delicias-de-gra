
document.addEventListener("DOMContentLoaded", () => {
    const loginLink = document.getElementById("loginLink");
    const loginTexto = document.getElementById("loginTexto");

    // Actualizar el contador del carrito.
    function actualizarContadorCarrito() {
        const contador = document.getElementById("contadorCarrito");

        if (!contador) return;

        try {
            const carrito = JSON.parse(
                localStorage.getItem("carritoLasDeliciasDeGra") || "[]"
            );

            const cantidad = carrito.reduce((total, producto) => {
                return total + (Number(producto.cantidad) || 0);
            }, 0);

            contador.textContent = cantidad;
        } catch (error) {
            console.error("Error al leer el carrito:", error);
            contador.textContent = "0";
        }
    }

    // Consultar y actualizar la sesión.
    async function actualizarCuenta() {
        if (!loginLink || !loginTexto) return;

        try {
            const respuesta = await fetch("/api/sesion", {
                credentials: "same-origin",
                cache: "no-store"
            });

            if (!respuesta.ok) return;

            const datos = await respuesta.json();

            if (!datos.autenticado || !datos.usuario) {
                loginTexto.textContent = "Iniciar sesión";
                loginLink.href = "login.html";
                loginLink.onclick = null;
                return;
            }

            loginTexto.textContent = datos.usuario.nombre;
            loginLink.href = "#";
            loginLink.title = "Pulsa para cerrar sesión";

            loginLink.onclick = async (evento) => {
                evento.preventDefault();

                if (!confirm("¿Deseas cerrar tu sesión?")) return;

                try {
                    const salida = await fetch("/api/logout", {
                        method: "POST",
                        credentials: "same-origin"
                    });

                    if (!salida.ok) {
                        alert("No se pudo cerrar la sesión.");
                        return;
                    }

                    window.location.reload();
                } catch (error) {
                    console.error(error);
                    alert("Ocurrió un error al cerrar sesión.");
                }
            };
        } catch (error) {
            console.error("Error al consultar la sesión:", error);
        }
    }

    actualizarContadorCarrito();
    actualizarCuenta();
});
