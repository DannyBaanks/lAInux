'use strict';

// Human-in-the-loop gate for commands that change this computer (files.write,
// files.mkdir, shell.exec). Muse asks; the person at the Linux desktop decides
// in a native zenity dialog. No display, no zenity, timeout or close => deny.

const { spawn } = require('node:child_process');

const PREVIEW_CHARS = 600;

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

// Approval Broker channel. ask() -> true (Permitir), false (Rechazar or the
// window closed), null (could not ask: no display, no zenity, timeout, or the
// broker cancelled it because another channel answered first).
function createZenityChannel({ timeoutMs = 110000, spawnImpl = spawn, env = process.env, logger = console } = {}) {
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
      const body = request.digest ? `${details}\n\nHuella de la petición: ${request.digest.slice(0, 12)}` : details;
      return new Promise((resolve) => {
        let settled = false;
        let child;
        const done = (answer, reason) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', cancel);
          logger.log(`[muse-node] desktop approval ${request.command_id}: ${answer === true ? 'approved' : answer === false ? 'rejected' : `no answer (${reason})`}`);
          resolve(answer);
        };
        function cancel() { try { child?.kill('SIGTERM'); } catch {} done(null, 'answered elsewhere'); }
        if (signal?.aborted) { done(null, 'cancelled'); return; }
        try {
          child = spawnImpl('zenity', [
            // --default-cancel: a stray Enter/Space must deny, never approve.
            '--question', '--no-markup', '--default-cancel', '--width=520',
            `--title=${title}`, `--text=${title}\n\n${body}`,
            '--ok-label=Permitir', '--cancel-label=Rechazar',
            `--timeout=${Math.ceil(timeoutMs / 1000)}`,
          ], { env, stdio: 'ignore' });
        } catch (error) {
          done(null, error.message);
          return;
        }
        signal?.addEventListener('abort', cancel, { once: true });
        child.on('error', (error) => done(null, error.message));
        // zenity: 0 = OK, 1 = cancel/close, 5 = timeout
        child.on('exit', (code) => done(code === 0 ? true : code === 1 ? false : null, code === 5 ? 'timeout' : `exit ${code}`));
      });
    },
  };
}

// Single-channel boolean approver (no answer = no).
function createZenityApprover(options = {}) {
  const channel = createZenityChannel(options);
  return async (request) => (await channel.ask(request)) === true;
}

module.exports = { createZenityApprover, createZenityChannel, describe, preview };
