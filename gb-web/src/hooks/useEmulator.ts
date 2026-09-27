import { t } from '../i18n';
import { useState, useRef, useCallback, useEffect } from 'react';
import type { RegisterState, EmulatorError } from '../types/emulator';
import type { FrameTrace } from '../neural/trace';

// These will be dynamically imported from the WASM module
let wasmMemory: WebAssembly.Memory | null = null;
const textDecoder = new TextDecoder();
const VRAM_SIZE = 0x2000; // 8192 bytes
const START = 3; // JoypadButton.Start

export interface BootOptions { colorize: boolean; palette: number; animation: boolean }
/** Console numbers, as the core reports them. */
export const CONSOLE_DMG = 0, CONSOLE_COMPAT = 2;

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

  /** `colorize`/`palette`: an original Game Boy cartridge on a Game Boy Color (palette 0 automatic, 1-12);
   *  `animation`: play the start-up animation (Start skips it). */
  const loadRom = useCallback((data: Uint8Array, boot: BootOptions = { colorize: false, palette: 0, animation: false }): boolean => {
    const emu = emulatorRef.current;
    if (!emu) {
      addError(t('player.error.init'));
      return false;
    }

    try {
      const success = emu.load_rom_with(data, boot.colorize, boot.palette, boot.animation);
      if (!success) {
        const err = emu.get_error();
        addError(err || t('player.error.unknown'));
        setRomLoaded(false);
        return false;
      }
      setRomLoaded(true);
      setIsCgb(emu.is_cgb());
      setErrors([]);
      return true;
    } catch (e) {
      addError(t('player.error.exception', { error: String(e) }));
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
    if (emu.link_stalled()) return null; // online link cable: the frame goes on once the other player's byte arrives

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
    if (button === START && emu.booting()) { emu.finish_boot(); return; } // Start skips the start-up animation
    emu.press_button(button);
  }, []);

  /** The console the core runs (0 Game Boy, 1 Game Boy Color, 2 Game Boy cartridge on a Game Boy Color), and a state's. */
  const consoleNow = useCallback((): number => emulatorRef.current?.console() ?? 255, []);
  const stateConsole = useCallback((data: Uint8Array): number => emulatorRef.current?.state_console(data) ?? 255, []);
  /** The palette a colourised Game Boy cartridge runs with (0 automatic, 1-12): a loaded state brings back its own. */
  const paletteNow = useCallback((): number => emulatorRef.current?.palette() ?? 0, []);
  const skipBoot = useCallback(() => { emulatorRef.current?.finish_boot(); }, []);

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

  const lastTraced = useRef(0);
  /** The per-frame layer trace (Neural 4x, Smooth motion). Costs some emulation time while on. */
  const setTraceEnabled = useCallback((on: boolean) => {
    const emu = emulatorRef.current;
    if (!emu || emu.trace_enabled() === on) return;
    emu.set_trace_enabled(on);
    lastTraced.current = 0; // the core counts frames again from 1
  }, []);

  /**
   * The trace of the frame finished since the last call, as views into the core's memory (valid until the
   * next run_frame); null when no new frame finished (LCD off) or tracing is off.
   */
  const getTrace = useCallback((): FrameTrace | null => {
    const emu = emulatorRef.current;
    if (!emu || !wasmMemory || !emu.trace_enabled()) return null;
    const frame = emu.trace_frame();
    if (frame === 0 || frame === lastTraced.current) return null;
    lastTraced.current = frame;
    const view = (ptr: number, len: number) => (ptr ? new Uint8Array(wasmMemory!.buffer, ptr, len) : null);
    const n = emu.layer_len();
    const meta = view(emu.frame_meta_ptr(), emu.frame_meta_len());
    const final = view(emu.layer_final_ptr(), n), bg = view(emu.layer_bg_ptr(), n), win = view(emu.layer_win_ptr(), n);
    const obj = view(emu.layer_obj_ptr(), n), info = view(emu.layer_info_ptr(), n);
    return meta && final && bg && win && obj && info ? { meta, final, bg, win, obj, info } : null;
  }, []);

  const getBgp = useCallback((): number => {
    const emu = emulatorRef.current;
    return emu ? emu.get_bgp() : 0;
  }, []);

  /** The core itself, for the cartridge peripherals (camera, printer, rumble). */
  const core = useCallback(() => emulatorRef.current, []);

  return {
    core,
    coreRef: emulatorRef,
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
    consoleNow,
    stateConsole,
    paletteNow,
    skipBoot,
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
    setTraceEnabled,
    getTrace,
  };
}
