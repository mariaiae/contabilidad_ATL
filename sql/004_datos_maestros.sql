-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Datos maestros (socios y domiciliarios)
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Sustituyen los arreglos `S.socios` y `S.domiciliarios` que vivían en memoria
-- y se reiniciaban en cada recarga.
--
-- NOTA sobre el saldo CxC de los domiciliarios: NO se guarda como columna.
-- Es un valor derivado (débitos menos créditos en la cuenta 1455 de sus
-- asientos) y `recalcularDerivados()` lo reconstruye. Guardarlo además aquí
-- crearía dos fuentes de verdad que se desincronizarían.

create table if not exists public.socios (
  id         text        primary key,   -- S001, S002, …
  nombre     text        not null,
  documento  text,
  activo     boolean     not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.domiciliarios (
  id         text        primary key,   -- D001, D002, …
  nombre     text        not null,
  documento  text,
  placa      text,
  telefono   text,
  ingreso    date,
  activo     boolean     not null default true,
  created_at timestamptz not null default now()
);

-- ── Carga inicial: lo que hoy está escrito en app.js ───────────────────────
insert into public.socios (id, nombre) values
  ('S001', 'Henry Camilo Taborda'),
  ('S002', 'María Isabel Arias'),
  ('S003', 'Manuel Fernando Toro')
on conflict (id) do nothing;

insert into public.domiciliarios (id, nombre, documento, placa, telefono, ingreso) values
  ('D001', 'Manuel Fernando Toro', '98.406.138', 'BZK-14A', '314 678 9012', '2025-03-01'),
  ('D002', 'Jhon Fredy Cardona',   '98.345.678', 'MSP-22C', '316 234 5678', '2025-05-15'),
  ('D003', 'Luz Marina Ospina',    '43.567.890', 'KLT-55B', '310 987 6543', '2025-07-01'),
  ('D004', 'Rodrigo Estrada Gil',  '71.234.567', 'NAP-88D', '312 456 7890', '2024-11-01')
on conflict (id) do nothing;

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Provisional, en línea con las tablas anteriores. El archivo 005 cierra el
-- acceso anónimo de TODAS las tablas de una sola vez.
alter table public.socios         enable row level security;
alter table public.domiciliarios  enable row level security;

drop policy if exists dev_all_socios on public.socios;
create policy dev_all_socios on public.socios
  for all to anon using (true) with check (true);

drop policy if exists dev_all_domiciliarios on public.domiciliarios;
create policy dev_all_domiciliarios on public.domiciliarios
  for all to anon using (true) with check (true);
