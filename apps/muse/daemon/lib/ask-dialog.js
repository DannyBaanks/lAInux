'use strict';

// Ask dialog: a zenity question that NEVER takes the keyboard.
//
// The operator asked for this: a dialog that pops up in the middle of a
// sentence steals the focus, the next key press lands on it and cancels (or
// approves) by accident. Here the dialog only answers to a real mouse click:
//
//   1. remember the window the operator is using (xdotool getactivewindow)
//      BEFORE zenity exists;
//   2. spawn zenity with the exact arguments muse-node built, so the
//      question, the digest and the labels are the real ones;
//   3. as soon as the dialog window is mapped, hand the keyboard focus back
//      to that window (xdotool windowactivate). Verified live on this
//      machine (zenity 4.0.1, GNOME/mutter X11): the dialog is found about
//      400 ms after spawn, stays visible and modal but loses
//      _NET_WM_STATE_FOCUSED, and Return/Escape/Space sent to it do nothing;
//   4. the answer comes from a mouse click on a button, through zenity's
//      own exit code + stdout (the extra button prints its label).
//
// Without xdotool, or with nothing to hand the focus back to, the helper
// does nothing special and plain zenity behaviour applies (keyboard can
// answer). That fallback keeps approvals possible on a machine without
// xdotool; it never makes an approval more likely.
//
// Protocol: `ask-dialog.js -- <zenity args...>`. stdout and the exit code
// are zenity's own, so approval.js keeps one parsing path.

const { spawn, spawnSync } = require('node:child_process');

const POLL_MS = 150;
const POLL_ATTEMPTS = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function activeWindow(env) {
  const result = spawnSync('xdotool', ['getactivewindow'], { env, encoding: 'utf8', timeout: 2000 });
  if (result.status !== 0) return null;
  const id = result.stdout.trim();
  return /^\d+$/.test(id) ? id : null;
}

// Plain `search --name` (no --onlyvisible: a freshly mapped dialog is not
// reported as visible yet, and that is exactly when we need it).
function findDialog(title, env) {
  if (!title) return null;
  const result = spawnSync('xdotool', ['search', '--name', title], { env, encoding: 'utf8', timeout: 2000 });
  if (result.status !== 0) return null;
  const ids = result.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids[ids.length - 1] : null;
}

// Hands the keyboard back to `previous` once the dialog is on screen.
async function releaseKeyboard({ previous, title, env, child, attempts = POLL_ATTEMPTS }) {
  for (let i = 0; i < attempts; i += 1) {
    if (child.exitCode !== null) return false;
    const dialog = findDialog(title, env);
    if (dialog && dialog !== previous) {
      spawnSync('xdotool', ['windowactivate', '--sync', previous], { env, timeout: 2000 });
      return true;
    }
    await sleep(POLL_MS);
  }
  return false;
}

function main(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0) process.exit(2);
  const args = argv.slice(separator + 1);
  const env = process.env;
  const title = (args.find((a) => a.startsWith('--title=')) ?? '').slice('--title='.length);
  const previous = activeWindow(env);
  const child = spawn('zenity', args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.on('exit', (code) => {
    process.stdout.write(stdout);
    process.exit(code ?? 1);
  });
  child.on('error', () => process.exit(2));
  if (previous) releaseKeyboard({ previous, title, env, child }).catch(() => {});
}

if (require.main === module) main(process.argv);
module.exports = { main, releaseKeyboard, findDialog, activeWindow };
