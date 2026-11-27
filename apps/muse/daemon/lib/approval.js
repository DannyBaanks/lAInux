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

function describe({ command_id: commandId, params = {} }) {
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

function createZenityApprover({ timeoutMs = 110000, spawnImpl = spawn, env = process.env, logger = console } = {}) {
  return function approve(request) {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
      logger.error(`[muse-node] approval ${request.command_id}: no graphical display, denied`);
      return Promise.resolve(false);
    }
    const { title, body } = describe(request);
    return new Promise((resolve) => {
      let settled = false;
      const done = (approved, reason) => {
        if (settled) return;
        settled = true;
        logger.log(`[muse-node] approval ${request.command_id}: ${approved ? 'approved' : `denied (${reason})`}`);
        resolve(approved);
      };
      let child;
      try {
        child = spawnImpl('zenity', [
          '--question', '--no-markup', '--width=520',
          `--title=${title}`, `--text=${title}\n\n${body}`,
          '--ok-label=Permitir', '--cancel-label=Rechazar',
          `--timeout=${Math.ceil(timeoutMs / 1000)}`,
        ], { env, stdio: 'ignore' });
      } catch (error) {
        done(false, error.message);
        return;
      }
      child.on('error', (error) => done(false, error.message));
      // zenity: 0 = OK, 1 = cancel/close, 5 = timeout
      child.on('exit', (code) => done(code === 0, code === 5 ? 'timeout' : `exit ${code}`));
    });
  };
}

module.exports = { createZenityApprover, describe };
