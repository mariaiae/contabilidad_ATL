import { defineConfig } from 'vite';

export default defineConfig({
  // Por defecto Vite solo expone al navegador las variables que empiezan por
  // VITE_. Este proyecto tiene las credenciales de Supabase con el prefijo
  // NEXT_PUBLIC_, así que se añade a la lista para no tener que duplicarlas
  // en .env (donde se perdían cada vez que el archivo se reescribía).
  //
  // Ojo: todo lo que lleve uno de estos prefijos termina embebido en el
  // bundle público. Nunca pongas aquí la service_role key.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
});
