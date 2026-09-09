-- ═══════════════════════════════════════════════════════════════════════════
-- Contabilidad ATL · Campos requeridos por Ventas, Nómina y Operación
-- Ejecutar en: Supabase Dashboard → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Los tres módulos capturan datos que no caben en las columnas de 001 y que
-- NO son derivables de las líneas contables:
--
--   tercero_nit  NIT del cliente (Ventas) o del proveedor (Operación).
--   vencimiento  Fecha de vencimiento de la factura de venta.
--   tasa         % aplicado: IVA en Ventas, retefuente en Operación. El monto
--                sí está en las líneas (2408 / 2370), pero el porcentaje no,
--                y los reportes de impuestos clasifican por tarifa.
--
-- Todo lo demás se deriva de `asiento_detalles`, que es la fuente de verdad:
--   IVA = crédito en 2408 · Retención = crédito en 2370 · Total = suma débitos

alter table public.asientos add column if not exists tercero_nit text;
alter table public.asientos add column if not exists vencimiento date;
alter table public.asientos add column if not exists tasa numeric(6,3);

-- El filtro por módulo se usa en cada render; con 4 módulos ya vale la pena.
create index if not exists idx_asientos_modulo_fecha
  on public.asientos (modulo, fecha desc, id desc);
