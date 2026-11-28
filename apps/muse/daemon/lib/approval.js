'use strict';

// Human-in-the-loop gate for commands that change this computer (files.write,
// files.mkdir, shell.exec). Muse asks; the person at the Linux desktop decides
// in a native zenity dialog. No display, no zenity, timeout or close => deny.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

const PREVIEW_CHARS = 600;
// ask-dialog.js: the same zenity question, but it hands the keyboard focus
// back to the operator's window as soon as the dialog appears, so only a
// mouse click can answer it. Used only when xdotool is installed.
const ASK_DIALOG = path.join(__dirname, 'ask-dialog.js');

function preview(text, limit = PREVIEW_CHARS) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} caracteres más)` : value;
}

function describe({ command_id: commandId, params = {}, action_id: actionId, target }) {
  if (actionId && ['workspace.files.list', 'workspace.files.read', 'workspace.files.search', 'node.system.which'].includes(actionId)) {
    const verb = { 'workspace.files.list': 'listar la carpeta', 'workspace.files.read': 'leer el archivo', 'workspace.files.search': 'buscar en', 'node.system.which': 'buscar el programa' }[actionId];
    return {
      title: 'Muse quiere leer algo fuera de tus carpetas permitidas',
      body: `Muse pide ${verb}:\n${target}\n\nEs una sola vez. Para no volver a preguntar en esta carpeta:\nmuse-node grant read <carpeta>`,
    };
  }
  if (commandId === 'shell.exec') {
    return {
      title: 'Muse quiere ejecutar un comando',
      body: `Comando:\n${preview(params.command)}\n\nCarpeta: ${params.cwd ?? '~'}`,
    };
  }
  if (commandId === 'files.write') {
    const content = String(params.content ?? '');
    return {
      title: 'Muse quiere escribir un archivo',
      body: `Archivo: ${params.path}\nTamaño: ${Buffer.byteLength(content)} bytes (si existe, se sobrescribe)\n\nContenido:\n${preview(content)}`,
    };
  }
  if (commandId === 'files.mkdir') {
    return {
      title: 'Muse quiere crear una carpeta',
      body: `Carpeta: ${params.path}${params.create_intermediates ? '\n(también crea las carpetas padre que falten)' : ''}`,
    };
  }
  return { title: 'Muse pide permiso', body: `${commandId}\n${preview(JSON.stringify(params, null, 2))}` };
}

// Approval Broker channel. ask() -> { approved: true, scope: 'once' | 'turn' }
// (Permitir / Aprobar todo este turno), { approved: false } (Rechazar or the
// window closed), null (could not ask: no display, no zenity, timeout, or the
// broker cancelled it because another channel answered first).
//
// The third button appears only when `request.turnOffered` is true, i.e. the
// gate checked that this request sits inside a folder the operator already
// granted (turn-approval.covers). A request outside every grant keeps the
// two-button dialog: a turn never widens a grant.
const TURN_BUTTON = 'Aprobar todo este turno';
const LEGACY_TURN_EXIT = 65; // zenity < 4: exit code of the extra button

// The dialog helper only changes focus handling; without xdotool it would
// be a no-op wrapper, so we skip it entirely (plain zenity).
function hasXdotool(env) {
  try {
    return spawnSync('xdotool', ['version'], { env, stdio: 'ignore', timeout: 2000 }).status === 0;
  } catch { return false; }
}

function createZenityChannel({ timeoutMs = 110000, spawnImpl = spawn, env = process.env, logger = console, keyboardFree = null } = {}) {
  // keyboardFree: null = auto (xdotool present), true/false = force.
  let free = keyboardFree;
  return {
    name: 'desktop',
    available: () => Boolean(env.DISPLAY || env.WAYLAND_DISPLAY),
    ask(request, { signal } = {}) {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
        logger.error(`[muse-node] approval ${request.command_id}: no graphical display`);
        return Promise.resolve(null);
      }
      const { title, body: details } = describe(request);
      // The short digest names the exact immutable request this yes applies to.
      const turnNote = request.turnOffered ? '\n\nAprobar todo este turno: las siguientes acciones de Muse en esta carpeta pasan sin preguntar durante 10 min (se apaga solo). Todo queda en el log: muse-node undo.' : '';
      const body = request.digest ? `${details}${turnNote}\n\nHuella de la petición: ${request.digest.slice(0, 12)}` : details;
      return new Promise((resolve) => {
        let settled = false;
        let child;
        let stdout = '';
        const done = (answer, reason) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', cancel);
          const label = answer === null ? `no answer (${reason})` : answer.approved ? (answer.scope === 'turn' ? 'approved for the turn' : 'approved') : 'rejected';
          logger.log(`[muse-node] desktop approval ${request.command_id}: ${label}`);
          resolve(answer);
        };
        function cancel() { try { child?.kill('SIGTERM'); } catch {} done(null, 'answered elsewhere'); }
        if (signal?.aborted) { done(null, 'cancelled'); return; }
        const args = [
          // --default-cancel: a stray Enter/Space must deny, never approve.
          '--question', '--no-markup', '--default-cancel', '--width=560',
          `--title=${title}`, `--text=${title}\n\n${body}`,
          '--ok-label=Permitir', '--cancel-label=Rechazar',
          `--timeout=${Math.ceil(timeoutMs / 1000)}`,
        ];
        if (request.turnOffered) args.push(`--extra-button=${TURN_BUTTON}`);
        // zenity prints the extra button's label on stdout when it is
        // pressed. Nothing else is expected there; anything else is ignored.
        if (free === null) free = hasXdotool(env);
        // With the helper, stdout must always flow (it carries the extra
        // button's label); without it, only when the turn button is offered.
        const viaHelper = free === true;
        const stdio = (viaHelper || request.turnOffered) ? ['ignore', 'pipe', 'ignore'] : 'ignore';
        try {
          child = viaHelper ? spawnImpl(process.execPath, [ASK_DIALOG, '--', ...args], { env, stdio }) : spawnImpl('zenity', args, { env, stdio });
        } catch (error) {
          done(null, error.message);
          return;
        }
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { stdout += chunk; });
        signal?.addEventListener('abort', cancel, { once: true });
        child.on('error', (error) => done(null, error.message));
        // zenity --question: 0 = OK, 1 = cancel/close/extra (told apart by
        // stdout, see above), 5 = timeout. Any other code is "no answer".
        child.on('exit', (code) => {
          const extra = stdout.trim();
          if (code === 0 && !extra) done({ approved: true, scope: 'once' });
          else if (request.turnOffered && extra === TURN_BUTTON && (code === 1 || code === LEGACY_TURN_EXIT)) done({ approved: true, scope: 'turn' });
          else if (code === 1 && !extra) done({ approved: false, scope: 'once' });
          else done(null, code === 5 ? 'timeout' : `exit ${code}${extra ? ` +stdout "${extra.slice(0, 40)}"` : ''}`);
        });
      });
    },
  };
}

// Single-channel boolean approver (no answer = no). A turn answer counts
// as a yes for this one request; the gate reads the scope through the broker.
function createZenityApprover(options = {}) {
  const channel = createZenityChannel(options);
  return async (request) => (await channel.ask(request))?.approved === true;
}

module.exports = { createZenityApprover, createZenityChannel, describe, preview };
