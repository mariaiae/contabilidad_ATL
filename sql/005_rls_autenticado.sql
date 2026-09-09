-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Cierre del acceso anónimo (RLS)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ ANTES DE EJECUTAR: crea al menos un usuario en
--      Supabase Dashboard → Authentication → Users → Add user
--    Si ejecutas esto sin tener usuario, la aplicación queda sin acceso a
--    ningún dato hasta que lo crees.
--
-- QUÉ CAMBIA
-- Hasta ahora las políticas concedían todo al rol `anon`, que es el que
-- representa a cualquier visitante con la clave pública embebida en el
-- JavaScript. Es decir: quien abriera la app podía leer, modificar y borrar
-- la contabilidad completa.
--
-- A partir de aquí solo el rol `authenticated` —usuarios con sesión iniciada
-- vía Supabase Auth— tiene acceso. La clave pública sigue viajando en el
-- bundle, pero por sí sola ya no abre ninguna puerta: sin JWT válido, RLS
-- no devuelve ni una fila.

-- ── 1. Retirar las políticas de desarrollo ────────────────────────────────
drop policy if exists dev_all_asientos        on public.asientos;
drop policy if exists dev_all_detalles        on public.asiento_detalles;
drop policy if exists dev_all_plan_cuentas    on public.plan_cuentas;
drop policy if exists dev_all_socios          on public.socios;
drop policy if exists dev_all_domiciliarios   on public.domiciliarios;

-- ── 2. RLS activa en todas las tablas ─────────────────────────────────────
-- Sin esto una tabla queda expuesta aunque no tenga políticas.
alter table public.asientos          enable row level security;
alter table public.asiento_detalles  enable row level security;
alter table public.plan_cuentas      enable row level security;
alter table public.socios            enable row level security;
alter table public.domiciliarios     enable row level security;

-- ── 3. Acceso solo para usuarios autenticados ─────────────────────────────
-- `using` filtra lo que se puede leer/actualizar/borrar; `with check` valida
-- lo que se inserta. Ambos en true: cualquier usuario con sesión ve y edita
-- toda la contabilidad de la empresa, que es el modelo de un equipo contable
-- único. Si más adelante hay varias empresas o roles, aquí es donde se
-- añade el filtro (por ejemplo `using (empresa_id = auth.jwt()->>'empresa')`).

create policy auth_all_asientos on public.asientos
  for all to authenticated using (true) with check (true);

create policy auth_all_detalles on public.asiento_detalles
  for all to authenticated using (true) with check (true);

create policy auth_all_socios on public.socios
  for all to authenticated using (true) with check (true);

create policy auth_all_domiciliarios on public.domiciliarios
  for all to authenticated using (true) with check (true);

-- El catálogo también queda abierto a usuarios autenticados, no solo en
-- lectura: seedCuentas.js lo puebla desde el navegador con la sesión del
-- usuario, y una política de solo lectura dejaría ese flujo inservible.
-- Si más adelante se separan roles, el catálogo es la primera candidata a
-- volverse solo lectura para todos salvo un rol de administración.
create policy auth_all_plan_cuentas on public.plan_cuentas
  for all to authenticated using (true) with check (true);

-- ── 4. Retirar privilegios de tabla al rol anónimo ────────────────────────
-- RLS ya lo bloquearía, pero quitar el GRANT es una segunda barrera: si en el
-- futuro alguien crea una política permisiva por error, anon sigue sin poder
-- tocar estas tablas.
revoke all on public.asientos          from anon;
revoke all on public.asiento_detalles  from anon;
revoke all on public.plan_cuentas      from anon;
revoke all on public.socios            from anon;
revoke all on public.domiciliarios     from anon;

-- ── 5. Comprobación ───────────────────────────────────────────────────────
-- Debe listar solo políticas `auth_*` con roles = {authenticated}.
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
