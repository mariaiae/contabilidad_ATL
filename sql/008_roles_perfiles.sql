-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Perfiles y roles de usuario (comercial / auditor)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ROLES
--   auditor    Acceso total: detalle de asientos, Libro Diario, Impuestos,
--              parámetros legales, plan de cuentas y gestión de roles.
--   comercial  Registra operaciones, sin detalle contable ni configuración.
--              Es el rol por defecto de todo usuario nuevo (mínimo privilegio).
--
-- QUÉ GARANTIZA LA BASE DE DATOS (no solo la interfaz)
--   · Nadie puede cambiarse su propio rol ni el de otro, salvo un auditor.
--   · Nunca puede quedar el sistema sin ningún auditor.
--   · Solo un auditor puede modificar el plan de cuentas.
--
-- QUÉ SIGUE SIENDO SOLO DE INTERFAZ
--   Ocultar el detalle de asientos, el Libro Diario e Impuestos al comercial.
--   Esas tablas siguen legibles para cualquier usuario autenticado.

-- ── 0. Cuenta administradora ──────────────────────────────────────────────
-- Único punto a editar si cambia el correo del administrador.
select set_config('atl.admin_email', 'isarias09@gmail.com', false);

-- ── 1. Tabla de perfiles (1:1 con auth.users) ─────────────────────────────
create table if not exists public.profiles (
  id          uuid        primary key references auth.users (id) on delete cascade,
  email       text,
  role        text        not null default 'comercial'
              check (role in ('comercial', 'auditor')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── 2. Función de rol para las políticas ──────────────────────────────────
-- SECURITY DEFINER evita la recursión infinita de RLS (una política de
-- `profiles` que a su vez lee `profiles`). search_path vacío y nombres
-- calificados: impide que un objeto homónimo en otro esquema la suplante.
create or replace function public.es_auditor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'auditor'
  );
$$;

revoke all on function public.es_auditor() from public, anon;
grant execute on function public.es_auditor() to authenticated;

-- ── 3. Perfil automático para cada usuario nuevo ──────────────────────────
create or replace function public.crear_perfil_usuario()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'comercial')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario
  after insert on auth.users
  for each row execute function public.crear_perfil_usuario();

-- ── 4. Perfiles para los usuarios que ya existen ──────────────────────────
insert into public.profiles (id, email, role)
select u.id, u.email, 'comercial'
from auth.users u
on conflict (id) do nothing;

-- ── 5. La cuenta administradora queda como auditor ────────────────────────
insert into public.profiles (id, email, role)
select u.id, u.email, 'auditor'
from auth.users u
where lower(u.email) = lower(current_setting('atl.admin_email', true))
on conflict (id) do update
  set role = 'auditor', updated_at = now();

-- Freno: si el correo no existe en auth.users no habría ningún auditor y el
-- administrador perdería el acceso técnico. Mejor detenerse aquí, ANTES de
-- restringir el plan de cuentas en el paso 8.
do $$
begin
  if not exists (select 1 from public.profiles where role = 'auditor') then
    raise exception
      'No quedó ningún auditor: el correo "%" no existe en auth.users. Corrige atl.admin_email (paso 0) y vuelve a ejecutar.',
      current_setting('atl.admin_email', true);
  end if;
end;
$$;

-- ── 6. Protección: nunca sin auditores ────────────────────────────────────
create or replace function public.proteger_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
    if old.role = 'auditor' and new.role <> 'auditor'
       and not exists (select 1 from public.profiles
                       where role = 'auditor' and id <> old.id) then
      raise exception 'No se puede quitar el rol auditor a %: es el último auditor del sistema.', old.email;
    end if;
    return new;
  end if;

  -- DELETE, incluido el que llega en cascada al eliminar el usuario en Auth.
  if old.role = 'auditor'
     and not exists (select 1 from public.profiles
                     where role = 'auditor' and id <> old.id) then
    raise exception 'No se puede eliminar a %: es el último auditor del sistema.', old.email;
  end if;
  return old;
end;
$$;

drop trigger if exists proteger_roles on public.profiles;
create trigger proteger_roles
  before update or delete on public.profiles
  for each row execute function public.proteger_roles();

-- ── 7. RLS de perfiles ────────────────────────────────────────────────────
alter table public.profiles enable row level security;

drop policy if exists perfiles_leer on public.profiles;
create policy perfiles_leer on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.es_auditor());

-- Solo un auditor cambia roles. Un comercial no puede ascenderse a sí mismo.
drop policy if exists perfiles_cambiar_rol on public.profiles;
create policy perfiles_cambiar_rol on public.profiles
  for update to authenticated
  using (public.es_auditor())
  with check (public.es_auditor());

-- Sin políticas de INSERT ni DELETE: los perfiles los crea el trigger y se van
-- con el usuario. Y privilegios de columna: desde la app, aun siendo auditor,
-- solo se puede modificar `role`.
revoke all on public.profiles from anon;
revoke insert, update, delete on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant update (role) on public.profiles to authenticated;

-- ── 8. Plan de cuentas: escritura solo para auditores ─────────────────────
-- Es la configuración contable por excelencia. Todos leen (el motor lo
-- necesita para nombrar cuentas); solo el auditor la modifica o la puebla.
drop policy if exists auth_all_plan_cuentas   on public.plan_cuentas;
drop policy if exists plan_cuentas_leer       on public.plan_cuentas;
drop policy if exists plan_cuentas_insertar   on public.plan_cuentas;
drop policy if exists plan_cuentas_actualizar on public.plan_cuentas;
drop policy if exists plan_cuentas_borrar     on public.plan_cuentas;

create policy plan_cuentas_leer on public.plan_cuentas
  for select to authenticated using (true);

create policy plan_cuentas_insertar on public.plan_cuentas
  for insert to authenticated with check (public.es_auditor());

create policy plan_cuentas_actualizar on public.plan_cuentas
  for update to authenticated
  using (public.es_auditor()) with check (public.es_auditor());

create policy plan_cuentas_borrar on public.plan_cuentas
  for delete to authenticated using (public.es_auditor());

notify pgrst, 'reload schema';

-- ── 9. Comprobación ───────────────────────────────────────────────────────
-- La cuenta administradora debe aparecer primero, como auditor.
select
  p.email,
  p.role,
  (select count(*) from public.profiles where role = 'auditor') as auditores_en_el_sistema
from public.profiles p
order by (p.role = 'auditor') desc, p.email;

-- PRUEBA OPCIONAL de la protección (no cambia nada gracias al rollback).
-- Debe fallar con "es el último auditor del sistema":
--
--   begin;
--   update public.profiles set role = 'comercial'
--   where lower(email) = lower('isarias09@gmail.com');
--   rollback;
