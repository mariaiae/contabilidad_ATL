-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Documentos soporte adjuntos
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta ahora el campo "Adjunta documento soporte" del formulario existía en
-- la interfaz pero el archivo se descartaba en silencio. Esto crea el destino.
--
-- La columna guarda la RUTA dentro del bucket, no el archivo. El binario vive
-- en Storage; la tabla solo lo referencia.

alter table public.asientos add column if not exists soporte_archivo text;

-- ── Bucket privado ─────────────────────────────────────────────────────────
-- `public = false` es deliberado: los soportes contables (facturas, actas,
-- consignaciones) llevan datos de terceros y no deben quedar accesibles por
-- URL a cualquiera que la adivine. El acceso se hace con URLs firmadas de
-- vida corta que genera la aplicación para usuarios autenticados.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'soportes',
  'soportes',
  false,
  10485760,                                              -- 10 MB por archivo
  array['application/pdf', 'image/png', 'image/jpeg']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Políticas de Storage ───────────────────────────────────────────────────
-- Mismo criterio que sql/005: solo usuarios autenticados. El rol `anon` no
-- aparece en ninguna política, así que no puede leer ni subir nada.
drop policy if exists soportes_leer      on storage.objects;
drop policy if exists soportes_subir     on storage.objects;
drop policy if exists soportes_actualizar on storage.objects;
drop policy if exists soportes_borrar    on storage.objects;

create policy soportes_leer on storage.objects
  for select to authenticated
  using (bucket_id = 'soportes');

create policy soportes_subir on storage.objects
  for insert to authenticated
  with check (bucket_id = 'soportes');

create policy soportes_actualizar on storage.objects
  for update to authenticated
  using (bucket_id = 'soportes')
  with check (bucket_id = 'soportes');

create policy soportes_borrar on storage.objects
  for delete to authenticated
  using (bucket_id = 'soportes');

-- ── Comprobación ───────────────────────────────────────────────────────────
select id, name, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'soportes';
