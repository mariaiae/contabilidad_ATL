/* ═══════════════════════════════════════════════════════════════════════
   Contabilidad ATL · Motor Contable — Módulo Completo 5 Tabs
   PUC Colombiano · Nómina · Socios · Ventas · Proveedores · Impuestos
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

import { supabase } from './supabase.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. PUC — Plan Único de Cuentas (relevantes para el módulo)
// ─────────────────────────────────────────────────────────────────────────────
const PUC = {
  '1105': 'Caja',
  '1110': 'Bancos',
  '1305': 'Clientes (Deudores comerciales)',
  '1325': 'Cuentas por cobrar a socios',
  '1455': 'Cuentas por Cobrar – Empleados',
  '1705': 'Seguros pagados por anticipado',
  '2305': 'Nómina por pagar',
  '2370': 'Retención en la fuente por pagar',
  '2380': 'Aportes Seguridad Social por pagar',
  '2408': 'IVA Generado por pagar',
  '2610': 'Cesantías por pagar',
  '2615': 'Intereses cesantías por pagar',
  '2630': 'Prima de servicios por pagar',
  '2640': 'Vacaciones por pagar',
  '2390': 'Cuentas por pagar a socios',
  '2396': 'Préstamos de socios – Pasivo financiero',
  '3105': 'Capital suscrito y pagado',
  '3120': 'Capital por capitalizar (inversiones transitorio)',
  '3305': 'Reservas de capital',
  '3610': 'Utilidades del ejercicio',
  '3705': 'Utilidades acumuladas de ejercicios anteriores',
  '4135': 'Ingresos – Servicios logísticos',
  '5105': 'Gastos personal – Salarios',
  '5110': 'Gastos personal – Aux. transporte',
  '5115': 'Gastos personal – Aux. rodamiento (no salarial)',
  '5120': 'Gastos personal – Dotación obligatoria',
  '5135': 'Provisión cesantías',
  '5136': 'Provisión int. cesantías',
  '5137': 'Provisión prima de servicios',
  '5138': 'Provisión vacaciones',
  '5140': 'Aportes seguridad social – empresa',
  '5150': 'Gastos generales – pólizas y seguros',
  '5195': 'Gastos generales – honorarios',
  '5199': 'Gastos generales – otros',
  '5395': 'Gastos no deducibles – multas (Art. 89 E.T.)',
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  params: { smlv: 1423500, auxTransporte: 200000, auxRodamiento: 300000, diasPeriodo: 30 },

  domiciliarios: [
    { id: 'D001', nombre: 'Manuel Fernando Toro', doc: '98.406.138', placa: 'BZK-14A', tel: '314 678 9012', ingreso: '2025-03-01', cxc: 0 },
    { id: 'D002', nombre: 'Jhon Fredy Cardona', doc: '98.345.678', placa: 'MSP-22C', tel: '316 234 5678', ingreso: '2025-05-15', cxc: 0 },
    { id: 'D003', nombre: 'Luz Marina Ospina', doc: '43.567.890', placa: 'KLT-55B', tel: '310 987 6543', ingreso: '2025-07-01', cxc: 0 },
    { id: 'D004', nombre: 'Rodrigo Estrada Gil', doc: '71.234.567', placa: 'NAP-88D', tel: '312 456 7890', ingreso: '2024-11-01', cxc: 0 },
  ],

  socios: [
    { id: 'S001', nombre: 'Henry Camilo Taborda' },
    { id: 'S002', nombre: 'María Isabel Arias' },
    { id: 'S003', nombre: 'Manuel Fernando Toro' },
  ],

  asientosSocios: [],
  asientosVentas: [],
  asientosNomina: [],
  asientosOp: [],

  // Acumuladores para impuestos
  ivaAcum: { pct19: 0, pct5: 0, excluido: 0 },
  rteAcum: { compras: 0, honJ: 0, honN: 0, serv: 0 },
  multasAcum: 0,

  seq: 1,
  liqActual: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. UTILIDADES
// ─────────────────────────────────────────────────────────────────────────────
const fmt = (v) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v ?? 0);

const today = () => new Date().toISOString().split('T')[0];

const initials = (n) => n.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();

const fmtDate = (d) => {
  if (!d) return '–';
  return new Date(d + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
};

const nextComp = (prefix = 'ATL') => `${prefix}-${String(S.seq++).padStart(5, '0')}`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. NÓMINA — MOTOR DE CÁLCULO
// ─────────────────────────────────────────────────────────────────────────────
function calcNomina(dom, dias) {
  const { smlv, auxTransporte, auxRodamiento, diasPeriodo } = S.params;
  dias = dias || diasPeriodo;

  const salario = Math.round((smlv / diasPeriodo) * dias);
  const transp = Math.round((auxTransporte / diasPeriodo) * dias);
  const rodamiento = auxRodamiento; // fijo mensual (política empresa)

  // BASE PRESTACIONES = Salario + Aux.Transporte (Ley 1955/2019)
  const base = salario + transp;

  const cesantias = Math.round(base * (1 / 12));
  const intCes = Math.round(cesantias * 0.12);
  const prima = Math.round(base * (1 / 12));
  const vacaciones = Math.round(salario * (15 / 360));

  // Seguridad social — base = solo salario
  const baseSS = salario;
  const ssEmpresa = Math.round(baseSS * 0.2115); // Salud 8.5+Pensión 12+ARL 1.044+Caja 4%
  const saludEmp = Math.round(baseSS * 0.04);
  const pensionEmp = Math.round(baseSS * 0.04);

  // Descuento CxC (máx 30% del devengado – Art.149 CST)
  const descCxC = dom.cxc > 0 ? Math.min(dom.cxc, Math.round(base * 0.3)) : 0;

  const totalDed = saludEmp + pensionEmp + descCxC;
  const devengado = salario + transp + rodamiento;
  const neto = devengado - totalDed;
  const costoTotal = devengado + cesantias + intCes + prima + vacaciones + ssEmpresa;

  return {
    dom, dias, salario, transp, rodamiento, base,
    cesantias, intCes, prima, vacaciones,
    ssEmpresa, saludEmp, pensionEmp,
    descCxC, totalDed, devengado, neto, costoTotal
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GENERADORES DE ASIENTOS CONTABLES
// ─────────────────────────────────────────────────────────────────────────────

/** Asiento genérico: array de { cuenta, desc, débito, crédito } */
function buildAsiento({ comp, fecha, modulo, chip, nombre, desc, lineas }) {
  const totD = lineas.reduce((a, l) => a + l.debito, 0);
  const totC = lineas.reduce((a, l) => a + l.credito, 0);
  return { comp, fecha: fecha || today(), modulo, chip, nombre, desc, lineas, totD, totC };
}

// ── Microcopy dinámico por tipo de movimiento (Apple HIG) ────────────────
const TIPO_SOCIO_HINTS = {
  capital: 'Inyección formal de dinero que aumenta el patrimonio de la empresa. No representa una deuda a devolver a corto plazo.',
  gasto_pagado_socio: 'El socio pagó con su dinero personal un gasto de la empresa y la empresa le reembolsará exactamente ese valor.',
  inversion: 'Fondos o activos destinados a proyectos o equipamiento clave, pendientes por formalizar en patrimonio.',
  distribucion: 'Pago de ganancias o dividendos acumulados generados por la empresa hacia el socio.',
  prestamo_de_socio: 'Préstamo de dinero temporal a la empresa que genera una obligación de devolución al socio a corto/mediano plazo.',
  prestamo_a_socio: 'Dinero entregado al socio como préstamo, generando una cuenta por cobrar a favor de la empresa.',
};

function asientoSocio(tipo, socio, valor, desc, fecha) {
  const comp = nextComp('SOC');
  let lineas = [];
  let chip = 'chip-socio';

  switch (tipo) {
    // ── NIIF Pymes: Aporte de Capital (Sección 22.7) ───────────────────
    // Débito: 1110 Bancos | Crédito: 3105 Capital Suscrito y Pagado
    case 'capital':
      lineas = [
        { cuenta: '1110', desc: `Aporte de capital – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '3105', desc: `Capital suscrito y pagado – ${socio.nombre}`, debito: 0, credito: valor },
      ]; break;

    // ── Gasto pagado por Socio (reembolso) ─────────────────────────
    // Débito: 5199 Gasto Operativo | Crédito: 2390 CxP Socios (Pasivo)
    case 'gasto_pagado_socio':
      lineas = [
        { cuenta: '5199', desc: `Gasto operativo pagado por socio – ${desc || socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '2390', desc: `Reembolso pendiente a ${socio.nombre} (CxP Socios)`, debito: 0, credito: valor },
      ]; break;

    // ── Inversión del Socio ──────────────────────────────────────
    // Débito: 1110 Bancos | Crédito: 3120 Capital por Capitalizar (Transitorio)
    case 'inversion':
      lineas = [
        { cuenta: '1110', desc: `Inversión socio – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '3120', desc: `Capital de trabajo por capitalizar – ${socio.nombre}`, debito: 0, credito: valor },
      ]; break;

    // ── Retiro / Distribución de Utilidades (NIIF Pymes § 22.18) ───────
    // Débito: 3705 Utilidades Acumuladas | Crédito: 1110 Bancos
    case 'distribucion':
      chip = 'chip-cxc';
      lineas = [
        { cuenta: '3705', desc: `Distribución de utilidades – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago dividendos / retiro socio`, debito: 0, credito: valor },
      ]; break;

    // ── Préstamo del Socio a Empresa (Art. 35 E.T.) ─────────────────
    // Débito: 1110 Bancos | Crédito: 2396 Préstamos Socios (Pasivo Financiero)
    case 'prestamo_de_socio':
      lineas = [
        { cuenta: '1110', desc: `Préstamo recibido de socio – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '2396', desc: `Pasivo financiero – Préstamo ${socio.nombre}`, debito: 0, credito: valor },
      ]; break;

    // ── Préstamo de Empresa a Socio ─────────────────────────────────
    // Débito: 1325 CxC Socios | Crédito: 1110 Bancos
    case 'prestamo_a_socio':
      chip = 'chip-cxc';
      lineas = [
        { cuenta: '1325', desc: `Préstamo otorgado a socio – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Desembolso préstamo a socio`, debito: 0, credito: valor },
      ]; break;
  }
  const a = buildAsiento({ comp, fecha, modulo: 'socio', chip, nombre: socio.nombre, desc: desc || tipo, lineas });
  S.asientosSocios.push(a);
  return a;
}

function asientoVenta(tipo, cliente, valorBase, ivaPct, desc, fecha) {
  const comp = nextComp('VEN');
  const iva = Math.round(valorBase * (ivaPct / 100));
  const total = valorBase + iva;
  let lineas = [];
  let chip = 'chip-venta';

  switch (tipo) {
    case 'factura':
      lineas = [
        { cuenta: '1305', desc: `Factura ${cliente} – ${desc}`, debito: total, credito: 0 },
        { cuenta: '4135', desc: `Ingreso servicio logístico`, debito: 0, credito: valorBase },
      ];
      if (iva > 0) lineas.push({ cuenta: '2408', desc: `IVA ${ivaPct}% generado`, debito: 0, credito: iva });
      // Acumular IVA
      if (ivaPct === 19) S.ivaAcum.pct19 += iva;
      else if (ivaPct === 5) S.ivaAcum.pct5 += iva;
      else S.ivaAcum.excluido += valorBase;
      break;
    case 'cobro':
      chip = 'chip-ok';
      lineas = [
        { cuenta: '1110', desc: `Cobro cartera – ${cliente}`, debito: total, credito: 0 },
        { cuenta: '1305', desc: `Cancelación cartera – ${cliente}`, debito: 0, credito: total },
      ]; break;
    case 'nota_credito':
      lineas = [
        { cuenta: '4135', desc: `Nota crédito – ${desc}`, debito: valorBase, credito: 0 },
        { cuenta: '1305', desc: `Reverso cartera – ${cliente}`, debito: 0, credito: valorBase },
      ]; break;
    case 'anticipo_cliente':
      lineas = [
        { cuenta: '1110', desc: `Anticipo cliente – ${cliente}`, debito: total, credito: 0 },
        { cuenta: '2305', desc: `Anticipo recibido`, debito: 0, credito: total },
      ]; break;
  }
  const a = buildAsiento({ comp, fecha, modulo: 'venta', chip, nombre: cliente, desc: desc || tipo, lineas });
  S.asientosVentas.push(a);
  return a;
}

function asientoMovDom(tipo, dom, valor, desc, prov, fecha, polizaDesde, polizaHasta) {
  const comp = nextComp('DOM');
  let lineas = [];
  let chip = 'chip-gasto';
  let alerta = null;

  switch (tipo) {
    case 'dotacion':
      lineas = [
        { cuenta: '5120', desc: `Dotación – ${desc} – ${dom.nombre}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago dotación: ${prov || 'Proveedor'}`, debito: 0, credito: valor },
      ];
      alerta = {
        clase: 'alerta-success', titulo: '✅ Gasto deducible — Dotación obligatoria',
        texto: `Casco, impermeable y uniforme se reconocen como <strong>gasto operativo deducible</strong> en cuenta 5120. Cumple Art. 107 E.T.`
      };
      break;
    case 'poliza': {
      chip = 'chip-poliza';
      const dias = polizaDesde && polizaHasta
        ? Math.round((new Date(polizaHasta) - new Date(polizaDesde)) / 86400000) : 30;
      const esAnticipado = dias > 30;
      const cuenta = esAnticipado ? '1705' : '5150';
      lineas = [
        { cuenta, desc: `${esAnticipado ? 'Seguro anticipado' : 'Póliza'} – ${desc} – ${dom?.nombre || 'Empresa'}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago póliza: ${prov || 'Aseguradora'}`, debito: 0, credito: valor },
      ];
      alerta = {
        clase: 'alerta-info', titulo: esAnticipado ? '🔵 Póliza → Gasto pagado por anticipado' : '🔵 Póliza → Gasto del período',
        texto: esAnticipado
          ? `Vigencia <strong>${dias} días</strong>. Registrado en <strong>1705 – Seguros pagados por anticipado</strong>. Se amortizará mensualmente.`
          : `Póliza dentro del período. Registrado en <strong>5150 – Gastos seguros</strong>. Deducible (Art. 107 E.T.).`
      };
      break;
    }
    case 'repuesto':
      chip = 'chip-cxc';
      dom.cxc += valor;
      lineas = [
        { cuenta: '1455', desc: `Préstamo: repuesto/mto. – ${dom.nombre}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago: ${prov || '?'}`, debito: 0, credito: valor },
      ];
      alerta = {
        clase: 'alerta-warn', titulo: '⚠️ No es gasto — Cuenta por Cobrar al Trabajador',
        texto: `Repuestos, gasolina y mantenimiento de la moto son <strong>responsabilidad del trabajador</strong>. Cuenta <strong>1455</strong>. Se descuenta en nómina.`
      };
      break;
    case 'multa':
      chip = 'chip-cxc';
      dom.cxc += valor;
      S.multasAcum += valor;
      lineas = [
        { cuenta: '1455', desc: `Multa tránsito – ${dom.nombre} – descuento nómina`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago multa: ${desc || 'Infracción'}`, debito: 0, credito: valor },
      ];
      alerta = {
        clase: 'alerta-danger', titulo: '🔴 ALERTA REVISORÍA FISCAL — Multa de Tránsito (Art. 89 E.T.)',
        texto: `Las multas son <strong>NO DEDUCIBLES</strong> del impuesto de renta. Se registra en <strong>1455 – CxC Empleado</strong> y se descuenta en nómina. El trabajador es el único responsable.`
      };
      break;
    case 'prestamo':
      chip = 'chip-cxc';
      dom.cxc += valor;
      lineas = [
        { cuenta: '1455', desc: `Préstamo/anticipo – ${dom.nombre}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Desembolso préstamo`, debito: 0, credito: valor },
      ];
      alerta = {
        clase: 'alerta-info', titulo: '💰 Préstamo / Anticipo Registrado',
        texto: `Registrado en <strong>1455 – CxC Empleado</strong>. El descuento en nómina no puede superar el <strong>30% del salario neto</strong> (Art. 149 CST).`
      };
      break;
  }
  const a = buildAsiento({ comp, fecha, modulo: 'nomina', chip, nombre: dom.nombre, desc: desc || tipo, lineas });
  a.alerta = alerta;
  S.asientosNomina.push(a);
  return a;
}

function asientoNomina(liq) {
  const comp = nextComp('NOM');
  const d = liq.dom;
  const lineas = [
    { cuenta: '5105', desc: `Salario – ${d.nombre}`, debito: liq.salario, credito: 0 },
    { cuenta: '5110', desc: `Aux. transporte – ${d.nombre}`, debito: liq.transp, credito: 0 },
    { cuenta: '5115', desc: `Rodamiento (no salarial) – ${d.nombre}`, debito: liq.rodamiento, credito: 0 },
    { cuenta: '5135', desc: `Prov. cesantías – ${d.nombre}`, debito: liq.cesantias, credito: 0 },
    { cuenta: '5136', desc: `Prov. Int. Ces. – ${d.nombre}`, debito: liq.intCes, credito: 0 },
    { cuenta: '5137', desc: `Prov. prima – ${d.nombre}`, debito: liq.prima, credito: 0 },
    { cuenta: '5138', desc: `Prov. vacaciones – ${d.nombre}`, debito: liq.vacaciones, credito: 0 },
    { cuenta: '5140', desc: `Aportes SS empresa – ${d.nombre}`, debito: liq.ssEmpresa, credito: 0 },
    { cuenta: '2305', desc: `Neto a pagar – ${d.nombre}`, debito: 0, credito: liq.neto },
    { cuenta: '2380', desc: `SS empleado – ${d.nombre}`, debito: 0, credito: liq.saludEmp + liq.pensionEmp },
    { cuenta: '1455', desc: `Descuento CxC – ${d.nombre}`, debito: 0, credito: liq.descCxC },
    { cuenta: '2610', desc: `Prov. cesantías – ${d.nombre}`, debito: 0, credito: liq.cesantias },
    { cuenta: '2615', desc: `Prov. Int. Ces. – ${d.nombre}`, debito: 0, credito: liq.intCes },
    { cuenta: '2630', desc: `Prov. prima – ${d.nombre}`, debito: 0, credito: liq.prima },
    { cuenta: '2640', desc: `Prov. vacaciones – ${d.nombre}`, debito: 0, credito: liq.vacaciones },
    { cuenta: '2380', desc: `SS empresa – ${d.nombre}`, debito: 0, credito: liq.ssEmpresa },
  ].filter(l => l.debito > 0 || l.credito > 0);

  d.cxc = Math.max(0, d.cxc - liq.descCxC);

  const a = buildAsiento({
    comp, fecha: today(), modulo: 'nomina', chip: 'chip-nomina',
    nombre: d.nombre, desc: `Nómina período ${new Date().toLocaleDateString('es-CO', { month: 'long', year: 'numeric' })}`, lineas
  });
  S.asientosNomina.push(a);
  return a;
}

function asientoOperacion(cat, prov, nit, valor, retePct, desc, nroFact, fecha) {
  const comp = nextComp('OP');
  const reteVal = Math.round(valor * (retePct / 100));
  const neto = valor - reteVal;

  // Cuenta gasto según categoría
  const cuentaGasto = {
    dotacion: '5120',
    poliza: '5150',
    honorarios: '5195',
    arriendo: '5199',
    servicios: '5199',
    papeleria: '5199',
    publicidad: '5199',
    mantenimiento: '5199',
    otros: '5199',
  }[cat] || '5199';

  // Acumular retención
  if (retePct === 3.5) S.rteAcum.compras += reteVal;
  else if (retePct === 4) S.rteAcum.honJ += reteVal;
  else if (retePct === 11) S.rteAcum.honN += reteVal;
  else if (retePct === 6 || retePct === 2) S.rteAcum.serv += reteVal;

  const lineas = [
    { cuenta: cuentaGasto, desc: `${cat} – ${desc} – ${prov}`, debito: valor, credito: 0 },
    { cuenta: '1110', desc: `Pago ${nroFact || ''}`, debito: 0, credito: neto },
    ...(reteVal > 0 ? [{ cuenta: '2370', desc: `RteFuente ${retePct}% – ${prov}`, debito: 0, credito: reteVal }] : []),
  ];

  const a = buildAsiento({
    comp, fecha, modulo: 'gasto', chip: 'chip-gasto',
    nombre: prov, desc: desc || cat, lineas
  });
  a.reteVal = reteVal; a.netoOp = neto;
  S.asientosOp.push(a);
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RENDER ASIENTO CONTABLE (HTML tabla)
// ─────────────────────────────────────────────────────────────────────────────
function htmlAsiento(a) {
  if (!a) return '';
  const lineasHtml = a.lineas.map(l => {
    const isCredito = l.debito === 0 && l.credito > 0;
    const nombreCuenta = PUC[l.cuenta] || l.cuenta;
    return `
      <tr>
        <td class="cuenta-col${isCredito ? ' indented' : ''}">
          <strong>${nombreCuenta}</strong> <span style="color: var(--text-muted); font-size: 0.85em;">Cód. ${l.cuenta}</span>
        </td>
        <td class="desc-col${isCredito ? ' indented' : ''}">${l.desc}</td>
        <td class="text-right mono-cell">${l.debito > 0 ? fmt(l.debito) : '<span style="color:var(--text-3)">—</span>'}</td>
        <td class="text-right mono-cell">${l.credito > 0 ? fmt(l.credito) : '<span style="color:var(--text-3)">—</span>'}</td>
      </tr>`;
  }).join('');

  const balanced = a.totD === a.totC;
  return `
    <div class="asiento-table-wrap">
      <table class="asiento-t">
        <thead>
          <tr>
            <th style="width:90px">Cuenta</th>
            <th>Descripción</th>
            <th class="text-right" style="width:140px">Débito</th>
            <th class="text-right" style="width:140px">Crédito</th>
          </tr>
        </thead>
        <tbody>${lineasHtml}</tbody>
        <tfoot>
          <tr>
            <td colspan="2" style="color:var(--text-3);font-size:11px">Totales</td>
            <td class="text-right mono-cell" style="color:var(--green)">${fmt(a.totD)}</td>
            <td class="text-right mono-cell" style="color:var(--green)">${fmt(a.totC)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div class="asiento-balance" style="color:${balanced ? 'var(--green)' : 'var(--red)'}">
      ${balanced ? '✓ Asiento cuadrado — Débitos = Créditos' : '⚠ Verificar: débitos ≠ créditos'}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. RENDER NÓMINA
// ─────────────────────────────────────────────────────────────────────────────
function refreshNomina() {
  S.params.smlv = parseFloat(document.getElementById('smlv')?.value) || 1423500;
  S.params.auxTransporte = parseFloat(document.getElementById('auxTransporte')?.value) || 200000;
  S.params.auxRodamiento = parseFloat(document.getElementById('auxRodamiento')?.value) || 300000;
  S.params.diasPeriodo = parseFloat(document.getElementById('diasPeriodo')?.value) || 30;
  renderNomina();
}

function renderNomina() {
  const body = document.getElementById('bodyNomina');
  const foot = document.getElementById('footNomina');
  const pstrip = document.getElementById('provisionesStrip');
  if (!body) return;

  let totSal = 0, totTrans = 0, totBase = 0, totRod = 0, totDed = 0, totNeto = 0;
  let provCards = '';

  body.innerHTML = S.domiciliarios.map(dom => {
    const dias = parseInt(document.querySelector(`.dias-dom-${dom.id}`)?.value ?? S.params.diasPeriodo, 10);
    const liq = calcNomina(dom, dias);
    totSal += liq.salario; totTrans += liq.transp; totBase += liq.base;
    totRod += liq.rodamiento; totDed += liq.totalDed; totNeto += liq.neto;

    const cxcBadge = dom.cxc > 0
      ? `<br/><span style="font-size:10px;color:var(--yellow)">CxC: ${fmt(dom.cxc)}</span>` : '';

    provCards += `
      <div class="provision-card">
        <div class="prov-name">${dom.nombre}</div>
        <div class="prov-rows">
          <div class="prov-row"><span>Base prestaciones</span><span class="prov-val prov-base">${fmt(liq.base)}</span></div>
          <div class="prov-row"><span>Cesantías</span><span class="prov-val">${fmt(liq.cesantias)}</span></div>
          <div class="prov-row"><span>Int. cesantías</span><span class="prov-val">${fmt(liq.intCes)}</span></div>
          <div class="prov-row"><span>Prima servicios</span><span class="prov-val">${fmt(liq.prima)}</span></div>
          <div class="prov-row"><span>Vacaciones</span><span class="prov-val">${fmt(liq.vacaciones)}</span></div>
          <div class="prov-row prov-total"><span>Costo total empresa</span><span class="prov-val" style="color:var(--green)">${fmt(liq.costoTotal)}</span></div>
        </div>
      </div>`;

    return `
      <tr>
        <td>
          <div class="worker-cell">
            <div class="avatar">${initials(dom.nombre)}</div>
            <div>
              <div class="worker-name">${dom.nombre}</div>
              <div class="worker-placa">🏍 ${dom.placa}</div>
            </div>
          </div>
        </td>
        <td class="text-center">
          <input type="number" class="dias-cell-input dias-dom-${dom.id}"
            value="${S.params.diasPeriodo}" min="1" max="30"
            onchange="renderNomina()" />
        </td>
        <td class="text-right mono-cell">${fmt(liq.salario)}</td>
        <td class="text-right mono-cell">${fmt(liq.transp)}</td>
        <td class="text-right mono-cell accent-col" style="font-weight:600">${fmt(liq.base)}</td>
        <td class="text-right mono-cell warn-col">${fmt(liq.rodamiento)}</td>
        <td class="text-right mono-cell danger-col">${fmt(liq.totalDed)}${cxcBadge}</td>
        <td class="text-right mono-cell success-col" style="font-weight:700">${fmt(liq.neto)}</td>
        <td>
          <button class="row-action" title="Ver detalle" onclick="openLiqModal('${dom.id}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </td>
      </tr>`;
  }).join('');

  foot.innerHTML = `
    <tr>
      <td colspan="2" style="font-size:12px;color:var(--text-3)">TOTALES · ${S.domiciliarios.length} domiciliarios</td>
      <td class="text-right mono-cell">${fmt(totSal)}</td>
      <td class="text-right mono-cell">${fmt(totTrans)}</td>
      <td class="text-right mono-cell accent-col">${fmt(totBase)}</td>
      <td class="text-right mono-cell warn-col">${fmt(totRod)}</td>
      <td class="text-right mono-cell danger-col">${fmt(totDed)}</td>
      <td class="text-right mono-cell success-col" style="font-size:15px">${fmt(totNeto)}</td>
      <td></td>
    </tr>`;

  if (pstrip) pstrip.innerHTML = provCards;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. MODAL DETALLE LIQUIDACIÓN
// ─────────────────────────────────────────────────────────────────────────────
function openLiqModal(domId) {
  const dom = S.domiciliarios.find(d => d.id === domId);
  if (!dom) return;
  const dias = parseInt(document.querySelector(`.dias-dom-${domId}`)?.value ?? S.params.diasPeriodo, 10);
  const liq = calcNomina(dom, dias);
  S.liqActual = liq;

  document.getElementById('liqTitle').textContent = `Liquidación — ${dom.nombre}`;

  const cxcRow = liq.descCxC > 0 ? `
    <div class="liq-row hl-deduccion">
      <span class="liq-lbl">Descuento CxC<small>Saldo pendiente: ${fmt(dom.cxc)}</small></span>
      <span class="liq-val danger">-${fmt(liq.descCxC)}</span>
    </div>` : '';

  document.getElementById('liqBody').innerHTML = `
    <div class="liq-section">
      <div class="liq-section-title">📋 Devengado</div>
      <div class="liq-row"><span class="liq-lbl">Salario (${dias} días)</span><span class="liq-val">${fmt(liq.salario)}</span></div>
      <div class="liq-row"><span class="liq-lbl">Aux. Transporte <small>Hace base prestaciones</small></span><span class="liq-val">${fmt(liq.transp)}</span></div>
      <div class="liq-row hl-aporte"><span class="liq-lbl">Aux. Rodamiento <small>Art. 128 CST — No salarial</small></span><span class="liq-val accent">${fmt(liq.rodamiento)}</span></div>
      <div class="liq-row hl-total"><span class="liq-lbl">Total Devengado</span><span class="liq-val">${fmt(liq.devengado)}</span></div>
    </div>
    <div class="liq-section">
      <div class="liq-section-title">🔵 Base Prestaciones (Sal + Aux.Transp)</div>
      <div class="liq-row"><span class="liq-lbl">Base</span><span class="liq-val accent">${fmt(liq.base)}</span></div>
      <div class="liq-row"><span class="liq-lbl">Cesantías (8.33%)</span><span class="liq-val">${fmt(liq.cesantias)}</span></div>
      <div class="liq-row"><span class="liq-lbl">Int. cesantías (12%)</span><span class="liq-val">${fmt(liq.intCes)}</span></div>
      <div class="liq-row"><span class="liq-lbl">Prima servicios (8.33%)</span><span class="liq-val">${fmt(liq.prima)}</span></div>
      <div class="liq-row"><span class="liq-lbl">Vacaciones (solo salario)</span><span class="liq-val">${fmt(liq.vacaciones)}</span></div>
      <div class="liq-row"><span class="liq-lbl">Aportes SS empresa (21.15%)</span><span class="liq-val">${fmt(liq.ssEmpresa)}</span></div>
    </div>
    <div class="liq-section">
      <div class="liq-section-title">➖ Deducciones del Trabajador</div>
      <div class="liq-row hl-deduccion"><span class="liq-lbl">Salud empleado (4%)</span><span class="liq-val danger">-${fmt(liq.saludEmp)}</span></div>
      <div class="liq-row hl-deduccion"><span class="liq-lbl">Pensión empleado (4%)</span><span class="liq-val danger">-${fmt(liq.pensionEmp)}</span></div>
      ${cxcRow}
      <div class="liq-row hl-total"><span class="liq-lbl">Total deducciones</span><span class="liq-val danger">-${fmt(liq.totalDed)}</span></div>
    </div>
    <div class="liq-row hl-neto"><span class="liq-lbl">💳 NETO A PAGAR</span><span class="liq-val success">${fmt(liq.neto)}</span></div>
    <div class="liq-row" style="margin-top:4px"><span class="liq-lbl" style="font-size:12px;color:var(--text-3)">Costo total empresa (incl. prestaciones + SS)</span><span class="liq-val accent">${fmt(liq.costoTotal)}</span></div>`;

  document.getElementById('modalLiqBg').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. RENDER LIBRO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
function renderLibro(filtro = '') {
  const body = document.getElementById('bodyLibro');
  if (!body) return;

  const all = [
    ...S.asientosSocios.map(a => ({ ...a, modLabel: 'Socios', chip: 'chip-socio' })),
    ...S.asientosVentas.map(a => ({ ...a, modLabel: 'Ventas', chip: a.chip || 'chip-venta' })),
    ...S.asientosNomina.map(a => ({ ...a, modLabel: 'Nómina', chip: a.chip || 'chip-nomina' })),
    ...S.asientosOp.map(a => ({ ...a, modLabel: 'Operación', chip: 'chip-gasto' })),
  ].reverse();

  const lista = filtro
    ? all.filter(a => a.modulo === filtro || a.chip === `chip-${filtro}`)
    : all;

  if (!lista.length) {
    body.innerHTML = `<tr><td colspan="6" class="empty-row">Sin movimientos registrados.</td></tr>`;
    return;
  }

  body.innerHTML = lista.map(a => `
    <tr>
      <td class="mono-cell" style="color:var(--accent);font-size:11.5px">${a.comp}</td>
      <td style="font-size:12px;color:var(--text-3)">${fmtDate(a.fecha)}</td>
      <td><span class="chip ${a.chip}" style="font-size:11px">${a.modLabel}</span></td>
      <td style="font-size:12.5px;color:var(--text-2);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a.desc}</td>
      <td class="text-right mono-cell">${fmt(a.totD)}</td>
      <td class="text-right mono-cell" style="color:var(--text-3)">${fmt(a.totC)}</td>
    </tr>`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ACTUALIZAR KPIs
// ─────────────────────────────────────────────────────────────────────────────
function updateKpiSocios() {
  let ap = 0, ret = 0, gso = 0;
  S.asientosSocios.forEach(a => {
    a.lineas.forEach(l => {
      // Aportes: 3105 Capital Suscrito + 3120 Capital por Capitalizar (inversión)
      if (l.cuenta === '3105' || l.cuenta === '3120') ap += l.credito;
      // Retiros / distribución: 3705 Utilidades Acumuladas debitadas
      if (l.cuenta === '3705') ret += l.debito;
      // Gastos pagados por socio: 5199 debitado
      if (l.cuenta === '5199' && l.debito > 0) gso += l.debito;
    });
  });
  const cap = ap - ret;
  document.getElementById('kpi-aportes').textContent = fmt(ap);
  document.getElementById('kpi-retiros').textContent = fmt(ret);
  document.getElementById('kpi-gsocio').textContent = fmt(gso);
  document.getElementById('kpi-capital').textContent = fmt(cap);
}

function updateKpiVentas() {
  let fac = 0, cob = 0;
  S.asientosVentas.forEach(a => {
    a.lineas.forEach(l => {
      if (l.cuenta === '4135') fac += l.credito;
      if (l.cuenta === '1110' && a.modulo === 'venta') cob += l.debito;
    });
  });
  const cartera = Math.max(0, fac - cob);
  document.getElementById('kpi-facturado').textContent = fmt(fac);
  document.getElementById('kpi-cobrado').textContent = fmt(cob);
  document.getElementById('kpi-cartera').textContent = fmt(cartera);
  const clientes = new Set(S.asientosVentas.map(a => a.nombre)).size;
  document.getElementById('kpi-clientes-count').textContent = clientes;
}

function updateKpiOp() {
  let total = 0, dot = 0, pol = 0, otros = 0;
  S.asientosOp.forEach(a => {
    a.lineas.forEach(l => {
      if (l.cuenta === '5120') { dot += l.debito; total += l.debito; }
      else if (l.cuenta === '5150') { pol += l.debito; total += l.debito; }
      else if (l.debito > 0) { otros += l.debito; total += l.debito; }
    });
  });
  document.getElementById('kpi-gastos-op').textContent = fmt(total);
  document.getElementById('kpi-dotacion').textContent = fmt(dot);
  document.getElementById('kpi-polizas').textContent = fmt(pol);
  document.getElementById('kpi-otros-op').textContent = fmt(otros);
}

function updateImpuestos() {
  document.getElementById('iva19').textContent = fmt(S.ivaAcum.pct19);
  document.getElementById('iva5').textContent = fmt(S.ivaAcum.pct5);
  document.getElementById('ivaExcluido').textContent = fmt(S.ivaAcum.excluido);
  document.getElementById('ivaTotal').textContent = fmt(S.ivaAcum.pct19 + S.ivaAcum.pct5);

  document.getElementById('rte-compras').textContent = fmt(S.rteAcum.compras);
  document.getElementById('rte-hon-j').textContent = fmt(S.rteAcum.honJ);
  document.getElementById('rte-hon-n').textContent = fmt(S.rteAcum.honN);
  document.getElementById('rte-serv').textContent = fmt(S.rteAcum.serv);
  const rteTotal = Object.values(S.rteAcum).reduce((a, b) => a + b, 0);
  document.getElementById('rte-total').textContent = fmt(rteTotal);

  document.getElementById('nd-multas').textContent = fmt(S.multasAcum);
  document.getElementById('nd-sanciones').textContent = '$0';
  document.getElementById('nd-total').textContent = fmt(S.multasAcum);

  // ICA base = ingresos brutos
  let ingBrutos = 0;
  S.asientosVentas.forEach(a => a.lineas.forEach(l => { if (l.cuenta === '4135') ingBrutos += l.credito; }));
  document.getElementById('icaBase').textContent = fmt(ingBrutos);
  document.getElementById('badge-nomina').textContent = String(S.domiciliarios.length);
  calcICA();
}

function calcICA() {
  let ingBrutos = 0;
  S.asientosVentas.forEach(a => a.lineas.forEach(l => { if (l.cuenta === '4135') ingBrutos += l.credito; }));
  const tarifa = parseFloat(document.getElementById('icaTarifa')?.value) || 6.9;
  document.getElementById('icaTotal').textContent = fmt(Math.round(ingBrutos * tarifa / 1000));
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. HELPERS DE FORMULARIOS
// ─────────────────────────────────────────────────────────────────────────────
function calcularIva() {
  const base = parseFloat(document.getElementById('valorVenta')?.value) || 0;
  const ivaPct = parseFloat(document.getElementById('ivaVenta')?.value) || 0;
  const iva = Math.round(base * (ivaPct / 100));
  const total = base + iva;
  const prev = document.getElementById('ivaPreview');
  if (ivaPct > 0 && base > 0) {
    prev?.classList.remove('hidden');
    const ivaEl = document.getElementById('ivaAmt');
    const totEl = document.getElementById('totalFactura');
    if (ivaEl) ivaEl.textContent = fmt(iva);
    if (totEl) totEl.textContent = fmt(total);
  } else {
    prev?.classList.add('hidden');
  }
}

function calcReteFuente() {
  const val = parseFloat(document.getElementById('valorOp')?.value) || 0;
  const pct = parseFloat(document.getElementById('reteFuente')?.value) || 0;
  const rete = Math.round(val * (pct / 100));
  const neto = val - rete;
  const prev = document.getElementById('retePreview');
  if (pct > 0 && val > 0) {
    prev?.classList.remove('hidden');
    const reteEl = document.getElementById('reteAmt');
    const netoEl = document.getElementById('netoOp');
    if (reteEl) reteEl.textContent = fmt(rete);
    if (netoEl) netoEl.textContent = fmt(neto);
  } else {
    prev?.classList.add('hidden');
  }
}

// Populate domiciliario select
function fillDomSel() {
  const sel = document.getElementById('domSel');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Todos / General —</option>' +
    S.domiciliarios.map(d => `<option value="${d.id}">${d.nombre} · ${d.placa}</option>`).join('');
}

// Fill socio selects
function fillSocioSel() {
  const sel = document.getElementById('socioNombre');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Seleccionar socio —</option>' +
    S.socios.map(s => `<option value="${s.id}">${s.nombre}</option>`).join('');
}

// Show asiento in a target card
function showAsiento(cardId, compId, bodyId, a) {
  const card = document.getElementById(cardId);
  const comp = document.getElementById(compId);
  const body = document.getElementById(bodyId);
  if (!card || !comp || !body) return;
  card.classList.remove('hidden');
  comp.textContent = a.comp;
  body.innerHTML = htmlAsiento(a);
}

// Show alerta
function showAlerta(wrapperId, boxId, alerta) {
  if (!alerta) return;
  const wrapper = document.getElementById(wrapperId);
  const box = document.getElementById(boxId);
  if (!wrapper || !box) return;
  wrapper.classList.remove('hidden');
  box.className = `alerta-box alerta-${alerta.clase === 'alerta-danger' ? 'danger' : alerta.clase === 'alerta-warn' ? 'warn' : alerta.clase === 'alerta-success' ? 'success' : 'info'}`;
  box.innerHTML = `
    <svg class="alerta-icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      ${alerta.clase === 'alerta-danger' ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>' :
      '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}
    </svg>
    <div>
      <div class="alerta-titulo">${alerta.titulo}</div>
      <div class="alerta-texto">${alerta.texto}</div>
    </div>`;
}

// Append row to a table body
function addTableRow(bodyId, cells, countId) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  const emptyRow = body.querySelector('.empty-row');
  if (emptyRow) emptyRow.parentElement.remove();
  const tr = document.createElement('tr');
  tr.innerHTML = cells;
  body.prepend(tr);
  if (countId) {
    const el = document.getElementById(countId);
    if (el) {
      const n = body.querySelectorAll('tr').length;
      el.textContent = `${n} registro${n !== 1 ? 's' : ''}`;
    }
  }
}

// Export CSV (all asientos)
function exportarCSV() {
  const all = [
    ...S.asientosSocios, ...S.asientosVentas,
    ...S.asientosNomina, ...S.asientosOp
  ];
  if (!all.length) { alert('No hay movimientos para exportar.'); return; }
  const rows = all.flatMap(a => a.lineas.map(l => [
    a.comp, a.fecha, a.modulo, `"${a.nombre}"`, `"${a.desc}"`,
    l.cuenta, `"${PUC[l.cuenta] || l.cuenta}"`,
    l.debito || 0, l.credito || 0
  ]));
  const csv = [['Comprobante', 'Fecha', 'Módulo', 'Tercero', 'Descripción', 'Cuenta', 'Nombre cuenta', 'Débito', 'Crédito'].join(','),
  ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ContabilidadATL_${today()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11.b PERSISTENCIA SUPABASE — MÓDULO SOCIOS
// ─────────────────────────────────────────────────────────────────────────────

const TIPO_SOCIO_LABELS = {
  capital: 'Aporte de Capital',
  gasto_pagado_socio: 'Gasto pagado por Socio',
  inversion: 'Inversión socio',
  distribucion: 'Retiro / Dividendos',
  prestamo_de_socio: 'Préstamo del Socio',
  prestamo_a_socio: 'Préstamo al Socio',
};

/** Escapa texto antes de inyectarlo como HTML (los datos vienen de la BD). */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** `modulo` en BD (plural) -> convención en memoria que usa el filtro del libro. */
const MODULO_BD_A_APP = { socios: 'socio', ventas: 'venta', nomina: 'nomina', operacion: 'gasto' };

/** Adapta una fila de la BD (con su join) al formato que espera htmlAsiento(). */
function asientoDesdeDB(row) {
  const lineas = (row.asiento_detalles || [])
    .slice()
    .sort((x, y) => x.id - y.id)
    .map(d => ({
      cuenta: d.cuenta,
      desc: d.descripcion || '',
      debito: Number(d.debito) || 0,
      credito: Number(d.credito) || 0,
      tipoNormativa: d.tipo_normativa,
    }));

  return {
    comp: row.comprobante,
    fecha: row.fecha,
    modulo: MODULO_BD_A_APP[row.modulo] || row.modulo,
    nombre: row.tercero,
    desc: row.descripcion,
    lineas,
    totD: lineas.reduce((acc, l) => acc + l.debito, 0),
    totC: lineas.reduce((acc, l) => acc + l.credito, 0),
  };
}

/**
 * Guarda el asiento en Supabase: primero la cabecera en `asientos`, recupera
 * el id generado y con él inserta las líneas en `asiento_detalles`.
 * Devuelve el id de la cabecera.
 */
async function guardarAsientoSocioDB(a, meta) {
  const { data: cabecera, error: errCab } = await supabase
    .from('asientos')
    .insert({
      comprobante: a.comp,
      fecha: a.fecha,
      descripcion: a.desc,
      modulo: 'socios',
      tercero: a.nombre,
      tipo: meta.tipo,
      modalidad: meta.modalidad || null,
      clasificacion: meta.clasificacion || null,
      soporte: meta.soporte || null,
      valor: meta.valor,
    })
    .select('id')
    .single();

  if (errCab) throw errCab;

  const detalles = a.lineas.map(l => ({
    asiento_id: cabecera.id,
    cuenta: l.cuenta,
    descripcion: l.desc,
    debito: l.debito,
    credito: l.credito,
    tipo_normativa: 'AMBOS',
  }));

  const { error: errDet } = await supabase.from('asiento_detalles').insert(detalles);

  if (errDet) {
    // PostgREST no da transacción entre las dos llamadas: si fallan las líneas
    // hay que borrar la cabecera para no dejar un asiento sin partida doble.
    await supabase.from('asientos').delete().eq('id', cabecera.id);
    throw errDet;
  }

  return cabecera.id;
}

/**
 * Alinea el contador de comprobantes con lo que ya existe en la BD para no
 * chocar con el UNIQUE de `comprobante` tras recargar la página.
 */
async function syncSeqComprobante() {
  const { data, error } = await supabase
    .from('asientos')
    .select('comprobante')
    .order('id', { ascending: false })
    .limit(1);

  if (error || !data || !data.length) return;
  const n = parseInt(String(data[0].comprobante).split('-').pop(), 10);
  if (Number.isFinite(n) && n >= S.seq) S.seq = n + 1;
}

/**
 * Renderiza el historial de socios leyendo `asientos` + `asiento_detalles`
 * mediante JOIN. Cada registro conserva la divulgación progresiva: la fila
 * muestra el resumen y el <details> despliega el asiento completo.
 */
async function renderSocios() {
  const body = document.getElementById('bodySocios');
  const countEl = document.getElementById('countSocios');
  if (!body) return;

  const { data, error } = await supabase
    .from('asientos')
    .select(`
      id, comprobante, fecha, descripcion, modulo, tercero, tipo, modalidad,
      clasificacion, valor,
      asiento_detalles ( id, cuenta, descripcion, debito, credito, tipo_normativa )
    `)
    .eq('modulo', 'socios')
    .order('fecha', { ascending: false })
    .order('id', { ascending: false });

  if (error) {
    console.error('[Supabase] Error al cargar asientos de socios:', error);
    body.innerHTML = `<tr><td colspan="7" class="empty-row" style="color:var(--red)">
      ⚠ No se pudieron cargar los movimientos: ${esc(error.message)}</td></tr>`;
    if (countEl) countEl.textContent = '— registros';
    return;
  }

  if (!data.length) {
    S.asientosSocios = [];
    body.innerHTML = `<tr><td colspan="7" class="empty-row">Sin registros aún.</td></tr>`;
    if (countEl) countEl.textContent = '0 registros';
    return;
  }

  // Los KPIs y el libro global siguen leyendo de memoria: se rehidratan aquí
  // para que no queden en cero tras recargar la página.
  S.asientosSocios = data.map(asientoDesdeDB).reverse();

  body.innerHTML = data.map(row => {
    const a = asientoDesdeDB(row);
    const nLineas = a.lineas.length;
    return `
      <tr>
        <td>${fmtDate(row.fecha)}</td>
        <td>${esc(row.tercero) || '—'}</td>
        <td><span class="chip chip-socio">${esc(TIPO_SOCIO_LABELS[row.tipo] || row.tipo || '—')}</span></td>
        <td style="color:var(--text-2);font-size:12.5px">${esc(row.descripcion) || '—'}</td>
        <td style="color:var(--text-2);font-size:12.5px">${esc(row.modalidad) || '—'}</td>
        <td class="text-right mono-cell">${fmt(Number(row.valor) || 0)}</td>
        <td><span class="mono-cell" style="font-size:11px;color:var(--accent)">${esc(row.comprobante)}</span></td>
      </tr>
      <tr>
        <td colspan="7" style="padding:0 14px 10px">
          <details>
            <summary style="cursor:pointer;padding:8px 0;color:var(--text-3);font-size:12px;list-style:none">
              ▸ Ver detalle del asiento contable · ${nLineas} línea${nLineas !== 1 ? 's' : ''} (Opcional)
            </summary>
            ${htmlAsiento(a)}
          </details>
        </td>
      </tr>`;
  }).join('');

  if (countEl) {
    countEl.textContent = `${data.length} registro${data.length !== 1 ? 's' : ''}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. ALERTAS FISCALES / CONTABLES — MÓDULO SOCIOS
// ─────────────────────────────────────────────────────────────────────────────
function mostrarAlertaFiscalSocio(tipo, soporte) {
  const banner = document.getElementById('alertaSocioFiscal');
  if (!banner) return;

  const ALERTAS = {
    capital: [
      {
        nivel: 'info',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
        titulo: 'Cuenta 3105 · Capital Suscrito y Pagado',
        texto: 'Este aporte afecta directamente el <strong>patrimonio</strong> (NIIF Pymes § 22.7). No genera deuda ni obligación de devolución.',
      },
      {
        nivel: 'warn',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        titulo: 'Documento requerido: Acta de Junta de Socios',
        texto: !soporte
          ? '⚠ No registraste un soporte. Para aportes de capital se <strong>requiere Acta de Junta de Socios</strong> firmada para soportar el aumento patrimonial ante la DIAN.'
          : `Soporte registrado: <strong>${soporte}</strong>. Verifica que sea el Acta de Junta de Socios correspondiente.`,
      },
    ],
    gasto_pagado_socio: [
      {
        nivel: 'info',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
        titulo: 'Cuentas: 5199 Gasto Operativo · 2390 CxP Socios (Pasivo)',
        texto: 'El reembolso genera un <strong>pasivo</strong> con el socio. El valor debe corresponder <em>exactamente</em> al desembolso real documentado.',
      },
      {
        nivel: 'warn',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        titulo: 'Soporte obligatorio: factura o documento a nombre de ATL',
        texto: 'Se requiere <strong>factura o documento soporte</strong> expedido a nombre de la empresa (ATL). Gastos soportados a nombre del socio pueden ser <em>no deducibles</em> ante la DIAN.',
      },
    ],
    inversion: [
      {
        nivel: 'info',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
        titulo: 'Cuenta 3120 · Capital por Capitalizar (Transitorio)',
        texto: 'Registrado como capital transitorio hasta su <strong>formalización patrimonial</strong> mediante acta o escritura. (NIIF Pymes § 22 + § 17 activos).',
      },
      {
        nivel: 'warn',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--yellow)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        titulo: 'Pendiente: formalizar en patrimonio',
        texto: 'Este movimiento <strong>debe formalizarse</strong> mediante Acta de Junta de Socios o escritura pública antes del cierre contable.',
      },
    ],
    distribucion: [
      {
        nivel: 'info',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
        titulo: 'Cuentas: 3705 Utilidades Acumuladas · 1110 Bancos',
        texto: 'Débita utilidades acumuladas (NIIF Pymes § 22.18). Solo puede realizarse si la empresa <strong>cuenta con utilidades disponibles</strong> para distribuir.',
      },
      {
        nivel: 'danger',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        titulo: '⚠ Alerta Fiscal · Retención en la Fuente por Dividendos',
        texto: 'Verificar aplicación de <strong>Retención en la Fuente sobre dividendos</strong> según <em>Art. 242 del Estatuto Tributario</em>. Dividendos gravados: tarifa del 10 %. Informar a revisor fiscal antes del pago.',
      },
    ],
    prestamo_de_socio: [
      {
        nivel: 'info',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
        titulo: 'Cuentas: 1110 Bancos · 2396 Pasivo Financiero – Préstamos Socios',
        texto: 'Registrado como <strong>pasivo financiero</strong> a corto/mediano plazo. El socio es acreedor de la empresa y tiene derecho a la devolución del capital.',
      },
      {
        nivel: 'danger',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
        titulo: '⚠ Revisoría Fiscal · Intereses Presuntivos (Art. 35 E.T.)',
        texto: 'Los préstamos de socios a la empresa <strong>generan intereses presuntivos</strong> según el <em>Art. 35 del Estatuto Tributario</em>. Tasa presuntiva DTF vigente. Controlar plazos y documentar condiciones.',
      },
    ],
    prestamo_a_socio: [
      {
        nivel: 'info',
        icon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
        titulo: 'Cuenta 1325 · Cuenta por Cobrar a Socios',
        texto: 'Registrado como <strong>activo</strong>. La empresa prestó dinero al socio, generando una obligación de pago a favor de la empresa.',
      }
    ]
  };

  const items = ALERTAS[tipo];
  if (!items || !items.length) {
    banner.innerHTML = '';
    banner.classList.add('hidden');
    return;
  }

  banner.innerHTML = items.map(item => `
    <div class="alerta-fiscal-item ${item.nivel}">
      <span class="alerta-fiscal-icon">${item.icon}</span>
      <div class="alerta-fiscal-body">
        <span class="alerta-fiscal-title">${item.titulo}</span>
        <span class="alerta-fiscal-text">${item.texto}</span>
      </div>
    </div>
  `).join('');

  banner.classList.remove('hidden');
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─────────────────────────────────────────────────────────────────────────────
// 12.b EXPOSICIÓN GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
// app.js pasó a ser módulo ES (<script type="module">) para poder importar el
// cliente de Supabase. Dentro de un módulo las funciones ya no son globales,
// pero los atributos onclick/oninput del HTML las siguen buscando en `window`.
Object.assign(window, {
  calcularIva, calcReteFuente, calcICA, refreshNomina, renderNomina, openLiqModal,
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. INICIALIZACIÓN Y EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Fechas por defecto
  ['fechaSocio', 'fechaVenta', 'fechaMovDom', 'fechaOp'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = today();
  });

  // Período en sidebar
  const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  const now = new Date();
  const pEl = document.getElementById('periodoActual');
  if (pEl) pEl.textContent = `${meses[now.getMonth()]} ${now.getFullYear()}`;
  const tEl = document.getElementById('taxPeriodo');
  if (tEl) tEl.textContent = `${meses[now.getMonth()]} ${now.getFullYear()}`;

  fillDomSel();
  fillSocioSel();
  renderNomina();
  renderLibro();
  updateImpuestos();

  // Carga inicial desde Supabase: alinea el consecutivo de comprobantes y
  // pinta el historial de socios con lo que ya está persistido.
  (async () => {
    await syncSeqComprobante();
    await renderSocios();
    updateKpiSocios();
    renderLibro();
  })();

  // ══ NAVEGACIÓN ══
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`)?.classList.add('active');
      if (btn.dataset.tab === 'impuestos') { renderLibro(); updateImpuestos(); }
      if (btn.dataset.tab === 'nomina') renderNomina();
    });
  });

  // ══ SOCIOS ══

  // Microcopy dinámico al cambiar tipo de movimiento
  document.getElementById('tipoSocio')?.addEventListener('change', function () {
    const hint = document.getElementById('hintTipoSocio');
    if (!hint) return;
    const texto = TIPO_SOCIO_HINTS[this.value];
    if (texto) {
      hint.textContent = texto;
      hint.classList.remove('hidden');
      requestAnimationFrame(() => hint.classList.add('visible'));
    } else {
      hint.classList.remove('visible');
      hint.addEventListener('transitionend', () => hint.classList.add('hidden'), { once: true });
    }
  });

  document.getElementById('btnNuevoSocio')?.addEventListener('click', () => {
    const el = document.getElementById('formSocioWrap');
    el?.scrollIntoView({ behavior: 'smooth' });
    document.getElementById('tipoSocio')?.focus();
  });

  document.getElementById('btnGuardarSocio')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnGuardarSocio');
    const tipo = document.getElementById('tipoSocio').value;
    const socioId = document.getElementById('socioNombre').value;
    const valor = parseFloat(document.getElementById('valorSocio').value) || 0;
    const desc = document.getElementById('descSocio').value.trim();
    const soporte = document.getElementById('soporteSocio').value.trim();
    const fecha = document.getElementById('fechaSocio').value;
    const modalidad = document.getElementById('modalidadSocio').value;

    if (tipo === 'capital' && !modalidad) { alert('Selecciona la modalidad del aporte de capital.'); return; }

    if (!tipo || !socioId || valor <= 0) { alert('Completa tipo, socio y valor.'); return; }

    let categoriaContable = '';
    switch (tipo) {
      case 'capital':
      case 'distribucion':
      case 'inversion':
        categoriaContable = 'Patrimonio';
        break;
      case 'prestamo_de_socio':
      case 'gasto_pagado_socio':
        categoriaContable = 'Pasivo';
        break;
      case 'prestamo_a_socio':
        categoriaContable = 'Activo';
        break;
    }

    const socio = S.socios.find(s => s.id === socioId) || { id: 'ext', nombre: socioId };
    const a = asientoSocio(tipo, socio, valor, desc, fecha);

    a.clasificacion = categoriaContable;

    // ── Persistencia en Supabase (cabecera + lineas) ───────────────────────
    const btnHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    try {
      await guardarAsientoSocioDB(a, {
        tipo, modalidad, soporte, valor, clasificacion: categoriaContable,
      });
    } catch (err) {
      console.error('[Supabase] No se pudo guardar el asiento de socio:', err);
      alert('No se pudo guardar en la base de datos:\n' + (err.message || err));
      // Deshacer lo que asientoSocio() ya habia dejado en memoria y liberar el
      // consecutivo, para no perder sincronia con la BD.
      S.asientosSocios.pop();
      S.seq--;
      return;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btnHtml; }
    }

    // La tabla se repinta desde la BD (SELECT con JOIN), no desde memoria.
    await renderSocios();

    showAsiento('asientoSocios', 'compSocios', 'asientoBodySocios', a);
    updateKpiSocios();
    renderLibro();

    // Alertas fiscales / contables post-guardado
    mostrarAlertaFiscalSocio(tipo, soporte);

    // Reset
    ['tipoSocio', 'socioNombre', 'valorSocio', 'descSocio', 'soporteSocio', 'modalidadSocio'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    // Ocultar microcopy al resetear
    const hint = document.getElementById('hintTipoSocio');
    if (hint) { hint.classList.remove('visible'); hint.classList.add('hidden'); }
  });

  // ══ VENTAS ══
  document.getElementById('btnNuevaVenta')?.addEventListener('click', () => {
    document.getElementById('clienteNombre')?.focus();
  });

  document.getElementById('btnGuardarVenta')?.addEventListener('click', () => {
    const tipo = document.getElementById('tipoVenta').value;
    const cliente = document.getElementById('clienteNombre').value.trim();
    const nit = document.getElementById('clienteNit').value.trim();
    const valor = parseFloat(document.getElementById('valorVenta').value) || 0;
    const ivaPct = parseFloat(document.getElementById('ivaVenta').value) || 0;
    const desc = document.getElementById('descVenta').value.trim();
    const fecha = document.getElementById('fechaVenta').value;
    const venc = document.getElementById('vencVenta').value;

    if (!tipo || !cliente || valor <= 0) { alert('Completa tipo, cliente y valor.'); return; }

    const iva = Math.round(valor * (ivaPct / 100));
    const total = valor + iva;
    const a = asientoVenta(tipo, cliente, valor, ivaPct, desc, fecha);

    const tipoLabels = { factura: 'Factura venta', cobro: 'Cobro cartera', nota_credito: 'Nota crédito', anticipo_cliente: 'Anticipo' };
    const estado = tipo === 'cobro' ? '<span class="chip chip-ok">Pagado</span>' : '<span class="chip chip-pendiente">Pendiente</span>';

    addTableRow('bodyVentas', `
      <td>${fmtDate(fecha)}</td>
      <td style="font-size:12.5px">${cliente}</td>
      <td><span class="chip chip-venta">${tipoLabels[tipo] || tipo}</span></td>
      <td class="text-right mono-cell">${fmt(valor)}</td>
      <td class="text-right mono-cell" style="color:var(--yellow)">${iva > 0 ? fmt(iva) : '—'}</td>
      <td class="text-right mono-cell" style="font-weight:700;color:var(--green)">${fmt(total)}</td>
      <td>${estado}</td>
    `, 'countVentas');

    showAsiento('asientoVentas', 'compVentas', 'asientoBodyVentas', a);
    updateKpiVentas();
    updateImpuestos();
    renderLibro();

    ['tipoVenta', 'clienteNombre', 'clienteNit', 'valorVenta', 'descVenta', 'vencVenta'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('ivaPreview')?.classList.add('hidden');
  });

  // ══ MOVIMIENTO DOMICILIARIO ══
  document.getElementById('tipoMovDom')?.addEventListener('change', (e) => {
    document.getElementById('polizaDates')?.classList.toggle('hidden', e.target.value !== 'poliza');
  });

  document.getElementById('btnProcesarMovDom')?.addEventListener('click', () => {
    const tipo = document.getElementById('tipoMovDom').value;
    const domId = document.getElementById('domSel').value;
    const valor = parseFloat(document.getElementById('valorMovDom').value) || 0;
    const desc = document.getElementById('descMovDom').value.trim();
    const prov = document.getElementById('provMovDom').value.trim();
    const fecha = document.getElementById('fechaMovDom').value;
    const pd = document.getElementById('polizaDesde')?.value;
    const ph = document.getElementById('polizaHasta')?.value;

    if (!tipo || valor <= 0) { alert('Selecciona tipo y valor.'); return; }

    const dom = S.domiciliarios.find(d => d.id === domId) || S.domiciliarios[0];
    const a = asientoMovDom(tipo, dom, valor, desc, prov, fecha, pd, ph);

    showAsiento('asientoDom', 'compDom', 'asientoBodyDom', a);
    if (a.alerta) showAlerta('alertaDomWrapper', 'alertaDom', a.alerta);
    renderNomina();
    fillDomSel();
    updateImpuestos();
    renderLibro();

    ['valorMovDom', 'descMovDom', 'provMovDom'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });

  // ══ LIQUIDAR PERÍODO (todos) ══
  document.getElementById('btnLiquidarPeriodo')?.addEventListener('click', () => {
    S.domiciliarios.forEach(dom => {
      const dias = parseInt(document.querySelector(`.dias-dom-${dom.id}`)?.value ?? S.params.diasPeriodo, 10);
      const liq = calcNomina(dom, dias);
      asientoNomina(liq);
    });
    renderNomina();
    renderLibro();
    updateImpuestos();
    document.querySelector('[data-tab="impuestos"]')?.click();
  });

  // ══ MODAL DOMICILIARIO ══
  document.getElementById('btnAgregarDom')?.addEventListener('click', () => {
    document.getElementById('modalTitle').textContent = 'Agregar domiciliario';
    document.getElementById('modalBg').classList.remove('hidden');
  });
  document.getElementById('modalClose')?.addEventListener('click', () => document.getElementById('modalBg').classList.add('hidden'));
  document.getElementById('btnCancelModal')?.addEventListener('click', () => document.getElementById('modalBg').classList.add('hidden'));

  document.getElementById('btnSaveModal')?.addEventListener('click', () => {
    const nombre = document.getElementById('mNombre').value.trim();
    const doc = document.getElementById('mDocumento').value.trim();
    const ing = document.getElementById('mIngreso').value;
    const placa = document.getElementById('mPlaca').value.trim().toUpperCase();
    const tel = document.getElementById('mTelefono').value.trim();
    if (!nombre || !doc) { alert('Nombre y documento son requeridos.'); return; }
    const seq = S.domiciliarios.length + 1;
    S.domiciliarios.push({ id: `D${String(seq + 100).padStart(3, '0')}`, nombre, doc, placa, tel, ingreso: ing || today(), cxc: 0 });
    fillDomSel(); renderNomina(); updateImpuestos();
    document.getElementById('modalBg').classList.add('hidden');
    ['mNombre', 'mDocumento', 'mIngreso', 'mPlaca', 'mTelefono'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });

  // ══ MODAL LIQUIDACIÓN ══
  document.getElementById('liqClose')?.addEventListener('click', () => document.getElementById('modalLiqBg').classList.add('hidden'));
  document.getElementById('liqCancel')?.addEventListener('click', () => document.getElementById('modalLiqBg').classList.add('hidden'));
  document.getElementById('liqConfirm')?.addEventListener('click', () => {
    if (S.liqActual) { asientoNomina(S.liqActual); renderNomina(); renderLibro(); updateImpuestos(); }
    document.getElementById('modalLiqBg').classList.add('hidden');
    document.querySelector('[data-tab="impuestos"]')?.click();
  });

  // ══ OPERACIÓN / PROVEEDORES ══
  document.getElementById('btnGuardarOp')?.addEventListener('click', () => {
    const cat = document.getElementById('catGasto').value;
    const prov = document.getElementById('provOp').value.trim();
    const nit = document.getElementById('nitProv').value.trim();
    const valor = parseFloat(document.getElementById('valorOp').value) || 0;
    const pct = parseFloat(document.getElementById('reteFuente').value) || 0;
    const desc = document.getElementById('descOp').value.trim();
    const nroF = document.getElementById('nroFactOp').value.trim();
    const fecha = document.getElementById('fechaOp').value;

    if (!cat || !prov || valor <= 0) { alert('Completa categoría, proveedor y valor.'); return; }

    const a = asientoOperacion(cat, prov, nit, valor, pct, desc, nroF, fecha);
    const reteVal = a.reteVal || 0;
    const neto = a.netoOp || valor;

    const catLabels = {
      dotacion: 'Dotación', poliza: 'Póliza', honorarios: 'Honorarios',
      arriendo: 'Arriendo', servicios: 'Servicios', papeleria: 'Papelería',
      publicidad: 'Publicidad', mantenimiento: 'Mantenimiento', otros: 'Otros'
    };

    addTableRow('bodyOp', `
      <td>${fmtDate(fecha)}</td>
      <td style="font-size:12.5px">${prov}</td>
      <td><span class="chip chip-gasto">${catLabels[cat] || cat}</span></td>
      <td class="text-right mono-cell">${fmt(valor)}</td>
      <td class="text-right mono-cell" style="color:var(--yellow)">${reteVal > 0 ? fmt(reteVal) : '—'}</td>
      <td class="text-right mono-cell">${fmt(neto)}</td>
      <td class="mono-cell" style="font-size:11px;color:var(--accent)">${a.comp}</td>
    `, 'countOp');

    showAsiento('asientoOp', 'compOp', 'asientoBodyOp', a);
    updateKpiOp();
    updateImpuestos();
    renderLibro();

    ['catGasto', 'provOp', 'nitProv', 'valorOp', 'reteFuente', 'descOp', 'nroFactOp'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('retePreview')?.classList.add('hidden');
  });

  // ══ FILTRO LIBRO ══
  document.getElementById('filtroLibro')?.addEventListener('change', e => renderLibro(e.target.value));

  // ══ EXPORTAR CSV ══
  document.getElementById('btnExportCSV')?.addEventListener('click', exportarCSV);

  // ══ CERRAR MODALES CON BACKDROP ══
  document.querySelectorAll('.modal-bg').forEach(overlay => {
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });
  });
});
