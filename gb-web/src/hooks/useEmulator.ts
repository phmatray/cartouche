import { t } from '../i18n';
import { useState, useRef, useCallback, useEffect } from 'react';
import type { RegisterState, EmulatorError } from '../types/emulator';
import type { FrameTrace } from '../neural/trace';

// These will be dynamically imported from the WASM module
let wasmMemory: WebAssembly.Memory | null = null;
const textDecoder = new TextDecoder();
const VRAM_SIZE = 0x4000; // both CGB banks, 8 KiB each
const START = 3; // JoypadButton.Start

/** A view of core memory at `ptr`, or null without a ROM. Valid until the WASM memory grows. */
const coreView = (ptr: number, len: number): Uint8Array | null =>
  ptr && wasmMemory ? new Uint8Array(wasmMemory.buffer, ptr, len) : null;

/** `sgb`: a Super Game Boy (only for a cartridge with its functions; `colorize` and `palette` then do not apply). */
/** `animation`: the start-up animation, 0 none or 1-3 (the index in `STARTUP`). */
export interface BootOptions { colorize: boolean; palette: number; animation: number; sgb?: boolean }
/** Console numbers, as the core reports them. */
export const CONSOLE_DMG = 0, CONSOLE_CGB = 1, CONSOLE_COMPAT = 2, CONSOLE_SGB = 3;

export function useEmulator() {
  const emulatorRef = useRef<import('gb-core').Emulator | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isRunning, setRunning] = useState(false);
  /** Why the core stopped mid-game ("breakpoint $0150", "frame"): the player is paused there until it runs again. */
  const [breakReason, setBreakReason] = useState<string | null>(null);
  const [breakpoints, setBreakpoints] = useState<number[]>([]);
  /** Debugger steps taken while paused, so the player can redraw the picture after each. */
  const [steps, setSteps] = useState(0);
  const bpRef = useRef<number[]>([]); // the same list, for loadRom (which must not change with it)
  const stopped = useRef(false); // no frame runs past a break, even the rest of this animation frame's batch
  const setIsRunning = useCallback((on: boolean) => {
    if (on) { stopped.current = false; setBreakReason(null); }
    setRunning(on);
  }, []);
  /** Power-ons so far (0: no cartridge running). Each load builds a new console, so per-console setup
   *  (channel mutes, printer, link cable) keys on this, not on romLoaded, which stays true across a restart. */
  const [power, setPower] = useState(0);
  const romLoaded = power > 0;
  /** The core runs the loaded cartridge in Game Boy Color mode (the only source of truth for colour). */
  const [isCgb, setIsCgb] = useState(false);
  const [errors, setErrors] = useState<EmulatorError[]>([]);
  const [registers, setRegisters] = useState<RegisterState | null>(null);
  /** The WebAssembly core couldn't load (offline before it was cached, say): the player offers a retry. */
  const [initFailed, setInitFailed] = useState(false);

  /** The open page's life: a load still awaiting the core when the page goes stops, and builds no console nobody would free. */
  const alive = useRef({ on: false });
  const initialize = useCallback(() => {
    const life = alive.current;
    return import('gb-core').then(async (wasm) => {
      if (!life.on) return;
      const initOutput = await wasm.default();
      if (!life.on) return;
      wasmMemory = initOutput.memory;
      emulatorRef.current?.free();
      emulatorRef.current = new wasm.Emulator();
      setIsReady(true);
    }).catch((e) => { if (life.on) { console.error(e); setInitFailed(true); } });
  }, []);

  useEffect(() => {
    const life = { on: true };
    alive.current = life;
    initialize();
    // Free the core after every other cleanup of the page has run (they may still save state or SRAM).
    return () => {
      life.on = false;
      setTimeout(() => { if (alive.current === life) { emulatorRef.current?.free(); emulatorRef.current = null; } });
    };
  }, [initialize]);
  const retryInit = useCallback(() => { setInitFailed(false); initialize(); }, [initialize]);

  const addError = useCallback((message: string, detail?: string) => {
    setErrors(prev => [...prev, { timestamp: Date.now(), message, detail }]);
  }, []);

  /** `colorize`/`palette`: an original Game Boy cartridge on a Game Boy Color (palette 0 automatic, 1-12);
   *  `animation`: the start-up animation to play, 0 none (Start skips it). */
  const loadRom = useCallback((data: Uint8Array, boot: BootOptions = { colorize: false, palette: 0, animation: 0 }): boolean => {
    const emu = emulatorRef.current;
    if (!emu) {
      addError(t('player.error.init'));
      return false;
    }

    try {
      const success = boot.sgb ? emu.load_rom_sgb(data, boot.animation) : emu.load_rom_with(data, boot.colorize, boot.palette, boot.animation);
      if (!success) {
        const err = emu.get_error();
        addError(t('player.error.unknown'), err);
        setPower(0);
        return false;
      }
      setPower((n) => n + 1);
      stopped.current = false;
      setBreakReason(null);
      bpRef.current.forEach((a) => emu.debug_add_breakpoint(a)); // each load builds a new console
      setIsCgb(emu.is_cgb());
      setErrors([]);
      return true;
    } catch (e) {
      addError(t('player.error.exception', { error: String(e) }));
      setPower(0);
      return false;
    }
  }, [addError]);

  const runFrame = useCallback((): Uint8ClampedArray | null => {
    const emu = emulatorRef.current;
    if (!emu || stopped.current) return null;

    const success = emu.run_frame();
    if (!success) {
      const err = emu.get_error();
      if (err) addError(t('player.error.crashed'), err);
      setRunning(false);
      return null;
    }
    if (emu.link_stalled()) return null; // online link cable: the frame goes on once the other player's byte arrives
    const reason = emu.debug_break_reason();
    if (reason) {
      stopped.current = true;
      setBreakReason(reason);
      setRunning(false);
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
      if (err) addError(t('player.error.crashed'), err);
    }
    setSteps((n) => n + 1);
    return cycles;
  }, [addError]);

  /** Runs to the next VBlank and stops there (the player stays paused). */
  const stepFrame = useCallback(() => {
    const emu = emulatorRef.current;
    if (!emu) return;
    if (emu.debug_step_frame()) setBreakReason(emu.debug_break_reason() ?? null);
    else {
      const err = emu.get_error();
      if (err) addError(t('player.error.crashed'), err);
    }
    setSteps((n) => n + 1);
  }, [addError]);

  /** Runs a CALL/RST to its return (at most to the end of the frame), otherwise one step. */
  const stepOver = useCallback(() => {
    const emu = emulatorRef.current;
    if (!emu) return;
    if (emu.debug_step_over()) setBreakReason(emu.debug_break_reason() ?? null);
    else {
      const err = emu.get_error();
      if (err) addError(t('player.error.crashed'), err);
    }
    setSteps((n) => n + 1);
  }, [addError]);

  /** `count` instructions from `addr` (the core's `ADDR|BYTES|TEXT` lines, parsed). */
  const disassemble = useCallback((addr: number, count: number): { addr: number; bytes: string; text: string }[] => {
    const out = emulatorRef.current?.disassemble(addr, count);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [a, bytes, text] = line.split('|');
      return { addr: parseInt(a, 16), bytes, text };
    });
  }, []);

  const addBreakpoint = useCallback((addr: number) => {
    emulatorRef.current?.debug_add_breakpoint(addr);
    if (!bpRef.current.includes(addr)) setBreakpoints(bpRef.current = [...bpRef.current, addr].sort((a, b) => a - b));
  }, []);

  const removeBreakpoint = useCallback((addr: number) => {
    const emu = emulatorRef.current;
    const rest = bpRef.current.filter((a) => a !== addr);
    if (rest.length) emu?.debug_remove_breakpoint(addr);
    else emu?.debug_clear(); // no breakpoint left: the core runs at full speed again
    setBreakpoints(bpRef.current = rest);
  }, []);

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

  /** `player` 1-3: Super Game Boy players 2-4 (heard once the game asks for more players). */
  const pressButton = useCallback((button: number, player = 0) => {
    const emu = emulatorRef.current;
    if (!emu) return;
    if (player) { emu.press_button_player(player, button); return; }
    if (button === START && emu.booting()) { emu.finish_boot(); return; } // Start skips the start-up animation
    emu.press_button(button);
  }, []);

  /** The Super Game Boy border the game sent (256×224 RGBA, a view valid until the next frame) when it changed since `version`. */
  const sgbBorder = useCallback((version: number): { version: number; rgba: Uint8ClampedArray | null } | null => {
    const emu = emulatorRef.current;
    const v = emu?.sgb_border_version() ?? 0;
    if (!emu || v === version) return null;
    const ptr = emu.sgb_border_ptr();
    return { version: v, rgba: v && ptr && wasmMemory ? new Uint8ClampedArray(wasmMemory.buffer, ptr, 256 * 224 * 4) : null };
  }, []);

  /** The game plays its music on the Super Game Boy's SNES sound chip (not emulated: silent there), known ~10 s in. */
  const sgbSnesMusic = useCallback(() => emulatorRef.current?.sgb_snes_music() ?? false, []);
  /** The console the core runs (0 Game Boy, 1 Game Boy Color, 2 Game Boy cartridge on a Game Boy Color, 3 Super Game Boy), and a state's. */
  const consoleNow = useCallback((): number => emulatorRef.current?.console() ?? 255, []);
  const stateConsole = useCallback((data: Uint8Array): number => emulatorRef.current?.state_console(data) ?? 255, []);
  /** The palette a colourised Game Boy cartridge runs with (0 automatic, 1-12): a loaded state brings back its own. */
  const paletteNow = useCallback((): number => emulatorRef.current?.palette() ?? 0, []);
  const skipBoot = useCallback(() => { emulatorRef.current?.finish_boot(); }, []);

  const releaseButton = useCallback((button: number, player = 0) => {
    const emu = emulatorRef.current;
    if (!emu) return;
    if (player) emu.release_button_player(player, button);
    else emu.release_button(button);
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

  /** `frame` (the picture on screen when the state was taken) replaces the core's pictures, which
   *  states do not hold: without it, a game that has the LCD off keeps showing the pre-load picture,
   *  and the next frame's rows drawn before the save point come from a blank or older one. */
  const loadState = useCallback((data: Uint8Array, frame?: Uint8Array | Uint8ClampedArray): boolean => {
    const emu = emulatorRef.current;
    if (!emu || !emu.load_state(data)) return false;
    stopped.current = false;
    setBreakReason(null);
    if (frame) emu.set_screen(frame instanceof Uint8Array ? frame : new Uint8Array(frame.buffer, frame.byteOffset, frame.length));
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

  const getOam = useCallback((): Uint8Array | null => {
    const emu = emulatorRef.current;
    return emu ? coreView(emu.oam_ptr(), 0xA0) : null;
  }, []);

  const getCram = useCallback((): { bg: Uint8Array; obj: Uint8Array } | null => {
    const emu = emulatorRef.current;
    const bg = emu && coreView(emu.cram_bg_ptr(), 64), obj = emu && coreView(emu.cram_obj_ptr(), 64);
    return bg && obj ? { bg, obj } : null;
  }, []);

  /** LCDC, STAT, SCY, SCX, LY, LYC, BGP, OBP0, OBP1, WY, WX, VBK. */
  const getLcdRegs = useCallback((): Uint8Array | null => {
    const regs = emulatorRef.current?.get_lcd_regs();
    return regs && regs.length ? regs : null;
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
    initFailed,
    retryInit,
    isRunning,
    setIsRunning,
    romLoaded,
    power,
    isCgb,
    loadRom,
    runFrame,
    getAudioSamples,
    stepInstruction,
    stepFrame,
    stepOver,
    steps,
    disassemble,
    breakReason,
    breakpoints,
    addBreakpoint,
    removeBreakpoint,
    registers,
    updateRegisters,
    readMemory,
    pressButton,
    releaseButton,
    consoleNow,
    sgbBorder,
    sgbSnesMusic,
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
    getOam,
    getCram,
    getLcdRegs,
    getBgp,
    setChannelMuted,
    setTraceEnabled,
    getTrace,
  };
}
