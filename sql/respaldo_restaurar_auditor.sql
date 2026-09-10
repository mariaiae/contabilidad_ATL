-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · RESPALDO: restaurar el rol auditor al administrador
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Úsalo si la cuenta administradora perdió el acceso técnico (por ejemplo, si
-- alguien le cambió el rol o su perfil no se creó). No es una migración: se
-- puede ejecutar cuantas veces haga falta sin efectos secundarios.
--
-- Funciona aunque la app esté bloqueada: el SQL Editor corre como `postgres`,
-- que no está sujeto a RLS, y ascender a auditor nunca lo impide la
-- protección de roles (esa solo frena quitar el último auditor).

select set_config('atl.admin_email', 'isarias09@gmail.com', false);

do $$
begin
  if not exists (
    select 1 from auth.users
    where lower(email) = lower(current_setting('atl.admin_email', true))
  ) then
    raise exception 'El correo "%" no existe en Authentication → Users.',
      current_setting('atl.admin_email', true);
  end if;
end;
$$;

insert into public.profiles (id, email, role)
select u.id, u.email, 'auditor'
from auth.users u
where lower(u.email) = lower(current_setting('atl.admin_email', true))
on conflict (id) do update
  set role = 'auditor', updated_at = now();

-- Debe devolver una fila con role = auditor.
select p.email, p.role, p.updated_at, u.last_sign_in_at
from public.profiles p
join auth.users u on u.id = p.id
where lower(p.email) = lower(current_setting('atl.admin_email', true));
