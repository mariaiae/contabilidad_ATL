-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Motor de retenciones y control de partida doble
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/011)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ CREA
--   reglas_impuestos          Reglas de retención por concepto tributario.
--   terceros                  + no_sujeto_retencion (autorretenedores, régimen simple).
--   documentos_comerciales    + concepto_tributario.
--   registrar_compra()        Ahora construye el asiento ENTERO en la base,
--                             incluidas las retenciones que correspondan.
--   validar_partida_doble     Control que impide guardar CUALQUIER asiento
--                             descuadrado, venga del módulo que venga.
--
-- ASIENTO DE UNA COMPRA CON RETENCIÓN (ejemplo: servicios $1.000.000 al 4 %)
--   D 5199 Gasto                  1.000.000   AMBOS
--   C 2370 Retención por pagar       40.000   AMBOS
--   C 2205 Proveedores              960.000   AMBOS   ← neto que se le paga
--
--   Las retenciones van como AMBOS, no FISCAL: son una deuda real con la DIAN
--   que existe en la contabilidad NIIF y en la fiscal. Marcarlas FISCAL dejaría
--   el libro NIIF descuadrado por el valor retenido.
--
-- REGLAS DE APLICACIÓN
--   · Solo se aplican las reglas activas del concepto tributario de la compra.
--   · Se aplica si el valor de la compra es IGUAL O SUPERIOR a la base mínima.
--   · La retención se redondea a pesos.
--   · Un proveedor marcado como no sujeto a retención no genera ninguna.
--   · Solo el auditor modifica reglas y marca exenciones; el comercial lee las
--     reglas (la app las usa para mostrar una estimación).
--
-- LA TABLA DE REGLAS QUEDA VACÍA: la carga el contador (ver ejemplo al final
-- de la sección 3). Mientras esté vacía, las compras no generan retenciones.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
-- Se detiene ANTES de tocar nada si falta una migración anterior o si ya hay
-- asientos descuadrados, porque el control del paso 7 los dejaría bloqueados.
do $$
declare
  v_descuadrados text;
begin
  if to_regprocedure('public.registrar_pago(jsonb)') is null then
    raise exception 'Falta sql/011: la función public.registrar_pago() no existe.';
  end if;
  if (select count(*) from public.plan_cuentas
      where codigo in ('1435', '2205', '5199') and es_cuenta_detalle) <> 3 then
    raise exception 'El plan de cuentas debe tener 1435, 2205 y 5199 como cuentas de detalle.';
  end if;

  select string_agg(a.comprobante, ', ' order by a.id) into v_descuadrados
  from public.asientos a
  cross join lateral (
    select
      coalesce(sum(d.debito)  filter (where d.tipo_normativa in ('AMBOS', 'NIIF')), 0)
    - coalesce(sum(d.credito) filter (where d.tipo_normativa in ('AMBOS', 'NIIF')), 0) as dif_niif,
      coalesce(sum(d.debito)  filter (where d.tipo_normativa in ('AMBOS', 'FISCAL')), 0)
    - coalesce(sum(d.credito) filter (where d.tipo_normativa in ('AMBOS', 'FISCAL')), 0) as dif_fiscal
    from public.asiento_detalles d
    where d.asiento_id = a.id
  ) s
  where s.dif_niif <> 0 or s.dif_fiscal <> 0;

  if v_descuadrados is not null then
    raise exception 'Hay asientos descuadrados: %. Corrígelos antes de activar el control de partida doble.', v_descuadrados;
  end if;
end;
$$;

-- ── 1. Reglas de impuestos ────────────────────────────────────────────────
create table if not exists public.reglas_impuestos (
  id                  bigint        generated always as identity primary key,
  nombre_impuesto     text          not null check (btrim(nombre_impuesto) <> ''),
  concepto            text          not null
                      check (concepto in ('bienes', 'servicios', 'honorarios', 'arrendamientos', 'otros')),
  porcentaje          numeric(7,4)  not null check (porcentaje > 0 and porcentaje < 100),
  base_minima         numeric(18,2) not null default 0 check (base_minima >= 0),
  cuenta_id_asociada  text          not null references public.plan_cuentas (codigo)
                                    on update cascade on delete restrict,
  activa              boolean       not null default true,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now()
);

create index if not exists idx_reglas_concepto_activas
  on public.reglas_impuestos (concepto) where activa;

-- Una retención es un pasivo: la cuenta debe ser de detalle y de la clase 2.
create or replace function public.validar_regla_impuesto()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
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

drop trigger if exists validar_regla_impuesto on public.reglas_impuestos;
create trigger validar_regla_impuesto
  before insert or update on public.reglas_impuestos
  for each row execute function public.validar_regla_impuesto();

-- ── 2. RLS de reglas ──────────────────────────────────────────────────────
alter table public.reglas_impuestos enable row level security;

drop policy if exists reglas_leer    on public.reglas_impuestos;
drop policy if exists reglas_auditor on public.reglas_impuestos;

create policy reglas_leer on public.reglas_impuestos
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

create policy reglas_auditor on public.reglas_impuestos
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

revoke all on public.reglas_impuestos from anon;

-- ── 3. Carga de reglas (EJEMPLO, no se ejecuta) ───────────────────────────
-- Las tarifas y bases las define el contador según la UVT del año y el tipo de
-- proveedor. Para ReteICA hay que crear antes su cuenta de pasivo en
-- plan_cuentas (por ejemplo 2368 ReteICA por pagar) y marcarla de detalle.
--
-- insert into public.reglas_impuestos
--   (nombre_impuesto, concepto, porcentaje, base_minima, cuenta_id_asociada)
-- values
--   ('Retefuente servicios', 'servicios', 4.0, <base mínima en pesos>, '2370');

-- ── 4. Proveedores no sujetos a retención ─────────────────────────────────
alter table public.terceros
  add column if not exists no_sujeto_retencion boolean not null default false;

-- sql/010 limitó por columna lo que la app puede escribir en terceros.
grant insert (no_sujeto_retencion) on public.terceros to authenticated;
grant update (no_sujeto_retencion) on public.terceros to authenticated;

-- Marcar a un proveedor como exento reduce lo que se retiene: es una decisión
-- tributaria reservada al auditor. (La edición ya es solo del auditor por RLS;
-- esto cubre el alta que hace el comercial.)
create or replace function public.proteger_exencion_retencion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.es_auditor() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.no_sujeto_retencion then
      raise exception 'Solo un auditor puede marcar un tercero como no sujeto a retención.'
        using errcode = '42501';
    end if;
  elsif new.no_sujeto_retencion is distinct from old.no_sujeto_retencion then
    raise exception 'Solo un auditor puede cambiar si un tercero está sujeto a retención.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists proteger_exencion_retencion on public.terceros;
create trigger proteger_exencion_retencion
  before insert or update on public.terceros
  for each row execute function public.proteger_exencion_retencion();

-- ── 5. Concepto tributario de cada compra ─────────────────────────────────
-- Las compras ya registradas quedan como 'otros': se hicieron sin retenciones.
alter table public.documentos_comerciales
  add column if not exists concepto_tributario text not null default 'otros';

alter table public.documentos_comerciales
  drop constraint if exists documentos_concepto_tributario_valido;
alter table public.documentos_comerciales
  add constraint documentos_concepto_tributario_valido
  check (concepto_tributario in ('bienes', 'servicios', 'honorarios', 'arrendamientos', 'otros'));

-- ── 6. registrar_compra(): el asiento completo se construye en la base ────
--   p_documento  { proveedor_id, concepto, total, destino, fecha, concepto_tributario }
--   p_asiento    { comprobante }   (las líneas que envíe la app se IGNORAN)
--
-- Antes la app construía las líneas y esta función las validaba. Con
-- retenciones eso ya no es seguro: un comercial podría enviar el asiento sin
-- ellas. Ahora la base consulta las reglas y decide todas las líneas.
create or replace function public.registrar_compra(p_documento jsonb, p_asiento jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol             text  := public.get_user_role();
  v_proveedor       public.terceros%rowtype;
  v_total           numeric(18,2);
  v_concepto        text  := btrim(coalesce(p_documento ->> 'concepto', ''));
  v_destino         text  := p_documento ->> 'destino';
  v_concepto_trib   text  := coalesce(nullif(btrim(p_documento ->> 'concepto_tributario'), ''), 'otros');
  v_fecha           date  := coalesce(nullif(p_documento ->> 'fecha', '')::date, current_date);
  v_comprobante     text  := btrim(coalesce(p_asiento ->> 'comprobante', ''));
  v_cuenta_debe     text;
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
    raise exception 'La compra necesita un concepto.';
  end if;
  if v_comprobante = '' then
    raise exception 'Falta el número de comprobante del asiento.';
  end if;
  if v_concepto_trib not in ('bienes', 'servicios', 'honorarios', 'arrendamientos', 'otros') then
    raise exception 'Concepto tributario no válido: %.', v_concepto_trib;
  end if;

  v_cuenta_debe := case v_destino when 'gasto' then '5199' when 'inventario' then '1435' end;
  if v_cuenta_debe is null then
    raise exception 'Destino de compra no válido: %.', coalesce(v_destino, '(vacío)');
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

  -- 3. Cabecera y débito
  insert into public.asientos
    (comprobante, fecha, descripcion, modulo, tercero, tipo, valor, tercero_nit)
  values
    (v_comprobante, v_fecha, v_concepto, 'compras',
     v_proveedor.nombre, v_destino, v_total, v_proveedor.nit)
  returning id into v_asiento_id;

  insert into public.asiento_detalles
    (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
  values
    (v_asiento_id, v_cuenta_debe,
     (case v_destino when 'inventario' then 'Entrada a inventario' else 'Gasto' end) || ' – ' || v_concepto,
     v_total, 0, 'AMBOS');

  -- 4. Retenciones, antes de cerrar el asiento
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

  -- 5. Neto que se le debe al proveedor
  v_neto := v_total - v_total_retenido;

  insert into public.asiento_detalles
    (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
  values
    (v_asiento_id, '2205',
     'Por pagar a ' || v_proveedor.nombre
       || case when v_total_retenido > 0 then ' (neto de retenciones)' else '' end,
     0, v_neto, 'AMBOS');

  -- 6. Partida doble, comprobada explícitamente antes de terminar. El control
  -- del paso 7 lo vuelve a verificar al confirmar la transacción.
  select coalesce(sum(debito), 0), coalesce(sum(credito), 0)
  into v_debitos, v_creditos
  from public.asiento_detalles
  where asiento_id = v_asiento_id;

  if v_debitos <> v_creditos then
    raise exception 'El asiento % no cuadra: débitos % y créditos %. No se guardó nada.',
      v_comprobante, v_debitos, v_creditos
      using errcode = '23514';
  end if;

  -- 7. Documento
  insert into public.documentos_comerciales
    (proveedor_id, concepto, total, fecha, destino, asiento_id, concepto_tributario)
  values
    (v_proveedor.id, v_concepto, v_total, v_fecha, v_destino, v_asiento_id, v_concepto_trib)
  returning id into v_documento_id;

  return jsonb_build_object(
    'documento_id', v_documento_id,
    'asiento_id', v_asiento_id,
    'total', v_total,
    'retenciones', v_retenciones,
    'total_retenido', v_total_retenido,
    'neto_por_pagar', v_neto
  );
end;
$$;

revoke all on function public.registrar_compra(jsonb, jsonb) from public, anon;
grant execute on function public.registrar_compra(jsonb, jsonb) to authenticated;

-- ── 7. Partida doble garantizada en TODOS los asientos ────────────────────
-- Se comprueba al CONFIRMAR la transacción (deferrable initially deferred): así
-- se pueden insertar varias líneas seguidas y solo cuenta el resultado final.
-- Se valida por libro: NIIF (AMBOS + NIIF) y fiscal (AMBOS + FISCAL).
--
-- SECURITY DEFINER es imprescindible: el comercial no puede leer las líneas
-- (sql/009). Con una consulta normal sumaría cero filas, vería todo cuadrado y
-- sus asientos quedarían sin protección.
create or replace function public.validar_partida_doble()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids   bigint[];
  v_id    bigint;
  v_comp  text;
  v_niif  numeric;
  v_fisc  numeric;
begin
  if tg_op = 'INSERT' then
    v_ids := array[new.asiento_id];
  elsif tg_op = 'DELETE' then
    v_ids := array[old.asiento_id];
  else
    v_ids := array[new.asiento_id, old.asiento_id];
  end if;

  foreach v_id in array v_ids loop
    select
      coalesce(sum(debito)  filter (where tipo_normativa in ('AMBOS', 'NIIF')), 0)
    - coalesce(sum(credito) filter (where tipo_normativa in ('AMBOS', 'NIIF')), 0),
      coalesce(sum(debito)  filter (where tipo_normativa in ('AMBOS', 'FISCAL')), 0)
    - coalesce(sum(credito) filter (where tipo_normativa in ('AMBOS', 'FISCAL')), 0)
    into v_niif, v_fisc
    from public.asiento_detalles
    where asiento_id = v_id;

    if v_niif <> 0 or v_fisc <> 0 then
      select comprobante into v_comp from public.asientos where id = v_id;
      raise exception 'El asiento % no cuadra (diferencia en libro NIIF: %, en libro fiscal: %). No se guardó ningún cambio.',
        coalesce(v_comp, v_id::text), v_niif, v_fisc
        using errcode = '23514';
    end if;
  end loop;

  return null;
end;
$$;

drop trigger if exists validar_partida_doble on public.asiento_detalles;
create constraint trigger validar_partida_doble
  after insert or update or delete on public.asiento_detalles
  deferrable initially deferred
  for each row execute function public.validar_partida_doble();

notify pgrst, 'reload schema';

-- ── 8. Comprobación ───────────────────────────────────────────────────────
-- Debe listar: 2 políticas de reglas, 3 triggers (partida doble diferido) y
-- 0 reglas activas (la tabla la carga el contador).
select 'politica' as tipo, policyname::text as detalle, cmd::text as valor
from pg_policies
where schemaname = 'public' and tablename = 'reglas_impuestos'
union all
select 'trigger', t.tgname::text,
       case when t.tgdeferrable then 'se comprueba al confirmar' else 'inmediato' end
from pg_trigger t
where t.tgname in ('validar_partida_doble', 'validar_regla_impuesto', 'proteger_exencion_retencion')
  and not t.tgisinternal
union all
select 'reglas activas', count(*)::text, 'las carga el contador'
from public.reglas_impuestos
where activa;
