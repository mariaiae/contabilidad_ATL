-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Seguridad por roles en la base de datos (RLS)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/008)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí las restricciones del rol `comercial` eran de INTERFAZ: con la
-- consola del navegador podía leer las líneas contables, el plan de cuentas,
-- y editar o borrar asientos. Este script las traslada al servidor.
--
-- MATRIZ DE PERMISOS
--   Tabla              auditor   comercial
--   asientos           todo      leer y crear · editar: SOLO adjuntar el soporte
--                                a un asiento que no lo tiene · borrar: SOLO una
--                                cabecera sin líneas (reversión de un guardado fallido)
--   asiento_detalles   todo      SOLO crear, y solo en un asiento sin líneas.
--                                NO puede leerlas.
--   plan_cuentas       todo      nada, ni siquiera leer
--   socios             todo      solo leer
--   domiciliarios      todo      solo leer
--   profiles           (sin cambios respecto a sql/008)
--   storage soportes   todo      subir · leer y retirar solo lo que él subió
--
-- POR QUÉ HAY UNA FUNCIÓN DE CIFRAS AGREGADAS
--   Los totales de venta, el IVA, la retención, los indicadores y el saldo por
--   cobrar de cada domiciliario se calculan desde las líneas. Si el comercial
--   no puede leerlas, `metricas_asientos()` le entrega solo esas cifras ya
--   sumadas, nunca las líneas con sus cuentas y descripciones. Sin ella, al
--   liquidar nómina no descontaría las cuentas por cobrar.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
-- Si algo falta, se detiene ANTES de endurecer ninguna política.
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Falta sql/008: la tabla public.profiles no existe.';
  end if;
  if not exists (select 1 from public.profiles where role = 'auditor') then
    raise exception 'No hay ningún auditor. Ejecuta sql/respaldo_restaurar_auditor.sql antes de continuar.';
  end if;
end;
$$;

-- ── 1. Rol del usuario actual ─────────────────────────────────────────────
-- SECURITY DEFINER: lee `profiles` sin pasar por su RLS (evita recursión).
-- STABLE + `(select ...)` en las políticas: se evalúa una vez por consulta,
-- no una vez por fila.
create or replace function public.get_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

revoke all on function public.get_user_role() from public, anon;
grant execute on function public.get_user_role() to authenticated;

-- es_auditor() (sql/008) pasa a apoyarse en get_user_role(): una sola fuente.
create or replace function public.es_auditor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.get_user_role() = 'auditor', false);
$$;

-- ── 2. ¿El asiento aún no tiene líneas? ───────────────────────────────────
-- Tiene que saltarse la RLS: el comercial no puede leer `asiento_detalles`, así
-- que una subconsulta normal le devolvería siempre "sin líneas" y le permitiría
-- borrar cualquier asiento (el borrado arrastra sus líneas en cascada).
create or replace function public.asiento_sin_lineas(p_asiento_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1 from public.asiento_detalles d where d.asiento_id = p_asiento_id
  );
$$;

revoke all on function public.asiento_sin_lineas(bigint) from public, anon;
grant execute on function public.asiento_sin_lineas(bigint) to authenticated;

-- ── 3. Cifras agregadas por asiento ───────────────────────────────────────
-- Única ventana del comercial a los importes. Las fórmulas deben coincidir con
-- metricasDe() en app.js.
create or replace function public.metricas_asientos(p_modulo text default null)
returns table (
  asiento_id      bigint,
  total_debito    numeric,
  total_credito   numeric,
  iva             numeric,   -- crédito en 2408
  retencion       numeric,   -- crédito en 2370
  cxc_neto        numeric,   -- débito − crédito en 1455
  ingreso         numeric,   -- crédito en 4135
  cobro_banco     numeric,   -- débito en 1110
  aporte_capital  numeric,   -- crédito en 3105 + 3120
  retiro          numeric,   -- débito en 3705
  gasto_general   numeric,   -- débito en 5199
  gasto_dotacion  numeric,   -- débito en 5120
  gasto_poliza    numeric    -- débito en 5150
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    d.asiento_id,
    coalesce(sum(d.debito), 0),
    coalesce(sum(d.credito), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '2408'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '2370'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '1455'), 0)
      - coalesce(sum(d.credito) filter (where d.cuenta = '1455'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '4135'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '1110'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta in ('3105', '3120')), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '3705'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '5199'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '5120'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '5150'), 0)
  from public.asiento_detalles d
  join public.asientos a on a.id = d.asiento_id
  where (select public.get_user_role()) in ('auditor', 'comercial')
    and (p_modulo is null or a.modulo = p_modulo)
  group by d.asiento_id;
$$;

revoke all on function public.metricas_asientos(text) from public, anon;
grant execute on function public.metricas_asientos(text) to authenticated;

-- ── 4. Edición de asientos: el comercial solo adjunta el soporte ──────────
-- La RLS no puede comparar el valor anterior con el nuevo; un trigger sí.
create or replace function public.restringir_edicion_asientos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Sin usuario de la API (SQL Editor, service_role) o auditor: sin límites.
  if auth.uid() is null or public.es_auditor() then
    return new;
  end if;

  -- Comercial: únicamente fijar `soporte_archivo` si todavía está vacío. Se
  -- compara la fila completa sin esa columna, así cualquier columna futura
  -- queda protegida sin tocar este trigger.
  if old.soporte_archivo is not null
     or (to_jsonb(new) - 'soporte_archivo') is distinct from (to_jsonb(old) - 'soporte_archivo') then
    raise exception 'Tu perfil no puede modificar asientos registrados; solo adjuntar su documento soporte.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists restringir_edicion_asientos on public.asientos;
create trigger restringir_edicion_asientos
  before update on public.asientos
  for each row execute function public.restringir_edicion_asientos();

-- ── 5. Retirar las políticas anteriores ───────────────────────────────────
drop policy if exists auth_all_asientos        on public.asientos;
drop policy if exists auth_all_detalles        on public.asiento_detalles;
drop policy if exists auth_all_socios          on public.socios;
drop policy if exists auth_all_domiciliarios   on public.domiciliarios;
drop policy if exists auth_all_plan_cuentas    on public.plan_cuentas;
drop policy if exists plan_cuentas_leer        on public.plan_cuentas;
drop policy if exists plan_cuentas_insertar    on public.plan_cuentas;
drop policy if exists plan_cuentas_actualizar  on public.plan_cuentas;
drop policy if exists plan_cuentas_borrar      on public.plan_cuentas;

-- Nombres de este script, para poder reejecutarlo.
drop policy if exists asientos_leer            on public.asientos;
drop policy if exists asientos_insertar        on public.asientos;
drop policy if exists asientos_actualizar      on public.asientos;
drop policy if exists asientos_borrar          on public.asientos;
drop policy if exists detalles_leer            on public.asiento_detalles;
drop policy if exists detalles_insertar        on public.asiento_detalles;
drop policy if exists detalles_actualizar      on public.asiento_detalles;
drop policy if exists detalles_borrar          on public.asiento_detalles;
drop policy if exists plan_cuentas_auditor     on public.plan_cuentas;
drop policy if exists socios_leer              on public.socios;
drop policy if exists socios_escribir          on public.socios;
drop policy if exists domiciliarios_leer       on public.domiciliarios;
drop policy if exists domiciliarios_escribir   on public.domiciliarios;

-- ── 6. asientos (cabeceras) ───────────────────────────────────────────────
create policy asientos_leer on public.asientos
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

create policy asientos_insertar on public.asientos
  for insert to authenticated
  with check ((select public.get_user_role()) in ('auditor', 'comercial'));

-- La RLS deja pasar a ambos roles; el trigger del paso 4 limita al comercial.
create policy asientos_actualizar on public.asientos
  for update to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'))
  with check ((select public.get_user_role()) in ('auditor', 'comercial'));

-- El comercial solo borra cabeceras SIN líneas: es lo que hace la app para
-- deshacer un guardado cuyas líneas fallaron.
create policy asientos_borrar on public.asientos
  for delete to authenticated
  using (
    (select public.es_auditor())
    or ((select public.get_user_role()) = 'comercial' and public.asiento_sin_lineas(id))
  );

-- ── 7. asiento_detalles (líneas contables) ────────────────────────────────
create policy detalles_leer on public.asiento_detalles
  for select to authenticated
  using ((select public.es_auditor()));

-- El comercial solo añade líneas a un asiento que aún no tiene ninguna, así no
-- puede alterar un asiento ya registrado. Las líneas de un mismo guardado van
-- en una sola sentencia, y la función ve el estado previo a esa sentencia.
create policy detalles_insertar on public.asiento_detalles
  for insert to authenticated
  with check (
    (select public.es_auditor())
    or ((select public.get_user_role()) = 'comercial' and public.asiento_sin_lineas(asiento_id))
  );

create policy detalles_actualizar on public.asiento_detalles
  for update to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

create policy detalles_borrar on public.asiento_detalles
  for delete to authenticated
  using ((select public.es_auditor()));

-- ── 8. plan_cuentas: exclusivo del auditor ────────────────────────────────
-- La clave foránea de sql/007 sigue validando las cuentas de un comercial:
-- las comprobaciones de integridad referencial no están sujetas a RLS.
create policy plan_cuentas_auditor on public.plan_cuentas
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

-- ── 9. Datos maestros: lectura para ambos, escritura para el auditor ──────
create policy socios_leer on public.socios
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

create policy socios_escribir on public.socios
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

create policy domiciliarios_leer on public.domiciliarios
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

create policy domiciliarios_escribir on public.domiciliarios
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

-- ── 10. Documentos soporte (Storage) ──────────────────────────────────────
-- El comercial sube soportes y solo ve o retira los suyos. Eso requiere la
-- columna `owner_id` de storage.objects; si esta versión no la tiene, el
-- comercial podrá subir pero no leer ni retirar (se avisa con un NOTICE).
do $$
declare
  hay_owner_id boolean := exists (
    select 1 from information_schema.columns
    where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner_id'
  );
  propio text := case when hay_owner_id
    then ' or ((select public.get_user_role()) = ''comercial'' and owner_id = (select auth.uid())::text)'
    else '' end;
begin
  execute 'drop policy if exists soportes_leer on storage.objects';
  execute 'drop policy if exists soportes_subir on storage.objects';
  execute 'drop policy if exists soportes_actualizar on storage.objects';
  execute 'drop policy if exists soportes_borrar on storage.objects';

  execute 'create policy soportes_leer on storage.objects for select to authenticated '
    || 'using (bucket_id = ''soportes'' and ((select public.es_auditor())' || propio || '))';

  execute 'create policy soportes_subir on storage.objects for insert to authenticated '
    || 'with check (bucket_id = ''soportes'' and (select public.get_user_role()) in (''auditor'', ''comercial''))';

  execute 'create policy soportes_actualizar on storage.objects for update to authenticated '
    || 'using (bucket_id = ''soportes'' and (select public.es_auditor())) '
    || 'with check (bucket_id = ''soportes'' and (select public.es_auditor()))';

  execute 'create policy soportes_borrar on storage.objects for delete to authenticated '
    || 'using (bucket_id = ''soportes'' and ((select public.es_auditor())' || propio || '))';

  if not hay_owner_id then
    raise notice 'storage.objects no tiene owner_id: el comercial podrá subir soportes, pero no leerlos ni retirarlos.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

-- ── 11. Comprobación ──────────────────────────────────────────────────────
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where (schemaname = 'public'
       and tablename in ('asientos', 'asiento_detalles', 'plan_cuentas',
                         'socios', 'domiciliarios', 'profiles'))
   or (schemaname = 'storage' and policyname like 'soportes_%')
order by schemaname, tablename, policyname;
