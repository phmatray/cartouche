export interface RegisterState {
  af: number;
  bc: number;
  de: number;
  hl: number;
  sp: number;
  pc: number;
  flags: {
    z: boolean;
    n: boolean;
    h: boolean;
    c: boolean;
  };
}

export interface EmulatorError {
  timestamp: number;
  message: string;
}
