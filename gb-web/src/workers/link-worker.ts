/// <reference lib="webworker" />

// Two Game Boys joined by a link cable. Both run in this one worker (one WASM instance) so
// the core can step them in lockstep and pass serial bytes between them (run_frame_linked).

export type LinkPlayerIndex = 1 | 2;

export type ToLinkWorkerMsg =
  // sram: the player's battery save to start from; state: a save state to start from instead.
  | { type: 'loadRom'; player: LinkPlayerIndex; data: ArrayBuffer; sram?: ArrayBuffer; state?: ArrayBuffer }
  | { type: 'exportSram' }
  | { type: 'runFrame' }
  | { type: 'setInput'; player: LinkPlayerIndex; buttons: number };

export type FromLinkWorkerMsg =
  | { type: 'ready' }
  | { type: 'romLoaded'; player: LinkPlayerIndex; success: boolean; error?: string }
  | { type: 'frame'; framebuffers: [ArrayBuffer | null, ArrayBuffer | null] }
  | { type: 'sram'; data: [ArrayBuffer | null, ArrayBuffer | null] }
  | { type: 'error'; message: string };

type Emulator = import('gb-core').Emulator;

const emus: [Emulator | null, Emulator | null] = [null, null];
const loaded = [false, false];
const prevButtons = [0, 0];
let wasmMemory: WebAssembly.Memory | null = null;

function post(msg: FromLinkWorkerMsg, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

async function initialize() {
  try {
    const wasm = await import('gb-core');
    const initOutput = await wasm.default();
    wasmMemory = initOutput.memory;
    emus[0] = new wasm.Emulator();
    emus[1] = new wasm.Emulator();
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'error', message: `WASM init failed: ${err}` });
  }
}

function copyFramebuffer(emu: Emulator): ArrayBuffer {
  const len = emu.framebuffer_len();
  const buf = new ArrayBuffer(len);
  new Uint8Array(buf).set(new Uint8Array(wasmMemory!.buffer, emu.framebuffer_ptr(), len));
  return buf;
}

(self as DedicatedWorkerGlobalScope).onmessage = (e: MessageEvent<ToLinkWorkerMsg>) => {
  const msg = e.data;
  const [emu1, emu2] = emus;
  if (!emu1 || !emu2 || !wasmMemory) {
    post({ type: 'error', message: 'Emulator not initialized' });
    return;
  }

  switch (msg.type) {
    case 'loadRom': {
      const i = msg.player - 1;
      const emu = emus[i]!;
      let success = emu.load_rom(new Uint8Array(msg.data));
      if (success && msg.sram) emu.import_sram(new Uint8Array(msg.sram));
      if (success && msg.state) success = emu.load_state(new Uint8Array(msg.state));
      loaded[i] = success;
      prevButtons[i] = 0;
      post(success
        ? { type: 'romLoaded', player: msg.player, success }
        : { type: 'romLoaded', player: msg.player, success, error: emu.get_error() ?? 'Unknown error' });
      break;
    }

    case 'exportSram': {
      const data = [0, 1].map((i) => (loaded[i] && emus[i]!.has_battery_ram() ? emus[i]!.export_sram().buffer as ArrayBuffer : null)) as [ArrayBuffer | null, ArrayBuffer | null];
      post({ type: 'sram', data }, data.filter((b): b is ArrayBuffer => b !== null));
      break;
    }

    case 'runFrame': {
      let ok = true;
      let failed: Emulator = emu1;
      if (loaded[0] && loaded[1]) {
        ok = emu1.run_frame_linked(emu2);
      } else {
        for (const i of [0, 1]) {
          if (loaded[i] && ok && !emus[i]!.run_frame()) {
            ok = false;
            failed = emus[i]!;
          }
        }
      }
      if (!ok) {
        post({ type: 'error', message: failed.get_error() ?? 'Frame error' });
        return;
      }
      const framebuffers: [ArrayBuffer | null, ArrayBuffer | null] = [
        loaded[0] ? copyFramebuffer(emu1) : null,
        loaded[1] ? copyFramebuffer(emu2) : null,
      ];
      post({ type: 'frame', framebuffers }, framebuffers.filter((b): b is ArrayBuffer => b !== null));
      break;
    }

    case 'setInput': {
      const i = msg.player - 1;
      const emu = emus[i]!;
      for (let b = 0; b < 8; b++) {
        const bit = 1 << b;
        const was = (prevButtons[i] & bit) !== 0;
        const is = (msg.buttons & bit) !== 0;
        if (!was && is) emu.press_button(b);
        else if (was && !is) emu.release_button(b);
      }
      prevButtons[i] = msg.buttons;
      break;
    }
  }
};

initialize();
