/*
        JSNascom: A Nascom 2 emulator in JavaScript
        Copyright (C) 2011 Tommy Thorn

        Contact details: <nascomhomepage@thorn.ws>

        partly based on JSSpeccy: Spectrum architecture implementation
        for JSSpeccy, a ZX Spectrum emulator in Javascript

        This program is free software: you can redistribute it and/or modify
        it under the terms of the GNU General Public License as published by
        the Free Software Foundation, either version 3 of the License, or
        (at your option) any later version.

        This program is distributed in the hope that it will be useful,
        but WITHOUT ANY WARRANTY; without even the implied warranty of
        MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
        GNU General Public License for more details.

        You should have received a copy of the GNU General Public License
        along with this program.  If not, see <http://www.gnu.org/licenses/>.


    A Nascom consists of:

    - a Z80 CPU,
    - an UART,
    - a bitmapped keyboard,
    - memory:
        0000 - 07ff  2 KiB ROM monitor,
        0800 - 0bff  1 KiB screen memory,
        0c00 - 0fff  1 KiB workspace
        1000 - dfff 52 KiB memory
        e000 - ffff  8 KiB of MS Basic

  With the Z80 emulator in place the first thing to get working is the
  screen memory.  The simplest way to simulate screen memory is to
  trap upon writes.

*/

var phys_mem;
var memory;
var phys_mem16;
var phys_mem32;

var canvas;
var ctx;
var imageData;
var imageDataData;

var keyp = 0;
var port0 = 0;
var tape_led = 0;
var led_off_str = "";
var keym = [0, 0, 0, 0, 0, 0, 0, 0, 0];

var replay_active = 0;
var replay_active_go = 10;
var replay_line = ""
var replay_p   = 0;
var replay_down = true;

var serial_input = "";
var serial_input_p = 0;

var nmi_pending = false;

fdc = new Object();
fdc.s = { IDLE : 0, DRV: 1, TRK: 2, INRD : 3, INWR : 4 };

function advance_replay() {
    replay_active = replay_active_go;
    sim_key(replay_line[replay_p], replay_down);
    if (replay_down == false) {
        ++replay_p;
        if (replay_line.length == replay_p)
            replay_active = 0;
    }
    replay_down = !replay_down;
}

function replay_kbd(str) {
    if (str.length == 0)
        return;
    replay_active = replay_active_go;
    replay_p = 0;
    replay_down = true;
    replay_line = str;
}

function form_enter() {
/*
    var t1 = document.getElementById('t1');
    replay_kbd(t1.value + "\n");
    t1.value = ""; */
}

function nascom_save() {
    if (!phys_mem32)
        return;
    var serialized = "";
    for (i = 0; i < 16384; ++i)
        serialized += phys_mem32[i] + ",";
    localStorage.setItem("memory", serialized);
    console.log("Save memory");
}

// XXX Shouldn't assume an int, but a char
function hexdigitValue(ch) {
    if (48 <= ch && ch < 58)
        return ch - 48;
    else if (65 <= ch && ch <= 70)
        return ch - 55;
    else if (97 <= ch && ch <= 102)
        return ch - 87;
    else
        return -1;
}

// XXX Shouldn't assume an int, but a char
function isxdigit(ch) { return hexdigitValue(ch) != -1; }

var fileIOOk = false;

function start_repo_program() {
    var program =  document.getElementById("LibProg").value;
    console.log("Start " + program);

    serial_input = repo[program];
    serial_input_p = 0;
    z80_reset();
// for BASIC
//    replay_kbd("j\n\ncload\n");
//    led_off_str = "run\n";
// for M.C
    replay_kbd("R\n");
    led_off_str = "E1000\n";
}

function nascom_load(val) {
    console.log("Restore memory");
    if (!phys_mem32)
        return;
    var aval = val.split(",");
    for (i = 0; i < 16384; ++i)
        phys_mem32[i] = parseInt(aval[i]);
}


// Run when you navigate away from jsnascom.html
// Could call nascom_save() but that might not be what the
// user wants, so leave that as an explicit action ("save state" button)
function nascom_unload(val) {
    console.log("Bye bye");
}

function read_hex(s, p, n) {
    if (s.length <= p + n) {
        alert("read past end of file");
        return null;
    }

    var v = 0;

    while (n > 0 && p < s.length) {
        var ch = s.charCodeAt(p);

        if (isxdigit(ch))
            v = 16*v + hexdigitValue(ch);
        else {
            alert("read_hex "+ s.charAt(p)+ "@" + p+ " is not a hex digit");

            return null;
        }

        ++p;
        --n;
    }

    return v;
}

var start_addr = null;

function load_ihex_line(s, p, memory) {
    // Expect lines like this:
    // 10010000214601360121470136007EFE09D2190140
    // That is (without spaces)
    // CC AAAAA TT DD DD DD .. DD KK
    // CC is the byte count (# of DD pairs)
    // AA is the 16-bit address (offset) from base
    // TT is the type
    // KK checksum (twos compliment of sum of all bytes)

    var count = read_hex(s, p, 2);
    if (count == null)
        return;
    p += 2;

    var addr = read_hex(s, p, 4);
    if (addr == null)
        return;
    p += 4;

    var type = read_hex(s, p, 2);
    if (type == null)
        return;
    p += 2;

    if (type == 5)
        start_addr = addr;

    while (count > 0 && p < s.length) {
        var v = read_hex(s, p, 2);
        if (v == null)
            return;
        p += 2;

        if (addr >= 2048 && addr < 65536)
            memory[addr] = v;
        ++addr;
        --count;
    }

    var chk = read_hex(s, p, 2);
    if (chk == null)
        return null;
    p += 2;

    // ignore chk

    while (p < s.length && (s.charAt(p) == '\n' || s.charAt(p) == '\r')) {
        ++p;
    }

    return p;
}

function load_ihex(s, memory) {
    var p = 0;

    start_addr = 4096|0;

    while (p != null && p < s.length && s.charAt(p) == ':') {
        p = load_ihex_line(s, p + 1, memory);
    }

    if (p == null || p > s.length)
        alert("load error");
    else {
        z80_reset();
        replay_kbd("E"+(start_addr|0).toString(16)+"\n");
    }
}

function ui_ihex_load() {
    var reader = new FileReader();
    reader.onload = (function(theFile) {
        return function(contents) {
            load_ihex(contents.target.result, memory);
        };
    })(document.getElementById('load_ihex').files[0]);

    // Read in the image file as a data URL.
    reader.readAsBinaryString(document.getElementById('load_ihex').files[0]);
}

// Update an LED in the UI
function ui_led(id,wdata,mask) {
    if (document.getElementById(id)) {
        var x = document.getElementById(id)
        if ((wdata & mask) ) {
            x.setAttribute("src", "red25.png");
        } else {
            x.setAttribute("src", "grey25.png");
        }
    }
}

function nascom_init() {
    var i;

    if (!'localStorage' in window || window['localStorage'] === null)
        alert("Your browser doesn't supports localStorage");

/*
    if (!window.File) alert("No window.File support in this browser");
    if (!window.FileReader) alert("No window.FileReader support in this browser");
    if (!window.FileList) alert("No window.FileList support in this browser");
    if (!window.Blob) alert("No window.Blob support in this browser");
*/

    // Check for the various File API support.
    if (window.File && window.FileReader && window.FileList && window.Blob) {
        // Great success! All the File APIs are supported.
        fileIOOk = true;
    }

    if (!window.BlobBuilder && window.WebKitBlobBuilder) {
        console.log("Compat: Using WebKitBlobBuilder as BlobBuilder");
        window.BlobBuilder = window.WebKitBlobBuilder;
    }

    var IsiPhone = navigator.userAgent.indexOf("iPhone") != -1 ;
    var IsiPod = navigator.userAgent.indexOf("iPod") != -1 ;
    var IsiPad = navigator.userAgent.indexOf("iPad") != -1 ;

    var IsiPhoneOS = IsiPhone || IsiPad || IsiPod ;

    if (IsiPhoneOS) {
        console.log("navigator.userAgent is iOS");

        var xx = document.getElementById("t1");

        if (xx) {
            //xx.onclick = start_repo_program;
            //xx.onkeydown  = function (evt) { alert("keydown"+(evt.which?evt.which :evt.keyCode)); return false; };
            //xx.onkeyup    = function (evt) { alert("keyup"+(evt.which?evt.which :evt.keyCode));   return false; };
            xx.onkeypress    = function (evt) {
                var ch = evt.which ? evt.which :evt.keyCode;

                if (ch == 13)
                    ch = 10;

                replay_kbd(String.fromCharCode(ch));
                //console.log("keypress " + ch + "=" + replay_line);
                var t1 = document.getElementById('t1');
                t1.value = "";
                return true; };
        }
        else {
            alert("No t1 found?");
        }
    }
    else {
        /* On the iPhone, the only way I have found to get keyboard
         * events is by focusing an input field *and* using an
         * external bluetooth keyboard. Even so, we do not appear to
         * get modifier events.  More investigation needed, but it's
         * clear that this needs more support. */
        document.onkeydown  = keyDown;
        document.onkeyup    = keyUp;
        document.onkeypress = keyPress;
    }

//  document.addEventListener('touchstart', touchStart, false);
//  document.addEventListener('touchend', touchEnd, false);

    if (document.getElementById("reset"))
        document.getElementById("reset").onclick = nascom_reset;

    if (document.getElementById("nmi"))
        document.getElementById("nmi").onclick = z80_nmi;

    if (document.getElementById("clear"))
        document.getElementById("clear").onclick = nascom_clear;

    if (document.getElementById("save"))
        document.getElementById("save").onclick = nascom_save;

    if (document.getElementById("keys"))
        document.getElementById("keys").onclick = start_repo_program;

    if (fileIOOk && document.getElementById("serial_input"))
        document.getElementById("serial_input").onchange = function() {
            var reader = new FileReader();
            reader.onload = (function(theFile) {
                return function(contents) {
                    serial_input = contents.target.result;
                    serial_input_p = 0;
                };
            })(this.files[0]);

            // Read in the image file as a data URL.
            reader.readAsBinaryString(this.files[0]);
        }

    if (fileIOOk && document.getElementById('load_nas'))
        document.getElementById('load_nas').onchange = function() {
            var reader = new FileReader();
            reader.onload = (function(theFile) {
                return function(contents) {
                    var s = contents.target.result;
                    var p = 0;

                    // Expect lines like this:
                    // nnnXXXXnXXnXXnXXnXXnXXnXXnXXnXXnXXnnnnn where X is a
                    // hexidecimal digit and n is not.  Note, the last digit
                    // is a checksum, but we treat it like any other with no
                    // ill effect.

                    var a = 0;
                    while (p < s.length) {
                        while (p < s.length && !isxdigit(s.charCodeAt(p))) ++p;
                        var d, v;
                        for (v = d = 0; p < s.length && isxdigit(s.charCodeAt(p)); ++p, ++d)
                            v = 16*v + hexdigitValue(s.charCodeAt(p));
                        if (d == 4)
                            a = v;
                        else if (d == 2)
                            memory[a++] = v;
                    }
                };
            })(this.files[0]);

            // Read in the image file as a data URL.
            reader.readAsBinaryString(this.files[0]);
        }

    if (document.getElementById('load_ihex'))
        document.getElementById('load_ihex').onchange = ui_ihex_load;

    if (document.getElementById('reload'))
        document.getElementById('reload').onclick  =
        function (evt) { ui_ihex_load();
                         return false; };

    /* This only works on Chrome */

    if (0 && window.BlobBuilder) {
        var serialOutputBlob = new window.BlobBuilder();
        serialOutputBlob.append("Lorem ipsum");
        //var fileSaver = window.saveAs(serialOutputBlob.getBlob(), "test_file");
        //fileSaver.onwriteend = (function (evt) { alert("done"); });

        var blob = serialOutputBlob.getBlob("application/octet-stream");
        var saveas = document.createElement("iframe");
        saveas.style.display = "none";
        saveas.src = window.createBlobURL(blob);

        if (window.createObjectURL)
            saveas.src = window.webkitURL.createObjectURL(blob);
        else
            saveas.src = window.createObjectURL(blob);
    }

    // Populate list of library programs
    var catOptions = "";
    Object.keys(repo).forEach(function(key) {
        catOptions += "<option>" + key + "</option>";
    });
    document.getElementById("LibProg").innerHTML = catOptions;

    // Populate list of ROMs
    var ROMOptions = "";
    Object.keys(nascom_rom).forEach(function(key) {
        ROMOptions += "<option>" + key + "</option>";
    });
    document.getElementById("ROM").innerHTML = ROMOptions;

    z80_init();
    fdc_init();

    var ea = 64 * 1024;
    phys_mem   = new ArrayBuffer(ea);
    memory     = new Uint8Array(this.phys_mem, 0, ea);
    phys_mem16 = new Uint16Array(this.phys_mem, 0, ea / 2);
    phys_mem32 = new Int32Array(this.phys_mem, 0, ea / 4);

    // Memory
    for (i = 0x800; i < 0xE000; i++)
        memory[i] = 0;

    var val = localStorage.getItem("memory");

    if (val !== null)
        nascom_load(val);

    // ROM Basic
    for (i = 0xE000; i < 0x10000; i++)
        memory[i] = nascom_rom["BASIC@E000"].charCodeAt(i - 0xE000);

    canvas = document.getElementById('screen');
    ctx = canvas.getContext('2d');

    paintScreen();

    run();
}


function ui_select_rom() {
    nascom_reset();
}

function nascom_tape_lib() {
    console.log("In nascom_tape_lib");
    start_repo_program();
}

// The very first time you run, there is no saved persistent data
// and therefore no ROM to boot from. After you press "reset" it
// loads the (selected) ROM
function nascom_reset() {

    // Load the selected ROM monitor
    // [NAC HACK 2020Mar26] should cope with 1K roms as well. This just
    // ignored overrun of the array!!
    var x =  document.getElementById("ROM").value;


    console.log("In nascom_reset loading "+ nascom_rom[x].length + " bytes from ROM "+x);
    for (i = 0; i < 0x800; i++)
        memory[i] = nascom_rom[x].charCodeAt(i);

    z80_reset();
}


function nascom_clear() {
    for (i = 0x800; i < 0xE000; i++)
        memory[i] = 0;
    z80_reset();
}


var kbd_translation = [
// 7:NC for all rows
/* 0 */  "`\r```-\n\007", // 4:shift
/* 1 */  "``txf5bh", // 6:up
/* 2 */  "``yzd6nj", // 6:left
/* 3 */  "``use7mk", // 6:down
/* 4 */  "``iaw8,l", // 6:right
/* 5 */  "``oq39.;", // 6:Graph
/* 6 */  "`[p120/:",
/* 7 */  "`]r c4vg"
];

var kbd_translation_shifted = [
// 7:NC for all rows
/* 0 */  "``@``=``", // 6:CH 5:Ctrl 4:Shift 3:Ctrl 2:NC 1:NC 0:NC
/* 1 */  "``TXF%BH", // 6:up
/* 2 */  "``YZD&NJ", // 6:left
/* 3 */  "``USE'MK", // 6:down
/* 4 */  "``IAW(,L", // 6:right
/* 5 */  "``OQ#)>+", // 6:graph
/* 6 */  "`\\P!\"^?*",
/* 7 */  "`_R`C$VG"
];

function sim_key(ch, down) {
    var row = -1, bit, shifted = 0;

    for (var i = 0; i < 8 && row == -1; ++i)
        for (bit = 0; bit < 8; ++bit)
            if (kbd_translation[i][7-bit] == ch) {
                row = i;
                break;
            }

    for (var i = 0; i < 8 && row == -1; ++i)
        for (bit = 0; bit < 8; ++bit)
            if (kbd_translation_shifted[i][7-bit] == ch) {
                row = i;
                shifted = 1;
                break;
            }

    shifted = 0;

    if (row != -1) {
        //console.log("key "+(down?"down":"up")+" at row "+row+" col "+bit);
        if (down) {
            keym[row] |= 1 << bit;
            keym[0] |= shifted << 4;
        }
        else {
            keym[row] &= ~(1 << bit);
            keym[0] &= ~(shifted << 4);
        }
    } else if (down)
        console.log("Sorry, couldn't find translation for "+ch);
}

function nascomKbdEvent(evt, down) {
    nascomCharCode(evt.which ? evt.which : event.keyCode, down);
}

function nascomCharCode(charCode, down) {
    var row = -1, bit, i;
    var ch;
    switch (charCode) {
    case 17: row = 0, bit = 3; break; // control (5 works too)
    case 16: row = 0, bit = 4; break; // shift
//  case 220:row = 0, bit = 5; break; // control (@, guess)
    case 38: row = 1, bit = 6; break; // up arrow
    case 37: row = 2, bit = 6; break; // left arrow
    case 40: row = 3, bit = 6; break; // down arrow
    case 39: row = 4, bit = 6; break; // right arrow
    case 18: row = 5, bit = 6; break; // graph
// XXX
    case  8: row = 0, bit = 0; break; // backspace
// XXX
    case 13: row = 0, bit = 1; break; // enter
    case 91: return; // Command/Apple
    case 186: ch = ';'; break;
    case 187: ch = '='; break;
    case 188: ch = ','; break;
    case 190: ch = '.'; break;
    case 191: ch = '/'; break;
    case 219: ch = '['; break;
    case 220: ch = '\r'; break;
    case 221: ch = ']'; break;
    case 222: ch = ':'; break; // Not ideal, pressing ' but getting :
    }

    if (row == -1) {
        if (ch == undefined)
            ch = String.fromCharCode(charCode)/*.toUpperCase()*/;

        sim_key(ch, down);
    } else if (down)
        keym[row] |= 1 << bit;
    else
        keym[row] &= ~(1 << bit);
}

function keyDown(evt) {
    nascomKbdEvent(evt, true)
    if (!evt.metaKey)
        return false;
    return true;
}

function keyUp(evt) {
//  console.log("keyDown "+evt);
    nascomKbdEvent(evt, false);
    if (!evt.metaKey)
        return false;
    return true;
}

function keyPress(evt) {
    if (!evt.metaKey)
        return false;
    return true;
}

/*

var touch_row = 4;
var touch_col = 4;

function touchStart(evt) {
    evt.preventDefault();
    var touch = evt.touches[0];
    var x = touch.pageX;
    var y = touch.pageY;

    touch_row = Math.floor(x*9/384);
    touch_col = Math.floor(y*7/300);

    console.log("Touch x:" + touch.pageX + ", y:" + touch.pageY + "->" +touch_row+" "+touch_col+
               " "+kbd_translation[touch_row][touch_col]);

    keym[touch_row] |= 1 << touch_col;
}

function touchEnd(evt) {
    evt.preventDefault();
    var touch = evt.touches[0];

    keym[touch_row] &= ~(1 << touch_col);
}
*/

var paintCountdown = 0;

function frame() {
    event_next_event = 69888;
    event_next_event = 129888;
    tstates = 0;

    z80_do_opcodes();
    ui_led("led_halt", z80_halted(), 1);

    if (nmi_pending) {
        nmi_pending = false;
        z80_nmi();
    }

/*
    if (paintCountdown-- == 0) {
        paintScreen();
        paintCountdown = 20;
    }
*/

    z80_interrupt();
}

function run() {

    // if (!running) return;
    frame();

    setTimeout(run, 20);
}

function contend_memory(addr) {
    return 0; /* TODO: implement */
}
function contend_port(addr) {
    return 0; /* TODO: implement */
}
function readbyte(addr) {
    return readbyte_internal(addr);
}
function readbyte_internal(addr) {
    return memory[addr];
}
function readport(port) {
    port &= 255;

    switch (port) {
    case 0:
        /* KBD */
        return ~keym[keyp];

    case 1:
        if (serial_input_p < serial_input.length)
            return serial_input.charCodeAt(serial_input_p++);
        return 0;

    case 2:
        /* Status port on the UART

           #define UART_DATA_READY 128
           #define UART_TBR_EMPTY   64
           #define UART_F_ERROR      8
           #define UART_P_ERROR      4
           #define UART_O_ERROR      2
        */

        if (serial_input.length == serial_input_p || !tape_led)
            return 64;
        else
            return 192;

    case 0xE0:
    case 0xE1:
    case 0xE2:
    case 0xE3:
    case 0xE4:
    case 0xE5:
        return fdc_rd(port);

    default:
        console.log("readport "+port);
        return 0;
    }
}

function writeport(port, value) {
    port &= 255;

//    if (port != 0 || (value & ~31) != 0)
//        console.log("writeport "+port+","+value);

    if (port == 0) {
        /* KBD */
        var down_trans = port0 & ~value;
        var up_trans = ~port0 & value;
        port0 = value;

        if (1 & down_trans)
            keyp = (keyp + 1) & 7;
        if (2 & down_trans) {
            keyp = 0;

            if (replay_active == 1) {
                //console.log("go advance_replay");
                advance_replay();
            }
            else if (replay_active > 0) {
                //console.log("replay_active " + replay_active);
                replay_active = replay_active - 1;
                //console.log("replay_active' " + replay_active);
            }
        }
        // bit 2 and 5 also go to the keyboard but does what?
        if (8 & up_trans) {
        // console.log("Single-step triggered");
            /* The logic implemented by IC14 & IC15
               appears to delay the NMI by counting
               110
               010
               100
               000
               111 -> NMI
               so four cycles? (experiments suggest using 25)

               20 1000
               22 1000
               23 1000
               24 1000
               25 1001
               30 1002
               40 1004

               This should probably not use tstates, but this will
               work for NAS-SYS 3
            */
            nmi_pending = true;
            event_next_event = tstates + 25;
        }

        if (tape_led != ((value >> 4) & 1)) {
            // state of tape_led has changed
            tape_led = (value >> 4) & 1;

            if (document.getElementById("io"))
                document.getElementById("io").value = "port 0 tape: " + tape_led;

            ui_led("led_tape", tape_led, tape_led);

            // if the tape has just turned off, execute commands (if any)
            if (tape_led == 0)
                replay_kbd(led_off_str);
        }
    }

    if (port == 1) {
        console.log("serial out " + value);
    }

    if (port == 10) {
        if (document.getElementById("io"))
            document.getElementById("io").value = "port 10:" + value;

        ui_led("led1", value, 1);
        ui_led("led2", value, 2);
        ui_led("led3", value, 4);
        ui_led("led4", value, 8);
    }
    if ((port & 0xF0) == 0xE0) {
        fdc_wr(port, value);
    }
}

function writebyte(addr, val) {
    return writebyte_internal(addr, val)
}

function writebyte_internal(addr, val) {
    /* Optimize for the common case */
    if (0xC00 <= addr && addr < 0xE000) {

        // General purpose memory
        memory[addr] = val;

    } else if (0x800 <= addr && addr < 0xC00) {
        // Framebuffer

        if (((addr - 10) & 63) < 48) {

            // Visible Screen write
            var oldByte = memory[addr];
            memory[addr] = val;

            if (val != oldByte)
                drawScreenByte(addr, val);
        } else
            memory[addr] = val;
    }
}

var char_height = 15; // PAL=12 , NTSC = 14 ?? (I think that should be 13/15)
function drawScreenByte(addr, val) {
    var x = (addr & 63) - 10;
    var y = ((addr >> 6) + 1) & 15;

    if (x < 0 || 48 <= x || y < 0 || 16 <= y || val < 0 || 255 < val)
        console.log("x,y,val "+x+" "+y+" "+val);

    if (ctx != undefined && rom_font != undefined &&
        val != undefined) {
        ctx.drawImage(rom_font,
                  0, 16*val,            // sx,sy
                  8, char_height,       // sWidth, sHeight
                  x*8,y*char_height,    // dx,dy
                  8, char_height);      // dWidth, dHeight
    } else
        console.log("Oh no, it would appear what drawScreenByte is called "
                    + "before all of the necessary resources are defined");
}

function paintScreen() {
    for (var addr = 0x800; addr < 0xC00; ++addr) {
        col = addr & 63;
        if (10 <= col && col < 58)
            drawScreenByte(addr, memory[addr]);
    }
}


// Emulation of MAP80/GM809 Floppy Disk Controller, WD1797/WD2797
// floppy disk controller. Goal is not to write an emulation that can be used to
// debug new disk drivers. Rather, it is to write an emulation that can run Known
// Good disk drivers. As such, this does the minimum emulation.
function fdc_init() {
    // disk geometry. Used to turn a track/sector into an offset into
    // a binary disk image. If necessary, could be different per-drive
    // in order to allow (eg) transfer from one drive image to another.
    fdc.SECTOR_SZ = 256;
    fdc.SECTORS = 18;
    fdc.TRACKS = 80;
    fdc.SIDES = 1;

    fdc.state = fdc.s.IDLE;

    fdc.file = [];
    fdc.buf = [];
    // 4 drives
    fdc.file[0] = new ArrayBuffer(fdc.SECTOR_SZ * fdc.SECTORS * fdc.TRACKS * fdc.SIDES);
    fdc.file[1] = new ArrayBuffer(fdc.SECTOR_SZ * fdc.SECTORS * fdc.TRACKS * fdc.SIDES);
    fdc.file[2] = new ArrayBuffer(fdc.SECTOR_SZ * fdc.SECTORS * fdc.TRACKS * fdc.SIDES);
    fdc.file[3] = new ArrayBuffer(fdc.SECTOR_SZ * fdc.SECTORS * fdc.TRACKS * fdc.SIDES);
    // fdc.buf[0]..[3] assigned when the files are loaded
    // 6-byte buffer for read address command.
    fdc.buf[4] = new Uint8Array(6);

    // For reads and writes, bufindx is calculated as the first offset
    // in the buffer and is incremented as bytes are read. buflast is
    // the final byte to be read.
    // The buffer is either the current drive or a 6-byte buffer used
    // for the read address command.
    fdc.bufindx = 0;
    fdc.buflast = 0;
    // fdc.buf[fdc.current] shows where data is coming from/going to. Its set to the
    // selected drive except for read address commands, where it's set to 4.
    fdc.current = 0;

    // values most-recently written to hardware registers
    fdc.cmd = 0;
    fdc.trk = 0;
    fdc.sec = 0;
    fdc.dat = 0;
    fdc.drv = 0;
    // emulates value to read back from status register
    fdc.status = 0;
    // emulates value to read back from port E4/E5.
    fdc.pinstatus = 0;

    // disk image handling
    fdc_ld_image("load_disk0", 0);
    fdc_ld_image("load_disk1", 1);
    fdc_ld_image("load_disk2", 2);
    fdc_ld_image("load_disk3", 3);

    console.log("fdc_init completed.");
}

function fdc_wr(port,value) {
    switch (port & 0xf) {
    case 0: // FDC command register
        // writing to the command register clears interrupt (but the
        // emulated command may set it again immediately)
        fdc.pinstatus = fdc.pinstatus & 0xfe;

        fdc.cmd = value;

        if ((fdc.cmd & 0xf0) == 0xd0) {
            // interrupt. Any data we had buffered is discarded implicitly by the state change.
            fdc.pinstatus = fdc.pinstatus | 1;

            if (fdc.state != fdc.s.IDLE) {
                fdc.bufindx = fdc.SECTOR_SZ;
                fdc.state = fdc.s.DRV;
            }
            console.log("fdc_wr cmd=interrupt");
            break;
        }
        if (fdc.state == fdc.s.IDLE) {
            console.log("fdc_wr warning: command write with no drive selected");
        }
        if ((fdc.cmd & 0xf0) == 0x00) {
            // restore.
            fdc.trk = 0;
            fdc.state = fdc.s.TRK;
            fdc.pinstatus = fdc.pinstatus | 1;
            fdc.status = 0x26;
            console.log("fdc_wr cmd=restore");
        }
        else if ((fdc.cmd & 0xf0) == 0x10) {
            // seek
            fdc.state = fdc.s.TRK;
            fdc.trk = fdc.dat;
            fdc.pinstatus = fdc.pinstatus | 1;
            if (fdc.trk == 0) {
                fdc.status = 0x26;
            }
            else {
                fdc.status = 0x22;
            }
            console.log("fdc_wr cmd=seek, track="+fdc.trk);
        }
        else if ((fdc.cmd & 0xf0) == 0x30) {
            // step and update track register
            fdc.state = fdc.s.TRK;
            fdc.trk = fdc.trk+1; // [NAC HACK 2018Feb25] should be same as prev direction... needs fixing!
            fdc.pinstatus = fdc.pinstatus | 1;
            if (fdc.trk == 0) {
                fdc.status = 0x26;
            }
            else {
                fdc.status = 0x22;
            }
            console.log("fdc_wr cmd=step, track="+fdc.trk);
        }
        else if ((fdc.cmd & 0xf0) == 0xc0) {
            // read address. Used by PolyDos to detect whether a disk is
            // present in the drive.
            fdc.pinstatus = fdc.pinstatus | 0x80;
            fdc.status = 0x00; // [NAC HACK 2018Feb25] fix
            fdc.state = fdc.s.INRD;
            fdc.current = 4;
            fdc.bufindx = 0;
            fdc.buflast = 5;
            fdc.buf[4][0] = fdc.trk;
            fdc.buf[4][1] = 0; // side
            fdc.buf[4][2] = fdc.sec; // sector [NAC HACK 2015Jun10] ?
            fdc.buf[4][3] = 1; // sector length 0:128 1:256 2:512 3:1024
            fdc.buf[4][4] = 0; // CRC
            fdc.buf[4][5] = 0; // CRC
            console.log("fdc_wr read_address - TODO: fail for drive where no image loaded");
        }
        else if ((fdc.cmd & 0xf0) == 0x80) {
            // read sector
            fdc.pinstatus = fdc.pinstatus | 0x80;
            fdc.status = 0x03;
            fdc.state = fdc.s.INRD;

            fdc.current = hot2bin(fdc.drv) - 1;
            fdc.bufindx = fdc.trk*fdc.SECTOR_SZ*fdc.SECTORS + fdc.sec*fdc.SECTOR_SZ;
            fdc.buflast = fdc.bufindx + fdc.SECTOR_SZ - 1;
            console.log("fdc_wr read_sector t="+fdc.trk+" s="+fdc.sec+" data index "+fdc.current);
        }
        else if ((fdc.cmd & 0xf0) == 0xa0) {
            // write sector
            fdc.pinstatus = fdc.pinstatus | 0x80;
            fdc.status = 0x03;
            fdc.state = fdc.s.INWR;

            fdc.current = hot2bin(fdc.drv) - 1;
            fdc.bufindx = fdc.trk*fdc.SECTOR_SZ*fdc.SECTORS + fdc.sec*fdc.SECTOR_SZ;
            fdc.buflast = fdc.bufindx + fdc.SECTOR_SZ - 1;
            console.log("fdc_wr write_sector t="+fdc.trk+" s="+fdc.sec+" data index "+fdc.current);
        }
        else {
            console.log("fdc_wr warning: command write with unknown command "+value);
        }
        break;
    case 1: // FDC track register
        fdc.trk = value;
        // console.log("fdc_wr trk="+fdc.trk);
        break;
    case 2: // FDC sector register
        fdc.sec = value;
        // console.log("fdc_wr sec="+fdc.sec);
        break;
    case 3: // FDC data register (wr or parameter for seek)
        fdc.dat = value;

        if (fdc.state == fdc.s.INWR) {
            if (fdc.bufindx == fdc.buflast) {
                // last one
                fdc.state = fdc.s.TRK;
                fdc.status = 0x00;
                fdc.pinstatus = (fdc.pinstatus & 0x7f) | 1;
            }
            // console.log("fdc_wr byte "+fdc.bufindx+" data: "+(fdc.buf[fdc.current][fdc.bufindx]).toString(16));
            fdc.buf[fdc.current][fdc.bufindx++] = fdc.dat;
        }
        break;
    case 4: // select drive, motor on, FM/MFM
    case 5:

        // FDC Drive Select lights in the UI
        ui_led("led0_dsk", value, 1);
        ui_led("led1_dsk", value, 2);
        ui_led("led2_dsk", value, 4);
        ui_led("led3_dsk", value, 8);

        if ((fdc.drv & 0x0f) == (value & 0xf)) {
            console.log("fdc_wr keep motor running..");
            // just keep the motor running
        }
        else {
            if ((fdc.state == fdc.s.INWR) || (fdc.state == fdc.INRD)) {
                console.log("fdc_wr error: select drive "+value+" while in state "+fdc.state);
            }
            else {
                if ((value & 0x20) == 0) {
                    console.log("fdc_wr info: select drive "+value+" -- motor off");
                }
                fdc.drv = value;
                fdc.state = fdc.s.DRV;
            }
        }
        break;
    default:
        console.log("fdc_wr error: unknown port "+port+","+value);
    }
}

function fdc_rd(port) {
    switch (port & 0xf) {
    case 0: // status - bit assignment depends upon command. Refer
            // to data sheet.

        // read of status clears down INTRQ
        fdc.pinstatus = fdc.pinstatus & 0xfe;
        // console.log("fdc_rd status: 0x"+(fdc.status).toString(16));
        return fdc.status;
    case 1: // track
        // console.log("fdc_rd track:"+fdc.trk);
        return fdc.trk;
    case 2: // sector
        // console.log("fdc_rd sector:"+fdc.sec);
        return fdc.sec;
    case 3: // data
        if (fdc.state == fdc.s.INRD) {
            if (fdc.bufindx == fdc.buflast) {
                // last one
                fdc.state = fdc.s.TRK;
                fdc.status = 0x00;
                fdc.pinstatus = (fdc.pinstatus & 0x7f) | 1;
            }
            // console.log("fdc_rd byte "+fdc.bufindx+" data: "+(fdc.buf[0][fdc.bufindx]).toString(16));
            return fdc.buf[fdc.current][fdc.bufindx++];
        }
        else {
            console.log("ERROR fdc_rd but not INRD");
            return 0;
        }
    case 4: // pin status
    case 5:
        // 7: DRQ     (1: ready for byte/byte available)
        // 6: 0
        // 5: 0
        // 4: 0
        // 3: 0
        // 2: 0
        // 1: !READY  (0: drive ready. Emulated as always 0)
        // 0: INTRQ   (1: when command completed)
        // console.log("fdc_rd pinstatus: 0x"+(fdc.pinstatus).toString(16));
        return fdc.pinstatus;

    default:
        console.log("fdc_rd error: unknown port "+port);
        return 0;
    }
}

function fdc_ld_image(id, index) {
    if (fileIOOk && document.getElementById(id))
        document.getElementById(id).onchange = function() {
        var reader = new FileReader();
        reader.onload = function(theFile) {
            console.log("Onload: Start to load disk "+id);
            fdc.file[index] = reader.result;
        }
        reader.onloadend = function(theFile) {
            console.log("Onload: Loaded disk "+id+"("+fdc.file[index].byteLength+" bytes)");
            fdc.buf[index] = new Uint8Array(fdc.file[index]);
        }
            // Read in the image file as byte sequence
            console.log("Read file "+this.files[0].name);
            reader.readAsArrayBuffer(this.files[0]);
        }
}

function hot2bin (value) {
    switch (value & 0xf) {
    case 0: return 0;
    case 1: return 1;
    case 2: return 2;
    case 4: return 3;
    case 8: return 4;
    default:
        console.log("hot2bin unexpected value "+value&0xf);
    }
}
