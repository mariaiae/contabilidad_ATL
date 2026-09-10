-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Conceptos operativos parametrizables
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/012)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ CAMBIA
--   Hasta ahora la cuenta del débito de una compra salía del campo "Destino"
--   (gasto → 5199, inventario → 1435), escrito dentro de registrar_compra().
--   Ahora cada compra elige un CONCEPTO OPERATIVO y la cuenta sale de esta tabla,
--   que el auditor administra desde la app sin tocar código.
--
-- QUÉ CREA
--   conceptos_operativos           Concepto → tipo de movimiento → cuenta contable
--                                  (+ concepto tributario por defecto).
--   conceptos_operativos_lista()   Lista para el formulario, SIN las cuentas.
--   documentos_comerciales         + concepto_operativo_id.
--   registrar_compra()             La cuenta la busca la base en la tabla.
--
-- SEGURIDAD
--   · La cuenta nunca viaja desde el navegador: la app envía el id del concepto
--     y la base busca la cuenta. Una cuenta enviada desde la consola se ignora.
--   · Leer la tabla (con cuentas): solo auditor. El comercial obtiene la lista
--     sin cuentas mediante conceptos_operativos_lista(), igual que en sql/009
--     no lee el plan de cuentas ni las líneas contables.
--   · Crear, editar y desactivar: solo auditor. Los conceptos no se borran si
--     tienen compras (on delete restrict): se desactivan.
--   · El asiento guarda la cuenta con que se registró: cambiar la cuenta de un
--     concepto solo afecta las compras nuevas.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
begin
  if to_regclass('public.reglas_impuestos') is null then
    raise exception 'Falta sql/012: la tabla public.reglas_impuestos no existe.';
  end if;
  if (select count(*) from public.plan_cuentas
      where codigo in ('1435', '5199') and es_cuenta_detalle) <> 2 then
    raise exception 'El plan de cuentas debe tener 1435 y 5199 como cuentas de detalle.';
  end if;
end;
$$;

-- ── 1. Tabla ──────────────────────────────────────────────────────────────
create table if not exists public.conceptos_operativos (
  id                           bigint      generated always as identity primary key,
  nombre_concepto              text        not null check (btrim(nombre_concepto) <> ''),
  tipo_movimiento              text        not null
                               check (tipo_movimiento in ('gasto', 'inventario', 'activo_fijo')),
  cuenta_id_asociada           text        not null references public.plan_cuentas (codigo)
                                           on update cascade on delete restrict,
  concepto_tributario_defecto  text
                               check (concepto_tributario_defecto in
                                      ('bienes', 'servicios', 'honorarios', 'arrendamientos', 'otros')),
  activo                       boolean     not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

-- "Repuestos" y " repuestos " son el mismo concepto.
create unique index if not exists conceptos_operativos_nombre_unico
  on public.conceptos_operativos ((lower(btrim(nombre_concepto))));

-- La cuenta debe ser de detalle y coherente con el tipo de movimiento.
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

drop trigger if exists validar_concepto_operativo on public.conceptos_operativos;
create trigger validar_concepto_operativo
  before insert or update on public.conceptos_operativos
  for each row execute function public.validar_concepto_operativo();

-- ── 2. RLS ────────────────────────────────────────────────────────────────
alter table public.conceptos_operativos enable row level security;

drop policy if exists conceptos_auditor on public.conceptos_operativos;

create policy conceptos_auditor on public.conceptos_operativos
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

revoke all on public.conceptos_operativos from anon;

-- Lista para el formulario de compras: ambos roles, sin la cuenta contable.
-- Incluye los inactivos para poder nombrar compras antiguas; la app solo
-- ofrece los activos.
create or replace function public.conceptos_operativos_lista()
returns table (
  id                          bigint,
  nombre_concepto             text,
  tipo_movimiento             text,
  concepto_tributario_defecto text,
  activo                      boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.nombre_concepto, c.tipo_movimiento, c.concepto_tributario_defecto, c.activo
  from public.conceptos_operativos c
  where (select public.get_user_role()) in ('auditor', 'comercial')
  order by c.nombre_concepto;
$$;

revoke all on function public.conceptos_operativos_lista() from public, anon;
grant execute on function public.conceptos_operativos_lista() to authenticated;

-- ── 3. Datos iniciales ────────────────────────────────────────────────────
-- Equivalen a los dos destinos que existían, así la app sigue funcionando.
-- El contador puede renombrarlos, cambiarles la cuenta o crear otros.
insert into public.conceptos_operativos
  (nombre_concepto, tipo_movimiento, cuenta_id_asociada, concepto_tributario_defecto)
select v.nombre, v.tipo, v.cuenta, v.tributario
from (values
  ('Gastos generales',    'gasto',      '5199', null),
  ('Compra de mercancía', 'inventario', '1435', 'bienes')
) as v (nombre, tipo, cuenta, tributario)
where not exists (
  select 1 from public.conceptos_operativos c
  where lower(c.nombre_concepto) = lower(v.nombre)
);

-- ── 4. Documentos comerciales ─────────────────────────────────────────────
alter table public.documentos_comerciales
  add column if not exists concepto_operativo_id bigint
  references public.conceptos_operativos (id) on delete restrict;

create index if not exists idx_documentos_concepto_operativo
  on public.documentos_comerciales (concepto_operativo_id);

-- Compras existentes: el concepto que corresponde a su destino.
update public.documentos_comerciales d
set concepto_operativo_id = c.id
from public.conceptos_operativos c
where d.concepto_operativo_id is null
  and lower(c.nombre_concepto) = case d.destino
                                   when 'gasto'      then 'gastos generales'
                                   when 'inventario' then 'compra de mercancía'
                                 end;

do $$
begin
  if exists (select 1 from public.documentos_comerciales where concepto_operativo_id is null) then
    raise exception 'Hay compras sin concepto operativo asignado; revisa los datos iniciales.';
  end if;
end;
$$;

alter table public.documentos_comerciales
  alter column concepto_operativo_id set not null;

-- `destino` se sigue llenando a partir del tipo de movimiento: los indicadores
-- y filtros existentes lo usan.
alter table public.documentos_comerciales
  drop constraint if exists documentos_comerciales_destino_check;
alter table public.documentos_comerciales
  drop constraint if exists documentos_destino_valido;
alter table public.documentos_comerciales
  add constraint documentos_destino_valido
  check (destino in ('gasto', 'inventario', 'activo_fijo'));

-- ── 5. registrar_compra(): la cuenta sale del concepto operativo ──────────
--   p_documento  { proveedor_id, concepto, total, fecha,
--                  concepto_operativo_id, concepto_tributario? }
--   p_asiento    { comprobante }
--
-- Cualquier cuenta, destino o línea que envíe la app se ignora.
-- Retenciones, neto a 2205 y partida doble: igual que en sql/012.
create or replace function public.registrar_compra(p_documento jsonb, p_asiento jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol             text  := public.get_user_role();
  v_proveedor       public.terceros%rowtype;
  v_operativo       public.conceptos_operativos%rowtype;
  v_total           numeric(18,2);
  v_concepto        text  := btrim(coalesce(p_documento ->> 'concepto', ''));
  v_concepto_trib   text  := nullif(btrim(coalesce(p_documento ->> 'concepto_tributario', '')), '');
  v_fecha           date  := coalesce(nullif(p_documento ->> 'fecha', '')::date, current_date);
  v_comprobante     text  := btrim(coalesce(p_asiento ->> 'comprobante', ''));
  v_regla           record;
  v_monto           numeric(18,2);
  v_total_retenido  numeric(18,2) := 0;
  v_retenciones     jsonb := '[]'::jsonb;
  v_neto            numeric(18,2);
  v_debitos         numeric(18,2);
  v_creditos        numeric(18,2);
  v_asiento_id      bigint;
  v_documento_id    bigint;
begin
  -- 1. Rol
  if v_rol is null or v_rol not in ('auditor', 'comercial') then
    raise exception 'Tu perfil no puede registrar compras.' using errcode = '42501';
  end if;

  -- 2. Documento
  v_total := (p_documento ->> 'total')::numeric;
  if v_total is null or v_total <= 0 then
    raise exception 'El valor total de la compra debe ser mayor que cero.';
  end if;
  if v_concepto = '' then
    raise exception 'La compra necesita una descripción.';
  end if;
  if v_comprobante = '' then
    raise exception 'Falta el número de comprobante del asiento.';
  end if;

  -- 3. Concepto operativo: de aquí sale la cuenta del débito
  if coalesce(p_documento ->> 'concepto_operativo_id', '') = '' then
    raise exception 'Selecciona el concepto operativo de la compra. Si no aparece el campo, recarga la página.';
  end if;
  select * into v_operativo
  from public.conceptos_operativos
  where id = (p_documento ->> 'concepto_operativo_id')::bigint;
  if not found then
    raise exception 'El concepto operativo indicado no existe.';
  end if;
  if not v_operativo.activo then
    raise exception 'El concepto operativo "%" está inactivo.', v_operativo.nombre_concepto;
  end if;

  v_concepto_trib := coalesce(v_concepto_trib, v_operativo.concepto_tributario_defecto);
  if v_concepto_trib is null then
    raise exception 'Indica el concepto tributario de la compra: "%" no tiene uno por defecto.',
      v_operativo.nombre_concepto;
  end if;
  if v_concepto_trib not in ('bienes', 'servicios', 'honorarios', 'arrendamientos', 'otros') then
    raise exception 'Concepto tributario no válido: %.', v_concepto_trib;
  end if;

  select * into v_proveedor
  from public.terceros
  where id = (p_documento ->> 'proveedor_id')::bigint;
  if not found then
    raise exception 'El proveedor indicado no existe.';
  end if;
  if v_proveedor.tipo not in ('proveedor', 'ambos') then
    raise exception '% no está registrado como proveedor.', v_proveedor.nombre;
  end if;

  -- 4. Cabecera y débito
  insert into public.asientos
    (comprobante, fecha, descripcion, modulo, tercero, tipo, valor, tercero_nit)
  values
    (v_comprobante, v_fecha, v_concepto, 'compras',
     v_proveedor.nombre, v_operativo.tipo_movimiento, v_total, v_proveedor.nit)
  returning id into v_asiento_id;

  insert into public.asiento_detalles
    (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
  values
    (v_asiento_id, v_operativo.cuenta_id_asociada,
     v_operativo.nombre_concepto || ' – ' || v_concepto,
     v_total, 0, 'AMBOS');

  -- 5. Retenciones, antes de cerrar el asiento
  if not v_proveedor.no_sujeto_retencion then
    for v_regla in
      select r.nombre_impuesto, r.porcentaje, r.cuenta_id_asociada
      from public.reglas_impuestos r
      where r.activa
        and r.concepto = v_concepto_trib
        and v_total >= r.base_minima
      order by r.id
    loop
      v_monto := round(v_total * v_regla.porcentaje / 100, 0);
      continue when v_monto <= 0;

      insert into public.asiento_detalles
        (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
      values
        (v_asiento_id, v_regla.cuenta_id_asociada,
         v_regla.nombre_impuesto || ' ' || rtrim(rtrim(v_regla.porcentaje::text, '0'), '.')
           || ' % – ' || v_proveedor.nombre,
         0, v_monto, 'AMBOS');

      v_total_retenido := v_total_retenido + v_monto;
      v_retenciones := v_retenciones || jsonb_build_object(
        'impuesto', v_regla.nombre_impuesto,
        'porcentaje', v_regla.porcentaje,
        'cuenta', v_regla.cuenta_id_asociada,
        'valor', v_monto
      );
    end loop;
  end if;

  if v_total_retenido >= v_total then
    raise exception 'Las retenciones (%) igualan o superan el valor de la compra (%): revisa las reglas de impuestos.',
      v_total_retenido, v_total;
  end if;

  -- 6. Neto que se le debe al proveedor
  v_neto := v_total - v_total_retenido;

  insert into public.asiento_detalles
    (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
  values
    (v_asiento_id, '2205',
     'Por pagar a ' || v_proveedor.nombre
       || case when v_total_retenido > 0 then ' (neto de retenciones)' else '' end,
     0, v_neto, 'AMBOS');

  -- 7. Partida doble (validar_partida_doble lo vuelve a comprobar al confirmar)
  select coalesce(sum(debito), 0), coalesce(sum(credito), 0)
  into v_debitos, v_creditos
  from public.asiento_detalles
  where asiento_id = v_asiento_id;

  if v_debitos <> v_creditos then
    raise exception 'El asiento % no cuadra: débitos % y créditos %. No se guardó nada.',
      v_comprobante, v_debitos, v_creditos
      using errcode = '23514';
  end if;

  -- 8. Documento
  insert into public.documentos_comerciales
    (proveedor_id, concepto, total, fecha, destino, asiento_id,
     concepto_tributario, concepto_operativo_id)
  values
    (v_proveedor.id, v_concepto, v_total, v_fecha, v_operativo.tipo_movimiento, v_asiento_id,
     v_concepto_trib, v_operativo.id)
  returning id into v_documento_id;

  return jsonb_build_object(
    'documento_id', v_documento_id,
    'asiento_id', v_asiento_id,
    'cuenta', v_operativo.cuenta_id_asociada,
    'total', v_total,
    'retenciones', v_retenciones,
    'total_retenido', v_total_retenido,
    'neto_por_pagar', v_neto
  );
end;
$$;

revoke all on function public.registrar_compra(jsonb, jsonb) from public, anon;
grant execute on function public.registrar_compra(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ── 6. Comprobación ───────────────────────────────────────────────────────
-- Debe listar la política, los 2 conceptos iniciales y 0 compras sin concepto.
select 'politica' as tipo, policyname::text as detalle, cmd::text as valor
from pg_policies
where schemaname = 'public' and tablename = 'conceptos_operativos'
union all
select 'concepto', c.nombre_concepto,
       c.tipo_movimiento || ' · ' || c.cuenta_id_asociada
         || ' · ' || coalesce(c.concepto_tributario_defecto, 'sin concepto tributario')
from public.conceptos_operativos c
union all
select 'compras sin concepto', count(*)::text, 'debe ser 0'
from public.documentos_comerciales
where concepto_operativo_id is null;
