"use strict";

const $ = (id) => document.getElementById(id);
let stream = null;
let scanning = false;
let transfer = null;

function show(section) {
  ["scan-idle", "scan-live", "scan-result"].forEach((id) => $(id).classList.toggle("hidden", id !== section));
}

function resetTransfer() {
  transfer = null;
  $("transfer-progress").classList.add("hidden");
  $("transfer-progress").innerHTML = "";
  $("idle-status").textContent = "";
  $("btn-scan").textContent = "📷 QRコードを読み取る";
}

async function startScan() {
  if (typeof jsQR === "undefined") {
    $("idle-status").textContent = "読み取り部品を読み込めませんでした。接続を確認してページを開き直してください。";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false,
    });
  } catch (_) {
    $("idle-status").textContent = "カメラを使用できません（許可が必要です）。下の貼り付け欄も使えます。";
    return;
  }
  const video = $("video");
  video.srcObject = stream;
  await video.play();
  show("scan-live");
  scanning = true;
  requestAnimationFrame(scanFrame);
}

function scanFrame() {
  if (!scanning) return;
  const video = $("video");
  if (video.readyState >= 2) {
    const canvas = $("frame-canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
    if (code?.data?.trim()) {
      stopScan();
      handleScannedData(code.data.trim());
      return;
    }
  }
  requestAnimationFrame(scanFrame);
}

function stopScan() {
  scanning = false;
  if (stream) { stream.getTracks().forEach((track) => track.stop()); stream = null; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function parsePart(text) {
  const pieces = text.split("|");
  if (pieces.length !== 7 || pieces[0] !== "ZD2" || pieces[1] !== "2") return null;
  const index = Number(pieces[3]);
  const total = Number(pieces[4]);
  if (!/^[0-9a-f]{12}$/.test(pieces[2]) || !Number.isInteger(index) || !Number.isInteger(total)
      || index < 1 || total < 1 || index > total || total > 60 || !["g", "n"].includes(pieces[5])
      || !/^[A-Za-z0-9_-]+$/.test(pieces[6])) return null;
  return { id: pieces[2], index, total, codec: pieces[5], chunk: pieces[6] };
}

function base64UrlToBytes(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function digestId(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest.slice(0, 6)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function decodePayload(encoded, codec, expectedId) {
  const bytes = base64UrlToBytes(encoded);
  if (await digestId(bytes) !== expectedId) throw new Error("checksum");
  let decoded = bytes;
  if (codec === "g") {
    if (!("DecompressionStream" in window)) throw new Error("unsupported");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    decoded = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (decoded.length > 2_000_000) throw new Error("too_large");
  return JSON.parse(new TextDecoder().decode(decoded));
}

function safeString(value, max = 2000) { return typeof value === "string" ? value.slice(0, max) : ""; }
function safeStrings(value, maxItems = 30, maxChars = 200) {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => safeString(item, maxChars)).filter(Boolean) : [];
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(record.date || "")) return null;
  return {
    entryType: record.entryType === "noHeadache" ? "noHeadache" : "headache",
    date: record.date,
    time: safeString(record.time, 80), duration: safeString(record.duration, 100),
    durationMinutes: Number.isFinite(record.durationMinutes) ? record.durationMinutes : null,
    ongoing: record.ongoing === true,
    severity: [1, 2, 3].includes(record.severity) ? record.severity : null,
    location: safeString(record.location, 200), symptoms: safeStrings(record.symptoms),
    triggers: safeStrings(record.triggers), med: safeString(record.med, 200),
    medTiming: safeString(record.medTiming, 200), medCount: Number.isFinite(record.medCount) ? record.medCount : null,
    medEffect: safeString(record.medEffect, 80), impact: safeString(record.impact, 80),
    auraDetail: safeString(record.auraDetail, 500), memo: safeString(record.memo),
    memoSummary: safeString(record.memoSummary), narrativeRaw: safeString(record.narrativeRaw),
    answeredFields: safeStrings(record.answeredFields, 30, 50),
    skippedFields: safeStrings(record.skippedFields, 30, 50), safetyFlags: safeStrings(record.safetyFlags),
  };
}

function validatePayload(payload) {
  if (!payload || payload.type !== "zutsu-diary-2-summary" || payload.version !== 2
      || ![1, 3, 6].includes(payload.summaryMonths)
      || !/^\d{4}-\d{2}-\d{2}$/.test(payload.startIso || "")
      || !/^\d{4}-\d{2}-\d{2}$/.test(payload.endIso || "")
      || !Array.isArray(payload.records) || payload.records.length > 400) throw new Error("invalid");
  const records = payload.records.map(normalizeRecord);
  if (records.some((record) => !record)) throw new Error("invalid_record");
  return { ...payload, records };
}

function updateProgress(message) {
  const received = transfer ? transfer.parts.filter(Boolean).length : 0;
  const box = $("transfer-progress");
  box.classList.remove("hidden");
  box.innerHTML = `<p><strong>読み取り中：${received} / ${transfer.total}</strong></p><p>${escapeHtml(message)}</p>`;
  $("idle-status").textContent = `次は患者さんの画面で「${received + 1} / ${transfer.total}」を表示して読み取ってください。`;
  $("btn-scan").textContent = "📷 次のQRコードを読み取る";
  show("scan-idle");
}

function showLegacyText(text) {
  const lines = text.split("\n");
  $("result-card").innerHTML = `<div class="head">${escapeHtml(lines[0] || "")}</div><div style="white-space:pre-wrap">${escapeHtml(lines.slice(1).join("\n"))}</div>`;
  $("result-time").textContent = new Date().toLocaleString("ja-JP");
  show("scan-result");
}

async function handleScannedData(text) {
  const part = parsePart(text);
  if (!part) { resetTransfer(); showLegacyText(text); return; }

  if (!transfer || transfer.id !== part.id) {
    transfer = { id: part.id, total: part.total, codec: part.codec, parts: Array(part.total).fill("") };
  }
  if (transfer.total !== part.total || transfer.codec !== part.codec) {
    resetTransfer();
    $("idle-status").textContent = "別の受診メモが混ざっています。1番から読み直してください。";
    show("scan-idle");
    return;
  }
  transfer.parts[part.index - 1] = part.chunk;
  const received = transfer.parts.filter(Boolean).length;
  if (received < transfer.total) {
    updateProgress(`${part.index}番のQRコードを読み取りました。内容はすべて揃うまで表示されません。`);
    return;
  }

  try {
    const payload = validatePayload(await decodePayload(transfer.parts.join(""), transfer.codec, transfer.id));
    $("result-card").innerHTML = window.ZutsuSummary.render({
      records: payload.records, startIso: payload.startIso, endIso: payload.endIso,
      summaryMonths: payload.summaryMonths,
    });
    $("result-time").textContent = new Date().toLocaleString("ja-JP");
    show("scan-result");
  } catch (_) {
    resetTransfer();
    $("idle-status").textContent = "QRコードの内容を復元できませんでした。患者さんの画面で1番から読み直してください。";
    show("scan-idle");
  }
}

window.ZutsuReception = { parsePart, decodePayload, validatePayload };

$("btn-scan").addEventListener("click", startScan);
$("btn-stop").addEventListener("click", () => { stopScan(); show("scan-idle"); });
$("btn-again").addEventListener("click", () => { resetTransfer(); startScan(); });
$("btn-print").addEventListener("click", () => window.print());
$("btn-paste").addEventListener("click", () => {
  const text = $("paste-input").value.trim();
  if (text) { $("paste-input").value = ""; handleScannedData(text); }
});
window.addEventListener("pagehide", stopScan);
