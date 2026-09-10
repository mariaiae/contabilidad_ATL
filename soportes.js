// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENTOS SOPORTE — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// Sube los archivos adjuntos de un asiento al bucket privado `soportes` y
// genera enlaces temporales para consultarlos.
//
// El bucket NO es público (ver sql/006): la descarga siempre pasa por una URL
// firmada de vida corta, que solo la app puede pedir con sesión iniciada.
import { supabase } from './supabase.js';
import { esAuditor } from './auth.js';

const BUCKET = 'soportes';
const TAMANO_MAXIMO = 10 * 1024 * 1024;   // 10 MB, igual que el limite del bucket
const TIPOS_PERMITIDOS = ['application/pdf', 'image/png', 'image/jpeg'];
const EXTENSIONES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

/**
 * Valida el archivo antes de gastar una subida.
 * @returns {string|null} mensaje de error, o null si es valido.
 */
export function validarSoporte(archivo) {
  if (!archivo) return 'No se selecciono ningun archivo.';
  if (!TIPOS_PERMITIDOS.includes(archivo.type)) {
    return 'Formato no permitido (' + (archivo.type || 'desconocido') + '). Solo PDF, PNG o JPG.';
  }
  if (archivo.size > TAMANO_MAXIMO) {
    const mb = (archivo.size / 1024 / 1024).toFixed(1);
    return 'El archivo pesa ' + mb + ' MB y el maximo son 10 MB.';
  }
  return null;
}

/** Nombre limpio y unico dentro de la carpeta del asiento. */
function rutaDeArchivo(asientoId, archivo) {
  const ext = EXTENSIONES[archivo.type] || 'bin';
  const base = String(archivo.name || 'soporte')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quitar tildes
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 60) || 'soporte';
  return asientoId + '/' + Date.now() + '-' + base + '.' + ext;
}

/**
 * Sube el archivo y deja su ruta en `asientos.soporte_archivo`.
 *
 * Se llama DESPUES de crear el asiento porque la ruta se organiza por su id.
 * Si la subida falla, el asiento se conserva: perder un apunte contable
 * cuadrado por un fallo al adjuntar seria peor que quedarse sin el adjunto.
 *
 * @returns {Promise<{ok: boolean, ruta?: string, error?: string}>}
 */
export async function adjuntarSoporte(archivo, asientoId) {
  const problema = validarSoporte(archivo);
  if (problema) return { ok: false, error: problema };

  const ruta = rutaDeArchivo(asientoId, archivo);

  const { error: errSubida } = await supabase.storage
    .from(BUCKET)
    .upload(ruta, archivo, { contentType: archivo.type, upsert: false });

  if (errSubida) {
    console.error('[Soportes] Fallo la subida:', errSubida);
    // sql/014: el comercial solo sube a un asiento existente que aun no tiene soporte.
    const sinPermiso = /row-level security|violates.*policy|unauthorized|403/i.test(errSubida.message || '');
    return {
      ok: false,
      error: sinPermiso
        ? 'No tienes permiso para adjuntar un documento a este registro: puede que ya tenga soporte.'
        : errSubida.message,
    };
  }

  const { error: errFila } = await supabase
    .from('asientos')
    .update({ soporte_archivo: ruta })
    .eq('id', asientoId);

  if (errFila) {
    // El binario quedaria huerfano en Storage sin nadie que lo referencie. Solo
    // el auditor puede retirarlo (sql/014); si subio un comercial, se deja
    // registrado para que el auditor lo limpie.
    if (esAuditor()) {
      console.error('[Soportes] Subido pero no se pudo enlazar; se retira:', errFila);
      await supabase.storage.from(BUCKET).remove([ruta]);
    } else {
      console.warn('[Soportes] Subido pero no se pudo enlazar; queda sin referencia (solo un auditor puede retirarlo):', ruta, errFila);
    }
    return { ok: false, error: errFila.message };
  }

  return { ok: true, ruta };
}

/**
 * URL temporal para ver o descargar un soporte.
 * @param {string} ruta valor de `asientos.soporte_archivo`
 * @param {number} segundos validez del enlace
 */
export async function urlDeSoporte(ruta, segundos = 120) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(ruta, segundos);

  if (error) {
    console.error('[Soportes] No se pudo firmar la URL:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true, url: data.signedUrl };
}

/** Nombre legible a partir de la ruta almacenada. */
export function nombreDeSoporte(ruta) {
  const archivo = String(ruta || '').split('/').pop() || '';
  return archivo.replace(/^\d+-/, '');   // quitar la marca de tiempo
}
