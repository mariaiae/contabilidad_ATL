// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE SUPABASE — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// Las credenciales viven en .env. Vite solo expone al navegador los prefijos
// declarados en `envPrefix` (ver vite.config.mjs): VITE_ y NEXT_PUBLIC_.
//
// El nombre exacto de las variables ha ido cambiando entre revisiones
// (PUBLISHABLE_KEY / ANON_KEY, prefijo VITE_ / NEXT_PUBLIC_), así que en vez de
// exigir uno concreto se busca el primero que exista entre los habituales.
//
// Tras editar .env hay que REINICIAR el servidor de Vite: las variables se leen
// al arrancar, no en caliente.
import { createClient } from '@supabase/supabase-js';

const env = import.meta.env;

/** Devuelve el valor de la primera variable de entorno que exista. */
const pick = (...nombres) => {
  for (const n of nombres) {
    const v = env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
};

const SUPABASE_URL = pick(
  'VITE_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
);

const SUPABASE_KEY = pick(
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  // Sin credenciales createClient() lanza al importar y app.js entero deja de
  // ejecutarse, lo que deja muerta toda la app (navegación, nómina, impuestos),
  // no solo el módulo de socios. Por eso el mensaje es explícito.
  const faltan = [
    !SUPABASE_URL ? 'la URL (VITE_SUPABASE_URL)' : null,
    !SUPABASE_KEY ? 'la clave (VITE_SUPABASE_ANON_KEY)' : null,
  ].filter(Boolean).join(' y ');

  throw new Error(
    `Faltan las credenciales de Supabase: no se encontró ${faltan} en .env. ` +
    'Revisa el archivo y reinicia el servidor de Vite.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

export default supabase;
