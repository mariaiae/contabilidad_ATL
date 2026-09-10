-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Pagos a proveedores (cuentas por pagar)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/010)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ CREA
--   pagos_proveedores    Abonos y pagos de las compras a crédito.
--   metricas_asientos()  Se amplía con cxp_neto: movimiento neto en 2205.
--   saldos_por_pagar()   Total, pagado y saldo de cada factura, solo en cifras.
--   registrar_pago()     Construye y guarda el asiento de egreso en UNA transacción.
--
-- ASIENTO DE UN PAGO
--   Débito  2205 Proveedores           disminuye la deuda
--   Crédito 1105 Caja / 1110 Bancos    sale el dinero
--
-- REGLAS POR ROL
--   comercial  Registra pagos. El origen es SIEMPRE 1105 Caja General: si pide
--              otra cuenta, la base lo rechaza. No edita ni borra pagos, y no
--              lee las líneas de los asientos (sql/009).
--   auditor    Control total. Elige cualquier cuenta de detalle del grupo
--              11 Disponible (Caja, Bancos, …).
--
-- EL SALDO SALE DEL LIBRO
--   El saldo de cada factura se calcula con los movimientos reales en 2205, a
--   través de metricas_asientos(), no con una columna que pueda desincronizarse.
--   registrar_pago() valida contra esa misma función: el saldo que ve la app es
--   exactamente el que la base hace cumplir.

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
begin
  if to_regclass('public.documentos_comerciales') is null
     or to_regprocedure('public.registrar_compra(jsonb, jsonb)') is null then
    raise exception 'Falta sql/010: no existen documentos_comerciales ni registrar_compra().';
  end if;
  if (select count(*) from public.plan_cuentas
      where codigo in ('1105', '1110', '2205') and es_cuenta_detalle) <> 3 then
    raise exception 'El plan de cuentas debe tener 1105, 1110 y 2205 como cuentas de detalle.';
  end if;
end;
$$;

-- ── 1. Tabla de pagos ─────────────────────────────────────────────────────
create table if not exists public.pagos_proveedores (
  id              bigint        generated always as identity primary key,
  documento_id    bigint        not null references public.documentos_comerciales (id) on delete restrict,
  valor           numeric(18,2) not null check (valor > 0),
  fecha           date          not null default current_date,
  cuenta_origen   text          not null references public.plan_cuentas (codigo)
                                on update cascade on delete restrict,
  -- Un pago, un asiento de egreso; no se borra el asiento sin borrar antes el pago.
  asiento_id      bigint        not null unique references public.asientos (id) on delete restrict,
  registrado_por  uuid          default auth.uid(),
  created_at      timestamptz   not null default now()
);

create index if not exists idx_pagos_documento on public.pagos_proveedores (documento_id);
create index if not exists idx_pagos_fecha     on public.pagos_proveedores (fecha desc, id desc);

-- ── 2. RLS de pagos ───────────────────────────────────────────────────────
alter table public.pagos_proveedores enable row level security;

drop policy if exists pagos_leer    on public.pagos_proveedores;
drop policy if exists pagos_auditor on public.pagos_proveedores;

-- Ambos roles ven el historial de pagos (fecha, factura, valor, origen).
create policy pagos_leer on public.pagos_proveedores
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

-- Escritura directa, edición y borrado: solo el auditor. El comercial registra
-- pagos únicamente con registrar_pago(), que siempre crea su asiento.
create policy pagos_auditor on public.pagos_proveedores
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

revoke all on public.pagos_proveedores from anon;

-- ── 3. metricas_asientos() con el movimiento en cuentas por pagar ─────────
-- Cambiar las columnas de salida de una función exige borrarla y recrearla.
-- Mismas fórmulas que sql/009 más cxp_neto; debe coincidir con metricasDe().
drop function if exists public.metricas_asientos(text);

create function public.metricas_asientos(p_modulo text default null)
returns table (
  asiento_id      bigint,
  total_debito    numeric,
  total_credito   numeric,
  iva             numeric,   -- crédito en 2408
  retencion       numeric,   -- crédito en 2370
  cxc_neto        numeric,   -- débito − crédito en 1455
  ingreso         numeric,   -- crédito en 4135
  cobro_banco     numeric,   -- débito en 1110
  aporte_capital  numeric,   -- crédito en 3105 + 3120
  retiro          numeric,   -- débito en 3705
  gasto_general   numeric,   -- débito en 5199
  gasto_dotacion  numeric,   -- débito en 5120
  gasto_poliza    numeric,   -- débito en 5150
  cxp_neto        numeric    -- crédito − débito en 2205
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    d.asiento_id,
    coalesce(sum(d.debito), 0),
    coalesce(sum(d.credito), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '2408'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '2370'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '1455'), 0)
      - coalesce(sum(d.credito) filter (where d.cuenta = '1455'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '4135'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '1110'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta in ('3105', '3120')), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '3705'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '5199'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '5120'), 0),
    coalesce(sum(d.debito)  filter (where d.cuenta = '5150'), 0),
    coalesce(sum(d.credito) filter (where d.cuenta = '2205'), 0)
      - coalesce(sum(d.debito) filter (where d.cuenta = '2205'), 0)
  from public.asiento_detalles d
  join public.asientos a on a.id = d.asiento_id
  where (select public.get_user_role()) in ('auditor', 'comercial')
    and (p_modulo is null or a.modulo = p_modulo)
  group by d.asiento_id;
$$;

revoke all on function public.metricas_asientos(text) from public, anon;
grant execute on function public.metricas_asientos(text) to authenticated;

-- ── 4. Saldos por pagar ───────────────────────────────────────────────────
-- Por factura: lo que se debe según el asiento de la compra, lo pagado según
-- los asientos de sus pagos, y la diferencia. Solo cifras: ninguna línea.
create or replace function public.saldos_por_pagar()
returns table (
  documento_id  bigint,
  proveedor_id  bigint,
  total         numeric,   -- crédito en 2205 del asiento de la compra
  pagado        numeric,   -- débito en 2205 de los asientos de sus pagos
  saldo         numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with m as (select * from public.metricas_asientos(null))
  select
    doc.id,
    doc.proveedor_id,
    coalesce(mc.cxp_neto, 0),
    coalesce(-sum(mp.cxp_neto), 0),
    coalesce(mc.cxp_neto, 0) + coalesce(sum(mp.cxp_neto), 0)
  from public.documentos_comerciales doc
  left join m mc on mc.asiento_id = doc.asiento_id
  left join public.pagos_proveedores p on p.documento_id = doc.id
  left join m mp on mp.asiento_id = p.asiento_id
  where (select public.get_user_role()) in ('auditor', 'comercial')
  group by doc.id, doc.proveedor_id, mc.cxp_neto;
$$;

revoke all on function public.saldos_por_pagar() from public, anon;
grant execute on function public.saldos_por_pagar() to authenticated;

-- ── 5. Registrar un pago ──────────────────────────────────────────────────
--   p_pago  { documento_id, valor, fecha, comprobante, cuenta_origen? }
-- El proveedor, el concepto y el saldo se toman de la base, no de la app.
create or replace function public.registrar_pago(p_pago jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol            text  := public.get_user_role();
  v_documento      public.documentos_comerciales%rowtype;
  v_proveedor      public.terceros%rowtype;
  v_valor          numeric(18,2);
  v_saldo          numeric(18,2);
  v_fecha          date  := coalesce(nullif(p_pago ->> 'fecha', '')::date, current_date);
  v_comprobante    text  := btrim(coalesce(p_pago ->> 'comprobante', ''));
  v_cuenta         text  := nullif(btrim(coalesce(p_pago ->> 'cuenta_origen', '')), '');
  v_cuenta_nombre  text;
  v_asiento_id     bigint;
  v_pago_id        bigint;
begin
  -- 1. Rol
  if v_rol is null or v_rol not in ('auditor', 'comercial') then
    raise exception 'Tu perfil no puede registrar pagos.' using errcode = '42501';
  end if;

  -- 2. Datos básicos
  v_valor := (p_pago ->> 'valor')::numeric;
  if v_valor is null or v_valor <= 0 then
    raise exception 'El valor del pago debe ser mayor que cero.';
  end if;
  if v_comprobante = '' then
    raise exception 'Falta el número de comprobante del asiento.';
  end if;

  -- 3. Regla de tesorería
  if v_rol = 'comercial' then
    if v_cuenta is not null and v_cuenta <> '1105' then
      raise exception 'Tu perfil solo puede registrar pagos desde Caja General.'
        using errcode = '42501';
    end if;
    v_cuenta := '1105';
  else
    v_cuenta := coalesce(v_cuenta, '1105');
  end if;

  select nombre into v_cuenta_nombre
  from public.plan_cuentas
  where codigo = v_cuenta and es_cuenta_detalle and codigo like '11%';
  if not found then
    raise exception 'La cuenta % no es una cuenta de tesorería válida: debe ser de detalle del grupo 11 Disponible.', v_cuenta;
  end if;

  -- 4. La factura, bloqueada: dos pagos simultáneos no pueden superar juntos
  -- el saldo. El segundo espera a que termine el primero y ve su efecto.
  select * into v_documento
  from public.documentos_comerciales
  where id = (p_pago ->> 'documento_id')::bigint
  for update;
  if not found then
    raise exception 'La factura indicada no existe.';
  end if;

  select s.saldo into v_saldo
  from public.saldos_por_pagar() s
  where s.documento_id = v_documento.id;
  v_saldo := coalesce(v_saldo, 0);

  if v_saldo <= 0 then
    raise exception 'Esta factura ya está pagada por completo.';
  end if;
  if v_valor > v_saldo then
    raise exception 'El pago (%) supera el saldo pendiente de la factura (%).', v_valor, v_saldo;
  end if;

  select * into v_proveedor
  from public.terceros
  where id = v_documento.proveedor_id;

  -- 5. Guardado: todo o nada.
  insert into public.asientos
    (comprobante, fecha, descripcion, modulo, tercero, tipo, valor, tercero_nit)
  values
    (v_comprobante, v_fecha, 'Pago – ' || v_documento.concepto, 'pagos',
     v_proveedor.nombre,
     case when v_valor = v_saldo then 'pago_total' else 'abono' end,
     v_valor, v_proveedor.nit)
  returning id into v_asiento_id;

  insert into public.asiento_detalles
    (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
  values
    (v_asiento_id, '2205', 'Pago a ' || v_proveedor.nombre || ' – ' || v_documento.concepto,
     v_valor, 0, 'AMBOS'),
    (v_asiento_id, v_cuenta, 'Egreso desde ' || v_cuenta_nombre,
     0, v_valor, 'AMBOS');

  insert into public.pagos_proveedores
    (documento_id, valor, fecha, cuenta_origen, asiento_id)
  values
    (v_documento.id, v_valor, v_fecha, v_cuenta, v_asiento_id)
  returning id into v_pago_id;

  return jsonb_build_object(
    'pago_id', v_pago_id,
    'asiento_id', v_asiento_id,
    'saldo_restante', v_saldo - v_valor
  );
end;
$$;

revoke all on function public.registrar_pago(jsonb) from public, anon;
grant execute on function public.registrar_pago(jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ── 6. Comprobación ───────────────────────────────────────────────────────
-- Debe listar las 2 políticas de pagos y, por cada factura, su saldo actual.
-- El saldo se calcula aquí directamente: saldos_por_pagar() no devuelve filas
-- desde el SQL Editor, porque ahí no hay usuario autenticado ni rol.
select 'politica' as tipo, policyname::text as detalle, cmd::text as valor
from pg_policies
where schemaname = 'public' and tablename = 'pagos_proveedores'
union all
select 'factura ' || d.id,
       t.nombre || ' · ' || d.concepto,
       'total ' || d.total || ' · saldo ' || s.saldo
from public.documentos_comerciales d
join public.terceros t on t.id = d.proveedor_id
cross join lateral (
  select coalesce(sum(dt.credito) filter (where dt.cuenta = '2205'), 0)
       - coalesce(sum(dt.debito)  filter (where dt.cuenta = '2205'), 0) as saldo
  from public.asiento_detalles dt
  where dt.asiento_id = d.asiento_id
     or dt.asiento_id in (select p.asiento_id from public.pagos_proveedores p
                          where p.documento_id = d.id)
) s;
