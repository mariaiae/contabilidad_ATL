// ─────────────────────────────────────────────────────────────────────────────
// INTERFAZ MÓVIL — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// En pantallas angostas (≤ 900 px), siguiendo las Apple Human Interface
// Guidelines:
//   · la barra lateral se convierte en una barra de pestañas inferior; con más
//     de cinco secciones, la quinta pestaña es «Más» y abre las restantes;
//   · los formularios de registro se abren como hojas que suben desde abajo;
//   · la sesión (correo, rol, cerrar sesión) se consulta en su propia hoja.
//
// Aquí vive solo el comportamiento; la presentación está en styles.css, que no
// cambia la paleta de la marca. En escritorio nada de esto se ve.

const CONSULTA_MOVIL = '(max-width: 900px)';
const MAX_PESTANAS = 5;          // HIG: con más de cinco, la quinta se vuelve «Más»
const DISTANCIA_PARA_CERRAR = 90; // px arrastrados hacia abajo para cerrar una hoja

const modoMovil = window.matchMedia(CONSULTA_MOVIL);
export const esMovil = () => modoMovil.matches;

let hojaAbierta = null;
let elementoPrevio = null;
let puedeVerSeccion = () => true;

const ICONO_MAS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2.5" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

const velo = () => document.getElementById('veloHoja');

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

function marcarMasActivo() {
  const activa = document.querySelector('.sidebar-nav .nav-item.en-mas.active');
  document.getElementById('tabMas')?.classList.toggle('active', !!activa);
}

/**
 * Reparte las secciones visibles para el rol actual: hasta cinco pestañas; si
 * hay más, las cuatro primeras y «Más». Se llama al cambiar de rol.
 */
export function organizarBarraPestanas() {
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;
  const secciones = [...nav.querySelectorAll('.nav-item[data-tab]')];
  const visibles = secciones.filter(b => puedeVerSeccion(b.dataset.tab));
  const hayMas = visibles.length > MAX_PESTANAS;

  secciones.forEach(b => b.classList.remove('en-mas'));
  if (hayMas) visibles.slice(MAX_PESTANAS - 1).forEach(b => b.classList.add('en-mas'));
  nav.classList.toggle('con-mas', hayMas);
  marcarMasActivo();
}

/** Hoja «Más»: lista las secciones que no caben en la barra. */
function abrirHojaMas() {
  const lista = document.getElementById('hojaMasLista');
  if (!lista) return;
  const opciones = [...document.querySelectorAll('.sidebar-nav .nav-item.en-mas')].map(original => {
    const opcion = document.createElement('button');
    opcion.type = 'button';
    opcion.className = 'opcion-mas' + (original.classList.contains('active') ? ' active' : '');

    const icono = original.querySelector('.nav-icon')?.cloneNode(true);
    const etiqueta = document.createElement('span');
    etiqueta.className = 'opcion-mas-etiqueta';
    etiqueta.textContent = original.querySelector('.nav-label')?.textContent.trim() || '';
    const insignia = original.querySelector('.nav-badge')?.cloneNode(true);
    insignia?.removeAttribute('id');

    opcion.append(...[icono, etiqueta, insignia].filter(Boolean));
    opcion.addEventListener('click', () => {
      cerrarHoja({ devolverFoco: false });
      original.click();   // mismo camino que la barra lateral: respeta permisos
    });
    return opcion;
  });
  lista.replaceChildren(...opciones);
  abrirHoja(document.getElementById('hojaMas'));
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

  document.getElementById('btnCuentaMovil')?.addEventListener('click', () => {
    abrirHoja(document.getElementById('hojaCuenta'));
  });
  document.getElementById('tabMas')?.addEventListener('click', abrirHojaMas);
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

  // Al cambiar de sección: se cierra cualquier hoja y se vuelve al inicio.
  document.querySelector('.sidebar-nav')?.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-item')) return;
    marcarMasActivo();
    if (esMovil()) {
      cerrarHoja({ devolverFoco: false });
      window.scrollTo({ top: 0 });
    }
  });

  const aplicarModo = () => {
    ubicarSesion();
    if (!esMovil()) cerrarHoja({ devolverFoco: false });
    sincronizarInert();
    organizarBarraPestanas();
  };
  modoMovil.addEventListener('change', aplicarModo);
  aplicarModo();
}
