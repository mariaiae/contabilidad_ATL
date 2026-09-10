import { defineConfig, loadEnv } from 'vite';

// Por defecto Vite solo expone al navegador las variables que empiezan por
// VITE_. Este proyecto tiene las credenciales de Supabase con el prefijo
// NEXT_PUBLIC_, así que se añade a la lista para no tener que duplicarlas
// en .env (donde se perdían cada vez que el archivo se reescribía).
//
// Ojo: todo lo que lleve uno de estos prefijos termina embebido en el
// bundle público. Nunca pongas aquí la service_role key.
const PREFIJOS = ['VITE_', 'NEXT_PUBLIC_'];

/**
 * Content-Security-Policy de la app.
 *
 * `script-src 'self'` impide ejecutar JavaScript que no venga de nuestros
 * propios archivos: aunque un texto con código llegara a pintarse en pantalla
 * (una descripción maliciosa, por ejemplo), el navegador no lo ejecuta. Por eso
 * la app no puede usar atributos onclick/oninput en el HTML.
 *
 * `connect-src` limita las conexiones al origen exacto del proyecto de Supabase:
 * un script inyectado tampoco podría enviar el token de sesión a otro servidor.
 *
 * Los estilos en línea se permiten ('unsafe-inline'): la interfaz los usa mucho
 * y no permiten ejecutar código.
 *
 * Una meta CSP no admite `frame-ancestors`: la protección contra clickjacking
 * debe enviarse como cabecera HTTP desde el hosting de producción.
 */
function politicaDeSeguridad(env, desarrollo) {
  const url = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';
  const conexiones = ["'self'"];
  try {
    const { protocol, host } = new URL(url);
    conexiones.push(`${protocol}//${host}`, `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}`);
  } catch {
    // Sin URL válida la app muestra su propio error de configuración.
  }
  // Recarga en caliente del servidor de desarrollo de Vite.
  if (desarrollo) conexiones.push('ws://localhost:*', 'ws://127.0.0.1:*');

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    `connect-src ${conexiones.join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
  ].join('; ');
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), PREFIJOS);

  return {
    envPrefix: PREFIJOS,
    plugins: [
      {
        name: 'atl-content-security-policy',
        transformIndexHtml() {
          return [{
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: politicaDeSeguridad(env, command === 'serve'),
            },
            injectTo: 'head-prepend',
          }];
        },
      },
    ],
  };
});
