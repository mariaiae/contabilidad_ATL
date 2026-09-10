-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Integridad referencial de las cuentas contables
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Enlaza `asiento_detalles.cuenta` con el catálogo `plan_cuentas.codigo`.
--
-- QUÉ GANA
--   1. PostgREST podrá incrustar la cuenta en la consulta de líneas
--      (`asiento_detalles(*, plan_cuentas(nombre, naturaleza, nivel))`), que es
--      lo que necesitan el Balance de Comprobación y los estados financieros.
--   2. Imposible registrar un movimiento contra una cuenta que no existe.
--   3. Imposible borrar del catálogo una cuenta que ya tiene movimientos.
--
-- QUÉ CAMBIA EN LA OPERACIÓN
--   Renumerar una cuenta ya NO se hace borrando e insertando. Se hace con un
--   UPDATE, y gracias a `on update cascade` los movimientos existentes siguen
--   al código nuevo automáticamente:
--
--       update public.plan_cuentas set codigo = '1705' where codigo = '1620';
--
--   Con `on delete restrict`, intentar borrar una cuenta con movimientos
--   devuelve error en lugar de dejar líneas huérfanas. Eso hace que
--   seedCuentas({ eliminarObsoletas: true }) falle si una cuenta obsoleta está
--   en uso — que es justo el aviso que uno quiere recibir.

-- ── 1. Comprobación previa ────────────────────────────────────────────────
-- Debe devolver CERO filas. Si devuelve alguna, esa cuenta está en uso pero no
-- existe en el catálogo: hay que darla de alta antes de crear la restricción.
select d.cuenta, count(*) as lineas_afectadas
from public.asiento_detalles d
left join public.plan_cuentas p on p.codigo = d.cuenta
where p.codigo is null
group by d.cuenta;

-- ── 2. La clave foránea ───────────────────────────────────────────────────
alter table public.asiento_detalles
  drop constraint if exists asiento_detalles_cuenta_fkey;

alter table public.asiento_detalles
  add constraint asiento_detalles_cuenta_fkey
  foreign key (cuenta)
  references public.plan_cuentas (codigo)
  on update cascade      -- renumerar una cuenta arrastra sus movimientos
  on delete restrict;    -- no se borra una cuenta que tenga movimientos

-- El índice acelera tanto el JOIN como la validación de la restricción.
create index if not exists idx_asiento_detalles_cuenta
  on public.asiento_detalles (cuenta);

-- ── 3. Comprobación final ─────────────────────────────────────────────────
select
  tc.constraint_name,
  kcu.column_name       as columna_origen,
  ccu.table_name        as tabla_destino,
  ccu.column_name       as columna_destino,
  rc.update_rule,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on kcu.constraint_name = tc.constraint_name
join information_schema.constraint_column_usage ccu
  on ccu.constraint_name = tc.constraint_name
join information_schema.referential_constraints rc
  on rc.constraint_name = tc.constraint_name
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_name = 'asiento_detalles';
