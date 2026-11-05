// snowPact website
// Reads accelerometer data from the helmet sensor (USB or Bluetooth),
// shows the live force, and flags impacts that may cause a concussion.

// ---------- Settings (change these to match your testing) ----------
const WARN_G = 75;          // "Hard impact" starts here (from our design requirements)
const DANGER_G = 95;        // "Severe impact" starts here
const IMPACT_END_MS = 150;  // an impact ends once force stays under WARN_G this long
const CHART_SECONDS = 10;   // how much history the chart shows
const STALE_MS = 3000;      // warn if no data arrives for this long
const BAUD_RATE = 115200;   // must match Serial.begin() in the Arduino code

// Bluetooth: "Nordic UART" service, the same UUIDs used in snowpact_ble.ino
const BLE_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const BLE_TX_CHAR = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

// ---------- Page elements ----------
const $ = (id) => document.getElementById(id);
const el = {
    btnUsb: $("btn-usb"), btnBle: $("btn-ble"), btnDemo: $("btn-demo"),
    btnDisconnect: $("btn-disconnect"), btnDismiss: $("btn-dismiss"), btnClear: $("btn-clear"),
    connStatus: $("conn-status"), browserNote: $("browser-note"),
    statusCard: $("status-card"), statusTitle: $("status-title"), statusText: $("status-text"),
    now: $("val-now"), peak: $("val-peak"), count: $("val-count"),
    x: $("val-x"), y: $("val-y"), z: $("val-z"),
    chart: $("chart"), lastMessage: $("last-message"),
    logEmpty: $("log-empty"), logTable: $("log-table"), logBody: $("log-body"),
};

document.querySelectorAll(".t-warn").forEach((s) => (s.textContent = WARN_G));
document.querySelectorAll(".t-danger").forEach((s) => (s.textContent = DANGER_G));

// ---------- State ----------
let connection = null;      // { type: "usb" | "ble" | "demo", close: async fn }
let samples = [];           // { t, g } for the chart
let latest = null;          // most recent { x, y, z, g }
let sessionPeak = 0;
let lastDataTime = 0;
let currentImpact = null;   // { start, peak, lastAbove } while an impact is happening
let activeAlert = null;     // the impact shown in the status card until dismissed
let impacts = loadImpacts();
let needsRedraw = true;

// ---------- Browser support ----------
const hasSerial = "serial" in navigator;
const hasBluetooth = "bluetooth" in navigator;
if (!hasSerial) el.btnUsb.disabled = true;
if (!hasBluetooth) el.btnBle.disabled = true;
if (!hasSerial || !hasBluetooth) {
    el.browserNote.hidden = false;
    el.browserNote.textContent = (!hasSerial && !hasBluetooth)
        ? "This browser can't connect to the sensor. Use Chrome or Edge on a computer, or Chrome on Android."
        : !hasSerial
            ? "USB doesn't work in this browser. Use Chrome or Edge."
            : "Bluetooth doesn't work in this browser. Use Chrome or Edge.";
}

// ---------- Reading the sensor's text ----------
// The Arduino prints lines like:  "0.05  -0.10  0.98  total: 0.99"
// We pull the numbers out of each line. Any other line (like "*** IMPACT ***")
// is shown as a message from the sensor.
let textBuffer = "";

function handleText(chunk) {
    textBuffer += chunk;
    let newline;
    while ((newline = textBuffer.indexOf("\n")) >= 0) {
        const line = textBuffer.slice(0, newline).trim();
        textBuffer = textBuffer.slice(newline + 1);
        if (line) handleLine(line);
    }
    if (textBuffer.length > 1000) textBuffer = ""; // garbage protection
}

function handleLine(line) {
    const nums = line.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 3) {
        showSensorMessage(line);
        return;
    }
    const x = parseFloat(nums[0]);
    const y = parseFloat(nums[1]);
    const z = parseFloat(nums[2]);
    const g = nums.length >= 4 ? parseFloat(nums[3]) : Math.sqrt(x * x + y * y + z * z);
    if ([x, y, z, g].some(Number.isNaN)) return;
    addSample(x, y, z, g);
}

function showSensorMessage(line) {
    el.lastMessage.hidden = false;
    el.lastMessage.textContent = "Sensor says: " + line;
}

// ---------- Processing samples ----------
function addSample(x, y, z, g) {
    const t = performance.now();
    lastDataTime = t;
    latest = { x, y, z, g };
    samples.push({ t, g });
    if (g > sessionPeak) sessionPeak = g;

    // Impact detection: start when force passes WARN_G, keep the highest value,
    // finish once force has stayed below WARN_G for IMPACT_END_MS.
    if (g >= WARN_G) {
        if (!currentImpact) currentImpact = { start: Date.now(), peak: g, lastAbove: t };
        currentImpact.peak = Math.max(currentImpact.peak, g);
        currentImpact.lastAbove = t;
    }
    needsRedraw = true;
}

function checkImpactFinished() {
    if (currentImpact && performance.now() - currentImpact.lastAbove > IMPACT_END_MS) {
        const impact = {
            time: currentImpact.start,
            peak: Math.round(currentImpact.peak * 10) / 10,
            level: currentImpact.peak >= DANGER_G ? "danger" : "warn",
        };
        currentImpact = null;
        impacts.unshift(impact);
        // Demo hits show up while the demo runs but aren't saved to the real history.
        if (connection && connection.type === "demo") impact.demo = true;
        saveImpacts();
        // Keep the worst alert showing until the user clears it.
        if (!activeAlert || impact.level === "danger" || activeAlert.level !== "danger") {
            activeAlert = impact;
        }
        renderLog();
        needsRedraw = true;
    }
}

// ---------- Status card ----------
function setStatus(kind, title, text) {
    el.statusCard.className = "sign sign-" + kind;
    const shape = kind === "off" || kind === "stale" ? "off" : kind;
    document.getElementById("status-shape").setAttribute("href", "#shape-" + shape);
    el.statusTitle.textContent = title;
    el.statusText.textContent = text;
}

function renderStatus() {
    el.btnDismiss.hidden = !activeAlert;

    if (activeAlert) {
        const when = formatTime(activeAlert.time);
        if (activeAlert.level === "danger") {
            setStatus("danger", "Stop skiing",
                `${activeAlert.peak} g hit at ${when}. High chance of concussion. ` +
                "Tell someone and get checked before you ride again.");
        } else {
            setStatus("warn", "Hard impact",
                `${activeAlert.peak} g hit at ${when}. Could cause a concussion. ` +
                "Take a break and watch for headache, dizziness or confusion.");
        }
        return;
    }
    if (!connection) {
        setStatus("off", "Not monitoring", "Connect the helmet to start.");
        return;
    }
    if (!latest) {
        setStatus("stale", "Connected", "Waiting for the first reading.");
        return;
    }
    if (performance.now() - lastDataTime > STALE_MS) {
        setStatus("stale", "No data from sensor",
            "Nothing received for a few seconds. Check the battery and wiring.");
        return;
    }
    setStatus("ok", "All clear", "No hard impacts.");
}

// ---------- Numbers ----------
function renderNumbers() {
    const f = (v) => (v == null ? "--" : (Math.abs(v) < 0.05 ? 0 : v).toFixed(1));
    el.now.textContent = latest ? f(latest.g) : "--";
    el.x.textContent = latest ? f(latest.x) : "--";
    el.y.textContent = latest ? f(latest.y) : "--";
    el.z.textContent = latest ? f(latest.z) : "--";
    el.peak.textContent = latest ? f(sessionPeak) : "--";
    el.count.textContent = impacts.length;
}

// ---------- Chart ----------
function drawChart() {
    const canvas = el.chart;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = 240;
    if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const left = 40, right = 10, top = 10, bottom = 26;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const now = performance.now();
    const windowMs = CHART_SECONDS * 1000;

    // Drop old samples
    while (samples.length && samples[0].t < now - windowMs) samples.shift();

    // Y range: always show the danger line, grow if a bigger hit happens
    let maxG = DANGER_G * 1.2;
    for (const s of samples) if (s.g > maxG) maxG = s.g;
    const step = maxG > 200 ? 50 : 25;
    maxG = Math.ceil(maxG / step) * step;

    const yFor = (g) => top + plotH - (g / maxG) * plotH;
    const xFor = (t) => left + plotW - ((now - t) / windowMs) * plotW;

    // Grid + labels
    ctx.font = "13px Barlow, Arial, sans-serif";
    ctx.fillStyle = "#5e6a78";
    ctx.strokeStyle = "#eceef0";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let g = 0; g <= maxG; g += step) {
        const y = yFor(g);
        ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plotW, y); ctx.stroke();
        ctx.fillText(String(g), left - 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let s = 0; s <= CHART_SECONDS; s += 2) {
        const x = left + plotW - (s / CHART_SECONDS) * plotW;
        ctx.fillText(s === 0 ? "now" : `-${s}s`, x, top + plotH + 6);
    }

    // Threshold lines
    const dashed = (g, color) => {
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(left, yFor(g)); ctx.lineTo(left + plotW, yFor(g)); ctx.stroke();
        ctx.restore();
    };
    dashed(WARN_G, "#e07a10");
    dashed(DANGER_G, "#c4261d");

    // Force line
    if (samples.length) {
        ctx.strokeStyle = "#14233a";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        samples.forEach((s, i) => {
            const x = xFor(s.t), y = yFor(s.g);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
    }
}

// ---------- Impact log ----------
function renderLog() {
    el.logEmpty.hidden = impacts.length > 0;
    el.logTable.hidden = impacts.length === 0;
    el.logBody.innerHTML = "";
    for (const imp of impacts) {
        const tr = document.createElement("tr");
        const label = imp.level === "danger" ? "Severe impact" : "Hard impact";
        tr.innerHTML = `<td>${formatDateTime(imp.time)}</td><td class="num">${imp.peak.toFixed(1)} g</td>` +
            `<td><svg class="row-shape"><use href="#shape-${imp.level}"/></svg>${label}</td>`;
        el.logBody.appendChild(tr);
    }
    el.count.textContent = impacts.length;
}

function loadImpacts() {
    try { return JSON.parse(localStorage.getItem("snowpact-impacts")) || []; }
    catch { return []; }
}
function saveImpacts() {
    try { localStorage.setItem("snowpact-impacts", JSON.stringify(impacts.filter((i) => !i.demo).slice(0, 200))); }
    catch { /* storage not available, history just won't be saved */ }
}

function formatTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
function formatDateTime(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + formatTime(ms);
}

// ---------- Connections ----------
async function connectUsb() {
    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: BAUD_RATE });
        const decoder = new TextDecoderStream();
        const pipeDone = port.readable.pipeTo(decoder.writable).catch(() => {});
        const reader = decoder.readable.getReader();
        let open = true;

        startConnection("usb", "Connected over USB", async () => {
            open = false;
            try { await reader.cancel(); } catch {}
            await pipeDone;
            try { await port.close(); } catch {}
        });

        (async () => {
            try {
                while (open) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) handleText(value);
                }
            } catch (err) {
                console.error(err);
            }
            if (open) endConnection("USB connection lost. Check the cable.");
        })();
    } catch (err) {
        if (err.name !== "NotFoundError") showError("Couldn't connect by USB: " + err.message +
            " Close the Arduino Serial Monitor if it is open.");
    }
}

async function connectBluetooth() {
    try {
        const device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [BLE_SERVICE] }, { namePrefix: "snowPact" }],
            optionalServices: [BLE_SERVICE],
        });
        el.connStatus.textContent = "Connecting to " + (device.name || "sensor") + "...";
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(BLE_SERVICE);
        const tx = await service.getCharacteristic(BLE_TX_CHAR);
        const decoder = new TextDecoder();
        const onData = (e) => handleText(decoder.decode(e.target.value));
        tx.addEventListener("characteristicvaluechanged", onData);
        await tx.startNotifications();

        let open = true;
        device.addEventListener("gattserverdisconnected", () => {
            if (open) endConnection("Bluetooth connection lost. Is the helmet on and nearby?");
        });
        startConnection("ble", "Connected to " + (device.name || "sensor") + " over Bluetooth", async () => {
            open = false;
            tx.removeEventListener("characteristicvaluechanged", onData);
            try { device.gatt.disconnect(); } catch {}
        });
    } catch (err) {
        if (err.name !== "NotFoundError") showError("Couldn't connect by Bluetooth: " + err.message);
        else el.connStatus.textContent = connection ? el.connStatus.textContent : "Not connected";
    }
}

function connectDemo() {
    // Fake sensor: about 1 g of normal movement, with an impact every ~6 seconds.
    let nextImpact = performance.now() + 3000;
    let impactSamples = [];
    const timer = setInterval(() => {
        const now = performance.now();
        if (now > nextImpact) {
            const peak = 50 + Math.random() * 80; // 50 to 130 g
            impactSamples = [peak * 0.4, peak, peak * 0.6, peak * 0.2];
            nextImpact = now + 5000 + Math.random() * 3000;
        }
        let g = impactSamples.length ? impactSamples.shift() : 1 + (Math.random() - 0.5) * 0.6;
        const x = (Math.random() - 0.5) * 0.3 * g, y = (Math.random() - 0.5) * 0.3 * g;
        const z = Math.sqrt(Math.max(g * g - x * x - y * y, 0));
        handleLine(`${x.toFixed(2)}  ${y.toFixed(2)}  ${z.toFixed(2)}  total: ${g.toFixed(2)}`);
    }, 20);
    startConnection("demo", "Demo data, no sensor", async () => clearInterval(timer));
}

function startConnection(type, message, close) {
    connection = { type, close };
    samples = [];
    latest = null;
    sessionPeak = 0;
    textBuffer = "";
    lastDataTime = performance.now();
    el.connStatus.textContent = message;
    el.lastMessage.hidden = true;
    setButtons();
}

async function disconnect(message) {
    if (!connection) return;
    const c = connection;
    connection = null;
    try { await c.close(); } catch {}
    if (c.type === "demo") {
        impacts = impacts.filter((i) => !i.demo);
        if (activeAlert && activeAlert.demo) activeAlert = null;
        renderLog();
    }
    el.connStatus.textContent = message || "Disconnected";
    setButtons();
}

function endConnection(message) {
    disconnect(message);
}

function showError(message) {
    el.connStatus.textContent = message;
}

function setButtons() {
    const on = !!connection;
    el.btnUsb.hidden = on;
    el.btnBle.hidden = on;
    el.btnDemo.hidden = on;
    el.btnDisconnect.hidden = !on;
}

// ---------- Buttons ----------
el.btnUsb.addEventListener("click", connectUsb);
el.btnBle.addEventListener("click", connectBluetooth);
el.btnDemo.addEventListener("click", connectDemo);
el.btnDisconnect.addEventListener("click", () => disconnect());
el.btnDismiss.addEventListener("click", () => { activeAlert = null; needsRedraw = true; });
el.btnClear.addEventListener("click", () => {
    impacts = [];
    saveImpacts();
    renderLog();
    renderNumbers();
});

// ---------- Update loop ----------
// Data can arrive hundreds of times a second, so the screen updates
// at most 30 times a second instead of on every reading.
renderLog();
setInterval(() => {
    checkImpactFinished();
    renderStatus();
    if (needsRedraw || connection) {
        renderNumbers();
        drawChart();
        needsRedraw = false;
    }
}, 33);
window.addEventListener("resize", drawChart);
