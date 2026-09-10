// ─────────────────────────────────────────────────────────────────────────────
// AUTENTICACIÓN — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// Envuelve Supabase Auth. La aplicación no carga ningún dato hasta que hay
// sesión activa, y las políticas RLS (ver sql/005) rechazan al rol `anon`,
// así que la puerta está cerrada en el cliente y en la base.
//
// Los usuarios NO se crean desde aquí: se dan de alta en
// Supabase Dashboard → Authentication → Users. La app solo inicia sesión.
import { supabase, CONFIG } from './supabase.js';

// ── Perfil y rol ─────────────────────────────────────────────────────────────
// El rol vive en la tabla `profiles` (ver sql/008). Se consulta una vez por
// sesion y se guarda aqui para que la interfaz lo lea de forma sincrona.
//
// Regla: ante cualquier duda (tabla inexistente, error de red, usuario sin
// perfil, rol desconocido) se asume `comercial`, el de MENOR privilegio.
// Nunca se concede `auditor` por defecto. Aun asi la base decide: sus
// politicas leen el rol de `profiles`, no el que asuma la interfaz.

export const ROLES = Object.freeze({ COMERCIAL: 'comercial', AUDITOR: 'auditor' });

/**
 * Cuenta registrada que un auditor aun no aprueba (sql/016). La base no le
 * entrega ningun dato; la app ni siquiera se monta para ella.
 */
export const ROL_PENDIENTE = 'pendiente';

let perfil = { userId: null, role: null, origen: 'sin-cargar', detalle: null };
let consultaEnCurso = null;   // { userId, promesa } para no duplicar la consulta

/**
 * Carga el rol del usuario desde `profiles`.
 * `origen` indica de donde salio: 'bd' (verificado), 'error', 'sin-perfil'
 * o 'rol-invalido' (en estos tres casos el rol es `comercial` por seguridad).
 */
export async function cargarPerfil(userId, { forzar = false } = {}) {
  if (!userId) return limpiarPerfil();
  if (!forzar && perfil.userId === userId && perfil.origen === 'bd') return perfil;
  // Login y onAuthStateChange piden el perfil casi a la vez: una sola consulta.
  if (!forzar && consultaEnCurso?.userId === userId) return consultaEnCurso.promesa;

  const promesa = (async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('[Auth] No se pudo leer el perfil:', error);
      perfil = {
        userId, role: ROLES.COMERCIAL, origen: 'error',
        detalle: error.code === 'PGRST205'
          ? 'la tabla de perfiles no existe todavia (falta ejecutar sql/008).'
          : (error.message || 'error desconocido al leer el perfil.'),
      };
    } else if (!data) {
      perfil = { userId, role: ROLES.COMERCIAL, origen: 'sin-perfil',
                 detalle: 'tu usuario no tiene un perfil asignado.' };
    } else if (data.role === ROL_PENDIENTE) {
      perfil = { userId, role: ROL_PENDIENTE, origen: 'bd', detalle: null };
    } else if (!Object.values(ROLES).includes(data.role)) {
      perfil = { userId, role: ROLES.COMERCIAL, origen: 'rol-invalido',
                 detalle: 'rol no reconocido (' + data.role + ').' };
    } else {
      perfil = { userId, role: data.role, origen: 'bd', detalle: null };
    }
    return perfil;
  })();

  consultaEnCurso = { userId, promesa };
  try {
    return await promesa;
  } finally {
    if (consultaEnCurso?.promesa === promesa) consultaEnCurso = null;
  }
}

/** Rol vigente, de forma sincrona. null si no hay sesion. */
export function rolActual() { return perfil.role; }

/** true solo si el rol fue verificado en la BD como auditor. */
export function esAuditor() { return perfil.role === ROLES.AUDITOR; }

/** Copia del estado del perfil (rol, origen y detalle del fallo si lo hubo). */
export function estadoPerfil() { return { ...perfil }; }

/** Olvida el rol (al cerrar sesion o sin sesion). */
export function limpiarPerfil() {
  perfil = { userId: null, role: null, origen: 'sin-cargar', detalle: null };
  consultaEnCurso = null;
  return perfil;
}

/** Sesión activa, o null si no hay. */
export async function sesionActual() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('[Auth] No se pudo leer la sesión:', error);
    return null;
  }
  return data.session;
}

/**
 * Inicia sesión con correo y contraseña.
 * @throws el error de Supabase si las credenciales son inválidas.
 */
export async function iniciarSesion(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  // El rol se consulta en cuanto hay sesion, antes de que la app pinte nada.
  await cargarPerfil(data.session?.user?.id);
  return data.session;
}

/** Cierra la sesión y limpia el token almacenado. */
export async function cerrarSesion() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  limpiarPerfil();
}

/**
 * Reacciona a los cambios de sesión (login, logout, token renovado o vencido).
 * @param {(session: object|null) => void} alCambiar
 */
export function observarSesion(alCambiar) {
  const { data } = supabase.auth.onAuthStateChange((_evento, session) => alCambiar(session));
  return data.subscription;
}

/**
 * Comprueba si el navegador alcanza el servicio de Auth, sin pasar por la
 * libreria. Sirve para distinguir "no hay red" de "Supabase dijo que no".
 * @returns {Promise<string>} descripcion del resultado.
 */
export async function probarConexion() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'el navegador se declara sin conexion a internet';
  }
  try {
    const r = await fetch(CONFIG.url + '/auth/v1/settings', { headers: { apikey: CONFIG.key } });
    if (r.ok) return 'Supabase SI responde, el problema no es la red';
    if (r.status === 401) return 'Supabase responde pero rechaza la clave (revisa VITE_SUPABASE_ANON_KEY en .env)';
    return 'Supabase responde con HTTP ' + r.status;
  } catch (e) {
    return 'no se alcanza ' + CONFIG.url + ' (' + e.message + '). Puede ser un bloqueador de anuncios, un proxy/antivirus, o el proyecto en pausa';
  }
}

/**
 * Traduce los errores de Supabase Auth a mensajes en espanol.
 *
 * Regla: nunca ocultar el error original. La version anterior mandaba
 * cualquier mensaje con la palabra "fetch" a un generico de red, lo que
 * enmascaraba la causa real y hacia imposible diagnosticar.
 */
export function mensajeDeError(err) {
  const m = String(err?.message || err || '');
  const codigo = err?.code || err?.name || '';

  if (/Invalid login credentials/i.test(m)) {
    return 'Correo o contrasena incorrectos.';
  }
  if (/Email not confirmed/i.test(m)) {
    return 'El usuario existe pero su correo no esta confirmado. Confirmalo en '
         + 'Supabase - Authentication - Users (boton ... - Confirm email).';
  }
  if (/rate limit|too many/i.test(m)) {
    return 'Demasiados intentos seguidos. Espera un minuto y reintenta.';
  }
  if (/signups? not allowed|disable/i.test(m)) {
    return 'El registro esta deshabilitado en el proyecto. El usuario debe crearse desde el Dashboard.';
  }

  // Fallo de red real: solo cuando la libreria lo marca como tal.
  if (err?.name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|load failed/i.test(m)) {
    return 'No se pudo contactar con Supabase. Detalle tecnico: ' + m;
  }

  // Cualquier otro caso se muestra tal cual, con su codigo.
  return m ? (m + (codigo ? ' [' + codigo + ']' : '')) : 'No se pudo iniciar sesion.';
}
