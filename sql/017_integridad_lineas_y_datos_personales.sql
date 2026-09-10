-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Integridad de líneas, hora de Colombia y datos personales
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/016)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. LÍNEAS CONTABLES VÁLIDAS
--    La partida doble ya estaba garantizada, pero una línea podía llevar un
--    valor negativo, débito y crédito a la vez, o ir a una cuenta de grupo
--    («11 Disponible»). Un asiento así cuadra y aun así distorsiona los saldos.
--    Ahora cada línea lleva un valor mayor que cero en UNA sola columna y solo
--    se registra en cuentas de detalle.
--
-- 2. HORA DE COLOMBIA
--    La base trabajaba en UTC: cuando un registro no trae fecha, `current_date`
--    daba el día siguiente desde las 7:00 p. m. La base pasa a America/Bogota.
--    Las marcas de tiempo (timestamptz) no cambian: solo cómo se interpretan.
--
-- 3. DATOS PERSONALES (Ley 1581 de 2012)
--    La cédula y el teléfono de los domiciliarios y el documento de los socios
--    quedan solo para el auditor. El comercial recibe las listas sin esos datos.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
declare
  v_malas text;
begin
  if to_regprocedure('public.validar_partida_doble()') is null then
    raise exception 'Falta sql/012: la función public.validar_partida_doble() no existe.';
  end if;

  select string_agg(a.comprobante || ' (' || d.cuenta || ')', ', ' order by d.id) into v_malas
  from public.asiento_detalles d
  join public.asientos a on a.id = d.asiento_id
  where d.debito < 0 or d.credito < 0 or (d.debito > 0) = (d.credito > 0);
  if v_malas is not null then
    raise exception 'Estas líneas no cumplen la regla de valores (negativas, en cero o con débito y crédito a la vez): %. Corrígelas antes de continuar.', v_malas;
  end if;

  select string_agg(distinct d.cuenta, ', ') into v_malas
  from public.asiento_detalles d
  left join public.plan_cuentas p on p.codigo = d.cuenta
  where not coalesce(p.es_cuenta_detalle, false);
  if v_malas is not null then
    raise exception 'Hay líneas en cuentas que no son de detalle: %. Corrígelas antes de continuar.', v_malas;
  end if;
end;
$$;

-- ── 1. Valores de cada línea ──────────────────────────────────────────────
alter table public.asiento_detalles
  drop constraint if exists asiento_detalles_montos_validos;
alter table public.asiento_detalles
  add constraint asiento_detalles_montos_validos
  check (debito >= 0 and credito >= 0 and (debito > 0) <> (credito > 0));

-- ── 2. Solo cuentas de detalle ────────────────────────────────────────────
-- SECURITY DEFINER: el comercial no puede leer el plan de cuentas (sql/009) y
-- con una consulta normal toda cuenta le parecería inexistente.
create or replace function public.validar_cuenta_detalle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.plan_cuentas
    where codigo = new.cuenta and es_cuenta_detalle
  ) then
    raise exception 'La cuenta % no admite movimientos: no existe o es un grupo del plan de cuentas.', new.cuenta
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists validar_cuenta_detalle on public.asiento_detalles;
create trigger validar_cuenta_detalle
  before insert or update of cuenta on public.asiento_detalles
  for each row execute function public.validar_cuenta_detalle();

-- Una cuenta con movimientos no puede volverse grupo: sus líneas quedarían
-- registradas en una cuenta que ya no admite movimientos.
create or replace function public.proteger_cuentas_con_movimientos()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.es_cuenta_detalle and not new.es_cuenta_detalle
     and exists (select 1 from public.asiento_detalles where cuenta = old.codigo) then
    raise exception 'La cuenta % tiene movimientos: no puede dejar de ser cuenta de detalle.', old.codigo
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists proteger_cuentas_con_movimientos on public.plan_cuentas;
create trigger proteger_cuentas_con_movimientos
  before update of es_cuenta_detalle on public.plan_cuentas
  for each row execute function public.proteger_cuentas_con_movimientos();

-- ── 3. Hora de Colombia ───────────────────────────────────────────────────
-- Aplica a las conexiones nuevas; las que ya están abiertas lo toman al
-- renovarse (puede tardar unos minutos).
do $$
begin
  execute format('alter database %I set timezone to %L', current_database(), 'America/Bogota');
end;
$$;

-- ── 4. Datos personales solo para el auditor ──────────────────────────────
drop policy if exists domiciliarios_leer on public.domiciliarios;
create policy domiciliarios_leer on public.domiciliarios
  for select to authenticated
  using ((select public.es_auditor()));

drop policy if exists socios_leer on public.socios;
create policy socios_leer on public.socios
  for select to authenticated
  using ((select public.es_auditor()));

-- Listas sin cédula ni teléfono, para ambos roles. Solo registros activos.
create or replace function public.domiciliarios_lista()
returns table (id text, nombre text, placa text, ingreso date)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.nombre, d.placa, d.ingreso
  from public.domiciliarios d
  where d.activo
    and (select public.get_user_role()) in ('auditor', 'comercial')
  order by d.id;
$$;

create or replace function public.socios_lista()
returns table (id text, nombre text)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.nombre
  from public.socios s
  where s.activo
    and (select public.get_user_role()) in ('auditor', 'comercial')
  order by s.id;
$$;

revoke all on function public.domiciliarios_lista() from public, anon;
grant execute on function public.domiciliarios_lista() to authenticated;
revoke all on function public.socios_lista() from public, anon;
grant execute on function public.socios_lista() to authenticated;

notify pgrst, 'reload schema';

-- ── 5. Comprobación ───────────────────────────────────────────────────────
-- Debe listar la restricción, los 2 triggers, la zona horaria America/Bogota
-- y las 2 políticas de lectura exclusivas del auditor.
select 'restriccion' as tipo, conname::text as detalle, 'una sola columna, mayor que cero' as valor
from pg_constraint
where conname = 'asiento_detalles_montos_validos'
union all
select 'trigger', tgname::text, 'activo'
from pg_trigger
where tgname in ('validar_cuenta_detalle', 'proteger_cuentas_con_movimientos') and not tgisinternal
union all
select 'zona horaria de la base', current_database()::text, array_to_string(s.setconfig, ', ')
from pg_db_role_setting s
join pg_database d on d.oid = s.setdatabase
where d.datname = current_database() and s.setrole = 0
union all
select 'politica', tablename || ' · ' || policyname, 'solo auditor'
from pg_policies
where schemaname = 'public' and policyname in ('domiciliarios_leer', 'socios_leer');
