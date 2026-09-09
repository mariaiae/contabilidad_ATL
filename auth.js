// ─────────────────────────────────────────────────────────────────────────────
// AUTENTICACIÓN — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// Envuelve Supabase Auth. La aplicación no carga ningún dato hasta que hay
// sesión activa, y las políticas RLS (ver sql/005) rechazan al rol `anon`,
// así que la puerta está cerrada en el cliente y en la base.
//
// Los usuarios NO se crean desde aquí: se dan de alta en
// Supabase Dashboard → Authentication → Users. La app solo inicia sesión.
import { supabase } from './supabase.js';

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
  return data.session;
}

/** Cierra la sesión y limpia el token almacenado. */
export async function cerrarSesion() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Reacciona a los cambios de sesión (login, logout, token renovado o vencido).
 * @param {(session: object|null) => void} alCambiar
 */
export function observarSesion(alCambiar) {
  const { data } = supabase.auth.onAuthStateChange((_evento, session) => alCambiar(session));
  return data.subscription;
}

/** Traduce los errores de Supabase Auth a mensajes en español. */
export function mensajeDeError(err) {
  const m = String(err?.message || err || '');
  if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
  if (/Email not confirmed/i.test(m)) return 'La cuenta existe pero el correo no está confirmado.';
  if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera un momento.';
  if (/fetch|network/i.test(m)) return 'Sin conexión con Supabase. Revisa tu red.';
  return m || 'No se pudo iniciar sesión.';
}
