// ─────────────────────────────────────────────────────────────────────────────
// SEED · Catálogo de cuentas (plan_cuentas) — Contabilidad ATL
// ─────────────────────────────────────────────────────────────────────────────
// Puebla la tabla `plan_cuentas` en Supabase con el PUC base del negocio.
//
// Es idempotente: usa upsert sobre `codigo`, así que se puede reejecutar sin
// duplicar filas (actualiza nombre / naturaleza / nivel si cambiaron).
//
// ⚠ NO está conectado a la app. El botón y el comando de consola se retiraron
// tras poblar el catálogo, para que este código no viaje al bundle de
// producción ni quede invocable por nadie que abra la consola del navegador.
//
// Para reejecutarlo cuando cambie el catálogo (añadir cuentas, renumerar):
//   1. En app.js, añadir temporalmente:
//        import { seedCuentas } from './seedCuentas.js';
//        Object.assign(window, { seedCuentas });
//   2. npm run dev  →  en la consola del navegador:
//        await seedCuentas()                              // altas y cambios
//        await seedCuentas({ eliminarObsoletas: true })   // tras renumerar
//   3. Deshacer el paso 1 antes de publicar.
//
// RENUMERAR UNA CUENTA (tras sql/007, con clave foranea activa):
//   NO se hace borrando la vieja e insertando la nueva: la base rechaza el
//   borrado de una cuenta con movimientos. Se hace con un UPDATE, que gracias
//   a `on update cascade` arrastra los asientos existentes al codigo nuevo:
//
//     update public.plan_cuentas set codigo = '1705' where codigo = '1620';
//
//   Despues se actualiza el array de abajo y se reejecuta el seed.
//
// Jerarquía por nivel:
//   1 = Clase   (1 dígito)   2 = Grupo (2 dígitos)   3 = Cuenta (4 dígitos)
// Solo las cuentas de nivel 3 son `es_cuenta_detalle` (admiten movimiento).
import { supabase } from './supabase.js';

const D = 'DEBITO';
const C = 'CREDITO';

/** Clase (nivel 1) o Grupo (nivel 2): agrupadores, no reciben movimiento. */
const grupo = (codigo, nombre, naturaleza) => ({
  codigo, nombre, naturaleza,
  nivel: codigo.length === 1 ? 1 : 2,
  es_cuenta_detalle: false,
});

/** Cuenta de detalle (nivel 3): admite débitos y créditos. */
const cuenta = (codigo, nombre, naturaleza) => ({
  codigo, nombre, naturaleza,
  nivel: 3,
  es_cuenta_detalle: true,
});

export const PLAN_CUENTAS = [
  // ══ CLASE 1 · ACTIVO ══════════════════════════════════════════════════════
  grupo('1', 'Activo', D),
  grupo('11', 'Disponible', D),
  cuenta('1105', 'Caja', D),
  cuenta('1110', 'Bancos', D),

  grupo('13', 'Deudores', D),
  cuenta('1305', 'Clientes (Deudores comerciales)', D),
  cuenta('1325', 'Cuentas por cobrar a socios', D),
  cuenta('1455', 'Cuentas por cobrar – Empleados', D),

  grupo('14', 'Inventarios', D),
  cuenta('1435', 'Mercancías no fabricadas por la empresa', D),

  grupo('17', 'Diferidos', D),
  cuenta('1705', 'Seguros pagados por anticipado', D),

  // ══ CLASE 2 · PASIVO ══════════════════════════════════════════════════════
  grupo('2', 'Pasivo', C),
  grupo('22', 'Proveedores', C),
  cuenta('2205', 'Proveedores nacionales', C),

  grupo('23', 'Cuentas por pagar', C),
  cuenta('2305', 'Nómina por pagar', C),
  cuenta('2370', 'Retención en la fuente por pagar', C),
  cuenta('2380', 'Aportes seguridad social por pagar', C),
  cuenta('2390', 'Cuentas por pagar a socios', C),
  cuenta('2396', 'Préstamos de socios – Pasivo financiero', C),

  grupo('24', 'Impuestos, gravámenes y tasas', C),
  cuenta('2404', 'Impuesto de renta y complementarios', C),
  cuenta('2408', 'IVA generado por pagar', C),

  grupo('26', 'Pasivos estimados y provisiones', C),
  cuenta('2610', 'Cesantías por pagar', C),
  cuenta('2615', 'Intereses sobre cesantías por pagar', C),
  cuenta('2630', 'Prima de servicios por pagar', C),
  cuenta('2640', 'Vacaciones por pagar', C),

  // ══ CLASE 3 · PATRIMONIO ══════════════════════════════════════════════════
  grupo('3', 'Patrimonio', C),
  grupo('31', 'Capital social', C),
  cuenta('3105', 'Capital suscrito y pagado', C),
  cuenta('3120', 'Capital por capitalizar (inversiones transitorio)', C),

  grupo('33', 'Reservas', C),
  cuenta('3305', 'Reservas de capital', C),

  grupo('36', 'Resultados del ejercicio', C),
  cuenta('3610', 'Utilidades del ejercicio', C),

  grupo('37', 'Resultados de ejercicios anteriores', C),
  cuenta('3705', 'Utilidades acumuladas de ejercicios anteriores', C),

  // ══ CLASE 4 · INGRESOS ════════════════════════════════════════════════════
  grupo('4', 'Ingresos', C),
  grupo('41', 'Operacionales', C),
  cuenta('4135', 'Ingresos – Servicios logísticos', C),

  // ══ CLASE 5 · GASTOS ══════════════════════════════════════════════════════
  grupo('5', 'Gastos', D),
  grupo('51', 'Operacionales de administración', D),
  cuenta('5105', 'Gastos personal – Salarios', D),
  cuenta('5110', 'Gastos personal – Aux. transporte', D),
  cuenta('5115', 'Gastos personal – Aux. rodamiento (no salarial)', D),
  cuenta('5120', 'Gastos personal – Dotación obligatoria', D),
  cuenta('5135', 'Provisión cesantías', D),
  cuenta('5136', 'Provisión intereses cesantías', D),
  cuenta('5137', 'Provisión prima de servicios', D),
  cuenta('5138', 'Provisión vacaciones', D),
  cuenta('5140', 'Aportes seguridad social – empresa', D),
  cuenta('5150', 'Gastos generales – pólizas y seguros', D),
  cuenta('5195', 'Gastos generales – honorarios', D),
  cuenta('5199', 'Gastos generales – otros', D),

  grupo('53', 'No operacionales', D),
  cuenta('5395', 'Gastos no deducibles – multas (Art. 89 E.T.)', D),
];

/**
 * Revisa el array antes de tocar la red: códigos duplicados, naturaleza
 * inválida o nivel que no concuerda con la longitud del código.
 * Devuelve un array de mensajes (vacío = todo correcto).
 */
export function validarPlanCuentas(filas = PLAN_CUENTAS) {
  const problemas = [];
  const vistos = new Set();
  const largoEsperado = { 1: 1, 2: 2, 3: 4, 4: 6 };

  for (const f of filas) {
    if (vistos.has(f.codigo)) problemas.push(`Código duplicado: ${f.codigo}`);
    vistos.add(f.codigo);

    if (f.naturaleza !== D && f.naturaleza !== C) {
      problemas.push(`${f.codigo}: naturaleza inválida "${f.naturaleza}"`);
    }
    const esperado = largoEsperado[f.nivel];
    if (esperado && f.codigo.length !== esperado) {
      problemas.push(`${f.codigo}: nivel ${f.nivel} implica ${esperado} dígitos, tiene ${f.codigo.length}`);
    }
    if (f.nivel < 3 && f.es_cuenta_detalle) {
      problemas.push(`${f.codigo}: clase/grupo no puede ser cuenta de detalle`);
    }
  }
  return problemas;
}

/**
 * Puebla `plan_cuentas` recorriendo el catálogo por lotes.
 *
 * Se envía en lotes en vez de una fila por llamada porque son ~60 cuentas:
 * de a una serían ~60 viajes de red secuenciales. `upsert` acepta el array
 * completo y resuelve el lote en una sola petición.
 *
 * @returns {Promise<{total:number, escritas:number, errores:string[]}>}
 */
export async function seedCuentas({ lote = 25, silencioso = false, eliminarObsoletas = false } = {}) {
  const log = (...a) => { if (!silencioso) console.log('[seed]', ...a); };

  const problemas = validarPlanCuentas();
  if (problemas.length) {
    console.error('[seed] El catálogo tiene inconsistencias, no se envía nada:', problemas);
    return { total: PLAN_CUENTAS.length, escritas: 0, errores: problemas };
  }

  const total = PLAN_CUENTAS.length;
  const errores = [];
  let escritas = 0;

  log(`Poblando plan_cuentas: ${total} cuentas en lotes de ${lote}…`);

  for (let i = 0; i < total; i += lote) {
    const bloque = PLAN_CUENTAS.slice(i, i + lote);
    const { data, error } = await supabase
      .from('plan_cuentas')
      .upsert(bloque, { onConflict: 'codigo' })
      .select('codigo');

    if (error) {
      const msg = 'Lote ' + i + '-' + (i + bloque.length - 1) + ': ' + error.message;
      console.error('[seed]', msg, error);
      errores.push(msg);
    } else {
      escritas += data.length;
      log('  lote ' + i + '-' + (i + bloque.length - 1) + ' -> ' + data.length + ' cuentas');
    }
  }

  // Borrado de codigos que ya no estan en el catalogo. El upsert nunca elimina,
  // asi que al renumerar una cuenta (p. ej. 1620 -> 1705) la fila vieja
  // quedaria huerfana en la BD. Va desactivado por defecto porque es
  // destructivo: borraria tambien cualquier cuenta creada a mano fuera de
  // PLAN_CUENTAS. Activarlo solo tras un cambio de codificacion.
  let eliminadas = [];
  if (eliminarObsoletas && !errores.length) {
    const vigentes = new Set(PLAN_CUENTAS.map(f => f.codigo));
    const { data: enBD, error: errLeer } = await supabase
      .from('plan_cuentas')
      .select('codigo');

    if (errLeer) {
      errores.push('No se pudo leer el catalogo para depurar: ' + errLeer.message);
    } else {
      const sobran = enBD.map(f => f.codigo).filter(c => !vigentes.has(c));
      if (sobran.length) {
        const { error: errBorrar } = await supabase
          .from('plan_cuentas')
          .delete()
          .in('codigo', sobran);

        if (errBorrar) {
          // 23503 = clave foranea: alguna de esas cuentas tiene movimientos.
          // Es la proteccion de sql/007 funcionando, no un fallo del seed.
          const msg = errBorrar.code === '23503'
            ? 'No se pudieron borrar ' + sobran.join(', ') + ': al menos una tiene '
              + 'movimientos registrados. Si la estas renumerando, hazlo con '
              + "UPDATE plan_cuentas SET codigo='NUEVO' WHERE codigo='VIEJO' "
              + '(los asientos siguen al codigo nuevo por cascada).'
            : 'No se pudieron borrar obsoletas: ' + errBorrar.message;
          console.error('[seed]', msg);
          errores.push(msg);
        }
        else { eliminadas = sobran; log('Eliminadas ' + sobran.length + ' obsoletas: ' + sobran.join(', ')); }
      } else {
        log('Sin cuentas obsoletas que eliminar.');
      }
    }
  }

  const resumen = { total, escritas, eliminadas, errores };
  if (errores.length) console.error('[seed] Termino con errores:', resumen);
  else log('Listo: ' + escritas + '/' + total + ' cuentas en plan_cuentas.');

  return resumen;
}

export default seedCuentas;
