# Guía del operador: muse-node + ISySentinel

`muse-node` deja que Muse (desde la PC o desde el celular) use tu computadora
Linux. Nada pasa sin tu autoridad: **Muse pide → ISySentinel decide → el
daemon ejecuta → tú conservas el control.** Es el mismo contrato que ISyCode
(Workspace Authority + IsySentinel + aprobaciones de un solo uso).

## Cómo decide

| Situación | Qué pasa |
|---|---|
| Leer/listar/buscar en una carpeta que **tú permitiste** | Se hace sin preguntar |
| Leer fuera de tus carpetas permitidas | Te sale un diálogo; un "Permitir" vale **solo para esa petición** |
| Escribir, crear carpetas, ejecutar comandos | **Siempre** pregunta, aunque la carpeta esté permitida |
| Llaves y credenciales (`~/.ssh`, `~/.gnupg`, `~/.aws`, keyrings, sesiones de navegador, credenciales de Muse/gh/Claude…) | **Negado siempre**, aunque digas que sí, también a través de symlinks |
| Fuera de tu `$HOME` | Negado sin preguntar |
| Algo que revocaste | Negado sin preguntar |
| Nodo bloqueado (`lock`) | Todo negado excepto `ping` |

El diálogo trae **Rechazar** por defecto: Enter, cerrar la ventana o dejar
pasar 110 s = rechazo. Cada diálogo muestra la *huella* de la petición: tu
"sí" vale para esa petición exacta (mismos argumentos, mismo archivo). Si el
archivo cambia entre tu "sí" y la escritura, se cancela y Muse tiene que
volver a pedirlo.

## Comandos

```bash
M="$HOME/Development/ISyCo Git/lAInux.muse/apps/muse/daemon/bin/muse-node"

"$M" status                       # estado del nodo: READY / DEGRADED / RECONNECTING…
"$M" policy                       # qué permisos tienes dados
"$M" grant read ~/Documents       # leer/listar/buscar ahí sin preguntar
"$M" grant read ~/Development     # puedes dar varias carpetas
"$M" grant which                  # system.which sin preguntar
"$M" revoke read                  # quita el permiso (efecto inmediato)
"$M" lock                         # BOTÓN DE PÁNICO: niega todo menos ping
"$M" unlock
"$M" receipts 20                  # últimas 20 decisiones (DENY / EXECUTE / RETURN)
"$M" receipts --verify            # comprueba que nadie editó el historial
```

`grant write` y `grant shell` existen, pero **no** quitan la pregunta: solo
limitan en qué carpetas se puede pedir.

## Dónde vive cada cosa

| Qué | Dónde |
|---|---|
| Permisos (solo tú los cambias) | `~/.local/state/lainux-mods/workspace-authority/grants-*.json` (0600) |
| Recibos encadenados por hash | `~/.local/state/lainux-mods/receipts/muse-node.jsonl` |
| Estado de conexión | `~/.local/state/muse-node/status.json` |
| Log del servicio | `journalctl --user -u muse-node.service -f` |

Muse no puede leer ni escribir estas rutas: están protegidas para que ningún
modelo pueda darse permisos a sí mismo. Los recibos guardan la ruta, la
decisión y un hash del resultado; **no** guardan el contenido de archivos ni
la salida de comandos (los comandos van como hash + vista previa recortada).

## Aprobar desde el celular (Telegram)

Las aprobaciones llegan **a la vez** al diálogo de la PC y a tu chat privado
con tu bot de Telegram; vale la primera respuesta (un «Rechazar» es tan
definitivo como un «Permitir»). Sin respuesta en 110 s = rechazado.

Vincular (una vez, en tu terminal):

1. En Telegram, abre **@BotFather**, envía `/newbot` y copia el token.
2. `muse-node telegram pair` → pega el token (no se ve; va al keyring, no a
   un archivo) → envía al bot el `/pair <pin>` que te muestra → confirma que
   es tu cuenta.
3. `systemctl --user restart muse-node.service`

Probar sin ejecutar nada: para el daemon y corre `muse-node telegram test`.
Otros: `muse-node telegram status` · `muse-node telegram unpair`.

Por qué no por el chat de Muse ni WhatsApp: esos mensajes los lee el modelo,
y lo que el modelo diga no puede contar como tu permiso. El bot solo hace
caso a tu usuario en tu chat privado; cada botón vale una sola vez, para esa
petición exacta (su huella) y caduca. Telegram ve la vista previa de la
petición; los textos con pinta de secreto se ocultan antes de enviarla.

En el chat del bot:

| Mensaje | Qué hace |
|---|---|
| `/estado` | En línea, bloqueo, Flow y peticiones pendientes |
| `/flow 30` · `/flow 2h` | Flow de escritura por ese tiempo |
| `/flow 30 terminal` | Flow que también cubre comandos (ver aviso) |
| `/flow off` | Volver a pedir permiso |
| `/bloquear` | Pánico: todo se niega salvo ping. **Desbloquear solo en la PC** (`muse-node unlock`) |

## Modo Flow (no pedir permiso un rato)

`muse-node flow on 30m` (o `2h`, máx. 8 h) · `muse-node flow off` ·
`muse-node flow status` · o el botón **⚡ Permitir + Flow 30 min**.

- Solo se salta la pregunta **dentro de carpetas ya autorizadas**:
  `muse-node grant write ~/Documents` (y `grant shell <carpeta>` para comandos).
  Fuera de ellas sigue preguntando; `~/.ssh`, credenciales y el estado de
  muse-node siguen negados siempre.
- Por defecto cubre escribir archivos y crear carpetas. Los comandos solo con
  `flow on 30m --shell` o `/flow 30 terminal`. **Aviso:** un comando corre
  con todo tu poder de usuario, así que en Flow de terminal el modelo podría
  hacer cualquier cosa que tú puedas (incluso alargar Flow). Úsalo corto.
- Cada acción en Flow deja recibo con `approval: "flow"` y te avisa por
  Telegram (`⚡ Flow: …`). Caduca solo.

## Comandos de shell

Se ejecutan con `bash --noprofile --norc` y un entorno mínimo (PATH, HOME,
idioma): tus tokens y variables secretas de la sesión **no** llegan al
comando. Al terminar o agotar el tiempo se mata el grupo de procesos entero,
también lo que haya quedado en segundo plano.

## Si algo falla

- `status` dice `DEGRADED`/`RECONNECTING`: el daemon se está recuperando solo.
  Mira `last_error` en `status`.
- Muse dice `permission_denied`: mira `receipts 5`; el campo `failed` explica
  qué verificación lo negó.
- Probar la reconexión a propósito:
  `systemctl --user kill --kill-whom=main -s SIGUSR2 muse-node.service`
