-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Gestión operativa: terceros y compras a crédito
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run      (requiere sql/009)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- QUÉ CREA
--   terceros                 Proveedores y clientes, con NIT único.
--   documentos_comerciales   Compras a crédito. Cada documento tiene su asiento.
--   registrar_compra()       Guarda documento + asiento + líneas en UNA transacción.
--
-- RELACIÓN CON "OPERACIÓN · PROVEEDORES"
--   Operación registra gastos pagados de contado: crédito a 1110 Bancos.
--   Gestión Operativa registra compras a crédito: crédito a 2205 Proveedores.
--
-- POR QUÉ LA COMPRA SE GUARDA CON UNA FUNCIÓN
--   Documento y asiento viven en tablas distintas. Si se guardaran por separado
--   y fallara el segundo paso, un comercial no podría deshacer el primero
--   (sql/009 no le permite borrar asientos con líneas). La función hace todo o
--   nada, y además valida lo que envía la app: que el asiento sea exactamente el
--   de una compra a crédito, que cuadre y que su valor coincida con el documento.
--
-- MATRIZ DE PERMISOS
--   terceros                 auditor: todo · comercial: leer y registrar
--   documentos_comerciales   auditor: todo · comercial: leer, y registrar
--                            SOLO mediante registrar_compra(), que garantiza
--                            que ningún documento quede sin su asiento

-- ── 0. Comprobaciones previas ─────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.get_user_role()') is null then
    raise exception 'Falta sql/009: la función public.get_user_role() no existe.';
  end if;
  if (select count(*) from public.plan_cuentas
      where codigo in ('5199', '1435', '2205') and es_cuenta_detalle) <> 3 then
    raise exception 'El plan de cuentas debe tener 5199, 1435 y 2205 como cuentas de detalle.';
  end if;
end;
$$;

-- ── 1. Terceros ───────────────────────────────────────────────────────────
create table if not exists public.terceros (
  id              bigint      generated always as identity primary key,
  nit             text        not null,
  nombre          text        not null,
  tipo            text        not null default 'proveedor'
                  check (tipo in ('proveedor', 'cliente', 'ambos')),
  registrado_por  uuid        default auth.uid(),
  created_at      timestamptz not null default now(),
  constraint terceros_nit_con_digitos  check (regexp_replace(nit, '[^0-9]', '', 'g') <> ''),
  constraint terceros_nombre_no_vacio  check (btrim(nombre) <> '')
);

-- "900.123.456-7" y "9001234567" son el mismo NIT: la unicidad compara dígitos.
create unique index if not exists terceros_nit_unico
  on public.terceros ((regexp_replace(nit, '[^0-9]', '', 'g')));

-- ── 2. Documentos comerciales (compras a crédito) ─────────────────────────
create table if not exists public.documentos_comerciales (
  id              bigint        generated always as identity primary key,
  proveedor_id    bigint        not null references public.terceros (id) on delete restrict,
  concepto        text          not null check (btrim(concepto) <> ''),
  total           numeric(18,2) not null check (total > 0),
  fecha           date          not null default current_date,
  destino         text          not null check (destino in ('gasto', 'inventario')),
  -- Un documento, un asiento. `restrict`: para borrar el asiento hay que borrar
  -- antes el documento, así nunca queda uno sin el otro.
  asiento_id      bigint        not null unique references public.asientos (id) on delete restrict,
  registrado_por  uuid          default auth.uid(),
  created_at      timestamptz   not null default now()
);

create index if not exists idx_documentos_fecha
  on public.documentos_comerciales (fecha desc, id desc);
create index if not exists idx_documentos_proveedor
  on public.documentos_comerciales (proveedor_id);

-- ── 3. RLS de terceros ────────────────────────────────────────────────────
alter table public.terceros enable row level security;

drop policy if exists terceros_leer      on public.terceros;
drop policy if exists terceros_crear     on public.terceros;
drop policy if exists terceros_modificar on public.terceros;
drop policy if exists terceros_borrar    on public.terceros;

create policy terceros_leer on public.terceros
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

create policy terceros_crear on public.terceros
  for insert to authenticated
  with check ((select public.get_user_role()) in ('auditor', 'comercial'));

create policy terceros_modificar on public.terceros
  for update to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

create policy terceros_borrar on public.terceros
  for delete to authenticated
  using ((select public.es_auditor()));

-- Privilegios de columna: desde la app solo se escriben nit, nombre y tipo.
-- Así nadie puede falsear `registrado_por` ni `created_at`.
revoke all on public.terceros from anon;
revoke insert, update on public.terceros from authenticated;
grant insert (nit, nombre, tipo) on public.terceros to authenticated;
grant update (nit, nombre, tipo) on public.terceros to authenticated;

-- ── 4. RLS de documentos comerciales ──────────────────────────────────────
alter table public.documentos_comerciales enable row level security;

drop policy if exists documentos_leer    on public.documentos_comerciales;
drop policy if exists documentos_auditor on public.documentos_comerciales;

create policy documentos_leer on public.documentos_comerciales
  for select to authenticated
  using ((select public.get_user_role()) in ('auditor', 'comercial'));

-- Escritura directa solo para el auditor. El comercial registra compras con
-- registrar_compra(), que siempre crea el asiento junto con el documento.
create policy documentos_auditor on public.documentos_comerciales
  for all to authenticated
  using ((select public.es_auditor()))
  with check ((select public.es_auditor()));

revoke all on public.documentos_comerciales from anon;

-- ── 5. Registrar una compra a crédito ─────────────────────────────────────
-- La app construye el asiento con su motor contable; esta función comprueba
-- que sea exactamente el de una compra a crédito y lo guarda todo o nada.
--
--   p_documento  { proveedor_id, concepto, total, destino, fecha }
--   p_asiento    { comprobante, lineas: [{ cuenta, descripcion, debito, credito }] }
--
-- El tercero y su NIT se toman de la base, no de lo que envíe la app.
-- Las cuentas deben coincidir con CUENTA_COMPRA y CUENTA_POR_PAGAR en app.js.
create or replace function public.registrar_compra(p_documento jsonb, p_asiento jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rol          text  := public.get_user_role();
  v_proveedor    public.terceros%rowtype;
  v_total        numeric(18,2);
  v_concepto     text  := btrim(coalesce(p_documento ->> 'concepto', ''));
  v_destino      text  := p_documento ->> 'destino';
  v_fecha        date  := coalesce(nullif(p_documento ->> 'fecha', '')::date, current_date);
  v_comprobante  text  := btrim(coalesce(p_asiento ->> 'comprobante', ''));
  v_lineas       jsonb := p_asiento -> 'lineas';
  v_cuenta_debe  text;
  v_asiento_id   bigint;
  v_documento_id bigint;
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

  -- 3. Asiento: exactamente dos líneas, débito a gasto o inventario y crédito
  -- a proveedores, ambas por el valor del documento. Con dos líneas y esas dos
  -- condiciones, el asiento queda cuadrado por construcción.
  if jsonb_typeof(v_lineas) is distinct from 'array' then
    raise exception 'El asiento de la compra no trae líneas.';
  end if;
  if jsonb_array_length(v_lineas) <> 2 then
    raise exception 'El asiento de una compra debe tener exactamente dos líneas.';
  end if;
  if not exists (
       select 1 from jsonb_array_elements(v_lineas) l
       where l ->> 'cuenta' = v_cuenta_debe
         and (l ->> 'debito')::numeric = v_total
         and coalesce((l ->> 'credito')::numeric, 0) = 0)
     or not exists (
       select 1 from jsonb_array_elements(v_lineas) l
       where l ->> 'cuenta' = '2205'
         and (l ->> 'credito')::numeric = v_total
         and coalesce((l ->> 'debito')::numeric, 0) = 0) then
    raise exception 'El asiento no corresponde a una compra a crédito por %: debe debitar la cuenta % y acreditar 2205 por ese mismo valor.',
      v_total, v_cuenta_debe;
  end if;

  -- 4. Guardado: si cualquier paso falla, la transacción entera se revierte.
  insert into public.asientos
    (comprobante, fecha, descripcion, modulo, tercero, tipo, valor, tercero_nit)
  values
    (v_comprobante, v_fecha, v_concepto, 'compras',
     v_proveedor.nombre, v_destino, v_total, v_proveedor.nit)
  returning id into v_asiento_id;

  insert into public.asiento_detalles
    (asiento_id, cuenta, descripcion, debito, credito, tipo_normativa)
  select v_asiento_id,
         l ->> 'cuenta',
         l ->> 'descripcion',
         coalesce((l ->> 'debito')::numeric, 0),
         coalesce((l ->> 'credito')::numeric, 0),
         'AMBOS'
  from jsonb_array_elements(v_lineas) l;

  insert into public.documentos_comerciales
    (proveedor_id, concepto, total, fecha, destino, asiento_id)
  values
    (v_proveedor.id, v_concepto, v_total, v_fecha, v_destino, v_asiento_id)
  returning id into v_documento_id;

  return jsonb_build_object('documento_id', v_documento_id, 'asiento_id', v_asiento_id);
end;
$$;

revoke all on function public.registrar_compra(jsonb, jsonb) from public, anon;
grant execute on function public.registrar_compra(jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- ── 6. Comprobación ───────────────────────────────────────────────────────
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('terceros', 'documentos_comerciales')
order by tablename, policyname;
