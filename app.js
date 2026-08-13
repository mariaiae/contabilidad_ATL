/* ═══════════════════════════════════════════════════════════════════════
   Contabilidad ATL · Motor Contable — Módulo Completo 5 Tabs
   PUC Colombiano · Nómina · Socios · Ventas · Proveedores · Impuestos
   ═══════════════════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. PUC — Plan Único de Cuentas (relevantes para el módulo)
// ─────────────────────────────────────────────────────────────────────────────
const PUC = {
  '1105': 'Caja',
  '1110': 'Bancos',
  '1305': 'Clientes (Deudores Comerciales)',
  '1455': 'Cuentas por Cobrar – Empleados',
  '1620': 'Seguros Pagados por Anticipado',
  '2305': 'Nómina por Pagar',
  '2370': 'Retención en la Fuente por Pagar',
  '2380': 'Aportes Seguridad Social por Pagar',
  '2408': 'IVA Generado por Pagar',
  '2610': 'Cesantías por Pagar',
  '2615': 'Intereses Cesantías por Pagar',
  '2630': 'Prima de Servicios por Pagar',
  '2640': 'Vacaciones por Pagar',
  '3105': 'Capital Social – Aportes',
  '3305': 'Reservas de Capital',
  '3610': 'Utilidades del Ejercicio',
  '4135': 'Ingresos – Servicios Logísticos',
  '5105': 'Gastos Personal – Salarios',
  '5110': 'Gastos Personal – Aux. Transporte',
  '5115': 'Gastos Personal – Aux. Rodamiento (No salarial)',
  '5120': 'Gastos Personal – Dotación Obligatoria',
  '5135': 'Provisión Cesantías',
  '5136': 'Provisión Int. Cesantías',
  '5137': 'Provisión Prima de Servicios',
  '5138': 'Provisión Vacaciones',
  '5140': 'Aportes Seguridad Social – Empresa',
  '5150': 'Gastos Generales – Pólizas y Seguros',
  '5195': 'Gastos Generales – Honorarios',
  '5199': 'Gastos Generales – Otros',
  '5899': 'Gastos No Deducibles – Multas (Art. 89 E.T.)',
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  params: { smlv: 1423500, auxTransporte: 200000, auxRodamiento: 300000, diasPeriodo: 30 },

  domiciliarios: [
    { id: 'D001', nombre: 'Carlos Andrés Ríos', doc: '1.023.456.789', placa: 'BZK-14A', tel: '314 678 9012', ingreso: '2025-03-01', cxc: 0 },
    { id: 'D002', nombre: 'Jhon Fredy Cardona', doc: '98.345.678', placa: 'MSP-22C', tel: '316 234 5678', ingreso: '2025-05-15', cxc: 0 },
    { id: 'D003', nombre: 'Luz Marina Ospina', doc: '43.567.890', placa: 'KLT-55B', tel: '310 987 6543', ingreso: '2025-07-01', cxc: 0 },
    { id: 'D004', nombre: 'Rodrigo Estrada Gil', doc: '71.234.567', placa: 'NAP-88D', tel: '312 456 7890', ingreso: '2024-11-01', cxc: 0 },
  ],

  socios: [
    { id: 'S001', nombre: 'Socio 1' },
    { id: 'S002', nombre: 'Socio 2' },
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

/** Asiento genérico: array de { cuenta, desc, debito, credito } */
function buildAsiento({ comp, fecha, modulo, chip, nombre, desc, lineas }) {
  const totD = lineas.reduce((a, l) => a + l.debito, 0);
  const totC = lineas.reduce((a, l) => a + l.credito, 0);
  return { comp, fecha: fecha || today(), modulo, chip, nombre, desc, lineas, totD, totC };
}

function asientoSocio(tipo, socio, valor, desc, fecha) {
  const comp = nextComp('SOC');
  let lineas = [];
  let chip = 'chip-socio';

  switch (tipo) {
    case 'aporte':
      lineas = [
        { cuenta: '1110', desc: `Aporte capital – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '3105', desc: `Capital social – ${socio.nombre}`, debito: 0, credito: valor },
      ]; break;
    case 'gasto_socio':
      lineas = [
        { cuenta: '5199', desc: `Gasto pagado por socio – ${desc}`, debito: valor, credito: 0 },
        { cuenta: '2305', desc: `Reembolso pendiente a ${socio.nombre}`, debito: 0, credito: valor },
      ]; break;
    case 'inversion':
      lineas = [
        { cuenta: '1110', desc: `Inversión socio – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '3305', desc: `Reserva inversión – ${socio.nombre}`, debito: 0, credito: valor },
      ]; break;
    case 'retiro':
      chip = 'chip-cxc';
      lineas = [
        { cuenta: '3610', desc: `Retiro utilidades – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago retiro socio`, debito: 0, credito: valor },
      ]; break;
    case 'prestamo_socio':
      lineas = [
        { cuenta: '1110', desc: `Préstamo socio – ${socio.nombre}`, debito: valor, credito: 0 },
        { cuenta: '2305', desc: `Pasivo préstamo socio`, debito: 0, credito: valor },
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
        clase: 'alerta-success', titulo: '✅ Gasto Deducible — Dotación Obligatoria',
        texto: `Casco, impermeable y uniforme se reconocen como <strong>gasto operativo deducible</strong> en cuenta 5120. Cumple Art. 107 E.T.`
      };
      break;
    case 'poliza': {
      chip = 'chip-poliza';
      const dias = polizaDesde && polizaHasta
        ? Math.round((new Date(polizaHasta) - new Date(polizaDesde)) / 86400000) : 30;
      const esAnticipado = dias > 30;
      const cuenta = esAnticipado ? '1620' : '5150';
      lineas = [
        { cuenta, desc: `${esAnticipado ? 'Seguro anticipado' : 'Póliza'} – ${desc} – ${dom?.nombre || 'Empresa'}`, debito: valor, credito: 0 },
        { cuenta: '1110', desc: `Pago póliza: ${prov || 'Aseguradora'}`, debito: 0, credito: valor },
      ];
      alerta = {
        clase: 'alerta-info', titulo: esAnticipado ? '🔵 Póliza → Gasto Pagado por Anticipado' : '🔵 Póliza → Gasto del Período',
        texto: esAnticipado
          ? `Vigencia <strong>${dias} días</strong>. Registrado en <strong>1620 – Seguros Pagados por Anticipado</strong>. Se amortizará mensualmente.`
          : `Póliza dentro del período. Registrado en <strong>5150 – Gastos Seguros</strong>. Deducible (Art. 107 E.T.).`
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
    { cuenta: '5110', desc: `Aux. Transporte – ${d.nombre}`, debito: liq.transp, credito: 0 },
    { cuenta: '5115', desc: `Rodamiento (no salarial) – ${d.nombre}`, debito: liq.rodamiento, credito: 0 },
    { cuenta: '5135', desc: `Prov. Cesantías – ${d.nombre}`, debito: liq.cesantias, credito: 0 },
    { cuenta: '5136', desc: `Prov. Int. Ces. – ${d.nombre}`, debito: liq.intCes, credito: 0 },
    { cuenta: '5137', desc: `Prov. Prima – ${d.nombre}`, debito: liq.prima, credito: 0 },
    { cuenta: '5138', desc: `Prov. Vacaciones – ${d.nombre}`, debito: liq.vacaciones, credito: 0 },
    { cuenta: '5140', desc: `Aportes SS empresa – ${d.nombre}`, debito: liq.ssEmpresa, credito: 0 },
    { cuenta: '2305', desc: `Neto a pagar – ${d.nombre}`, debito: 0, credito: liq.neto },
    { cuenta: '2380', desc: `SS empleado – ${d.nombre}`, debito: 0, credito: liq.saludEmp + liq.pensionEmp },
    { cuenta: '1455', desc: `Descuento CxC – ${d.nombre}`, debito: 0, credito: liq.descCxC },
    { cuenta: '2610', desc: `Prov. Ces. – ${d.nombre}`, debito: 0, credito: liq.cesantias },
    { cuenta: '2615', desc: `Prov. Int.Ces. – ${d.nombre}`, debito: 0, credito: liq.intCes },
    { cuenta: '2630', desc: `Prov. Prima – ${d.nombre}`, debito: 0, credito: liq.prima },
    { cuenta: '2640', desc: `Prov. Vac. – ${d.nombre}`, debito: 0, credito: liq.vacaciones },
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
    return `
      <tr>
        <td class="cuenta-col${isCredito ? ' indented' : ''}">${l.cuenta}</td>
        <td class="desc-col${isCredito ? ' indented' : ''}">${PUC[l.cuenta] || l.cuenta} — ${l.desc}</td>
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
  const aportes = S.asientosSocios.filter(a => a.desc === 'aporte' || a.desc?.includes('aporte') || true)
    .filter(a => ['aporte', 'inversion', 'prestamo_socio'].includes(
      S.asientosSocios.find(x => x.comp === a.comp)?.desc || ''
    )).reduce((s, a) => s + a.totD, 0);

  let ap = 0, ret = 0, gso = 0;
  S.asientosSocios.forEach(a => {
    // simple sum por lineas
    a.lineas.forEach(l => {
      if (l.cuenta === '3105' || l.cuenta === '3305') ap += l.credito;
      if (l.cuenta === '3610') ret += l.debito;
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
  const csv = [['Comprobante', 'Fecha', 'Módulo', 'Tercero', 'Descripción', 'Cuenta', 'Nombre Cuenta', 'Débito', 'Crédito'].join(','),
  ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `ContabilidadATL_${today()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. INICIALIZACIÓN Y EVENT LISTENERS
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
  document.getElementById('btnNuevoSocio')?.addEventListener('click', () => {
    const el = document.getElementById('formSocioWrap');
    el?.scrollIntoView({ behavior: 'smooth' });
    document.getElementById('valorSocio')?.focus();
  });

  document.getElementById('btnGuardarSocio')?.addEventListener('click', () => {
    const tipo = document.getElementById('tipoSocio').value;
    const socioId = document.getElementById('socioNombre').value;
    const valor = parseFloat(document.getElementById('valorSocio').value) || 0;
    const desc = document.getElementById('descSocio').value.trim();
    const soporte = document.getElementById('soporteSocio').value.trim();
    const fecha = document.getElementById('fechaSocio').value;

    if (!tipo || !socioId || valor <= 0) { alert('Completa tipo, socio y valor.'); return; }

    const socio = S.socios.find(s => s.id === socioId) || { id: 'ext', nombre: socioId };
    const a = asientoSocio(tipo, socio, valor, desc, fecha);

    const tipoLabels = {
      aporte: 'Aporte Capital', gasto_socio: 'Gasto x Socio',
      inversion: 'Inversión', retiro: 'Retiro', prestamo_socio: 'Préstamo Socio'
    };

    addTableRow('bodySocios', `
      <td>${fmtDate(fecha)}</td>
      <td>${socio.nombre}</td>
      <td><span class="chip chip-socio">${tipoLabels[tipo] || tipo}</span></td>
      <td style="color:var(--text-2);font-size:12.5px">${desc || '—'}</td>
      <td class="text-right mono-cell">${fmt(valor)}</td>
      <td><span class="mono-cell" style="font-size:11px;color:var(--accent)">${a.comp}</span></td>
    `, 'countSocios');

    showAsiento('asientoSocios', 'compSocios', 'asientoBodySocios', a);
    updateKpiSocios();
    renderLibro();

    // Reset
    ['tipoSocio', 'socioNombre', 'valorSocio', 'descSocio', 'soporteSocio'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
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

    const tipoLabels = { factura: 'Factura Venta', cobro: 'Cobro Cartera', nota_credito: 'Nota Crédito', anticipo_cliente: 'Anticipo' };
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
    document.getElementById('modalTitle').textContent = 'Agregar Domiciliario';
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
