//! Link cable: two consoles exchanging a byte over the serial port, on synthetic ROMs.

use gb_core::gameboy::{run_linked_frame, GameBoy};

/// ROM that (after `delay` DEC B loops) sends `byte` with SC = `sc`, waits for SC bit 7 to
/// clear, then stores SB at $C000 and IF at $C001 and loops forever.
fn rom(byte: u8, sc: u8, delay: bool) -> GameBoy {
    let mut r = vec![0u8; 0x8000];
    let wait = if delay { [0x06, 0x00, 0x05, 0x20, 0xFD] } else { [0x00; 5] }; // LD B,0; DEC B; JR NZ
    let code = [
        0x3E, byte, 0xE0, 0x01, // LD A,byte; LDH (SB),A
        0x3E, sc, 0xE0, 0x02, // LD A,sc; LDH (SC),A
        0xF0, 0x02, 0xCB, 0x7F, 0x20, 0xFA, // wait: LDH A,(SC); BIT 7,A; JR NZ,wait
        0xF0, 0x01, 0xEA, 0x00, 0xC0, // LDH A,(SB); LD ($C000),A
        0xF0, 0x0F, 0xEA, 0x01, 0xC0, // LDH A,(IF); LD ($C001),A
        0x18, 0xFE, // JR -2
    ];
    r[0x100..0x105].copy_from_slice(&wait);
    r[0x105..0x105 + code.len()].copy_from_slice(&code);
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    let mut gb = GameBoy::new(r).unwrap();
    gb.skip_boot_rom();
    gb
}

fn result(gb: &GameBoy) -> (u8, bool) {
    (gb.bus.read_byte(0xC000), gb.bus.read_byte(0xC001) & 0x08 != 0)
}

#[test]
fn linked_consoles_swap_bytes_and_raise_the_serial_interrupt() {
    // The master waits a little so the slave is already listening on the external clock.
    let mut master = rom(0x42, 0x81, true);
    let mut slave = rom(0x99, 0x80, false);
    for _ in 0..3 {
        run_linked_frame(&mut master, &mut slave).unwrap();
    }
    assert_eq!(result(&master), (0x99, true), "master receives the slave's byte");
    assert_eq!(result(&slave), (0x42, true), "slave receives the master's byte");
}

#[test]
fn unplugged_master_shifts_in_ff() {
    let mut gb = rom(0x42, 0x81, false);
    gb.run_frame().unwrap();
    assert_eq!(result(&gb), (0xFF, true));
}

#[test]
fn unplugged_slave_keeps_waiting() {
    let mut gb = rom(0x42, 0x80, false);
    gb.run_frame().unwrap();
    assert_eq!(gb.bus.read_byte(0xFF02) & 0x80, 0x80);
    assert_eq!(gb.bus.read_byte(0xC000), 0x00);
}
