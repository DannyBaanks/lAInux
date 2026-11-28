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
