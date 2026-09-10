-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Soportes documentales por rol
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/009)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BUCKET
--   Se mantiene el bucket PRIVADO `soportes` (sql/006). No se crea otro ni se
--   hace público: los soportes llevan NIT, valores y datos personales.
--
-- QUÉ SE GUARDA EN LA BASE
--   `asientos.soporte_archivo` guarda la RUTA del archivo dentro del bucket
--   ({asiento_id}/{marca de tiempo}-{nombre}), nunca una URL. Para verlo, la
--   app genera un enlace firmado de 120 segundos en el momento del clic. Una
--   URL guardada caducaría (firmada) o sería accesible a cualquiera (pública).
--
-- MATRIZ DE PERMISOS DEL BUCKET (reemplaza la de sql/009)
--   Acción                  auditor                 comercial
--   Ver / descargar         todos los soportes      todos los soportes
--   Subir                   a cualquier asiento     solo a un asiento que aún
--                                                   no tiene soporte
--   Reemplazar (update)     sí                      no
--   Eliminar                sí                      no
--
-- INTEGRIDAD DE `asientos.soporte_archivo`
--   · Solo acepta rutas con el formato de la app, dentro de la carpeta de su
--     propio asiento: no se puede apuntar al soporte de otro registro ni
--     guardar una URL.
--   · El archivo debe existir en el bucket al enlazarlo.
--   · Sigue vigente sql/009: el comercial solo llena un soporte vacío; cambiarlo
--     o quitarlo es exclusivo del auditor.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
declare
  v_malas text;
begin
  if to_regprocedure('public.restringir_edicion_asientos()') is null then
    raise exception 'Falta sql/009: la función public.restringir_edicion_asientos() no existe.';
  end if;
  if not exists (select 1 from storage.buckets where id = 'soportes') then
    raise exception 'Falta sql/006: el bucket soportes no existe.';
  end if;

  select string_agg(comprobante || ' (' || soporte_archivo || ')', ', ' order by id) into v_malas
  from public.asientos
  where soporte_archivo is not null
    and not (soporte_archivo ~ '^[0-9]+/[^/]+$' and split_part(soporte_archivo, '/', 1) = id::text);

  if v_malas is not null then
    raise exception 'Estos asientos tienen un soporte con una ruta que no corresponde a su carpeta: %. Corrígelos antes de continuar.', v_malas;
  end if;
end;
$$;

-- ── 1. Bucket: privado, 10 MB, PDF / PNG / JPG ────────────────────────────
update storage.buckets
set public             = false,
    file_size_limit    = 10485760,
    allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg']
where id = 'soportes';

-- ── 2. ¿Se puede subir un archivo a esta ruta? ────────────────────────────
-- SECURITY DEFINER: consulta `asientos` sin depender de la RLS de quien sube.
-- El primer segmento de la ruta debe ser el id de un asiento existente; para
-- el comercial, además, ese asiento no debe tener soporte todavía.
create or replace function public.soporte_ruta_permitida(p_ruta text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_ruta ~ '^[0-9]{1,18}/[^/]+$' then exists (
      select 1
      from public.asientos a
      where a.id = split_part(p_ruta, '/', 1)::bigint
        and (public.es_auditor() or a.soporte_archivo is null)
    )
    else false
  end;
$$;

revoke all on function public.soporte_ruta_permitida(text) from public, anon;
grant execute on function public.soporte_ruta_permitida(text) to authenticated;

-- ── 3. Políticas del bucket ───────────────────────────────────────────────
drop policy if exists soportes_leer       on storage.objects;
drop policy if exists soportes_subir      on storage.objects;
drop policy if exists soportes_actualizar on storage.objects;
drop policy if exists soportes_borrar     on storage.objects;

create policy soportes_leer on storage.objects
  for select to authenticated
  using (bucket_id = 'soportes'
         and (select public.get_user_role()) in ('auditor', 'comercial'));

create policy soportes_subir on storage.objects
  for insert to authenticated
  with check (bucket_id = 'soportes'
              and (select public.get_user_role()) in ('auditor', 'comercial')
              and public.soporte_ruta_permitida(name));

-- Reemplazar un archivo cambiaría una factura ya registrada: solo auditor.
create policy soportes_actualizar on storage.objects
  for update to authenticated
  using ((bucket_id = 'soportes') and (select public.es_auditor()))
  with check ((bucket_id = 'soportes') and (select public.es_auditor()));

create policy soportes_borrar on storage.objects
  for delete to authenticated
  using ((bucket_id = 'soportes') and (select public.es_auditor()));

-- ── 4. Integridad de asientos.soporte_archivo ─────────────────────────────
alter table public.asientos
  drop constraint if exists asientos_soporte_archivo_ruta;
alter table public.asientos
  add constraint asientos_soporte_archivo_ruta
  check (soporte_archivo is null
         or (soporte_archivo ~ '^[0-9]+/[^/]+$'
             and split_part(soporte_archivo, '/', 1) = id::text));

-- El archivo debe existir en el bucket en el momento de enlazarlo.
create or replace function public.validar_soporte_archivo()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.soporte_archivo is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.soporte_archivo is not distinct from old.soporte_archivo then
    return new;
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'soportes' and o.name = new.soporte_archivo
  ) then
    raise exception 'El documento soporte no existe en el almacenamiento: súbelo antes de enlazarlo.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists validar_soporte_archivo on public.asientos;
create trigger validar_soporte_archivo
  before insert or update of soporte_archivo on public.asientos
  for each row execute function public.validar_soporte_archivo();

notify pgrst, 'reload schema';

-- ── 5. Comprobación ───────────────────────────────────────────────────────
-- Debe listar 4 políticas del bucket, la restricción de ruta, el trigger y
-- cuántos soportes hay enlazados y cuántos apuntan a un archivo inexistente.
select 'politica' as tipo, policyname::text as detalle, cmd::text as valor
from pg_policies
where schemaname = 'storage' and policyname like 'soportes_%'
union all
select 'restriccion', conname::text, 'ruta dentro de la carpeta del asiento'
from pg_constraint
where conname = 'asientos_soporte_archivo_ruta'
union all
select 'trigger', tgname::text, 'el archivo debe existir al enlazarlo'
from pg_trigger
where tgname = 'validar_soporte_archivo' and not tgisinternal
union all
select 'soportes enlazados', count(*)::text,
       count(*) filter (where not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'soportes' and o.name = a.soporte_archivo
       ))::text || ' sin archivo en el bucket'
from public.asientos a
where a.soporte_archivo is not null;
