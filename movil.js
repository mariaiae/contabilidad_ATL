// ─────────────────────────────────────────────────────────────────────────────
// INTERFAZ MÓVIL — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// En pantallas angostas (≤ 900 px), siguiendo las Apple Human Interface
// Guidelines:
//   · la barra lateral se convierte en una barra de pestañas inferior; con más
//     de cinco secciones (perfil auditor) la barra se desliza con el dedo;
//   · los formularios de registro se abren como hojas que suben desde abajo;
//   · la sesión (correo, rol, cerrar sesión) se consulta en su propia hoja.
//
// Aquí vive solo el comportamiento; la presentación está en styles.css, que no
// cambia la paleta de la marca. En escritorio nada de esto se ve.

const CONSULTA_MOVIL = '(max-width: 900px)';
const PESTANAS_SIN_DESLIZAR = 5;  // hasta cinco caben a lo ancho; con más, la barra se desliza
const DISTANCIA_PARA_CERRAR = 90; // px arrastrados hacia abajo para cerrar una hoja

const modoMovil = window.matchMedia(CONSULTA_MOVIL);
export const esMovil = () => modoMovil.matches;

let hojaAbierta = null;
let elementoPrevio = null;
let puedeVerSeccion = () => true;

const ICONO_MAS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2.5" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

const velo = () => document.getElementById('veloHoja');
const barraDeSecciones = () => document.querySelector('.sidebar-nav');

// ── Hojas ─────────────────────────────────────────────────────────────────────

/** Abre una hoja (formulario o menú del sistema). Solo en móvil. */
export function abrirHoja(hoja) {
  if (!hoja || !esMovil()) return;
  if (hojaAbierta && hojaAbierta !== hoja) cerrarHoja({ devolverFoco: false });

  elementoPrevio = document.activeElement;
  hojaAbierta = hoja;
  hoja.setAttribute('role', 'dialog');
  hoja.setAttribute('aria-modal', 'true');
  hoja.scrollTop = 0;
  hoja.inert = false;
  hoja.classList.add('abierta');
  velo()?.classList.add('visible');
  document.documentElement.classList.add('hoja-abierta');
  hoja.focus({ preventScroll: true });
}

/** Cierra la hoja abierta, si la hay. */
export function cerrarHoja({ devolverFoco = true } = {}) {
  const hoja = hojaAbierta;
  if (!hoja) return;
  hojaAbierta = null;

  hoja.classList.remove('abierta', 'arrastrando');
  hoja.style.transform = '';
  hoja.inert = esMovil();
  hoja.removeAttribute('aria-modal');
  // Un formulario solo es diálogo mientras es hoja; los menús del sistema lo son siempre.
  if (hoja.classList.contains('form-card')) hoja.removeAttribute('role');
  velo()?.classList.remove('visible');
  document.documentElement.classList.remove('hoja-abierta');

  if (devolverFoco && elementoPrevio && document.contains(elementoPrevio)) {
    elementoPrevio.focus({ preventScroll: true });
  }
  elementoPrevio = null;
}

/**
 * Después de guardar un registro: cierra la hoja para que se vea el resultado
 * (la tabla, el asiento o la confirmación). La deja abierta si el guardado dejó
 * un aviso fiscal dentro del formulario, como pasa en Socios, para que se lea.
 */
export function cerrarHojaTrasGuardar() {
  const hoja = hojaAbierta;
  if (!hoja) return;
  // El aviso se pinta en la misma vuelta, justo después de mostrar el asiento.
  setTimeout(() => {
    if (hojaAbierta !== hoja) return;
    if (hoja.querySelector('.alerta-fiscal:not(.hidden)')) return;
    cerrarHoja({ devolverFoco: false });
  }, 0);
}

/** Arrastrar la cabecera hacia abajo cierra la hoja, como en iOS. */
function habilitarArrastre(hoja, asa) {
  let inicio = null;
  let recorrido = 0;

  asa.addEventListener('touchstart', (e) => {
    if (!esMovil() || e.target.closest('button, a, input, select, textarea')) return;
    inicio = e.touches[0].clientY;
    recorrido = 0;
    hoja.classList.add('arrastrando');
  }, { passive: true });

  asa.addEventListener('touchmove', (e) => {
    if (inicio === null) return;
    recorrido = Math.max(0, e.touches[0].clientY - inicio);
    hoja.style.transform = `translateY(${recorrido}px)`;
  }, { passive: true });

  const soltar = () => {
    if (inicio === null) return;
    inicio = null;
    hoja.classList.remove('arrastrando');
    if (recorrido > DISTANCIA_PARA_CERRAR) cerrarHoja();
    else hoja.style.transform = '';
  };
  asa.addEventListener('touchend', soltar);
  asa.addEventListener('touchcancel', soltar);
}

/**
 * Cada formulario de registro se vuelve una hoja en móvil. En su lugar queda un
 * botón que la abre, con el mismo título del formulario.
 */
function prepararHojasDeRegistro() {
  document.querySelectorAll('.tab-panel .form-card').forEach((tarjeta, indice) => {
    if (tarjeta.dataset.hoja) return;
    tarjeta.dataset.hoja = '1';
    tarjeta.classList.add('hoja');
    tarjeta.tabIndex = -1;

    const titulo = tarjeta.querySelector('.card-title');
    if (titulo) {
      if (!titulo.id) titulo.id = 'tituloHoja' + indice;
      tarjeta.setAttribute('aria-labelledby', titulo.id);
    }

    const cabecera = tarjeta.querySelector('.card-header');
    if (cabecera) {
      const cerrar = document.createElement('button');
      cerrar.type = 'button';
      cerrar.className = 'hoja-cerrar';
      cerrar.textContent = 'Cerrar';
      cerrar.addEventListener('click', () => cerrarHoja());
      cabecera.appendChild(cerrar);
      habilitarArrastre(tarjeta, cabecera);
    }

    const abrir = document.createElement('button');
    abrir.type = 'button';
    abrir.className = 'btn-primary full abrir-hoja';
    abrir.innerHTML = ICONO_MAS;
    const etiqueta = document.createElement('span');
    etiqueta.textContent = titulo?.textContent.trim() || 'Nuevo registro';
    abrir.appendChild(etiqueta);
    abrir.setAttribute('aria-haspopup', 'dialog');
    abrir.addEventListener('click', () => abrirHoja(tarjeta));

    const contenedor = tarjeta.closest('.two-col-layout');
    if (contenedor) contenedor.insertBefore(abrir, contenedor.firstChild);
    else tarjeta.before(abrir);
  });
}

/**
 * Una hoja cerrada no recibe foco ni la leen los lectores de pantalla. En
 * escritorio los formularios vuelven a ser tarjetas normales.
 */
function sincronizarInert() {
  document.querySelectorAll('.form-card.hoja, .hoja-sistema').forEach(hoja => {
    hoja.inert = esMovil() ? hoja !== hojaAbierta : hoja.classList.contains('hoja-sistema');
  });
}

// ── Barra de pestañas ─────────────────────────────────────────────────────────

/** Desvanece el borde de la barra por el lado donde quedan más pestañas. */
function actualizarBordesBarra() {
  const nav = barraDeSecciones();
  if (!nav) return;
  const desliza = esMovil() && nav.classList.contains('desliza') && nav.scrollWidth > nav.clientWidth + 1;
  nav.classList.toggle('hay-antes', desliza && nav.scrollLeft > 2);
  nav.classList.toggle('hay-despues', desliza && nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
}

/** Lleva a la vista la pestaña activa, por ejemplo al saltar a Impuestos. */
function mostrarPestanaActiva(suave = false) {
  const nav = barraDeSecciones();
  const activa = nav?.querySelector('.nav-item.active');
  if (!esMovil() || !activa || !nav.classList.contains('desliza')) return;
  const izquierda = activa.offsetLeft;
  const derecha = izquierda + activa.offsetWidth;
  if (izquierda < nav.scrollLeft) {
    nav.scrollTo({ left: izquierda, behavior: suave ? 'smooth' : 'auto' });
  } else if (derecha > nav.scrollLeft + nav.clientWidth) {
    nav.scrollTo({ left: derecha - nav.clientWidth, behavior: suave ? 'smooth' : 'auto' });
  }
}

/**
 * Hasta cinco secciones visibles para el rol, la barra reparte el ancho entre
 * ellas. Con más (perfil auditor), la barra se desliza. Se llama al cambiar de rol.
 */
export function organizarBarraPestanas() {
  const nav = barraDeSecciones();
  if (!nav) return;
  const visibles = [...nav.querySelectorAll('.nav-item[data-tab]')].filter(b => puedeVerSeccion(b.dataset.tab));
  nav.classList.toggle('desliza', visibles.length > PESTANAS_SIN_DESLIZAR);
  if (!nav.classList.contains('desliza')) nav.scrollLeft = 0;
  mostrarPestanaActiva();
  actualizarBordesBarra();
}

/** Un contador en cero no se muestra en la barra de pestañas. */
function vigilarContadores() {
  document.querySelectorAll('.sidebar .nav-badge').forEach(contador => {
    const marcar = () => contador.classList.toggle('sin-valor', contador.textContent.trim() === '0');
    marcar();
    new MutationObserver(marcar).observe(contador, { childList: true, characterData: true, subtree: true });
  });
}

// ── Sesión ────────────────────────────────────────────────────────────────────

/** El pie de la barra lateral (periodo y sesión) vive en su hoja en móvil. */
function ubicarSesion() {
  const pie = document.querySelector('.sidebar-footer');
  const cuerpo = document.getElementById('hojaCuentaCuerpo');
  const barra = document.querySelector('.sidebar');
  if (!pie || !cuerpo || !barra) return;
  if (esMovil()) {
    if (pie.parentElement !== cuerpo) cuerpo.appendChild(pie);
  } else if (pie.parentElement !== barra) {
    barra.appendChild(pie);
  }
}

// ── Arranque ──────────────────────────────────────────────────────────────────

/**
 * @param {{ puedeVerTab: (tab: string) => boolean }} opciones
 *   la misma regla de permisos que usa la barra lateral.
 */
export function montarInterfazMovil({ puedeVerTab }) {
  puedeVerSeccion = puedeVerTab;
  prepararHojasDeRegistro();
  vigilarContadores();

  document.getElementById('btnCuentaMovil')?.addEventListener('click', () => {
    abrirHoja(document.getElementById('hojaCuenta'));
  });
  velo()?.addEventListener('click', () => cerrarHoja());

  document.querySelectorAll('.hoja-sistema').forEach(hoja => {
    const cabecera = hoja.querySelector('.hoja-sistema-cab');
    if (cabecera) habilitarArrastre(hoja, cabecera);
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-cerrar-hoja]')) cerrarHoja();
    // Editar un concepto operativo llena su formulario: en móvil está en una hoja.
    if (e.target.closest('.editar-concepto') && esMovil()) {
      abrirHoja(document.getElementById('conceptoNombre')?.closest('.form-card'));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && hojaAbierta) cerrarHoja();
  });

  const nav = barraDeSecciones();
  // Al cambiar de sección: se cierra cualquier hoja, se vuelve al inicio y la
  // pestaña elegida queda completa a la vista.
  nav?.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-item') || !esMovil()) return;
    cerrarHoja({ devolverFoco: false });
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => mostrarPestanaActiva(true));
  });
  nav?.addEventListener('scroll', actualizarBordesBarra, { passive: true });
  window.addEventListener('resize', actualizarBordesBarra, { passive: true });

  const aplicarModo = () => {
    ubicarSesion();
    if (!esMovil()) cerrarHoja({ devolverFoco: false });
    sincronizarInert();
    organizarBarraPestanas();
  };
  modoMovil.addEventListener('change', aplicarModo);
  aplicarModo();
}
