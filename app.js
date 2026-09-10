/* ═══════════════════════════════════════════════════════════════════════
   Contabilidad ATL · Motor Contable — Módulo Completo 5 Tabs
   PUC Colombiano · Nómina · Socios · Ventas · Proveedores · Impuestos
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

import { supabase } from './supabase.js';
import {
  sesionActual, iniciarSesion, cerrarSesion, observarSesion, mensajeDeError, probarConexion,
  cargarPerfil, esAuditor, rolActual, estadoPerfil, limpiarPerfil, ROLES,
} from './auth.js';
import { adjuntarSoporte, urlDeSoporte, nombreDeSoporte, validarSoporte } from './soportes.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. PUC — Plan Único de Cuentas (relevantes para el módulo)
// ─────────────────────────────────────────────────────────────────────────────
// El catalogo de cuentas vive en Supabase (tabla `plan_cuentas`). Este Map es
// solo la cache en memoria de esa consulta: se llena al arrancar con
// cargarPlanCuentas(). Antes habia aqui una constante con los codigos y
// nombres duplicados, que se desincronizaba del catalogo real.
const CUENTAS = new Map();

/** Nombre de una cuenta del PUC; cae al propio codigo si aun no esta cargado. */
const nombreCuenta = (codigo) => CUENTAS.get(codigo) || codigo;

// ─────────────────────────────────────────────────────────────────────────────
// 2. ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  params: { smlv: 1423500, auxTransporte: 200000, auxRodamiento: 300000, diasPeriodo: 30 },

  // Datos maestros: se cargan de Supabase (tablas `socios` y `domiciliarios`).
  // `cxc` de cada domiciliario NO se guarda: se deriva de sus asientos en la
  // cuenta 1455 dentro de recalcularDerivados().
  domiciliarios: [],
  socios: [],

  asientosSocios: [],
  asientosVentas: [],
  asientosNomina: [],
  asientosOp: [],

  // Acumuladores para impuestos
  ivaAcum: { pct19: 0, pct5: 0, excluido: 0 },
  rteAcum: { compras: 0, honJ: 0, honN: 0, serv: 0, arriendo: 0 },
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
    const nombreDeLaCuenta = nombreCuenta(l.cuenta);
    return `
      <tr>
        <td class="cuenta-col${isCredito ? ' indented' : ''}">
          <strong>${nombreDeLaCuenta}</strong> <span style="color: var(--text-muted); font-size: 0.85em;">Cód. ${l.cuenta}</span>
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
  // Libro global con enlaces a soportes: reservado al auditor.
  if (!esAuditor()) { body.innerHTML = ''; return; }

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
      <td class="mono-cell" style="color:var(--accent);font-size:11.5px">
        ${a.comp}
        ${a.soporteArchivo ? `<button type="button" class="ver-soporte" data-ruta="${esc(a.soporteArchivo)}"
             title="Ver documento soporte: ${esc(nombreDeSoporte(a.soporteArchivo))}"
             style="background:none;border:none;padding:0 0 0 4px;cursor:pointer;color:var(--text-3);font-size:12px">&#128206;</button>` : ''}
      </td>
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
    const m = metricasDe(a);
    ap += m.aporte_capital;   // 3105 Capital suscrito + 3120 Capital por capitalizar
    ret += m.retiro;          // 3705 Utilidades acumuladas debitadas
    gso += m.gasto_general;   // 5199 debitado: gastos pagados por socio
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
    const m = metricasDe(a);
    fac += m.ingreso;                               // 4135 acreditado
    if (a.modulo === 'venta') cob += m.cobro_banco; // 1110 debitado
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
    const m = metricasDe(a);
    dot += m.gasto_dotacion;                                        // 5120
    pol += m.gasto_poliza;                                          // 5150
    otros += m.total_debito - m.gasto_dotacion - m.gasto_poliza;    // resto de debitos
    total += m.total_debito;
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
  const elArr = document.getElementById('rte-arriendo');
  if (elArr) elArr.textContent = fmt(S.rteAcum.arriendo);
  const rteTotal = Object.values(S.rteAcum).reduce((a, b) => a + b, 0);
  document.getElementById('rte-total').textContent = fmt(rteTotal);

  document.getElementById('nd-multas').textContent = fmt(S.multasAcum);
  document.getElementById('nd-sanciones').textContent = '$0';
  document.getElementById('nd-total').textContent = fmt(S.multasAcum);

  // ICA base = ingresos brutos
  let ingBrutos = 0;
  S.asientosVentas.forEach(a => { ingBrutos += metricasDe(a).ingreso; });
  document.getElementById('icaBase').textContent = fmt(ingBrutos);
  document.getElementById('badge-nomina').textContent = String(S.domiciliarios.length);
  calcICA();
}

function calcICA() {
  let ingBrutos = 0;
  S.asientosVentas.forEach(a => { ingBrutos += metricasDe(a).ingreso; });
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
  // El asiento generado es informacion tecnica del auditor; los demas roles
  // reciben solo la confirmacion de que el registro se guardo.
  if (!esAuditor()) { avisoGuardado(a.comp); return; }
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

// Export CSV (all asientos)
function exportarCSV() {
  if (!esAuditor()) return;
  const all = [
    ...S.asientosSocios, ...S.asientosVentas,
    ...S.asientosNomina, ...S.asientosOp
  ];
  if (!all.length) { alert('No hay movimientos para exportar.'); return; }
  const rows = all.flatMap(a => a.lineas.map(l => [
    a.comp, a.fecha, a.modulo, `"${a.nombre}"`, `"${a.desc}"`,
    l.cuenta, `"${nombreCuenta(l.cuenta)}"`,
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
// 11.b PERSISTENCIA SUPABASE — TODOS LOS MÓDULOS
// ─────────────────────────────────────────────────────────────────────────────
// Cabecera en `asientos` + líneas en `asiento_detalles`. Los cuatro módulos
// comparten exactamente el mismo camino: guardarAsientoDB() escribe, y cada
// render vuelve a leer de la BD con un JOIN.

/** `modulo` en BD (plural) -> valor que usan el libro y sus filtros. */
const MODULO_BD_A_APP = { socios: 'socio', ventas: 'venta', nomina: 'nomina', operacion: 'gasto' };

const TIPO_SOCIO_LABELS = {
  capital: 'Aporte de Capital',
  gasto_pagado_socio: 'Gasto pagado por Socio',
  inversion: 'Inversión socio',
  distribucion: 'Retiro / Dividendos',
  prestamo_de_socio: 'Préstamo del Socio',
  prestamo_a_socio: 'Préstamo al Socio',
};

const TIPO_VENTA_LABELS = {
  factura: 'Factura venta', cobro: 'Cobro cartera',
  nota_credito: 'Nota crédito', anticipo_cliente: 'Anticipo',
};

const CAT_OP_LABELS = {
  dotacion: 'Dotación', poliza: 'Póliza', honorarios: 'Honorarios',
  arriendo: 'Arriendo', servicios: 'Servicios', papeleria: 'Papelería',
  publicidad: 'Publicidad', mantenimiento: 'Mantenimiento', otros: 'Otros',
};

// El chip es presentación, así que no se guarda: se deriva del tipo, que sí
// está en la BD. Mantiene vivo el filtro por "cxc" del libro global.
const CHIP_POR_TIPO = {
  cobro: 'chip-ok',
  poliza: 'chip-poliza',
  dotacion: 'chip-gasto',
  repuesto: 'chip-cxc', multa: 'chip-cxc', prestamo: 'chip-cxc',
};
const MODULO_ETIQUETA = {
  socios: 'Socios', ventas: 'Ventas', nomina: 'Nomina', operacion: 'Operacion',
};

const CHIP_POR_MODULO = {
  socios: 'chip-socio', ventas: 'chip-venta',
  nomina: 'chip-nomina', operacion: 'chip-gasto',
};

/** Escapa texto antes de inyectarlo como HTML (los datos vienen de la BD). */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Suma un lado ('debito' | 'credito') de todas las líneas de una cuenta. */
const montoCuenta = (a, cuenta, lado) =>
  (a.lineas || []).reduce((s, l) => s + (l.cuenta === cuenta ? (l[lado] || 0) : 0), 0);

const CAMPOS_METRICAS = [
  'total_debito', 'total_credito', 'iva', 'retencion', 'cxc_neto', 'ingreso',
  'cobro_banco', 'aporte_capital', 'retiro', 'gasto_general', 'gasto_dotacion', 'gasto_poliza',
];

/** Convierte la fila de metricas_asientos() en numeros. null si no hay fila. */
function normalizarMetricas(m) {
  if (!m) return null;
  return Object.fromEntries(CAMPOS_METRICAS.map(k => [k, Number(m[k]) || 0]));
}

/**
 * Cifras de negocio de un asiento. Si llegaron agregadas desde la base (roles
 * sin acceso a las lineas) se usan tal cual; si no, se calculan de las lineas.
 * Las formulas deben coincidir con public.metricas_asientos() en sql/009.
 */
function metricasDe(a) {
  if (a.metricas) return a.metricas;
  const dr = (c) => montoCuenta(a, c, 'debito');
  const cr = (c) => montoCuenta(a, c, 'credito');
  a.metricas = {
    total_debito: a.totD,
    total_credito: a.totC,
    iva: cr('2408'),
    retencion: cr('2370'),
    cxc_neto: dr('1455') - cr('1455'),
    ingreso: cr('4135'),
    cobro_banco: dr('1110'),
    aporte_capital: cr('3105') + cr('3120'),
    retiro: dr('3705'),
    gasto_general: dr('5199'),
    gasto_dotacion: dr('5120'),
    gasto_poliza: dr('5150'),
  };
  return a.metricas;
}

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
    id: row.id,
    comp: row.comprobante,
    fecha: row.fecha,
    modulo: MODULO_BD_A_APP[row.modulo] || row.modulo,
    chip: CHIP_POR_TIPO[row.tipo] || CHIP_POR_MODULO[row.modulo] || 'chip-gasto',
    nombre: row.tercero,
    desc: row.descripcion,
    tipo: row.tipo,
    modalidad: row.modalidad,
    clasificacion: row.clasificacion,
    soporte: row.soporte,
    soporteArchivo: row.soporte_archivo,
    nit: row.tercero_nit,
    vencimiento: row.vencimiento,
    tasa: (row.tasa === null || row.tasa === undefined) ? null : Number(row.tasa),
    valor: Number(row.valor) || 0,
    // Cifras agregadas de la base para los roles sin acceso a las lineas; null
    // para el auditor, que las calcula de sus lineas en metricasDe().
    metricas: normalizarMetricas(row._metricas),
    lineas,
    totD: lineas.reduce((acc, l) => acc + l.debito, 0),
    totC: lineas.reduce((acc, l) => acc + l.credito, 0),
  };
}

/**
 * Traduce los errores de Postgres que llegan por PostgREST a algo accionable.
 * Sin esto, un fallo de integridad sale como
 * 'violates foreign key constraint "asiento_detalles_cuenta_fkey"',
 * que no le dice nada a quien no programa.
 */
function mensajeDeErrorBD(err) {
  const codigo  = err?.code || '';
  const detalle = String(err?.details || '');
  const mensaje = String(err?.message || err || '');

  // 23503 - clave foranea.
  // OJO: Supabase censura los valores en `details` ('Key is not present in
  // table "x"', sin la columna ni el valor), asi que no se puede extraer el
  // codigo de cuenta de ahi. Se distingue por el nombre de la restriccion y
  // por el tipo de operacion, ambos si presentes en `message`.
  if (codigo === '23503') {
    const esCuenta  = /cuenta_fkey/.test(mensaje);
    const esBorrado = /^update or delete/i.test(mensaje);

    if (esCuenta && esBorrado) {
      return 'No se puede eliminar esa cuenta del catalogo: ya tiene movimientos '
           + 'registrados. Para renumerarla usa UPDATE sobre plan_cuentas, que '
           + 'arrastra los asientos al codigo nuevo.';
    }
    if (esCuenta) {
      return 'El asiento usa una cuenta que no existe en el plan de cuentas. '
           + 'Agregala al catalogo antes de registrar este movimiento.';
    }
    if (esBorrado) {
      return 'No se puede eliminar ese registro: otros datos dependen de el.';
    }
    return 'El registro apunta a un dato que no existe en la base de datos.';
  }

  // 23505 - unicidad
  if (codigo === '23505') {
    if (/comprobante/.test(detalle + mensaje)) {
      return 'Ya existe un asiento con ese numero de comprobante. '
           + 'Recarga la pagina para sincronizar el consecutivo e intenta de nuevo.';
    }
    if (/codigo/.test(detalle)) return 'Ya existe una cuenta con ese codigo en el catalogo.';
    return 'Ya existe un registro con esos datos. ' + detalle;
  }

  if (codigo === '23514') return 'Un valor no cumple una regla de la base de datos. ' + detalle;
  if (codigo === '23502') return 'Falta un dato obligatorio. ' + detalle;
  if (codigo === '42501') return 'Tu sesion no tiene permiso para esta operacion.';
  if (codigo === 'PGRST301' || /JWT|token/i.test(mensaje)) {
    return 'Tu sesion expiro. Cierra sesion y vuelve a entrar.';
  }
  return mensaje;
}

/**
 * Guarda un asiento: primero la cabecera en `asientos`, recupera el id
 * generado y con él inserta las líneas en `asiento_detalles`.
 * Idéntico para los cuatro módulos.
 */
async function guardarAsientoDB(a, meta) {
  // Comprobacion local contra el catalogo ya cargado. La clave foranea de
  // sql/007 es la garantia real, pero Postgres no revela que cuenta fallo
  // (Supabase censura los valores), asi que se detecta aqui para poder
  // nombrarla en el aviso.
  if (CUENTAS.size) {
    const desconocidas = [...new Set(a.lineas.map(l => l.cuenta))].filter(c => !CUENTAS.has(c));
    if (desconocidas.length) {
      throw new Error('El asiento usa cuentas que no estan en el plan de cuentas: '
        + desconocidas.join(', ') + '. Agregalas al catalogo antes de registrarlo.');
    }
  }

  const { data: cabecera, error: errCab } = await supabase
    .from('asientos')
    .insert({
      comprobante: a.comp,
      fecha: a.fecha,
      descripcion: a.desc,
      modulo: meta.modulo,
      tercero: a.nombre,
      tipo: meta.tipo || null,
      modalidad: meta.modalidad || null,
      clasificacion: meta.clasificacion || null,
      soporte: meta.soporte || null,
      valor: meta.valor,
      tercero_nit: meta.nit || null,
      vencimiento: meta.vencimiento || null,
      tasa: (meta.tasa === undefined || meta.tasa === null || meta.tasa === '') ? null : meta.tasa,
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
 * Envoltorio común de los botones de guardado: bloquea el botón, persiste y,
 * si la BD falla, revierte lo que el generador ya había dejado en memoria.
 * @returns {Promise<number|null>} id del asiento creado, o null si fallo.
 */
async function guardarConFeedback(btn, a, meta, arrayEnMemoria) {
  const htmlOriginal = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

  try {
    // Se devuelve el id porque el adjunto se sube a una carpeta con ese id.
    return await guardarAsientoDB(a, meta);
  } catch (err) {
    console.error('[Supabase] No se pudo guardar el asiento:', err);
    alert('No se pudo guardar en la base de datos:' + String.fromCharCode(10) + mensajeDeErrorBD(err));
    if (arrayEnMemoria) arrayEnMemoria.pop();
    S.seq--;
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = htmlOriginal; }
  }
}

/**
 * Sube el documento soporte de un asiento recien creado, si el usuario
 * adjunto uno. Lo usan los cuatro modulos.
 *
 * El adjunto va DESPUES de crear el asiento porque se archiva en una carpeta
 * con su id. Si la subida falla el asiento se conserva y se avisa: perder un
 * apunte contable cuadrado por un fallo al adjuntar seria peor.
 *
 * @param {string} inputId  id del <input type="file"> del formulario
 * @param {number} asientoId id devuelto al guardar
 * @param {HTMLElement|null} btn boton a bloquear mientras sube
 */
async function subirAdjuntoSiHay(inputId, asientoId, btn) {
  const input = document.getElementById(inputId);
  const archivo = input?.files?.[0];
  if (!archivo) return;

  const htmlBoton = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Subiendo soporte...'; }

  const res = await adjuntarSoporte(archivo, asientoId);

  if (btn) { btn.disabled = false; btn.innerHTML = htmlBoton; }
  if (input) input.value = '';

  if (!res.ok) {
    alert('El asiento se guardo correctamente, pero el documento NO se adjunto:'
      + String.fromCharCode(10) + res.error
      + String.fromCharCode(10) + String.fromCharCode(10)
      + 'Puedes volver a adjuntarlo mas tarde.');
  }
}

/** Lee de la BD los asientos de un módulo, con sus líneas. */
async function leerAsientos(moduloBD) {
  // Se piden todas las columnas (`*`) en vez de enumerarlas: asi una columna
  // anadida por una migracion pendiente no hace fallar la consulta entera.
  const consulta = (columnas) => supabase
    .from('asientos')
    .select(columnas)
    .eq('modulo', moduloBD)
    .order('fecha', { ascending: false })
    .order('id', { ascending: false });

  const fallo = (error) => {
    console.error('[Supabase] Error al cargar asientos de ' + moduloBD + ':', error);
    return { filas: null, error };
  };

  // El auditor lee las lineas y las cifras se calculan a partir de ellas.
  if (esAuditor()) {
    const { data, error } = await consulta('*, asiento_detalles ( * )');
    return error ? fallo(error) : { filas: data, error: null };
  }

  // Los demas roles no pueden leer las lineas (RLS de sql/009): reciben las
  // cabeceras y, aparte, solo las cifras agregadas que calcula la base.
  const [cabeceras, metricas] = await Promise.all([
    consulta('*'),
    supabase.rpc('metricas_asientos', { p_modulo: moduloBD }),
  ]);
  if (cabeceras.error) return fallo(cabeceras.error);

  if (metricas.error) {
    // Compatibilidad mientras no se ejecute sql/009: la funcion aun no existe,
    // pero las lineas todavia son legibles. Sin esto las cifras saldrian en cero.
    console.warn('[Supabase] metricas_asientos no disponible; se usan las lineas:', metricas.error.message);
    const { data, error } = await consulta('*, asiento_detalles ( * )');
    return error ? fallo(error) : { filas: data, error: null };
  }

  const porAsiento = new Map(metricas.data.map(m => [m.asiento_id, m]));
  cabeceras.data.forEach(fila => { fila._metricas = porAsiento.get(fila.id) || null; });
  return { filas: cabeceras.data, error: null };
}

/** Fila desplegable con el asiento completo, común a las tres tablas. */
function filaDetalle(a, columnas) {
  // Detalle contable reservado al auditor. Para los demas roles ni se genera,
  // asi el contenido tampoco queda escondido en el DOM.
  if (!esAuditor()) return '';
  const n = a.lineas.length;
  // El bucket es privado: el enlace se firma al hacer clic, no al pintar.
  const soporte = a.soporteArchivo
    ? `<div style="padding:8px 0 2px">
         <button type="button" class="ver-soporte" data-ruta="${esc(a.soporteArchivo)}"
                 style="background:none;border:none;padding:0;cursor:pointer;font-size:12px;
                        color:var(--accent);text-decoration:underline">
           Ver documento soporte (${esc(nombreDeSoporte(a.soporteArchivo))})
         </button>
       </div>`
    : '';
  return `
    <tr>
      <td colspan="${columnas}" style="padding:0 14px 10px">
        <details>
          <summary style="cursor:pointer;padding:8px 0;color:var(--text-3);font-size:12px;list-style:none">
            ▸ Ver detalle del asiento contable · ${n} línea${n !== 1 ? 's' : ''} (Opcional)
          </summary>
          ${htmlAsiento(a)}
          ${soporte}
        </details>
      </td>
    </tr>`;
}

/** Pinta el estado vacío o el error de una tabla. Devuelve true si ya pintó. */
function pintarEstadoTabla(body, countEl, columnas, filas, error) {
  if (error) {
    body.innerHTML = `<tr><td colspan="${columnas}" class="empty-row" style="color:var(--red)">
      ⚠ No se pudieron cargar los movimientos: ${esc(error.message)}</td></tr>`;
    if (countEl) countEl.textContent = '— registros';
    return true;
  }
  if (!filas.length) {
    body.innerHTML = `<tr><td colspan="${columnas}" class="empty-row">Sin registros aún.</td></tr>`;
    if (countEl) countEl.textContent = '0 registros';
    return true;
  }
  if (countEl) countEl.textContent = `${filas.length} registro${filas.length !== 1 ? 's' : ''}`;
  return false;
}

// ── SOCIOS ───────────────────────────────────────────────────────────────────
async function renderSocios() {
  const body = document.getElementById('bodySocios');
  const countEl = document.getElementById('countSocios');
  if (!body) return;

  const { filas, error } = await leerAsientos('socios');
  if (pintarEstadoTabla(body, countEl, 7, filas || [], error)) {
    if (!error) S.asientosSocios = [];
    return;
  }

  S.asientosSocios = filas.map(asientoDesdeDB).reverse();

  body.innerHTML = filas.map(row => {
    const a = asientoDesdeDB(row);
    return `
      <tr>
        <td>${fmtDate(row.fecha)}</td>
        <td>${esc(row.tercero) || '—'}</td>
        <td><span class="chip chip-socio">${esc(TIPO_SOCIO_LABELS[row.tipo] || row.tipo || '—')}</span></td>
        <td style="color:var(--text-2);font-size:12.5px">${esc(row.descripcion) || '—'}</td>
        <td style="color:var(--text-2);font-size:12.5px">${esc(row.modalidad) || '—'}</td>
        <td class="text-right mono-cell">${fmt(a.valor)}</td>
        <td><span class="mono-cell" style="font-size:11px;color:var(--accent)">${esc(row.comprobante)}</span></td>
      </tr>
      ${filaDetalle(a, 7)}`;
  }).join('');
}

// ── VENTAS ───────────────────────────────────────────────────────────────────
async function renderVentas() {
  const body = document.getElementById('bodyVentas');
  const countEl = document.getElementById('countVentas');
  if (!body) return;

  const { filas, error } = await leerAsientos('ventas');
  if (pintarEstadoTabla(body, countEl, 7, filas || [], error)) {
    if (!error) S.asientosVentas = [];
    return;
  }

  S.asientosVentas = filas.map(asientoDesdeDB).reverse();

  body.innerHTML = filas.map(row => {
    const a = asientoDesdeDB(row);
    // IVA y total salen de las líneas: la partida doble es la fuente de verdad.
    const { iva, total_debito: total } = metricasDe(a);
    const estado = row.tipo === 'cobro'
      ? '<span class="chip chip-ok">Pagado</span>'
      : '<span class="chip chip-pendiente">Pendiente</span>';
    return `
      <tr>
        <td>${fmtDate(row.fecha)}</td>
        <td style="font-size:12.5px">${esc(row.tercero) || '—'}</td>
        <td><span class="chip chip-venta">${esc(TIPO_VENTA_LABELS[row.tipo] || row.tipo || '—')}</span></td>
        <td class="text-right mono-cell">${fmt(a.valor)}</td>
        <td class="text-right mono-cell" style="color:var(--yellow)">${iva > 0 ? fmt(iva) : '—'}</td>
        <td class="text-right mono-cell" style="font-weight:700;color:var(--green)">${fmt(total)}</td>
        <td>${estado}</td>
      </tr>
      ${filaDetalle(a, 7)}`;
  }).join('');
}

// ── OPERACIÓN / PROVEEDORES ──────────────────────────────────────────────────
async function renderOp() {
  const body = document.getElementById('bodyOp');
  const countEl = document.getElementById('countOp');
  if (!body) return;

  const { filas, error } = await leerAsientos('operacion');
  if (pintarEstadoTabla(body, countEl, 7, filas || [], error)) {
    if (!error) S.asientosOp = [];
    return;
  }

  S.asientosOp = filas.map(asientoDesdeDB).reverse();

  body.innerHTML = filas.map(row => {
    const a = asientoDesdeDB(row);
    const rete = metricasDe(a).retencion;
    const neto = a.valor - rete;
    return `
      <tr>
        <td>${fmtDate(row.fecha)}</td>
        <td style="font-size:12.5px">${esc(row.tercero) || '—'}</td>
        <td><span class="chip chip-gasto">${esc(CAT_OP_LABELS[row.tipo] || row.tipo || '—')}</span></td>
        <td class="text-right mono-cell">${fmt(a.valor)}</td>
        <td class="text-right mono-cell" style="color:var(--yellow)">${rete > 0 ? fmt(rete) : '—'}</td>
        <td class="text-right mono-cell">${fmt(neto)}</td>
        <td class="mono-cell" style="font-size:11px;color:var(--accent)">${esc(row.comprobante)}</td>
      </tr>
      ${filaDetalle(a, 7)}`;
  }).join('');
}

// ── NÓMINA ───────────────────────────────────────────────────────────────────
// No tiene tabla de historial propia: `bodyNomina` es el listado de personal.
// Los asientos (movimientos y liquidaciones) se cargan para el libro global,
// los impuestos y el saldo de cuentas por cobrar de cada trabajador.
async function cargarAsientosNomina() {
  const { filas, error } = await leerAsientos('nomina');
  if (error) return;
  S.asientosNomina = filas.map(asientoDesdeDB).reverse();
}

/**
 * Concepto de retencion segun la CATEGORIA del gasto elegida por el usuario.
 *
 * Antes esto se decidia por la tarifa, lo que confundia conceptos distintos que
 * comparten porcentaje: arrendamiento y compras son ambos 3.5%, asi que todo
 * arriendo se declaraba como compra. La categoria es lo que describe la
 * operacion, asi que es la que manda.
 */
const CONCEPTO_RETE_POR_CATEGORIA = {
  dotacion: 'compras',
  papeleria: 'compras',
  honorarios: 'honorarios',   // se resuelve J / N mas abajo
  arriendo: 'arriendo',
  servicios: 'serv',
  publicidad: 'serv',
  mantenimiento: 'serv',
  poliza: 'serv',
};

/**
 * Respaldo por tarifa. Solo se usa con categorias sin concepto propio
 * ('otros' o cualquier valor no previsto), donde no hay senal de categoria.
 */
const CONCEPTO_RETE_POR_TASA = { 3.5: 'compras', 4: 'honJ', 11: 'honN', 6: 'serv', 2: 'serv' };

/**
 * Resuelve el casillero de retencion de un gasto.
 * @param {string} categoria  valor de `catGasto`, guardado como `tipo`.
 * @param {number|null} tasa  % retenido; solo desempata honorarios J / N,
 *                            porque la categoria no dice el tipo de tercero.
 */
function conceptoRetencion(categoria, tasa) {
  const porCategoria = CONCEPTO_RETE_POR_CATEGORIA[categoria];
  if (porCategoria === 'honorarios') return tasa === 11 ? 'honN' : 'honJ';
  if (porCategoria) return porCategoria;
  return CONCEPTO_RETE_POR_TASA[tasa] || null;
}

/**
 * Recalcula desde los asientos ya cargados todo lo que antes se acumulaba
 * al vuelo en variables de memoria y se perdía al recargar la página:
 * IVA por tarifa, retenciones por concepto, multas no deducibles y el saldo
 * de cuentas por cobrar de cada domiciliario.
 */
function recalcularDerivados() {
  S.ivaAcum = { pct19: 0, pct5: 0, excluido: 0 };
  S.rteAcum = { compras: 0, honJ: 0, honN: 0, serv: 0, arriendo: 0 };
  S.multasAcum = 0;
  S.domiciliarios.forEach(d => { d.cxc = 0; });

  S.asientosVentas.forEach(a => {
    if (a.tipo !== 'factura') return;
    const iva = metricasDe(a).iva;
    if (a.tasa === 19) S.ivaAcum.pct19 += iva;
    else if (a.tasa === 5) S.ivaAcum.pct5 += iva;
    else S.ivaAcum.excluido += a.valor;
  });

  S.asientosOp.forEach(a => {
    const rete = metricasDe(a).retencion;
    if (!rete) return;
    // `a.tipo` guarda la categoria del gasto (catGasto).
    const concepto = conceptoRetencion(a.tipo, a.tasa);
    if (concepto && concepto in S.rteAcum) S.rteAcum[concepto] += rete;
    else console.warn('[retenciones] Gasto sin concepto asignable:', a.comp, a.tipo, a.tasa);
  });

  S.asientosNomina.forEach(a => {
    if (a.tipo === 'multa') S.multasAcum += a.valor;
    const dom = S.domiciliarios.find(d => d.nombre === a.nombre);
    if (dom) dom.cxc += metricasDe(a).cxc_neto;
  });

  S.domiciliarios.forEach(d => { d.cxc = Math.max(0, Math.round(d.cxc)); });
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

// ── DATOS MAESTROS Y CATALOGO ────────────────────────────────────────────────

/** Carga el catalogo de cuentas a la cache que usa nombreCuenta(). */
async function cargarPlanCuentas() {
  const { data, error } = await supabase
    .from('plan_cuentas')
    .select('codigo, nombre');

  if (error) {
    // Sin catalogo los asientos siguen cuadrando: solo se veran los codigos
    // en lugar de los nombres, asi que no se aborta la carga.
    console.error('[Supabase] No se pudo cargar plan_cuentas:', error);
    return;
  }
  CUENTAS.clear();
  data.forEach(c => CUENTAS.set(c.codigo, c.nombre));
}

/** Carga el listado de socios desde la BD. */
async function cargarSocios() {
  const { data, error } = await supabase
    .from('socios')
    .select('id, nombre, documento')
    .eq('activo', true)
    .order('id');

  if (error) { console.error('[Supabase] No se pudo cargar socios:', error); return; }
  S.socios = data;
}

/** Carga el listado de domiciliarios. `cxc` arranca en 0: lo llena recalcularDerivados(). */
async function cargarDomiciliarios() {
  const { data, error } = await supabase
    .from('domiciliarios')
    .select('id, nombre, documento, placa, telefono, ingreso')
    .eq('activo', true)
    .order('id');

  if (error) { console.error('[Supabase] No se pudo cargar domiciliarios:', error); return; }
  S.domiciliarios = data.map(d => ({
    id: d.id, nombre: d.nombre, doc: d.documento, placa: d.placa,
    tel: d.telefono, ingreso: d.ingreso, cxc: 0,
  }));
}

/** Siguiente id libre de la serie D001, D002, ... */
function siguienteIdDomiciliario() {
  const usados = S.domiciliarios
    .map(d => parseInt(String(d.id).replace(/\D/g, ''), 10))
    .filter(Number.isFinite);
  const siguiente = (usados.length ? Math.max(...usados) : 0) + 1;
  return 'D' + String(siguiente).padStart(3, '0');
}

/**
 * Contadores de la barra lateral. Estaban fijos en `0` en el HTML y solo
 * nomina se actualizaba, asi que la barra decia 0 mientras la tabla mostraba
 * registros.
 */
function actualizarBadges() {
  const poner = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  };
  poner('badge-socios', S.asientosSocios.length);
  poner('badge-clientes', S.asientosVentas.length);
  poner('badge-operacion', S.asientosOp.length);
  poner('badge-nomina', S.domiciliarios.length);
}

/** Recarga todo desde Supabase y repinta la interfaz completa. */
async function recargarTodo() {
  // Maestros y catalogo van primero: renderNomina() y recalcularDerivados()
  // necesitan el listado de domiciliarios ya cargado.
  // El plan de cuentas solo lo lee el auditor (sql/009): para los demas roles la
  // consulta volveria vacia, y sin detalle de asientos no necesitan los nombres.
  await Promise.all([esAuditor() ? cargarPlanCuentas() : null, cargarSocios(), cargarDomiciliarios()]);
  fillSocioSel();
  await Promise.all([renderSocios(), renderVentas(), renderOp(), cargarAsientosNomina()]);
  recalcularDerivados();
  updateKpiSocios();
  updateKpiVentas();
  updateKpiOp();
  actualizarBadges();
  renderNomina();
  fillDomSel();
  updateImpuestos();
  renderLibro();
  // Solo si ya se consulto alguna vez: evita una consulta extra al arrancar.
  if (document.getElementById('bodyDiario')?.dataset.consultado === '1') renderDiario();
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
// 11.d LIBRO DIARIO
// ─────────────────────────────────────────────────────────────────────────────
// Vista cronologica a nivel de LINEA contable, a diferencia del Libro Global
// de la pestana Impuestos, que resume un asiento por fila.
//
// Sobre el JOIN con plan_cuentas: PostgREST solo puede incrustar una tabla
// relacionada si existe una clave foranea, y `asiento_detalles.cuenta` es texto
// libre sin FK hacia `plan_cuentas.codigo`. El nombre de cada cuenta se resuelve
// con el catalogo que ya esta cargado en memoria (CUENTAS), que se llena de esa
// misma tabla al arrancar. Mismo resultado, sin una consulta extra por fila.

/** Primer y ultimo dia del mes en curso, en formato YYYY-MM-DD. */
function rangoMesActual() {
  const hoy = new Date();
  const primero = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const ultimo = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  const iso = (d) => d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
  return { desde: iso(primero), hasta: iso(ultimo) };
}

/**
 * Consulta los asientos del periodo con sus lineas.
 * @param {string} desde  YYYY-MM-DD inclusive
 * @param {string} hasta  YYYY-MM-DD inclusive
 * @param {string} modulo '' para todos
 */
async function consultarDiario(desde, hasta, modulo) {
  let consulta = supabase
    .from('asientos')
    .select('*, asiento_detalles ( * )')
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha', { ascending: true })
    .order('id', { ascending: true });

  if (modulo) consulta = consulta.eq('modulo', modulo);

  const { data, error } = await consulta;
  if (error) {
    console.error('[Diario] Error al consultar:', error);
    return { filas: null, error };
  }
  return { filas: data, error: null };
}

/** Pinta el Libro Diario con el periodo elegido en los filtros. */
async function renderDiario() {
  if (!esAuditor()) return;   // modulo reservado: ni siquiera se consulta
  const body = document.getElementById('bodyDiario');
  const foot = document.getElementById('footDiario');
  if (!body) return;

  const desde = document.getElementById('diarioDesde')?.value;
  const hasta = document.getElementById('diarioHasta')?.value;
  const modulo = document.getElementById('diarioModulo')?.value || '';

  if (!desde || !hasta) {
    body.innerHTML = '<tr><td colspan="6" class="empty-row">Indica las dos fechas del período.</td></tr>';
    if (foot) foot.innerHTML = '';
    return;
  }
  if (desde > hasta) {
    body.innerHTML = '<tr><td colspan="6" class="empty-row" style="color:var(--red)">La fecha inicial es posterior a la final.</td></tr>';
    if (foot) foot.innerHTML = '';
    return;
  }

  body.innerHTML = '<tr><td colspan="6" class="empty-row">Consultando…</td></tr>';
  if (foot) foot.innerHTML = '';
  body.dataset.consultado = '1';   // recargarTodo() lo usa para refrescar esta vista

  const { filas, error } = await consultarDiario(desde, hasta, modulo);

  if (error) {
    body.innerHTML = `<tr><td colspan="6" class="empty-row" style="color:var(--red)">
      ⚠ No se pudo consultar el libro: ${esc(error.message)}</td></tr>`;
    return;
  }

  if (!filas.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-row">Sin asientos en el período seleccionado.</td></tr>';
    const badge = document.getElementById('badge-diario');
    if (badge) badge.textContent = '0';
    return;
  }

  let totalDebito = 0;
  let totalCredito = 0;
  const bloques = [];

  for (const row of filas) {
    const a = asientoDesdeDB(row);
    const nLineas = a.lineas.length;

    // Cabecera del asiento: agrupa visualmente sus lineas.
    bloques.push(`
      <tr style="background:var(--bg-2, rgba(255,255,255,.02))">
        <td style="font-size:12px;color:var(--text-2)">${fmtDate(row.fecha)}</td>
        <td class="mono-cell" style="font-size:11px;color:var(--accent)">
          ${esc(a.comp)}
          ${a.soporteArchivo ? `<button type="button" class="ver-soporte" data-ruta="${esc(a.soporteArchivo)}"
               title="Ver documento soporte"
               style="background:none;border:none;padding:0 0 0 4px;cursor:pointer;color:var(--text-3)">&#128206;</button>` : ''}
        </td>
        <td colspan="2" style="font-size:12px;color:var(--text-2)">
          <span class="chip ${a.chip}" style="font-size:10.5px">${esc(MODULO_ETIQUETA[row.modulo] || row.modulo)}</span>
          <strong style="margin-left:6px">${esc(a.nombre) || '—'}</strong>
          <span style="color:var(--text-3)"> · ${esc(a.desc) || '—'}</span>
        </td>
        <td colspan="2" class="text-right" style="font-size:11px;color:var(--text-3)">
          ${nLineas} línea${nLineas !== 1 ? 's' : ''}
        </td>
      </tr>`);

    for (const l of a.lineas) {
      totalDebito += l.debito;
      totalCredito += l.credito;
      const esCredito = l.debito === 0 && l.credito > 0;
      bloques.push(`
        <tr>
          <td></td>
          <td></td>
          <td style="${esCredito ? 'padding-left:22px;' : ''}font-size:12px">
            <strong>${esc(nombreCuenta(l.cuenta))}</strong>
            <div class="mono-cell" style="font-size:10.5px;color:var(--text-3)">Cód. ${esc(l.cuenta)}</div>
          </td>
          <td style="font-size:12px;color:var(--text-2)">${esc(l.desc)}</td>
          <td class="text-right mono-cell">${l.debito > 0 ? fmt(l.debito) : '<span style="color:var(--text-3)">—</span>'}</td>
          <td class="text-right mono-cell">${l.credito > 0 ? fmt(l.credito) : '<span style="color:var(--text-3)">—</span>'}</td>
        </tr>`);
    }
  }

  body.innerHTML = bloques.join('');

  // Sumatorias del periodo y validacion de partida doble.
  const cuadra = Math.abs(totalDebito - totalCredito) < 0.01;
  const color = cuadra ? 'var(--green)' : 'var(--red)';

  if (foot) {
    foot.innerHTML = `
      <tr style="border-top:2px solid var(--border)">
        <td colspan="4" style="font-weight:700;font-size:12.5px">
          TOTALES DEL PERÍODO · ${filas.length} asiento${filas.length !== 1 ? 's' : ''}
        </td>
        <td class="text-right mono-cell" style="font-weight:700;color:${color}">${fmt(totalDebito)}</td>
        <td class="text-right mono-cell" style="font-weight:700;color:${color}">${fmt(totalCredito)}</td>
      </tr>
      <tr>
        <td colspan="6" style="padding-top:10px;color:${color};font-size:12.5px;font-weight:600">
          ${cuadra
            ? '✓ Partida doble correcta — Débitos = Créditos'
            : '⚠ Descuadre de ' + fmt(Math.abs(totalDebito - totalCredito)) + ' — revisar los asientos del período'}
        </td>
      </tr>`;
  }

  const badge = document.getElementById('badge-diario');
  if (badge) badge.textContent = String(filas.length);
}

/** Exporta a CSV exactamente lo que se ve en el Libro Diario. */
async function exportarDiario() {
  if (!esAuditor()) return;
  const desde = document.getElementById('diarioDesde')?.value;
  const hasta = document.getElementById('diarioHasta')?.value;
  const modulo = document.getElementById('diarioModulo')?.value || '';
  if (!desde || !hasta) { alert('Indica las dos fechas del período.'); return; }

  const { filas, error } = await consultarDiario(desde, hasta, modulo);
  if (error) { alert('No se pudo exportar: ' + error.message); return; }
  if (!filas.length) { alert('No hay asientos en el período.'); return; }

  const escaparCsv = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const encabezado = ['Fecha', 'Comprobante', 'Modulo', 'Tercero', 'Concepto',
                      'Cuenta', 'Nombre cuenta', 'Detalle linea', 'Debito', 'Credito'];

  let totD = 0, totC = 0;
  const lineas = [];
  for (const row of filas) {
    const a = asientoDesdeDB(row);
    for (const l of a.lineas) {
      totD += l.debito; totC += l.credito;
      lineas.push([
        row.fecha, a.comp, row.modulo, a.nombre, a.desc,
        l.cuenta, nombreCuenta(l.cuenta), l.desc, l.debito || 0, l.credito || 0,
      ].map(escaparCsv).join(','));
    }
  }
  lineas.push(['', '', '', '', '', '', '', 'TOTALES', totD, totC].map(escaparCsv).join(','));

  const csv = [encabezado.map(escaparCsv).join(','), ...lineas].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = `LibroDiario_${desde}_a_${hasta}.csv`;
  enlace.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11.c CONTROL DE SESION
// ─────────────────────────────────────────────────────────────────────────────
// La app no consulta nada sin sesion: con las politicas RLS de sql/005 la
// clave publica del navegador ya no da acceso a ninguna tabla.

// Control de acceso por rol. PERMISOS es el UNICO lugar a editar para ajustar
// que ve cada perfil.
//
// OJO: esto gobierna la INTERFAZ. Ocultar un bloque no impide que alguien con
// conocimientos tecnicos consulte los datos desde la consola del navegador; la
// proteccion de datos vive en las politicas RLS (sql/005 y sql/008).
const PERMISOS = {
  // Lectura contable y configuracion: reservadas al auditor.
  tabsSoloAuditor: ['diario', 'impuestos'],
  // Parametros legales: visibles para todos, editables solo por el auditor.
  camposConfig: ['smlv', 'auxTransporte', 'auxRodamiento', 'diasPeriodo'],
};

/** true si el rol actual puede abrir esa pestana. */
function puedeVerTab(tab) {
  return esAuditor() || !PERMISOS.tabsSoloAuditor.includes(tab);
}

/** Cambia de pestana sin simular un click (no depende del orden de los listeners). */
function activarPestana(tab) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
}

/**
 * Aplica a la interfaz los permisos del rol cargado. Se puede llamar varias
 * veces. Si el rol no se pudo verificar, auth.js ya asigno `comercial`
 * (minimo privilegio) y aqui solo se avisa.
 */
function aplicarPermisos() {
  const auditor = esAuditor();
  const rol = rolActual() || 'pendiente';

  // styles.css oculta todo .solo-auditor mientras data-rol no sea "auditor".
  document.documentElement.dataset.rol = rol;

  PERMISOS.camposConfig.forEach(id => {
    const campo = document.getElementById(id);
    if (!campo) return;
    campo.disabled = !auditor;
    campo.title = auditor ? '' : 'Solo un auditor puede modificar los parametros legales.';
  });

  const activa = document.querySelector('.nav-item.active');
  if (activa && !puedeVerTab(activa.dataset.tab)) activarPestana('socios');

  const etiqueta = document.getElementById('sesionRol');
  if (etiqueta) {
    etiqueta.textContent = rol === ROLES.AUDITOR ? 'Auditor'
      : rol === ROLES.COMERCIAL ? 'Comercial' : '';
  }

  const estado = estadoPerfil();
  const aviso = document.getElementById('avisoRol');
  if (!aviso) return;
  if (estado.origen === 'bd' || estado.origen === 'sin-cargar') {
    aviso.style.display = 'none';
    aviso.innerHTML = '';
  } else {
    aviso.innerHTML = '<strong>Permisos restringidos.</strong> No se pudo verificar tu rol: '
      + esc(estado.detalle || 'motivo desconocido.')
      + ' Mientras tanto se aplican los permisos del perfil comercial.'
      + '<button type="button" id="btnReintentarRol">Reintentar</button>';
    aviso.style.display = 'block';
  }
}

/**
 * Confirmacion breve para los roles que no ven el asiento generado: sin ella,
 * en Nomina no quedaria ninguna senal de que el registro se guardo.
 */
function avisoGuardado(comprobante) {
  let toast = document.getElementById('toastGuardado');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastGuardado';
    toast.setAttribute('role', 'status');
    toast.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9000;padding:10px 14px;'
      + 'border-radius:8px;font-size:12.5px;font-weight:600;background:var(--card,#1b1b1b);'
      + 'border:1px solid var(--green,#3ba55d);color:var(--green,#3ba55d);'
      + 'box-shadow:0 6px 20px rgba(0,0,0,.35)';
    document.body.appendChild(toast);
  }
  toast.textContent = '✓ Registro guardado · ' + comprobante;
  toast.style.display = 'block';
  clearTimeout(avisoGuardado.temporizador);
  avisoGuardado.temporizador = setTimeout(() => { toast.style.display = 'none'; }, 3500);
}

let sesionMontada = false;
// Rol con el que se pintaron las tablas por ultima vez. Decide si un evento
// de sesion debe volver a pintar (cambio real de rol) o puede ignorarse.
let rolPintado = null;

function mostrarLogin(mostrar) {
  const pantalla = document.getElementById('pantallaLogin');
  if (pantalla) {
    // OJO: el atributo `hidden` NO basta aqui. El contenedor lleva su display
    // en un estilo en linea, y un estilo en linea gana siempre al [hidden] del
    // navegador: la pantalla se quedaba encima de la app ya cargada y parecia
    // que el login habia fallado, cuando la sesion si se habia creado.
    pantalla.style.display = mostrar ? 'flex' : 'none';
    pantalla.hidden = !mostrar;          // se mantiene por semantica/accesibilidad
  }
  const info = document.getElementById('sesionInfo');
  if (info) info.hidden = mostrar;
}

/** Reacciona a la sesion: carga la app o muestra la pantalla de acceso. */
async function aplicarSesion(session) {
  if (!session) {
    sesionMontada = false;
    rolPintado = null;
    limpiarPerfil();
    aplicarPermisos();
    mostrarLogin(true);
    return;
  }

  // Otro usuario en la misma pestana: lo cargado para el anterior no sirve.
  const perfilPrevio = estadoPerfil().userId;
  if (perfilPrevio && perfilPrevio !== session.user.id) sesionMontada = false;

  const email = document.getElementById('sesionEmail');
  if (email) email.textContent = session.user?.email || 'Sesion activa';

  // El rol se resuelve ANTES de retirar la pantalla de acceso: asi no hay ni
  // un instante con contenido tecnico visible para quien no debe verlo.
  await cargarPerfil(session.user.id);
  aplicarPermisos();
  mostrarLogin(false);

  // onAuthStateChange tambien dispara al renovar el token; sin esta guarda
  // se recargaria toda la interfaz cada vez que caduca el access token.
  if (sesionMontada) {
    // ...salvo que el rol haya cambiado respecto al usado para pintar (por
    // ejemplo, se ejecuto la migracion de roles y luego se renovo el token):
    // las tablas dependen del rol.
    //
    // Se compara con rolPintado y NO con el rol al inicio de esta llamada: al
    // cargar la pagina, el arranque y onAuthStateChange entran aqui casi a la
    // vez, ambas ven el rol aun vacio, y la segunda recargaba todo otra vez.
    if (rolPintado !== rolActual()) {
      rolPintado = rolActual();
      await recargarTodo();
    }
    return;
  }
  sesionMontada = true;
  rolPintado = rolActual();   // sincrono, antes del primer await

  try {
    await syncSeqComprobante();
    await recargarTodo();
  } catch (err) {
    // Si la carga falla el usuario veria la app vacia sin saber por que.
    // Se marca como no montada para que un reintento vuelva a cargar.
    sesionMontada = false;
    console.error('[App] Fallo la carga inicial tras iniciar sesion:', err);
    alert('Iniciaste sesion, pero no se pudieron cargar los datos:'
      + String.fromCharCode(10) + (err?.message || err)
      + String.fromCharCode(10) + String.fromCharCode(10)
      + 'Revisa que se hayan ejecutado los archivos de sql/ en Supabase.');
  }
}

function montarControlesSesion() {
  const form = document.getElementById('formLogin');
  const cajaError = document.getElementById('loginError');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnLogin');
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (cajaError) cajaError.hidden = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Entrando...'; }

    try {
      await iniciarSesion(email, password);
      // La carga la dispara observarSesion(); aqui solo se limpia el campo.
      document.getElementById('loginPassword').value = '';
    } catch (err) {
      // Se registra el error crudo: el mensaje traducido puede perder detalle.
      console.error('[Auth] Fallo el inicio de sesion:', err);
      if (cajaError) { cajaError.textContent = mensajeDeError(err); cajaError.hidden = false; }

      // Si parece un fallo de red, se comprueba de verdad si Supabase responde
      // y se anade el resultado, en vez de dejar al usuario adivinando.
      if (err?.name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|load failed/i.test(String(err?.message || ''))) {
        const diagnostico = await probarConexion();
        if (cajaError) cajaError.textContent += ' -- Diagnostico: ' + diagnostico;
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Entrar'; }
    }
  });

  // Diagnostico de conectividad, en pantalla y sin consola.
  document.getElementById('btnProbarConexion')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnProbarConexion');
    const caja = document.getElementById('loginDiagnostico');
    if (!caja) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Probando...'; }
    caja.hidden = false;
    caja.textContent = 'Comprobando...';

    const resultado = await probarConexion();
    const alcanza = resultado.startsWith('Supabase SI responde');

    caja.innerHTML =
      '<div style="color:' + (alcanza ? 'var(--green,#3ba55d)' : 'var(--yellow,#d5a439)') + ';font-weight:600;margin-bottom:5px">'
      + (alcanza ? 'Conexion correcta' : 'Problema de conexion') + '</div>'
      + '<div>' + esc(resultado) + '</div>'
      + (alcanza
          ? '<div style="margin-top:6px;color:var(--text-3,#888)">Si aun no entras, el usuario no existe o su correo no esta confirmado (Supabase - Authentication - Users).</div>'
          : '<div style="margin-top:6px;color:var(--text-3,#888)">Causa habitual: una extension del navegador (bloqueador de anuncios o de rastreo) esta bloqueando la peticion. Prueba en una ventana de incognito con las extensiones desactivadas.</div>');

    if (btn) { btn.disabled = false; btn.textContent = 'Probar conexion de nuevo'; }
  });

  // Reintentar la verificacion del rol desde el aviso de permisos restringidos.
  document.addEventListener('click', async (e) => {
    const boton = e.target.closest('#btnReintentarRol');
    if (!boton) return;
    const { userId } = estadoPerfil();
    if (!userId) return;
    boton.disabled = true;
    boton.textContent = 'Verificando...';
    await cargarPerfil(userId, { forzar: true });
    aplicarPermisos();
    rolPintado = rolActual();
    await recargarTodo();   // las tablas dependen del rol (detalle de asientos)
  });

  // Ver / ocultar la contrasena escrita.
  document.getElementById('btnVerPassword')?.addEventListener('click', () => {
    const campo = document.getElementById('loginPassword');
    const btn = document.getElementById('btnVerPassword');
    if (!campo || !btn) return;
    const visible = campo.type === 'text';
    campo.type = visible ? 'password' : 'text';
    btn.setAttribute('aria-pressed', String(!visible));
    const etiqueta = visible ? 'Mostrar contrasena' : 'Ocultar contrasena';
    btn.setAttribute('aria-label', etiqueta);
    btn.title = etiqueta;
    // styles.css fija display:block en los svg, asi que el atributo `hidden`
    // no los oculta: hay que tocar el estilo en linea.
    const ojo = document.getElementById('iconoOjoAbierto');
    const tachado = document.getElementById('iconoOjoTachado');
    if (ojo) ojo.style.display = visible ? '' : 'none';
    if (tachado) tachado.style.display = visible ? 'none' : '';
    campo.focus();
  });

  document.getElementById('btnCerrarSesion')?.addEventListener('click', async () => {
    try {
      await cerrarSesion();
    } catch (err) {
      console.error('[Auth] No se pudo cerrar sesion:', err);
      alert('No se pudo cerrar sesion: ' + mensajeDeError(err));
      return;
    }
    // Se limpia lo que hubiera quedado en pantalla y en memoria.
    S.asientosSocios = []; S.asientosVentas = []; S.asientosNomina = []; S.asientosOp = [];
    S.socios = []; S.domiciliarios = [];
    CUENTAS.clear();
    location.reload();
  });
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


  // Nada se carga sin sesion. observarSesion() dispara aplicarSesion() tanto
  // al arrancar como en cada login / logout / renovacion de token.
  montarControlesSesion();
  observarSesion(aplicarSesion);
  (async () => { await aplicarSesion(await sesionActual()); })();

  // ══ NAVEGACIÓN ══
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      // Control de acceso. Tambien frena los saltos programaticos: la
      // liquidacion de nomina hace click en Impuestos al terminar.
      if (!puedeVerTab(btn.dataset.tab)) return;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`)?.classList.add('active');
      if (btn.dataset.tab === 'impuestos') { renderLibro(); updateImpuestos(); }
      if (btn.dataset.tab === 'diario') renderDiario();
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

  // Aviso inmediato si el archivo elegido no sirve, sin esperar a guardar.
  ['soporteArchivo', 'soporteArchivoVenta', 'soporteArchivoDom', 'soporteArchivoOp']
    .forEach(id => {
      document.getElementById(id)?.addEventListener('change', function () {
        const archivo = this.files?.[0];
        if (!archivo) return;
        const problema = validarSoporte(archivo);
        if (problema) { alert(problema); this.value = ''; }
      });
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

    // Persistencia en Supabase (cabecera + lineas)
    const guardado = await guardarConFeedback(btn, a, {
      modulo: 'socios', tipo, modalidad, soporte, valor,
      clasificacion: categoriaContable,
    }, S.asientosSocios);
    if (!guardado) return;

    await subirAdjuntoSiHay('soporteArchivo', guardado, btn);

    // La tabla se repinta desde la BD (SELECT con JOIN), no desde memoria.
    await renderSocios();
    recalcularDerivados();

    showAsiento('asientoSocios', 'compSocios', 'asientoBodySocios', a);
    updateKpiSocios();
    updateImpuestos();
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

  document.getElementById('btnGuardarVenta')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnGuardarVenta');
    const tipo = document.getElementById('tipoVenta').value;
    const cliente = document.getElementById('clienteNombre').value.trim();
    const nit = document.getElementById('clienteNit').value.trim();
    const valor = parseFloat(document.getElementById('valorVenta').value) || 0;
    const ivaPct = parseFloat(document.getElementById('ivaVenta').value) || 0;
    const desc = document.getElementById('descVenta').value.trim();
    const fecha = document.getElementById('fechaVenta').value;
    const venc = document.getElementById('vencVenta').value;

    if (!tipo || !cliente || valor <= 0) { alert('Completa tipo, cliente y valor.'); return; }

    const a = asientoVenta(tipo, cliente, valor, ivaPct, desc, fecha);

    const guardado = await guardarConFeedback(btn, a, {
      modulo: 'ventas', tipo, valor, nit, tasa: ivaPct, vencimiento: venc || null,
    }, S.asientosVentas);
    if (!guardado) return;

    await subirAdjuntoSiHay('soporteArchivoVenta', guardado, btn);

    // La tabla se repinta desde la BD (SELECT con JOIN), no desde memoria.
    await renderVentas();
    recalcularDerivados();

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

  document.getElementById('btnProcesarMovDom')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnProcesarMovDom');
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

    const guardado = await guardarConFeedback(btn, a, {
      // En polizas, `vencimiento` guarda el fin de vigencia.
      modulo: 'nomina', tipo, valor, vencimiento: (tipo === 'poliza' && ph) ? ph : null,
    }, S.asientosNomina);

    // asientoMovDom() ya habia movido dom.cxc en memoria; se recalcula siempre
    // desde la BD para que el saldo refleje solo lo realmente persistido.
    if (!guardado) { recalcularDerivados(); renderNomina(); return; }

    await subirAdjuntoSiHay('soporteArchivoDom', guardado, btn);

    await cargarAsientosNomina();
    recalcularDerivados();

    showAsiento('asientoDom', 'compDom', 'asientoBodyDom', a);
    if (a.alerta) showAlerta('alertaDomWrapper', 'alertaDom', a.alerta);
    renderNomina();
    fillDomSel();
    updateImpuestos();
    renderLibro();

    ['valorMovDom', 'descMovDom', 'provMovDom'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });

  // ══ LIQUIDAR PERÍODO (todos) ══
  document.getElementById('btnLiquidarPeriodo')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnLiquidarPeriodo');
    const htmlOriginal = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Liquidando...'; }

    // Cada trabajador genera su propio asiento; si uno falla se revierte solo
    // ese y se sigue con el resto, informando al final cuales quedaron fuera.
    const fallidos = [];
    try {
      for (const dom of S.domiciliarios) {
        const dias = parseInt(document.querySelector('.dias-dom-' + dom.id)?.value ?? S.params.diasPeriodo, 10);
        const liq = calcNomina(dom, dias);
        const a = asientoNomina(liq);
        try {
          await guardarAsientoDB(a, { modulo: 'nomina', tipo: 'liquidacion', valor: a.totD });
        } catch (err) {
          console.error('[Supabase] No se pudo guardar la nomina de', dom.nombre, err);
          S.asientosNomina.pop();
          S.seq--;
          fallidos.push(dom.nombre);
        }
      }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = htmlOriginal; }
    }

    if (fallidos.length) {
      alert('No se pudieron guardar las liquidaciones de:' + String.fromCharCode(10) + fallidos.join(', '));
    }

    await cargarAsientosNomina();
    recalcularDerivados();
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

  document.getElementById('btnSaveModal')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnSaveModal');
    const nombre = document.getElementById('mNombre').value.trim();
    const doc = document.getElementById('mDocumento').value.trim();
    const ing = document.getElementById('mIngreso').value;
    const placa = document.getElementById('mPlaca').value.trim().toUpperCase();
    const tel = document.getElementById('mTelefono').value.trim();
    if (!nombre || !doc) { alert('Nombre y documento son requeridos.'); return; }

    const htmlOriginal = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

    const { error } = await supabase.from('domiciliarios').insert({
      id: siguienteIdDomiciliario(),
      nombre, documento: doc, placa, telefono: tel,
      ingreso: ing || today(),
    });

    if (btn) { btn.disabled = false; btn.innerHTML = htmlOriginal; }

    if (error) {
      console.error('[Supabase] No se pudo crear el domiciliario:', error);
      alert('No se pudo guardar el domiciliario:' + String.fromCharCode(10) + mensajeDeErrorBD(error));
      return;
    }

    await cargarDomiciliarios();
    recalcularDerivados();
    fillDomSel(); renderNomina(); updateImpuestos();
    document.getElementById('modalBg').classList.add('hidden');
    ['mNombre', 'mDocumento', 'mIngreso', 'mPlaca', 'mTelefono'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  });

  // ══ MODAL LIQUIDACIÓN ══
  document.getElementById('liqClose')?.addEventListener('click', () => document.getElementById('modalLiqBg').classList.add('hidden'));
  document.getElementById('liqCancel')?.addEventListener('click', () => document.getElementById('modalLiqBg').classList.add('hidden'));
  document.getElementById('liqConfirm')?.addEventListener('click', async () => {
    if (S.liqActual) {
      const btn = document.getElementById('liqConfirm');
      const a = asientoNomina(S.liqActual);
      const guardado = await guardarConFeedback(btn, a, {
        modulo: 'nomina', tipo: 'liquidacion', valor: a.totD,
      }, S.asientosNomina);
      if (guardado) await cargarAsientosNomina();
      recalcularDerivados();
      renderNomina(); renderLibro(); updateImpuestos();
      if (!guardado) return;
    }
    document.getElementById('modalLiqBg').classList.add('hidden');
    document.querySelector('[data-tab="impuestos"]')?.click();
  });

  // ══ OPERACIÓN / PROVEEDORES ══
  document.getElementById('btnGuardarOp')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnGuardarOp');
    const cat = document.getElementById('catGasto').value;
    const prov = document.getElementById('provOp').value.trim();
    const nit = document.getElementById('nitProv').value.trim();
    const valor = parseFloat(document.getElementById('valorOp').value) || 0;
    const pct = parseFloat(document.getElementById('reteFuente').value) || 0;
    const desc = document.getElementById('descOp').value.trim();
    const nroF = document.getElementById('nroFactOp').value.trim();
    const fecha = document.getElementById('fechaOp').value;

    if (!cat || !prov || valor <= 0) { alert('Completa categoria, proveedor y valor.'); return; }

    const a = asientoOperacion(cat, prov, nit, valor, pct, desc, nroF, fecha);

    const guardado = await guardarConFeedback(btn, a, {
      // `cat` es el tipo de gasto; el numero de factura es su soporte documental.
      modulo: 'operacion', tipo: cat, valor, nit, tasa: pct, soporte: nroF,
    }, S.asientosOp);
    if (!guardado) return;

    await subirAdjuntoSiHay('soporteArchivoOp', guardado, btn);

    // La tabla se repinta desde la BD (SELECT con JOIN), no desde memoria.
    await renderOp();
    recalcularDerivados();

    showAsiento('asientoOp', 'compOp', 'asientoBodyOp', a);
    updateKpiOp();
    updateImpuestos();
    renderLibro();

    ['catGasto', 'provOp', 'nitProv', 'valorOp', 'reteFuente', 'descOp', 'nroFactOp'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('retePreview')?.classList.add('hidden');
  });

  // ══ DOCUMENTOS SOPORTE ══
  // Delegado en document: las filas de las tablas se repintan en cada carga.
  document.addEventListener('click', async (e) => {
    const boton = e.target.closest('.ver-soporte');
    if (!boton) return;
    e.preventDefault();

    const texto = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Generando enlace...';

    const res = await urlDeSoporte(boton.dataset.ruta);

    boton.disabled = false;
    boton.textContent = texto;

    if (!res.ok) { alert('No se pudo abrir el documento: ' + res.error); return; }
    window.open(res.url, '_blank', 'noopener');
  });

  // ══ LIBRO DIARIO ══
  {
    const rango = rangoMesActual();
    const dDesde = document.getElementById('diarioDesde');
    const dHasta = document.getElementById('diarioHasta');
    if (dDesde && !dDesde.value) dDesde.value = rango.desde;
    if (dHasta && !dHasta.value) dHasta.value = rango.hasta;
  }
  document.getElementById('btnConsultarDiario')?.addEventListener('click', renderDiario);
  document.getElementById('btnExportDiario')?.addEventListener('click', exportarDiario);
  ['diarioDesde', 'diarioHasta', 'diarioModulo'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', renderDiario);
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
