; Cartouche boot ROMs: DMG, CGB and SGB, one per start-up animation.
;
; A fork of SameBoy's boot ROMs (BootROMs/dmg_boot.asm, cgb_boot.asm and sgb_boot.asm, SameBoy v1.0.3,
; https://github.com/LIJI32/SameBoy), Copyright (c) 2015-2026 Lior Halphon, under the Expat (MIT) License:
;
;   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
;   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
;   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
;   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
;
;   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
;   the Software.
;
;   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
;   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
;   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
;   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
;   IN THE SOFTWARE.
;
; Changes made for Cartouche (2026):
; - SameBoy's logo, its animation and its chime are replaced by one of three original animations ("Registration",
;   "Insert", "Shelf pick"), drawn from tables that gen.mjs builds from the approved concept model, and played on the
;   DMG and the SGB as well. CONCEPT = 0 builds the CGB boot without an animation (the colourisation only).
; - The cartridge's logo is never read, drawn, copied to VRAM or compared: the DMG-compatible logo tiles, the
;   logo tilemap some titles expect and the SGB's copy of it in the header packets (sent as zeros) are gone.
; - VRAM, OAM and the registers the animation used are cleared or reset before the hand-over, so a game starts
;   from the same machine state whichever animation played (or none).
; - Everything else a boot ROM does is SameBoy's: hardware set-up, the post-boot register values, the CGB's
;   title-checksum palette choice for original cartridges and the 12 button combinations, the SGB header packets,
;   and the hand-over through $FF50. The SameBoy-only A+B combinations stay too.
; - SameBoy's hardware.inc is not used (it carries the logo bytes in a macro); the few registers are defined below.
;
; Build: build.sh (rgbds, version pinned there). Defines: CGB or SGB (else DMG), CONCEPT 0-3.

; ---- hardware ----
DEF rP1    EQU $FF00
DEF rIF    EQU $FF0F
DEF rNR10  EQU $FF10
DEF rNR11  EQU $FF11
DEF rNR12  EQU $FF12
DEF rNR13  EQU $FF13
DEF rNR14  EQU $FF14
DEF rNR22  EQU $FF17
DEF rNR50  EQU $FF24
DEF rNR51  EQU $FF25
DEF rNR52  EQU $FF26
DEF rWAVE  EQU $FF30
DEF rLCDC  EQU $FF40
DEF rSCY   EQU $FF42
DEF rDMA   EQU $FF46
DEF rBGP   EQU $FF47
DEF rOBP0  EQU $FF48
DEF rOBP1  EQU $FF49
DEF rWY    EQU $FF4A
DEF rWX    EQU $FF4B
DEF rKEY0  EQU $FF4C
DEF rVBK   EQU $FF4F
DEF rBANK  EQU $FF50
DEF rHDMA1 EQU $FF51
DEF rBGPI  EQU $FF68
DEF rOBPI  EQU $FF6A
DEF rOPRI  EQU $FF6C
DEF rSVBK  EQU $FF70
DEF rIE    EQU $FFFF

DEF BOOTUP_A_DMG EQU $01
DEF BOOTUP_A_CGB EQU $11

; Cartridge header (visible at $0100-$01FF while the boot ROM is mapped)
DEF Title           EQU $0134
DEF CGBFlag         EQU $0143
DEF NewLicenseeCode EQU $0144
DEF OldLicenseeCode EQU $014B

MACRO lb ; r16, high, low
    ld \1, LOW(\2) << 8 | LOW(\3)
ENDM

DEF FRAMES EQU 160 ; the animation's length; the model fades out from frame 144
DEF wOAM   EQU $C000 ; OAM as built for the next frame, copied by OAM DMA in VBlank

SECTION "Start", ROM0[$0000]
    ld sp, $FFFE
    jp Main

IF DEF(CGB)
; SameBoy's palette choice for original cartridges, by title checksum. These three arrays share one 256-byte page.
TitleChecksums:
    db $00, $88, $16, $36, $D1, $DB, $F2, $3C, $8C, $92, $3D, $5C, $58, $C9, $3E, $70
    db $1D, $59, $69, $19, $35, $A8, $14, $AA, $75, $95, $99, $34, $6F, $15, $FF, $97
    db $4B, $90, $17, $10, $39, $F7, $F6, $A2, $49, $4E, $43, $68, $E0, $8B, $F0, $CE
    db $0C, $29, $E8, $B7, $86, $9A, $52, $01, $9D, $71, $9C, $BD, $5D, $6D, $67, $3F
    db $6B
FirstChecksumWithDuplicate: ; these need the 4th title letter too (Dups4thLetterArray)
    db $B3, $46, $28, $A5, $C6, $D3, $27, $61, $18, $66, $6A, $BF, $0D, $F4, $B3, $46
    db $28, $A5, $C6, $D3, $27, $61, $18, $66, $6A, $BF, $0D, $F4, $B3
ChecksumsEnd:

PalettePerChecksum: ; palette combination per checksum above (bit 7: SameBoy draws the logo tilemap; ignored here)
    db 0, 4, 5, 35, 34, 3, 31, 15, 10, 5, 19, 36, 7 | $80, 37, 30, 44
    db 21, 32, 31, 20, 5, 33, 13, 14, 5, 29, 5, 18, 9, 3, 2, 26
    db 25, 25, 41, 42, 26, 45, 42, 45, 36, 38, 26 | $80, 42, 30, 41, 34, 34
    db 5, 42, 6, 5, 33, 25, 42, 42, 40, 2, 16, 25, 42, 42, 5, 0
    db 39, 36, 22, 25, 6, 32, 12, 36, 11, 39, 18, 39, 24, 31, 50, 17
    db 46, 6, 27, 0, 47, 41, 41, 0, 0, 19, 34, 23, 18, 29

Dups4thLetterArray:
    db "BEFAARBEKEK R-URAR INAILICE R"
ENDC

SECTION "BootGame", ROM0[$00FE]
BootGame:
    ldh [rBANK], a ; unmap boot ROM

SECTION "Main", ROM0[$0200]
Main:
; Clear VRAM
    call ClearVRAM

; Clear OAM (a = 0, l = 0)
    ld h, $FE
    ld c, 160
    call Fill

IF DEF(CGB)
; Init waveform
    ld c, 16
    ld hl, rWAVE
.waveformLoop
    ldi [hl], a
    cpl
    dec c
    jr nz, .waveformLoop

; Clear chosen input palette and title checksum
    xor a
    ldh [hInputPalette], a
    ldh [hTitleChecksum], a

; Clear the second VRAM bank
    inc a
    ldh [rVBK], a
    call ClearVRAM
    ldh [rVBK], a
ENDC

; Init Audio
    ld a, $80
    ldh [rNR52], a
    ldh [rNR11], a
    ld a, $F3
    ldh [rNR12], a ; Envelope $F, decreasing, sweep $3
    ldh [rNR51], a ; Channels 1+2+3+4 left, channels 1+2 right
    ld a, $77
    ldh [rNR50], a ; Volume $7, left and right

IF CONCEPT != 0
; OAM DMA runs from HRAM
    ld hl, DMARoutine
    lb bc, DMARoutineEnd - DMARoutine, LOW(hDMA)
.copyDMA
    ld a, [hli]
    ldh [c], a
    inc c
    dec b
    jr nz, .copyDMA

; Frame 0, drawn while the LCD is off
    call ClearShadowOAM
    call LoadTiles
    call LoadMaps
    ld a, LOW(ConceptEvents)
    ldh [hEvents], a
    ld a, HIGH(ConceptEvents)
    ldh [hEvents + 1], a
    xor a
    ldh [hFrame], a
    call BuildOAM
    call ShowFrame
    ld a, [ConceptLCDC]
    ldh [rLCDC], a

; Each frame's OBJs are built while the previous one is drawn, then shown in VBlank with its register writes
.animate
    ld hl, hFrame
    inc [hl]
    ld a, [hl]
    cp FRAMES
    jr z, .animationDone
    call BuildOAM
    call WaitFrame
    call ShowFrame
    jr .animate
.animationDone

; Back to a blank machine: the LCD goes off in VBlank, VRAM and OAM are cleared
    call WaitFrame
    xor a
    ldh [rLCDC], a
    call ClearVRAM
    ld h, $FE
    ld c, 160
    call Fill
    call ClearShadowOAM
ENDC

; Registers the animation may have changed, back to their post-boot values (the ch1 frequency is SameBoy's last note)
    xor a
    ldh [rSCY], a
    ldh [rWY], a
    ldh [rWX], a
    ldh [rNR10], a
    ldh [rNR22], a ; channel 2 off
    ld a, $80
    ldh [rNR11], a
    ld a, $F3
    ldh [rNR12], a
    ld a, $C1
    ldh [rNR13], a
    ld a, $07
    ldh [rNR14], a
    ld a, $FF
    ldh [rOBP0], a
    ldh [rOBP1], a
    ld a, %11_11_11_00
    ldh [rBGP], a
    ld a, $91 ; LCD on, BG on, tiles at $8000
    ldh [rLCDC], a

IF DEF(CGB)
; Every BG palette white and OBJ palettes 0-1 cleared, as SameBoy leaves them (its fade leaves colour 0 at $FFFF)
    ld c, LOW(rBGPI)
    ld a, $80
    ldh [c], a
    inc c
    ld b, 8
.whiteLoop
    ld a, $FF
    ldh [c], a
    ldh [c], a
    ld d, 3
.whiteColor
    ld a, $FF
    ldh [c], a
    ld a, $7F
    ldh [c], a
    dec d
    jr nz, .whiteColor
    dec b
    jr nz, .whiteLoop
    inc c
    ld a, $80
    ldh [c], a
    inc c
    ld b, 16
    xor a
.objLoop
    ldh [c], a
    dec b
    jr nz, .objLoop

    call GetInputPaletteIndex
    call Preboot
    jp BootGame

ELIF DEF(SGB)
    call SendHeader
; Set registers to match the original SGB boot
    ld hl, BOOTUP_A_DMG << 8
    push hl
    pop af
    ld bc, $0014
    ld de, $0000
    ld hl, $C060
    jp BootGame

ELSE
; Set registers to match the original DMG boot
    ld hl, BOOTUP_A_DMG << 8 | %10110000
    push hl
    pop af
    ld bc, $0013
    ld de, $00D8
    ld hl, $014D
    jp BootGame
ENDC


; ---- helpers ----
WaitFrame:
    push hl
    ld hl, rIF
    res 0, [hl]
.wait
    bit 0, [hl]
    jr z, .wait
    pop hl
    ret

ClearVRAM:
    ld hl, $8000
; Clear from HL to HL | 0x2000
ClearMemoryPage:
    xor a
    ldi [hl], a
    bit 5, h
    jr z, ClearMemoryPage
    ret

; c bytes of a at hl
Fill:
    ldi [hl], a
    dec c
    jr nz, Fill
    ret

IF CONCEPT != 0
ClearShadowOAM:
    ld hl, wOAM
    ld c, 160
    xor a
    jr Fill

DMARoutine:
LOAD "DMA", HRAM
hDMA:
    ldh [rDMA], a
    ld a, 40
.wait
    dec a
    jr nz, .wait
    ret
ENDL
DMARoutineEnd:

; Tiles 1 and up: a colour byte then 8 rows of one bit per pixel, or 0 then 16 bytes of 2bpp. $FF ends.
LoadTiles:
    ld hl, ConceptTiles
    ld de, $8010
.tile
    ld a, [hli]
    cp $FF
    ret z
    and a
    jr z, .raw
    ld c, a
    ld b, 8
.row
    ld a, [hl]
    bit 0, c
    jr nz, .plane0
    xor a
.plane0
    ld [de], a
    inc de
    ld a, [hli]
    bit 1, c
    jr nz, .plane1
    xor a
.plane1
    ld [de], a
    inc de
    dec b
    jr nz, .row
    jr .tile
.raw
    ld b, 16
.rawLoop
    ld a, [hli]
    ld [de], a
    inc de
    dec b
    jr nz, .rawLoop
    jr .tile

; Rectangles of tilemap: address (high byte first), width, height, tiles row by row. 0 ends.
LoadMaps:
    ld hl, ConceptMaps
.rect
    ld a, [hli]
    and a
    ret z
    ld d, a
    ld a, [hli]
    ld e, a
    ld a, [hli]
    ld b, a
    ld a, [hli]
    ld c, a
.rows
    push de
    push bc
.cols
    ld a, [hli]
    ld [de], a
    inc de
    dec b
    jr nz, .cols
    pop bc
    pop de
    ld a, e
    add 32
    ld e, a
    adc d
    sub e
    ld d, a
    dec c
    jr nz, .rows
    jr .rect

; OAM for frame [hFrame] into wOAM. Per group: start frame, runs of (frames, x, y) ended by 0 (the last run
; holds), OBJ count, then per OBJ dy, dx, tile, attributes. $FF ends. Groups start in order and never leave.
BuildOAM:
    ld hl, ConceptGroups
    ld de, wOAM
.group
    ld a, [hli]
    ld b, a
    ldh a, [hFrame]
    sub b
    ret c ; not shown yet, nor any group after it ($FF: the end)
    ld c, a ; frames since the group appeared
.run
    ld a, [hli]
    and a
    jr z, .emit
    ld b, a
    ld a, [hli]
    ldh [hX], a
    ld a, [hli]
    ldh [hY], a
    ld a, c
    sub b
    ld c, a
    jr nc, .run
.skip
    ld a, [hli]
    and a
    jr z, .emit
    inc hl
    inc hl
    jr .skip
.emit
    ld b, [hl]
    inc hl
.obj
    ldh a, [hY]
    add [hl]
    inc hl
    add 16
    cp $90 ; y + dy < -16: above the screen, hidden
    jr c, .shown
    xor a
.shown
    ld [de], a
    inc e
    ldh a, [hX]
    add [hl]
    inc hl
    add 8
    ld [de], a
    inc e
    ld a, [hli]
    ld [de], a
    inc e
    ld a, [hli]
    ld [de], a
    inc e
    dec b
    jr nz, .obj
    jr .group

; In VBlank: OAM from wOAM, then the frame's writes. Per frame: frame, items, 0; frame $FF ends. Item: an I/O
; register ($10-$4F) and its value; BCPS/OCPS ($68/$6A), a count and that many palette bytes from index 0; or a
; VRAM address ($98-$9F, high byte first) and its value.
ShowFrame:
    ld a, HIGH(wOAM)
    call hDMA
    ldh a, [hEvents]
    ld l, a
    ldh a, [hEvents + 1]
    ld h, a
    ldh a, [hFrame]
    cp [hl]
    ret nz
    inc hl
.item
    ld a, [hli]
    and a
    jr z, .done
    cp $80
    jr nc, .vram
    ld c, a
    cp LOW(rBGPI)
    jr z, .burst
    cp LOW(rOBPI)
    jr z, .burst
    ld a, [hli]
    ldh [c], a
    jr .item
.burst
    ld a, $80
    ldh [c], a
    inc c
    ld b, [hl]
    inc hl
.color
    ld a, [hli]
    ldh [c], a
    dec b
    jr nz, .color
    jr .item
.vram
    ld d, a
    ld e, [hl]
    inc hl
    ld a, [hli]
    ld [de], a
    jr .item
.done
    ld a, l
    ldh [hEvents], a
    ld a, h
    ldh [hEvents + 1], a
    ret
ENDC

IF DEF(SGB)
; The cartridge header, $0104-$014F, to the SNES side in six packets as SameBoy sends it (the SNES side checks
; the logo; here the logo area, $0104-$0133, is never read and goes out as zeros).
SendHeader:
    ld a, $F1 ; Packet magic, increases by 2 for every packet
    ldh [hCommand], a
    ld hl, $0104 ; Header start

    xor a
    ld c, a ; JOYP

.sendCommand
    xor a
    ldh [c], a
    ld a, $30
    ldh [c], a

    ldh a, [hCommand]
    call SendByte
    push hl

    ld b, 14
    ld d, 0
.checksumLoop
    call ReadHeaderByte
    add d
    ld d, a
    dec b
    jr nz, .checksumLoop

    ; Send checksum
    call SendByte
    pop hl

    ld b, 14
.sendLoop
    call ReadHeaderByte
    call SendByte
    dec b
    jr nz, .sendLoop

    ; Done bit
    ld a, $20
    ldh [c], a
    ld a, $30
    ldh [c], a

    ; Wait 4 frames
    ld e, 4
    ld a, 1
    ldh [rIE], a
    xor a
.waitLoop
    ldh [rIF], a
    halt
    nop
    dec e
    jr nz, .waitLoop
    ldh [rIE], a

    ; Update command
    ldh a, [hCommand]
    add 2
    ldh [hCommand], a

    ld a, $58
    cp l
    jr nz, .sendCommand
    ret

ReadHeaderByte:
    ld a, l
    cp $34 ; the logo area
    jr c, .zero
    cp $50
    jr nc, .zero
    ld a, [hli]
    ret
.zero:
    inc hl
    xor a
    ret

SendByte:
    ld e, a
    ld d, 8
.loop
    ld a, $10
    rr e
    jr c, .zeroBit
    add a ; 10 -> 20
.zeroBit
    ldh [c], a
    ld a, $30
    ldh [c], a
    dec d
    ret z
    jr .loop
ENDC

IF DEF(CGB)
; ---- SameBoy's CGB hand-over: colourisation of original cartridges ----
Preboot:
    ld a, 2
    ldh [rSVBK], a
    ; Clear RAM Bank 2 (Like the original boot ROM)
    ld hl, $D000
    call ClearMemoryPage
    inc a
    call ClearVRAMViaHDMA
    call _ClearVRAMViaHDMA
    call ClearVRAMViaHDMA ; A = $40, so it's bank 0
    xor a
    ldh [rSVBK], a
    cpl
    ldh [rP1], a

    ; Final values for CGB mode
    ld d, a
    ld e, c
    ld l, $0D

    ld a, [CGBFlag]
    bit 7, a
    call z, EmulateDMG
    bit 7, a

    ldh [rKEY0], a ; write CGB compatibility byte, CGB mode
    ldh a, [hTitleChecksum]
    ld b, a

    jr z, .skipDMGForCGBCheck
    ldh a, [hInputPalette]
    and a
    jr nz, .emulateDMGForCGBGame
.skipDMGForCGBCheck
    ; Set registers to match the original CGB boot
    ; AF = $1180, C = 0
    xor a
    ld c, a
    ld a, BOOTUP_A_CGB
    ld h, c
    ; B is set to the title checksum (BOOTUP_B_CGB, 0)
    ret

.emulateDMGForCGBGame
    call EmulateDMG
    ldh [rKEY0], a ; write $04, DMG emulation mode
    ld a, $1
    ret

HDMAData:
    db HIGH($D000), LOW($D000), HIGH($9800 + 5 * 32), LOW($9800 + 5 * 32), 18
    db HIGH($D000), LOW($D000), HIGH($8000), LOW($8000), 64

GetKeyComboPalette:
    ld hl, KeyCombinationPalettes - 1 ; Return value is 1-based, 0 means nothing down
    ld c, a
    ld b, 0
    add hl, bc
    ld a, [hl]
    ret

EmulateDMG:
    ld a, 1
    ldh [rOPRI], a ; DMG Emulation sprite priority
    call GetPaletteIndex
    res 7, a ; (SameBoy draws the logo's tilemap for these titles; there is no logo here)
    ld b, a
    add b
    add b
    ld b, a
    ldh a, [hInputPalette]
    and a
    jr z, .nothingDown
    call GetKeyComboPalette
    jr .paletteFromKeys
.nothingDown
    ld a, b
.paletteFromKeys
    call WaitFrame
    call LoadPalettesFromIndex
    ld a, 4
    ; Set the final values for DMG mode
    ld de, 8
    ld l, $7C
    ret

GetPaletteIndex:
    ld hl, OldLicenseeCode
    ld a, [hl]
    cp $33
    jr z, .newLicensee
    dec a ; 1 = Nintendo
    jr nz, .notNintendo
    jr .doChecksum
.newLicensee
    ld l, LOW(NewLicenseeCode)
    ld a, [hli]
    cp $30 ; ASCII '0'
    jr nz, .notNintendo
    ld a, [hl]
    cp $31 ; ASCII '1'
    jr nz, .notNintendo

.doChecksum
    ld l, LOW(Title)
    ld c, 16
    xor a
.checksumLoop
    add [hl]
    inc l
    dec c
    jr nz, .checksumLoop
    ldh [hTitleChecksum], a
    ld b, a

    ; c = 0
    ld hl, TitleChecksums

.searchLoop
    ld a, l
    sub LOW(ChecksumsEnd) ; use sub to zero out a
    ret z
    ld a, [hli]
    cp b
    jr nz, .searchLoop

    ; We might have a match, Do duplicate/4th letter check
    ld a, l
    sub FirstChecksumWithDuplicate - TitleChecksums + 1
    jr c, .match ; Does not have a duplicate, must be a match!
    ; Has a duplicate; check 4th letter
    push hl
    ld a, l
    add Dups4thLetterArray - FirstChecksumWithDuplicate - 1 ; -1 since hl was incremented
    ld l, a
    ld a, [hl]
    pop hl
    ld c, a
    ld a, [Title + 3] ; Get 4th letter
    cp c
    jr nz, .searchLoop ; Not a match, continue

.match
    ld a, l
    add PalettePerChecksum - TitleChecksums - 1; -1 since hl was incremented
    ld l, a
    ld a, b
    ldh [hTitleChecksum], a
    ld a, [hl]
    ret

.notNintendo
    xor a
    ret

; optimizations in callers rely on this returning with b = 0
GetPaletteCombo:
    ld hl, PaletteCombinations
    ld b, 0
    ld c, a
    add hl, bc
    ret

LoadPalettesFromIndex: ; a = index of combination
    call GetPaletteCombo

    ; Obj Palettes
    ld e, 0
.loadObjPalette
    ld a, [hli]
    push hl
    ld hl, Palettes
    ; b is already 0
    ld c, a
    add hl, bc
    ld d, 4 * 2
    ld c, LOW(rOBPI)
    call LoadPalettes
    pop hl
    bit 3, e
    jr nz, .loadBGPalette
    ld e, 8
    jr .loadObjPalette
.loadBGPalette
    ;BG Palette
    ld c, [hl]
    ; b is already 0
    ld hl, Palettes
    add hl, bc
    ld d, 8
    ld e, 0
    ld c, LOW(rBGPI)
LoadPalettes:
    ld a, $80
    or e
    ldh [c], a
    inc c
.loop
    ld a, [hli]
    ldh [c], a
    dec d
    jr nz, .loop
    ret

ClearVRAMViaHDMA:
    ldh [rVBK], a
    ld hl, HDMAData
_ClearVRAMViaHDMA:
    call WaitFrame ; Wait for vblank
    ld c, LOW(rHDMA1)
    ld b, 5
.loop
    ld a, [hli]
    ldh [c], a
    inc c
    dec b
    jr nz, .loop
    ret

; The held direction (+ A, B) picks a palette: hInputPalette = 1-16, 0 when none. (SameBoy also recolours its
; logo as the combination changes; there is no logo here.)
GetInputPaletteIndex:
    ld a, $20 ; directions
    ldh [rP1], a
    ldh a, [rP1]
    cpl
    and $F
    ret z ; No direction keys pressed, no palette

    ld l, 0
.directionLoop
    inc l
    rra
    jr nc, .directionLoop

    ; l = 1: Right, 2: Left, 3: Up, 4: Down

    ld a, $10 ; buttons
    ldh [rP1], a
    ldh a, [rP1]
    cpl
    rla
    rla
    and $C
    add l
    ldh [hInputPalette], a
    ret

PaletteCombinations:
MACRO palette_comb ; Obj0, Obj1, Bg
    db (\1) * 8, (\2) * 8, (\3) *8
ENDM
MACRO raw_palette_comb ; Obj0, Obj1, Bg
    db (\1) * 2, (\2) * 2, (\3) * 2
ENDM
    palette_comb  4,  4, 29 ;  0, Right + A
    palette_comb 18, 18, 18 ;  1, Right
    palette_comb 20, 20, 20 ;  2
    palette_comb 24, 24, 24 ;  3, Down + A
    palette_comb  9,  9,  9 ;  4
    palette_comb  0,  0,  0 ;  5, Up
    palette_comb 27, 27, 27 ;  6, Right + B
    palette_comb  5,  5,  5 ;  7, Left + B
    palette_comb 12, 12, 12 ;  8, Down
    palette_comb 26, 26, 26 ;  9
    palette_comb 16,  8,  8 ; 10
    palette_comb  4, 28, 28 ; 11
    palette_comb  4,  2,  2 ; 12
    palette_comb  3,  4,  4 ; 13
    palette_comb  4, 29, 29 ; 14
    palette_comb 28,  4, 28 ; 15
    palette_comb  2, 17,  2 ; 16
    palette_comb 16, 16,  8 ; 17
    palette_comb  4,  4,  7 ; 18
    palette_comb  4,  4, 18 ; 19
    palette_comb  4,  4, 20 ; 20
    palette_comb 19, 19,  9 ; 21
    raw_palette_comb 4 * 4 - 1, 4 * 4 - 1, 11 * 4 ; 22
    palette_comb 17, 17,  2 ; 23
    palette_comb  4,  4,  2 ; 24
    palette_comb  4,  4,  3 ; 25
    palette_comb 28, 28,  0 ; 26
    palette_comb  3,  3,  0 ; 27
    palette_comb  0,  0,  1 ; 28, Up + B
    palette_comb 18, 22, 18 ; 29
    palette_comb 20, 22, 20 ; 30
    palette_comb 24, 22, 24 ; 31
    palette_comb 16, 22,  8 ; 32
    palette_comb 17,  4, 13 ; 33
    raw_palette_comb 28 * 4 - 1, 0 * 4, 14 * 4 ; 34
    raw_palette_comb 28 * 4 - 1, 4 * 4, 15 * 4 ; 35
    raw_palette_comb 19 * 4, 23 * 4 - 1, 9 * 4 ; 36
    palette_comb 16, 28, 10 ; 37
    palette_comb  4, 23, 28 ; 38
    palette_comb 17, 22,  2 ; 39
    palette_comb  4,  0,  2 ; 40, Left + A
    palette_comb  4, 28,  3 ; 41
    palette_comb 28,  3,  0 ; 42
    palette_comb  3, 28,  4 ; 43, Up + A
    palette_comb 21, 28,  4 ; 44
    palette_comb  3, 28,  0 ; 45
    palette_comb 25,  3, 28 ; 46
    palette_comb  0, 28,  8 ; 47
    palette_comb  4,  3, 28 ; 48, Left
    palette_comb 28,  3,  6 ; 49, Down + B
    palette_comb  4, 28, 29 ; 50
    ; SameBoy "Exclusives"
    palette_comb 30, 30, 30 ; 51, Right + A + B, CGA
    palette_comb 31, 31, 31 ; 52, Left + A + B, DMG LCD
    palette_comb 28,  4,  1 ; 53, Up + A + B
    palette_comb  0,  0,  2 ; 54, Down + A + B

Palettes:
    dw $7FFF, $32BF, $00D0, $0000 ;  0
    dw $639F, $4279, $15B0, $04CB ;  1
    dw $7FFF, $6E31, $454A, $0000 ;  2
    dw $7FFF, $1BEF, $0200, $0000 ;  3
    dw $7FFF, $421F, $1CF2, $0000 ;  4
    dw $7FFF, $5294, $294A, $0000 ;  5
    dw $7FFF, $03FF, $012F, $0000 ;  6
    dw $7FFF, $03EF, $01D6, $0000 ;  7
    dw $7FFF, $42B5, $3DC8, $0000 ;  8
    dw $7E74, $03FF, $0180, $0000 ;  9
    dw $67FF, $77AC, $1A13, $2D6B ; 10
    dw $7ED6, $4BFF, $2175, $0000 ; 11
    dw $53FF, $4A5F, $7E52, $0000 ; 12
    dw $4FFF, $7ED2, $3A4C, $1CE0 ; 13
    dw $03ED, $7FFF, $255F, $0000 ; 14
    dw $036A, $021F, $03FF, $7FFF ; 15
    dw $7FFF, $01DF, $0112, $0000 ; 16
    dw $231F, $035F, $00F2, $0009 ; 17
    dw $7FFF, $03EA, $011F, $0000 ; 18
    dw $299F, $001A, $000C, $0000 ; 19
    dw $7FFF, $027F, $001F, $0000 ; 20
    dw $7FFF, $03E0, $0206, $0120 ; 21
    dw $7FFF, $7EEB, $001F, $7C00 ; 22
    dw $7FFF, $3FFF, $7E00, $001F ; 23
    dw $7FFF, $03FF, $001F, $0000 ; 24
    dw $03FF, $001F, $000C, $0000 ; 25
    dw $7FFF, $033F, $0193, $0000 ; 26
    dw $0000, $4200, $037F, $7FFF ; 27
    dw $7FFF, $7E8C, $7C00, $0000 ; 28
    dw $7FFF, $1BEF, $6180, $0000 ; 29
    ; SameBoy "Exclusives"
    dw $7FFF, $7FEA, $7D5F, $0000 ; 30, CGA 1
    dw $4778, $3290, $1D87, $0861 ; 31, DMG LCD

KeyCombinationPalettes:
MACRO palette_comb_id ; PaletteCombinations ID
    db (\1) * 3
ENDM
    palette_comb_id  1 ;  1, Right
    palette_comb_id 48 ;  2, Left
    palette_comb_id  5 ;  3, Up
    palette_comb_id  8 ;  4, Down
    palette_comb_id  0 ;  5, Right + A
    palette_comb_id 40 ;  6, Left + A
    palette_comb_id 43 ;  7, Up + A
    palette_comb_id  3 ;  8, Down + A
    palette_comb_id  6 ;  9, Right + B
    palette_comb_id  7 ; 10, Left + B
    palette_comb_id 28 ; 11, Up + B
    palette_comb_id 49 ; 12, Down + B
    ; SameBoy "Exclusives"
    palette_comb_id 51 ; 13, Right + A + B
    palette_comb_id 52 ; 14, Left + A + B
    palette_comb_id 53 ; 15, Up + A + B
    palette_comb_id 54 ; 16, Down + A + B

ENDC

IF CONCEPT == 1
    INCLUDE "concept_a.inc"
ELIF CONCEPT == 2
    INCLUDE "concept_b.inc"
ELIF CONCEPT == 3
    INCLUDE "concept_c.inc"
ENDC

; A CGB maps its boot ROM at $0000-$00FF and $0200-$08FF. With an animation's tables these run to $0AFF, which
; Cartouche maps too (memory.rs: $0200 to the image's end, the cartridge header at $0100-$01FF showing through).
BootEnd:
IF BootEnd > $0B00
    FAIL "BootROM overflowed: {BootEnd}"
ENDC
    ds $0B00 - @

SECTION "HRAM", HRAM[$FF80]
hTitleChecksum:
    ds 1
hInputPalette:
    ds 1
hFrame:
    ds 1
hEvents:
    ds 2
hX:
    ds 1
hY:
    ds 1
hCommand:
    ds 1
