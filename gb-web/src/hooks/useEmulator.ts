import { useState, useRef, useCallback, useEffect } from 'react';
import type { RegisterState, EmulatorError } from '../types/emulator';

// These will be dynamically imported from the WASM module
let wasmMemory: WebAssembly.Memory | null = null;
const textDecoder = new TextDecoder();
const VRAM_SIZE = 0x2000; // 8192 bytes

export function useEmulator() {
  const emulatorRef = useRef<import('gb-core').Emulator | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [romLoaded, setRomLoaded] = useState(false);
  /** The core runs the loaded cartridge in Game Boy Color mode (the only source of truth for colour). */
  const [isCgb, setIsCgb] = useState(false);
  const [errors, setErrors] = useState<EmulatorError[]>([]);
  const [registers, setRegisters] = useState<RegisterState | null>(null);

  const initialize = useCallback(async () => {
    try {
      const wasm = await import('gb-core');
      const initOutput = await wasm.default();
      wasmMemory = initOutput.memory;

      emulatorRef.current = new wasm.Emulator();
      setIsReady(true);
    } catch (e) {
      setErrors(prev => [...prev, {
        timestamp: Date.now(),
        message: `Failed to initialize WASM: ${e}`,
      }]);
    }
  }, []);

  useEffect(() => {
    initialize();
    // Free the core after every other cleanup of the page has run (they may still save state or SRAM).
    return () => { setTimeout(() => { emulatorRef.current?.free(); emulatorRef.current = null; }); };
  }, [initialize]);

  const addError = useCallback((message: string) => {
    setErrors(prev => [...prev, { timestamp: Date.now(), message }]);
  }, []);

  const loadRom = useCallback((data: Uint8Array): boolean => {
    const emu = emulatorRef.current;
    if (!emu) {
      addError('Emulator not initialized');
      return false;
    }

    try {
      const success = emu.load_rom(data);
      if (!success) {
        const err = emu.get_error();
        addError(err || 'Unknown error loading ROM');
        setRomLoaded(false);
        return false;
      }
      setRomLoaded(true);
      setIsCgb(emu.is_cgb());
      setErrors([]);
      return true;
    } catch (e) {
      addError(`ROM load exception: ${e}`);
      setRomLoaded(false);
      return false;
    }
  }, [addError]);

  const runFrame = useCallback((): Uint8ClampedArray | null => {
    const emu = emulatorRef.current;
    if (!emu) return null;

    const success = emu.run_frame();
    if (!success) {
      const err = emu.get_error();
      if (err) addError(err);
      setIsRunning(false);
      return null;
    }

    const ptr = emu.framebuffer_ptr();
    const len = emu.framebuffer_len();

    if (ptr === 0 || !wasmMemory) {
      // Fallback: try to access memory differently
      return null;
    }

    try {
      return new Uint8ClampedArray(wasmMemory.buffer, ptr, len);
    } catch {
      return null;
    }
  }, [addError]);

  const getAudioSamples = useCallback((): Float32Array | null => {
    const emu = emulatorRef.current;
    if (!emu || !wasmMemory) return null;

    const len = emu.audio_buffer_len();
    if (len === 0) return null;

    const ptr = emu.audio_buffer_ptr();
    if (ptr === 0) return null;

    try {
      const samples = new Float32Array(wasmMemory.buffer, ptr, len);
      const copy = new Float32Array(samples);
      emu.clear_audio_buffer();
      return copy;
    } catch {
      return null;
    }
  }, []);

  const stepInstruction = useCallback((): number => {
    const emu = emulatorRef.current;
    if (!emu) return 0;

    const cycles = emu.step();
    if (cycles === 0) {
      const err = emu.get_error();
      if (err) addError(err);
    }
    return cycles;
  }, [addError]);

  const updateRegisters = useCallback(() => {
    const emu = emulatorRef.current;
    if (!emu) return;

    const af = emu.get_af();
    setRegisters({
      af,
      bc: emu.get_bc(),
      de: emu.get_de(),
      hl: emu.get_hl(),
      sp: emu.get_sp(),
      pc: emu.get_pc(),
      flags: {
        z: (af & 0x80) !== 0,
        n: (af & 0x40) !== 0,
        h: (af & 0x20) !== 0,
        c: (af & 0x10) !== 0,
      },
    });
  }, []);

  const readMemory = useCallback((addr: number): number => {
    const emu = emulatorRef.current;
    if (!emu) return 0;
    return emu.read_memory(addr);
  }, []);

  const pressButton = useCallback((button: number) => {
    const emu = emulatorRef.current;
    if (!emu) return;
    emu.press_button(button);
  }, []);

  const releaseButton = useCallback((button: number) => {
    const emu = emulatorRef.current;
    if (!emu) return;
    emu.release_button(button);
  }, []);

  const hasBatteryRam = useCallback((): boolean => {
    const emu = emulatorRef.current;
    return emu ? emu.has_battery_ram() : false;
  }, []);

  const exportSram = useCallback((): Uint8Array | null => {
    const emu = emulatorRef.current;
    if (!emu) return null;
    return emu.export_sram();
  }, []);

  const importSram = useCallback((data: Uint8Array) => {
    const emu = emulatorRef.current;
    if (emu) emu.import_sram(data);
  }, []);

  const saveState = useCallback((): Uint8Array | null => {
    const emu = emulatorRef.current;
    if (!emu) return null;
    return emu.save_state();
  }, []);

  /** `frame` (the picture on screen when the state was taken) replaces the core's framebuffer, which
   *  states do not hold: without it, a game that has the LCD off keeps showing the pre-load picture. */
  const loadState = useCallback((data: Uint8Array, frame?: Uint8Array | Uint8ClampedArray): boolean => {
    const emu = emulatorRef.current;
    if (!emu || !emu.load_state(data)) return false;
    const ptr = emu.framebuffer_ptr();
    if (frame && ptr && wasmMemory && frame.length === emu.framebuffer_len()) new Uint8Array(wasmMemory.buffer, ptr, frame.length).set(frame);
    return true;
  }, []);

  const framebufferSnapshot = useCallback((): Uint8Array | null => {
    const emu = emulatorRef.current;
    if (!emu) return null;
    return emu.framebuffer_snapshot();
  }, []);

  const getSerialOutput = useCallback((): string => {
    const emu = emulatorRef.current;
    if (!emu || !wasmMemory) return '';
    const len = emu.serial_output_len();
    if (len === 0) return '';
    const ptr = emu.serial_output_ptr();
    if (ptr === 0) return '';
    const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
    return textDecoder.decode(bytes);
  }, []);

  const clearSerialOutput = useCallback(() => {
    const emu = emulatorRef.current;
    if (emu) emu.clear_serial_output();
  }, []);

  const getVramData = useCallback((): Uint8Array | null => {
    const emu = emulatorRef.current;
    if (!emu || !wasmMemory) return null;
    const ptr = emu.vram_ptr();
    if (ptr === 0) return null;
    return new Uint8Array(wasmMemory.buffer, ptr, VRAM_SIZE);
  }, []);

  /** Mute one of the four sound channels (0 Pulse 1, 1 Pulse 2, 2 Wave, 3 Noise). */
  const setChannelMuted = useCallback((channel: number, muted: boolean) => {
    emulatorRef.current?.set_channel_muted(channel, muted);
  }, []);

  const getBgp = useCallback((): number => {
    const emu = emulatorRef.current;
    return emu ? emu.get_bgp() : 0;
  }, []);

  return {
    isReady,
    isRunning,
    setIsRunning,
    romLoaded,
    isCgb,
    loadRom,
    runFrame,
    getAudioSamples,
    stepInstruction,
    registers,
    updateRegisters,
    readMemory,
    pressButton,
    releaseButton,
    errors,
    setErrors,
    hasBatteryRam,
    exportSram,
    importSram,
    saveState,
    loadState,
    framebufferSnapshot,
    getSerialOutput,
    clearSerialOutput,
    getVramData,
    getBgp,
    setChannelMuted,
  };
}
