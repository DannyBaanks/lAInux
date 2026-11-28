'use strict';

// Desktop keyring (Secret Service) access through python3-keyring, the same
// store ISyCode uses. The secret travels only through a pipe: never argv,
// never a file, never a log line.

const { spawnSync } = require('node:child_process');

const SERVICE = 'lainux-mods';
const SCRIPT = {
  get: 'import sys,keyring\nv=keyring.get_password(sys.argv[1],sys.argv[2])\nsys.stdout.write(v or "")',
  set: 'import sys,keyring\nkeyring.set_password(sys.argv[1],sys.argv[2],sys.stdin.read())',
  delete: 'import sys,keyring\ntry:\n keyring.delete_password(sys.argv[1],sys.argv[2])\nexcept keyring.errors.PasswordDeleteError:\n pass',
};

function run(kind, account, input) {
  const result = spawnSync('python3', ['-E', '-P', '-c', SCRIPT[kind], SERVICE, account], {
    input, encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    // stderr is not echoed: keyring backends can include more than we want in it.
    throw new Error(`desktop keyring ${kind} failed (is the keyring unlocked and python3-keyring installed?)`);
  }
  return result.stdout;
}

const getSecret = (account) => run('get', account, '') || null;
const setSecret = (account, value) => { run('set', account, value); };
const deleteSecret = (account) => { run('delete', account, ''); };

module.exports = { getSecret, setSecret, deleteSecret, SERVICE };
