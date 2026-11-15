// neotix bridge for Dola's UI (what Cici.dll's Aha/MOA runtime injects on Windows).
//   window.neotix          neotix.<ns>.<method>(...) and root methods neotix.<method>(...)
//   window.neotixChannel   cross-window event channel: on/off/once/emit
//   neotix.towel.createAp  synchronous access point (call/subscribe) for host services
// A method the host does not implement throws Error("No such method!"): the UI's
// ShellApi maps that to isExisted:false and degrades. contextIsolation is off because
// the UI needs a live global with arbitrary members; ipcRenderer stays in this closure.
"use strict";
const { ipcRenderer } = require("electron");

async function invoke(ns, method, args) {
  let r;
  try { r = await ipcRenderer.invoke("neotix", ns, method, JSON.parse(JSON.stringify(args ?? []))); }
  catch (e) { throw new Error(String((e && e.message) || e)); }
  if (r && r.miss) throw new Error("No such method!");
  if (r && r.error) throw new Error(r.error);
  return r ? r.value : undefined;
}

// ---- access points: callback-style call/subscribe, answered by the main process
const subscriptions = new Map(); // event -> Set(handler)
ipcRenderer.on("towel-push", (_e, event, payload) => {
  for (const h of subscriptions.get(event) || []) try { h(event, payload); } catch {}
});
function createAp() {
  return {
    call(method, payload, cb) {
      ipcRenderer.invoke("towel", method, JSON.parse(JSON.stringify(payload ?? null)))
        .then(([ok, res]) => cb && cb(ok, res), (e) => cb && cb(false, String(e)));
    },
    subscribe(event, handler) { (subscriptions.get(event) || subscriptions.set(event, new Set()).get(event)).add(handler); },
    unsubscribe(event, handler) { subscriptions.get(event)?.delete(handler); },
    on(event, handler) { this.subscribe(event, handler); },
    off(event, handler) { this.unsubscribe(event, handler); },
    close() {},
  };
}

// ---- members that are data or must be synchronous
const ENV = ipcRenderer.sendSync("neotix-env"); // neotix.env() is synchronous in the UI
const SPECIAL = {
  "": { env: () => ENV },
  jsruntime: { workerId: 0 },
  jsRuntime: { workerId: 0 },
  towel: { createAp },
};

function member(path) {
  const target = function () {};
  return new Proxy(target, {
    apply(_t, _this, args) { // neotix.<method>(...) at the root, or deeper calls
      const parts = path.split(".");
      const method = parts.pop();
      return invoke(parts.join(".") || "", method, args);
    },
    get(_t, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      const special = SPECIAL[path];
      if (special && key in special) return special[key];
      return member(path ? `${path}.${key}` : key);
    },
    has() { return true; },
  });
}
globalThis.neotix = member("");

// ---- neotixChannel: in-window events now, routed across windows by the main process
// Messages carry any number of arguments: broadcast(event, scope, payload) is what the
// UI's RPC ("rfc-request"/"rfc-response") uses.
const channel = new Map();
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));
// Listeners receive an envelope { type, data, senderToken }: broadcast(event, type, data)
// and sendToTargets(tokens, event, type, data) put their 2nd/3rd arguments there.
ipcRenderer.on("neotix-channel", (_e, name, args, senderToken) => {
  const env = args.length > 1 ? { type: args[0], data: args[1], senderToken } : { type: "", data: args[0], senderToken };
  for (const h of channel.get(name) || []) try { h(env); } catch {}
});
globalThis.neotixChannel = {
  on(name, handler) { (channel.get(name) || channel.set(name, new Set()).get(name)).add(handler); },
  once(name, handler) { const w = (...a) => { this.off(name, w); handler(...a); }; this.on(name, w); },
  off(name, handler) { channel.get(name)?.delete(handler); },
  emit(name, ...args) { ipcRenderer.send("neotix-channel", name, args.map(plain), null); },
  async broadcast(name, ...args) { ipcRenderer.send("neotix-channel", name, args.map(plain), null); return true; },
  async sendToTargets(tokens, name, ...args) {
    ipcRenderer.send("neotix-channel", name, args.map(plain), Array.isArray(tokens) ? tokens : [tokens]);
    return true;
  },
};
