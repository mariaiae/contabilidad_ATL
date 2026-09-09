-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Catálogo de cuentas (PUC)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.plan_cuentas (
  id                bigint generated always as identity primary key,

  -- UNIQUE es obligatorio: es la columna sobre la que el seed hace
  -- upsert(..., { onConflict: 'codigo' }). Sin esta restricción el upsert
  -- falla y reejecutar el seed duplicaría todo el catálogo.
  codigo            text        not null unique,

  nombre            text        not null,
  naturaleza        text        not null check (naturaleza in ('DEBITO', 'CREDITO')),

  -- 1 = Clase (1 díg.) · 2 = Grupo (2 díg.) · 3 = Cuenta (4 díg.)
  -- 4 = Subcuenta (6 díg.) · 5 = Auxiliar
  nivel             smallint    not null check (nivel between 1 and 5),

  -- true solo en las cuentas que admiten movimiento contable directo.
  -- Las clases y grupos son agrupadores: no se debita ni acredita en ellos.
  es_cuenta_detalle boolean     not null default false,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_plan_cuentas_nivel   on public.plan_cuentas (nivel);
create index if not exists idx_plan_cuentas_detalle on public.plan_cuentas (es_cuenta_detalle) where es_cuenta_detalle;

-- ── RLS ────────────────────────────────────────────────────────────────────
-- ⚠ Mismo criterio que en 001: la app aún no tiene login, así que se abre el
-- acceso al rol anon. Es válido solo para desarrollo. Al implementar Supabase
-- Auth, cambiar `to anon` por `to authenticated`.
alter table public.plan_cuentas enable row level security;

drop policy if exists dev_all_plan_cuentas on public.plan_cuentas;
create policy dev_all_plan_cuentas on public.plan_cuentas
  for all to anon using (true) with check (true);
