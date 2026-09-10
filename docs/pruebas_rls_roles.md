# Pruebas de seguridad por roles (RLS)

Cómo comprobar que la base de datos, y no solo la interfaz, impide que un usuario
`comercial` lea el detalle contable o toque la configuración, incluso si lo intenta
desde la consola del navegador.

## Qué debe cumplirse

| Tabla | auditor | comercial |
|---|---|---|
| `asientos` (cabeceras) | Todo | Leer y crear. Editar: solo adjuntar el soporte a un asiento que no lo tiene. Borrar: solo una cabecera sin líneas |
| `asiento_detalles` (líneas) | Todo | Solo crear, y solo en un asiento sin líneas. **No puede leerlas** |
| `plan_cuentas` | Todo | Nada, ni leer |
| `socios`, `domiciliarios` | Todo | Solo leer |
| `profiles` | Leer todos y cambiar roles | Leer el suyo |
| Storage `soportes` | Todo | Subir; leer y retirar solo lo que subió |
| `metricas_asientos()` | Sí | Sí: solo cifras agregadas, sin líneas |

## 1. Preparación

1. Ejecuta `sql/009_rls_por_roles.sql` en el SQL Editor. Requiere `sql/008`.
2. Crea el usuario de prueba en **Authentication → Users → Add user → Create new user**
   con correo y contraseña, y marca **Auto Confirm User**.
3. Escribe ese correo en la primera línea de `sql/prueba_usuario_comercial.sql` y
   ejecútalo. Debe listar al administrador como `auditor` y al de prueba como
   `comercial` con `correo_confirmado = true`.

## 2. Iniciar sesión como comercial

Abre la app (`http://localhost:5173`) e inicia sesión con el usuario de prueba. La
barra lateral debe decir **COMERCIAL**.

Iniciar sesión con otro usuario reemplaza la sesión del auditor en ese navegador:
para volver a auditor, cierra sesión y entra con la cuenta administradora.

## 3. Prueba desde la consola

1. Con la app abierta, pulsa **F12 → Console**. Tiene que ser la pestaña de la app,
   no la del Dashboard de Supabase.
2. Si Chrome pide confirmación para pegar código, escribe `allow pasting` y pulsa Enter.
3. Pega y ejecuta:

```js
const { supabase: s } = await import('/supabase.js');
const uid = (await s.auth.getUser()).data.user.id;
// Registro de prueba con líneas. Si la protección fallara, solo se alteraría este.
const objetivo = (await s.from('asientos').select('id, descripcion').eq('comprobante', 'SOC-00006').single()).data;
const r = {};
r['1. Rol en la base']              = (await s.rpc('get_user_role')).data;
r['2. Leer líneas de asientos']     = (await s.from('asiento_detalles').select('*')).data?.length;
r['3. Leer plan de cuentas']        = (await s.from('plan_cuentas').select('*')).data?.length;
r['4. Escribir plan de cuentas']    = (await s.from('plan_cuentas').update({ nombre: 'Bancos' }).eq('codigo', '1110').select()).data?.length;
r['5. Ascenderse a auditor']        = (await s.from('profiles').update({ role: 'auditor' }).eq('id', uid).select()).data?.length;
const edicion = await s.from('asientos').update({ descripcion: objetivo.descripcion + ' (editado)' }).eq('id', objetivo.id).select();
r['6. Editar un asiento']           = edicion.error ? 'rechazado ' + edicion.error.code : edicion.data.length;
r['7. Borrar asiento con líneas']   = (await s.from('asientos').delete().eq('id', objetivo.id).select()).data?.length;
r['8. Cifras agregadas (permitido)'] = (await s.rpc('metricas_asientos', { p_modulo: 'ventas' })).data?.length;
console.table(r);
```

`import('/supabase.js')` solo existe con el servidor de desarrollo (`npm run dev`).

## 4. Resultado esperado

| Prueba | Esperado | Por qué |
|---|---|---|
| 1. Rol en la base | `comercial` | La base identifica el rol por el token, no por lo que diga la app |
| 2. Leer líneas | `0` | RLS filtra todas las filas: no hay error, simplemente no devuelve nada |
| 3. Leer plan de cuentas | `0` | Igual que el anterior |
| 4. Escribir plan de cuentas | `0` | La actualización no alcanza ninguna fila |
| 5. Ascenderse a auditor | `0` | Solo un auditor cambia roles |
| 6. Editar un asiento | `rechazado 42501` | El trigger solo permite adjuntar el soporte |
| 7. Borrar asiento con líneas | `0` | Solo se pueden borrar cabeceras sin líneas |
| 8. Cifras agregadas | `1` o más | Es la vía permitida: totales, sin líneas |

Si en las pruebas 2 a 7 aparece un número mayor que `0`, esa protección **no** está
activa: revisa que `sql/009` terminara sin errores.

Con la sesión del auditor, las pruebas 2, 3 y 7 devuelven valores mayores que `0`:
es correcto, porque el auditor tiene acceso total.

## Qué no cubre

- El comercial ve las **cabeceras** de todos los asientos: fecha, tercero, tipo y valor.
- `metricas_asientos()` entrega cifras por asiento. En asientos sencillos de dos o tres
  líneas se acercan mucho al detalle, aunque sin cuentas ni descripciones.
- La base **no valida que un asiento cuadre**. La app siempre genera débitos iguales a
  créditos, pero alguien que inserte líneas a mano desde la consola en un asiento
  nuevo podría dejarlo descuadrado.
