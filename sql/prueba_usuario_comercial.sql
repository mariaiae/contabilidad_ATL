-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Usuario comercial de prueba
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (después de sql/009)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PASO PREVIO, en el Dashboard (los usuarios no se crean por SQL):
--   Authentication → Users → Add user → Create new user
--     · Email:    el que elijas, distinto del administrador
--     · Password: la que elijas
--     · Marca "Auto Confirm User": el proyecto no confirma correos solo
--
-- El trigger de sql/008 ya le crea el perfil como `comercial`. Este script lo
-- comprueba y fija el rol de forma explícita. No es una migración: se puede
-- repetir sin efectos secundarios.

-- Único punto a editar: el correo del usuario de prueba.
select set_config('atl.comercial_email', 'comercial.prueba@example.com', false);

do $$
declare
  correo text := lower(current_setting('atl.comercial_email', true));
begin
  if not exists (select 1 from auth.users where lower(email) = correo) then
    raise exception 'El usuario "%" no existe. Créalo primero en Authentication → Users.', correo;
  end if;
  -- Nunca degradar a un auditor por un error al escribir el correo.
  if exists (select 1 from public.profiles where lower(email) = correo and role = 'auditor') then
    raise exception '"%" es auditor. Este script es solo para el usuario de prueba.', correo;
  end if;
end;
$$;

insert into public.profiles (id, email, role)
select u.id, u.email, 'comercial'
from auth.users u
where lower(u.email) = lower(current_setting('atl.comercial_email', true))
on conflict (id) do update set role = 'comercial';

-- Deben aparecer el administrador como auditor y el usuario de prueba como
-- comercial con el correo confirmado.
select p.email, p.role, (u.email_confirmed_at is not null) as correo_confirmado
from public.profiles p
join auth.users u on u.id = p.id
order by (p.role = 'auditor') desc, p.email;
