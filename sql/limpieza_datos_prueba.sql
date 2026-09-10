-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Limpieza de los datos de prueba antes de producción
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ⚠ IRREVERSIBLE. El proyecto no tiene respaldos activos: lo que se borre no
--   se puede recuperar. Ejecuta primero el PASO 1 y revisa el inventario.
--
-- QUÉ BORRA
--   · Todos los asientos y sus líneas (hoy son solo registros de prueba).
--   · Todas las compras (documentos comerciales) y todos los pagos.
--   · Terceros, reglas de impuestos y conceptos operativos con «PRUEBA».
--
-- QUÉ CONSERVA
--   · Plan de cuentas, socios, domiciliarios, los conceptos «Gastos generales»
--     y «Compra de mercancía», perfiles y usuarios.
--
-- ARCHIVOS DE SOPORTE
--   La base de datos no puede borrar archivos de Storage. Tras el PASO 2, en
--   Storage → soportes, borra todas las carpetas: sin asientos, ya no las
--   referencia ningún registro. El PASO 3 las lista.
--
-- Después de limpiar, el consecutivo de comprobantes vuelve a empezar en 00001.

-- ── PASO 1 · Inventario (no borra nada) ───────────────────────────────────
select 'asientos' as que, count(*)::text as cantidad,
       coalesce(string_agg(comprobante, ', ' order by id), '—') as detalle
from public.asientos
union all
select 'lineas contables', count(*)::text, '—' from public.asiento_detalles
union all
select 'compras', count(*)::text, '—' from public.documentos_comerciales
union all
select 'pagos', count(*)::text, '—' from public.pagos_proveedores
union all
select 'terceros PRUEBA', count(*)::text, coalesce(string_agg(nombre, ', '), '—')
from public.terceros where nombre ilike '%prueba%'
union all
select 'terceros que se conservan', count(*)::text, coalesce(string_agg(nombre, ', '), '—')
from public.terceros where nombre not ilike '%prueba%'
union all
select 'reglas PRUEBA', count(*)::text, coalesce(string_agg(nombre_impuesto, ', '), '—')
from public.reglas_impuestos where nombre_impuesto ilike '%prueba%'
union all
select 'conceptos PRUEBA', count(*)::text, coalesce(string_agg(nombre_concepto, ', '), '—')
from public.conceptos_operativos where nombre_concepto ilike '%prueba%'
union all
select 'archivos de soporte', count(*)::text, '—'
from storage.objects where bucket_id = 'soportes';

-- ── PASO 2 · Borrado ──────────────────────────────────────────────────────
-- Todo o nada: si algo falla, no se borra ningún registro.
-- Para ejecutarlo, selecciona desde «do $$» hasta el «$$;» final y pulsa Run.
do $$
declare
  v_pagos      integer;
  v_compras    integer;
  v_lineas     integer;
  v_asientos   integer;
  v_terceros   integer;
  v_reglas     integer;
  v_conceptos  integer;
begin
  delete from public.pagos_proveedores;
  get diagnostics v_pagos = row_count;

  delete from public.documentos_comerciales;
  get diagnostics v_compras = row_count;

  select count(*) into v_lineas from public.asiento_detalles;
  delete from public.asientos;                -- las líneas se borran en cascada
  get diagnostics v_asientos = row_count;

  delete from public.terceros where nombre ilike '%prueba%';
  get diagnostics v_terceros = row_count;

  delete from public.reglas_impuestos where nombre_impuesto ilike '%prueba%';
  get diagnostics v_reglas = row_count;

  delete from public.conceptos_operativos where nombre_concepto ilike '%prueba%';
  get diagnostics v_conceptos = row_count;

  raise notice 'Borrados: % pagos, % compras, % asientos con % líneas, % terceros, % reglas, % conceptos.',
    v_pagos, v_compras, v_asientos, v_lineas, v_terceros, v_reglas, v_conceptos;
end;
$$;

-- ── PASO 3 · Carpetas de soportes que quedan sin registro ─────────────────
-- Bórralas en Storage → soportes.
select split_part(o.name, '/', 1) as carpeta, count(*) as archivos
from storage.objects o
where o.bucket_id = 'soportes'
  and not exists (
    select 1 from public.asientos a
    where a.id::text = split_part(o.name, '/', 1)
  )
group by 1
order by 1;
