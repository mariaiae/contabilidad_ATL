-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Segundo factor obligatorio para el auditor
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/016)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ ANTES DE EJECUTARLO, cada auditor debe haber registrado su segundo factor
--   en la app (la pantalla «Activa la verificación en dos pasos» aparece al
--   entrar como auditor). El script se detiene si algún auditor no lo tiene.
--
-- QUÉ HACE
--   La app ya pide el código de 6 dígitos al auditor. Este script lo exige
--   también en la base: una sesión de auditor que solo usó la contraseña (nivel
--   aal1) no obtiene ningún rol, así que no lee ni modifica nada, ni siquiera
--   desde la consola del navegador. Tras escribir el código la sesión pasa a
--   aal2 y recupera todos sus permisos.
--
--   El comercial no cambia: no se le exige segundo factor.
--
-- SI EL AUDITOR PIERDE EL TELÉFONO
--   Borra su factor desde el SQL Editor y vuelve a registrarlo en la app:
--
--   delete from auth.mfa_factors
--   where user_id = (select id from auth.users where lower(email) = lower('correo@empresa.com'));

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
declare
  v_sin_factor text;
begin
  if to_regprocedure('public.get_user_role()') is null then
    raise exception 'Falta sql/009: la función public.get_user_role() no existe.';
  end if;

  select string_agg(p.email, ', ') into v_sin_factor
  from public.profiles p
  where p.role = 'auditor'
    and not exists (
      select 1 from auth.mfa_factors f
      where f.user_id = p.id and f.factor_type = 'totp' and f.status = 'verified'
    );

  if v_sin_factor is not null then
    raise exception 'Estos auditores aún no registran su segundo factor en la app: %. Hazlo antes de ejecutar este script: sin él perderían el acceso a los datos.', v_sin_factor;
  end if;
end;
$$;

-- ── 1. Rol efectivo: el auditor necesita sesión aal2 ──────────────────────
-- Todas las políticas y es_auditor() se apoyan en esta función (sql/009), así
-- que basta cambiarla aquí para que la regla aplique en toda la base.
create or replace function public.get_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p.role = 'auditor'
                and coalesce((select auth.jwt()) ->> 'aal', '') <> 'aal2' then null
           else p.role
         end
  from public.profiles p
  where p.id = (select auth.uid());
$$;

revoke all on function public.get_user_role() from public, anon;
grant execute on function public.get_user_role() to authenticated;

notify pgrst, 'reload schema';

-- ── 2. Comprobación ───────────────────────────────────────────────────────
-- Debe mostrar cada auditor con «segundo factor: sí» y la función exigiendo aal2.
select 'auditor' as tipo, p.email::text as detalle,
       case when exists (
         select 1 from auth.mfa_factors f
         where f.user_id = p.id and f.factor_type = 'totp' and f.status = 'verified'
       ) then 'segundo factor: sí' else 'segundo factor: NO' end as valor
from public.profiles p
where p.role = 'auditor'
union all
select 'funcion', 'get_user_role',
       case when prosrc like '%aal2%' then 'exige aal2 al auditor' else 'REVISAR' end
from pg_proc
where proname = 'get_user_role' and pronamespace = 'public'::regnamespace;
