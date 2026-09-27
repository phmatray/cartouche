//! Remote link cable: two consoles that each run on their own, exchanging serial bytes through a
//! simulated network with a delay, on synthetic ROMs.

use std::collections::VecDeque;

use gb_core::gameboy::GameBoy;
use gb_core::serial::HOLD_CYCLES;

const N: u8 = 16;

/// ROM that (after `delay` DEC B loops) exchanges `N` bytes from its table (`first`, `first + 1`, …)
/// with SC = `sc`, storing each received byte from $C000, then loops forever. With `pause`, it waits
/// another loop between bytes (a master giving the slave time to get ready, as games do).
fn rom(first: u8, sc: u8, delay: u8, pause: bool) -> GameBoy {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x104].copy_from_slice(&[0x00, 0xC3, 0x50, 0x01]); // NOP; JP $0150
    let wait = |d: u8| [0x06, d, 0x05, 0x20, 0xFD]; // LD B,d; DEC B; JR NZ,-3
    let mut code = vec![];
    code.extend_from_slice(&wait(delay));
    code.extend_from_slice(&[0x21, 0x00, 0x02, 0x11, 0x00, 0xC0]); // LD HL,$0200; LD DE,$C000
    let top = code.len();
    code.extend_from_slice(&if pause { wait(0) } else { [0; 5] });
    code.extend_from_slice(&[
        0x2A, 0xE0, 0x01, // LD A,(HL+); LDH (SB),A
        0x3E, sc, 0xE0, 0x02, // LD A,sc; LDH (SC),A
        0xF0, 0x02, 0xCB, 0x7F, 0x20, 0xFA, // wait: LDH A,(SC); BIT 7,A; JR NZ,wait
        0xF0, 0x01, 0x12, 0x13, // LDH A,(SB); LD (DE),A; INC DE
        0x7B, 0xFE, N, // LD A,E; CP N
    ]);
    let back = top as i32 - (code.len() as i32 + 2);
    code.extend_from_slice(&[0x20, back as u8, 0x18, 0xFE]); // JR NZ,top; JR -2
    r[0x150..0x150 + code.len()].copy_from_slice(&code);
    for i in 0..N {
        r[0x200 + i as usize] = first.wrapping_add(i);
    }
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    let mut gb = GameBoy::new(r).unwrap();
    gb.skip_boot_rom();
    gb.bus.serial.set_remote(true);
    gb
}

/// ROM that never touches the serial port.
fn deaf() -> GameBoy {
    let mut r = vec![0u8; 0x8000];
    r[0x100..0x102].copy_from_slice(&[0x18, 0xFE]); // JR -2
    r[0x14D] = (0x134..=0x14C).fold(0u8, |c, i| c.wrapping_sub(r[i]).wrapping_sub(1));
    let mut gb = GameBoy::new(r).unwrap();
    gb.skip_boot_rom();
    gb.bus.serial.set_remote(true);
    gb
}

enum Msg {
    Clock(u8, u32),
    Reply(u8),
}

/// One console and the messages on their way to it (delivery slice, message).
struct Node {
    gb: GameBoy,
    inbox: VecDeque<(u32, Msg)>,
    ran: u64,
    stalled_slices: u32,
}

const SLICE: u32 = 4096; // CPU cycles per simulation step (about a sixteenth of a frame)

/// Runs both consoles slice by slice; each message arrives `delay` slices after it was sent.
/// Stops after `slices` or once `until(a, b)` holds.
fn run(a: &mut Node, b: &mut Node, delay: u32, slices: u32, until: impl Fn(&Node, &Node) -> bool) -> u32 {
    for now in 0..slices {
        step(a, b, now, delay);
        step(b, a, now, delay);
        if until(a, b) {
            return now;
        }
    }
    slices
}

/// One slice of `me`: the messages due, then up to `SLICE` cycles unless a transfer stalls it.
fn step(me: &mut Node, other: &mut Node, now: u32, delay: u32) {
    while me.inbox.front().is_some_and(|(t, _)| *t <= now) {
        match me.inbox.pop_front().unwrap().1 {
            Msg::Clock(byte, cycles) => me.gb.bus.serial.remote_clock(byte, cycles),
            Msg::Reply(byte) => me.gb.bus.serial.remote_reply(byte),
        }
        pump(me, other, now + delay);
    }
    let mut spent = 0;
    while spent < SLICE && !me.gb.bus.serial.stalled() {
        let c = me.gb.step_instruction().unwrap();
        spent += c;
        me.ran += c as u64;
        pump(me, other, now + delay);
    }
    if spent < SLICE {
        me.stalled_slices += 1;
    }
}

fn pump(me: &mut Node, other: &mut Node, at: u32) {
    if let Some(byte) = me.gb.bus.serial.take_reply() {
        other.inbox.push_back((at, Msg::Reply(byte)));
    }
    if let Some((byte, cycles)) = me.gb.bus.serial.take_request() {
        other.inbox.push_back((at, Msg::Clock(byte, cycles)));
    }
}

fn node(gb: GameBoy) -> Node {
    Node { gb, inbox: VecDeque::new(), ran: 0, stalled_slices: 0 }
}

fn received(gb: &GameBoy) -> Vec<u8> {
    (0..N as u16).map(|i| gb.bus.read_byte(0xC000 + i)).collect()
}

fn done(n: &Node) -> bool {
    n.gb.bus.read_byte(0xFF02) & 0x80 == 0 && received(&n.gb)[N as usize - 1] != 0
}

fn table(first: u8) -> Vec<u8> {
    (0..N).map(|i| first.wrapping_add(i)).collect()
}

#[test]
fn bytes_cross_the_network_whatever_the_delay() {
    for delay in [0, 1, 7, 40] {
        let mut master = node(rom(0x10, 0x81, 8, true));
        let mut slave = node(rom(0xA0, 0x80, 0, false));
        run(&mut master, &mut slave, delay, 20_000, |a, b| done(a) && done(b));
        assert_eq!(received(&master.gb), table(0xA0), "master receives the slave's bytes (delay {delay})");
        assert_eq!(received(&slave.gb), table(0x10), "slave receives the master's bytes (delay {delay})");
        assert_eq!(master.gb.bus.read_byte(0xFF0F) & 0x08, 0x08, "serial interrupt requested");
        assert_eq!(slave.gb.bus.read_byte(0xFF0F) & 0x08, 0x08, "serial interrupt requested");
        if delay > 0 {
            assert!(master.stalled_slices >= N as u32 * delay, "the master waited for each byte (delay {delay})");
        }
    }
}

#[test]
fn the_clocking_console_runs_the_same_whatever_the_delay() {
    // The master is paused while it waits: after the same number of its own cycles, it is in the same
    // state (registers, memory, timers) with a 0-slice or a 40-slice network.
    let states: Vec<Vec<u8>> = [0, 3, 40]
        .into_iter()
        .map(|delay| {
            let mut master = node(rom(0x10, 0x81, 8, true));
            let mut slave = node(rom(0xA0, 0x80, 0, false));
            run(&mut master, &mut slave, delay, 20_000, |a, b| done(a) && done(b));
            // Run on alone to a fixed point in the master's own time.
            let target = 40 * 70224;
            assert!(master.ran < target);
            while master.ran < target {
                master.ran += master.gb.step_instruction().unwrap() as u64;
            }
            master.gb.save_state()
        })
        .collect();
    assert!(states.windows(2).all(|w| w[0] == w[1]), "the master's run does not depend on the latency");
}

#[test]
fn two_consoles_clocking_at_once_both_read_ff_and_go_on() {
    let mut a = node(rom(0x10, 0x81, 0, false));
    let mut b = node(rom(0xA0, 0x81, 0, false));
    let at = run(&mut a, &mut b, 5, 20_000, |a, b| done(a) && done(b));
    assert!(at < 20_000, "no deadlock");
    assert_eq!(received(&a.gb), vec![0xFF; N as usize]);
    assert_eq!(received(&b.gb), vec![0xFF; N as usize]);
}

#[test]
fn a_partner_not_listening_answers_ff_after_the_hold() {
    let mut master = node(rom(0x10, 0x81, 0, false));
    let mut other = node(deaf());
    let at = run(&mut master, &mut other, 2, 20_000, |a, _| done(a));
    assert!(at < 20_000);
    assert_eq!(received(&master.gb), vec![0xFF; N as usize]);
    // Each byte waited for the whole hold on the partner's side.
    assert!(at as u64 * SLICE as u64 >= N as u64 * HOLD_CYCLES as u64);
}

#[test]
fn a_held_clock_goes_through_once_the_partner_listens() {
    // The slave only starts listening a while (under the hold) after the master's first byte arrives.
    let mut master = node(rom(0x10, 0x81, 0, true));
    let mut slave = node(rom(0xA0, 0x80, 40, false));
    run(&mut master, &mut slave, 0, 20_000, |a, b| done(a) && done(b));
    assert_eq!(received(&master.gb), table(0xA0));
    assert_eq!(received(&slave.gb), table(0x10));
}

#[test]
fn turning_the_remote_link_off_releases_a_stalled_transfer() {
    let mut gb = rom(0x10, 0x81, 0, false);
    gb.run_frame().unwrap();
    assert!(gb.bus.serial.stalled());
    let pc = gb.cpu.regs.pc;
    gb.run_frame().unwrap();
    assert_eq!(gb.cpu.regs.pc, pc, "a stalled console does not run");
    gb.bus.serial.set_remote(false);
    gb.run_frame().unwrap();
    assert_eq!(gb.bus.read_byte(0xC000), 0xFF, "the transfer completed as with no cable");
}
