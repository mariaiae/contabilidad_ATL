-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Esquema de asientos contables (partida doble)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cabecera del asiento ───────────────────────────────────────────────────
create table if not exists public.asientos (
  id             bigint generated always as identity primary key,
  comprobante    text        not null unique,          -- ATL-00001
  fecha          date        not null default current_date,
  descripcion    text,
  modulo         text        not null default 'socios',-- socios | ventas | nomina | operacion
  tercero        text,                                 -- nombre del socio / cliente
  tipo           text,                                 -- capital | prestamo_de_socio | ...
  modalidad      text,                                 -- solo aportes de capital
  clasificacion  text,                                 -- Patrimonio | Pasivo | Activo
  soporte        text,                                 -- nro. consignación, recibo, factura
  valor          numeric(18,2) not null default 0,
  created_at     timestamptz not null default now()
);

-- ── Líneas del asiento (débito / crédito) ──────────────────────────────────
create table if not exists public.asiento_detalles (
  id             bigint generated always as identity primary key,
  asiento_id     bigint      not null references public.asientos(id) on delete cascade,
  cuenta         text        not null,                 -- código PUC: 1110, 3105, ...
  descripcion    text,
  debito         numeric(18,2) not null default 0,
  credito        numeric(18,2) not null default 0,
  tipo_normativa text        not null default 'AMBOS'
                 check (tipo_normativa in ('NIIF', 'FISCAL', 'AMBOS')),
  created_at     timestamptz not null default now()
);

create index if not exists idx_detalles_asiento on public.asiento_detalles (asiento_id);
create index if not exists idx_asientos_fecha   on public.asientos (fecha desc, id desc);
create index if not exists idx_asientos_modulo  on public.asientos (modulo);

-- ── RLS ────────────────────────────────────────────────────────────────────
-- ⚠ ATENCIÓN: la app todavía no tiene login, así que se abre el acceso a la
-- clave publishable (rol anon). Esto significa que CUALQUIERA con la URL y la
-- clave del proyecto puede leer y escribir estos asientos contables.
-- Es aceptable solo para desarrollo. Antes de manejar datos reales: implementar
-- Supabase Auth y reemplazar `to anon` por `to authenticated`.
alter table public.asientos          enable row level security;
alter table public.asiento_detalles  enable row level security;

drop policy if exists dev_all_asientos on public.asientos;
create policy dev_all_asientos on public.asientos
  for all to anon using (true) with check (true);

drop policy if exists dev_all_detalles on public.asiento_detalles;
create policy dev_all_detalles on public.asiento_detalles
  for all to anon using (true) with check (true);
