/// <reference lib="webworker" />

// Typed message protocols
export type ToWorkerMsg =
  | { type: 'loadRom'; data: ArrayBuffer }
  | { type: 'runFrame' }
  | { type: 'setInput'; buttons: number }
  | { type: 'saveState' }
  | { type: 'loadState'; data: ArrayBuffer };

export type FromWorkerMsg =
  | { type: 'ready' }
  | { type: 'romLoaded'; success: boolean; error?: string }
  | { type: 'frame'; framebuffer: ArrayBuffer }
  | { type: 'serialOutput'; byte: number }
  | { type: 'error'; message: string }
  | { type: 'stateSaved'; data: ArrayBuffer }
  | { type: 'stateLoaded'; success: boolean };

let emulator: import('gb-core').Emulator | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let prevButtons = 0;
let lastSerialLen = 0;

async function initialize() {
  try {
    // Dynamic import resolved by Vite via alias
    const wasm = await import('gb-core');
    const initOutput = await wasm.default();
    wasmMemory = initOutput.memory;
    emulator = new wasm.Emulator();
    (self as DedicatedWorkerGlobalScope).postMessage({ type: 'ready' } satisfies FromWorkerMsg);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({
      type: 'error',
      message: `WASM init failed: ${err}`,
    } satisfies FromWorkerMsg);
  }
}

(self as DedicatedWorkerGlobalScope).onmessage = (e: MessageEvent<ToWorkerMsg>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'loadRom': {
      if (!emulator) {
        post({ type: 'error', message: 'Emulator not initialized' });
        return;
      }
      const romData = new Uint8Array(msg.data);
      const success = emulator.load_rom(romData);
      if (!success) {
        const err = emulator.get_error() ?? 'Unknown error';
        post({ type: 'romLoaded', success: false, error: err });
      } else {
        lastSerialLen = 0;
        post({ type: 'romLoaded', success: true });
      }
      break;
    }

    case 'runFrame': {
      if (!emulator || !wasmMemory) {
        post({ type: 'error', message: 'Emulator not ready' });
        return;
      }
      const ok = emulator.run_frame();
      if (!ok) {
        const err = emulator.get_error() ?? 'Frame error';
        post({ type: 'error', message: err });
        return;
      }

      // Copy framebuffer — cannot transfer WASM memory directly
      const ptr: number = emulator.framebuffer_ptr();
      const len: number = emulator.framebuffer_len();
      const framebuffer = new ArrayBuffer(len);
      new Uint8Array(framebuffer).set(new Uint8Array(wasmMemory.buffer, ptr, len));

      // Check for new serial output and forward the latest byte
      const serialLen: number = emulator.serial_output_len();
      if (serialLen > lastSerialLen) {
        const serialPtr: number = emulator.serial_output_ptr();
        const lastByte = new Uint8Array(wasmMemory.buffer, serialPtr + serialLen - 1, 1)[0];
        lastSerialLen = serialLen;
        // Emit to main thread for display (the link cable runs in link-worker.ts)
        post({ type: 'serialOutput', byte: lastByte });
      }

      (self as DedicatedWorkerGlobalScope).postMessage(
        { type: 'frame', framebuffer } satisfies FromWorkerMsg,
        [framebuffer],
      );
      break;
    }

    case 'setInput': {
      if (!emulator) return;
      const { buttons } = msg;
      for (let i = 0; i < 8; i++) {
        const bit = 1 << i;
        const wasPressed = (prevButtons & bit) !== 0;
        const isPressed = (buttons & bit) !== 0;
        if (!wasPressed && isPressed) emulator.press_button(i);
        else if (wasPressed && !isPressed) emulator.release_button(i);
      }
      prevButtons = buttons;
      break;
    }

    case 'saveState': {
      if (!emulator) return;
      const state: Uint8Array = emulator.save_state();
      const buf = state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength) as ArrayBuffer;
      (self as DedicatedWorkerGlobalScope).postMessage(
        { type: 'stateSaved', data: buf } satisfies FromWorkerMsg,
        [buf],
      );
      break;
    }

    case 'loadState': {
      if (!emulator) return;
      const data = new Uint8Array(msg.data);
      const success = emulator.load_state(data);
      post({ type: 'stateLoaded', success });
      break;
    }
  }
};

function post(msg: FromWorkerMsg) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

initialize();
