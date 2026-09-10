-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Cuentas nuevas sin acceso hasta que un auditor las apruebe
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/009)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PROBLEMA
--   El registro público de Supabase Auth estaba habilitado y todo usuario nuevo
--   nacía con rol `comercial`. Con la clave pública que viaja en la app,
--   cualquiera podía crearse una cuenta y leer asientos, terceros y soportes.
--
-- DOS CERROJOS
--   1. Panel de Supabase (lo hace una persona, no este script):
--      Authentication → Sign In / Providers → desactivar
--      «Allow new users to sign up». Los usuarios se crean o invitan desde
--      Authentication → Users.
--   2. Este script, por si el registro se reactiva por error:
--      todo usuario nuevo nace `pendiente`. Todas las políticas exigen
--      `auditor` o `comercial`, así que un pendiente no ve ni escribe nada.
--
-- APROBAR UN USUARIO (desde el SQL Editor)
--   update public.profiles set role = 'comercial'
--   where lower(email) = lower('correo@empresa.com');
--
-- Los usuarios que ya existen conservan su rol.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.get_user_role()') is null then
    raise exception 'Falta sql/009: la función public.get_user_role() no existe.';
  end if;
  if not exists (select 1 from public.profiles where role = 'auditor') then
    raise exception 'No hay ningún auditor. Ejecuta sql/respaldo_restaurar_auditor.sql antes de continuar.';
  end if;
end;
$$;

-- ── 1. Nuevo rol permitido ────────────────────────────────────────────────
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('pendiente', 'comercial', 'auditor'));

alter table public.profiles alter column role set default 'pendiente';

-- ── 2. Todo usuario nuevo nace pendiente ──────────────────────────────────
create or replace function public.crear_perfil_usuario()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'pendiente')
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ── 3. Comprobación ───────────────────────────────────────────────────────
-- a) Usuarios por rol: los existentes siguen como estaban.
-- b) Políticas que NO consultan el rol: un usuario pendiente podría pasarlas.
--    Debe devolver 0 filas de ese tipo.
-- c) Rol por defecto de la columna y del trigger.
select 'usuarios' as tipo, role::text as detalle, count(*)::text as valor
from public.profiles
group by role
union all
select 'politica sin control de rol', schemaname || '.' || tablename || ' · ' || policyname, cmd::text
from pg_policies
where (schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects'))
  and ('authenticated' = any (roles) or 'public' = any (roles))
  and coalesce(qual, '') !~ '(get_user_role|es_auditor)'
  and coalesce(with_check, '') !~ '(get_user_role|es_auditor)'
union all
select 'rol por defecto', 'columna profiles.role',
       (select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'profiles' and column_name = 'role')
union all
select 'rol por defecto', 'trigger crear_perfil_usuario',
       case when prosrc like '%''pendiente''%' then 'pendiente' else 'REVISAR' end
from pg_proc
where proname = 'crear_perfil_usuario' and pronamespace = 'public'::regnamespace;
