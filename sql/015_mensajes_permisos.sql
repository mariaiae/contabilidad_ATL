-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Mensajes claros al rechazar reglas y conceptos
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/013)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- No cambia permisos: la RLS ya impedía al comercial crear o editar reglas de
-- impuestos y conceptos operativos. Solo corrige QUÉ mensaje recibe.
--
-- 1. Permiso antes que validación
--    Los triggers de validación corren antes que la RLS. Como el comercial no
--    puede leer el plan de cuentas, la validación no encontraba la cuenta y
--    respondía "la cuenta 5199 no sirve…", un motivo falso. Ahora el trigger
--    comprueba primero el rol y responde "Solo un auditor puede…" (42501).
--
-- 2. Tipo de movimiento desconocido
--    Un tipo inválido producía "…debe ser una cuenta de detalle <NULL>." Ahora
--    lo rechaza el check de la columna con su propio mensaje.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
begin
  if to_regclass('public.conceptos_operativos') is null then
    raise exception 'Falta sql/013: la tabla public.conceptos_operativos no existe.';
  end if;
end;
$$;

-- ── 1. Reglas de impuestos ────────────────────────────────────────────────
create or replace function public.validar_regla_impuesto()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Sin usuario de la API (SQL Editor) no hay rol que comprobar.
  if auth.uid() is not null and not public.es_auditor() then
    raise exception 'Solo un auditor puede crear o modificar reglas de impuestos.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.plan_cuentas
    where codigo = new.cuenta_id_asociada and es_cuenta_detalle and codigo like '2%'
  ) then
    raise exception 'La cuenta % no sirve para una retención: debe ser una cuenta de detalle de pasivo (clase 2).',
      new.cuenta_id_asociada
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ── 2. Conceptos operativos ───────────────────────────────────────────────
create or replace function public.validar_concepto_operativo()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prefijo text := case new.tipo_movimiento
                      when 'gasto'       then '5'
                      when 'inventario'  then '14'
                      when 'activo_fijo' then '15'
                    end;
  v_nombre  text := case new.tipo_movimiento
                      when 'gasto'       then 'de gasto (clase 5)'
                      when 'inventario'  then 'de inventario (grupo 14)'
                      when 'activo_fijo' then 'de activo fijo (grupo 15)'
                    end;
begin
  if auth.uid() is not null and not public.es_auditor() then
    raise exception 'Solo un auditor puede crear o modificar conceptos operativos.'
      using errcode = '42501';
  end if;

  new.nombre_concepto := btrim(new.nombre_concepto);

  -- Tipo desconocido: lo rechaza el check de la columna con su propio mensaje.
  if v_prefijo is null then
    return new;
  end if;

  if not exists (
    select 1 from public.plan_cuentas
    where codigo = new.cuenta_id_asociada and es_cuenta_detalle and codigo like v_prefijo || '%'
  ) then
    raise exception 'La cuenta % no sirve para este concepto: debe ser una cuenta de detalle %.',
      new.cuenta_id_asociada, v_nombre
      using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ── 3. Comprobación ───────────────────────────────────────────────────────
-- Debe listar las dos funciones con "comprueba el rol: sí".
select p.proname::text as funcion,
       case when p.prosrc like '%Solo un auditor puede%' then 'sí' else 'NO' end as comprueba_el_rol,
       case when p.proname = 'validar_concepto_operativo'
            then case when p.prosrc like '%v_prefijo is null%' then 'sí' else 'NO' end
            else 'no aplica' end as tipo_desconocido_corregido
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('validar_regla_impuesto', 'validar_concepto_operativo')
order by p.proname;
