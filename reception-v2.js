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

function formatDate(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  const weekday = "日月火水木金土"[new Date(year, month - 1, day).getDay()];
  return `${year}/${month}/${day}(${weekday})`;
}

function renderDoctorMemo(payload) {
  const records = payload.records;
  const headaches = records.filter((record) => record.entryType !== "noHeadache");
  const recordedDays = new Set(records.map((record) => record.date)).size;
  const headacheDays = new Set(headaches.map((record) => record.date)).size;
  const medicineDays = new Set(headaches.filter((record) => record.med).map((record) => record.date)).size;
  const severeCount = headaches.filter((record) => record.severity === 3).length;
  const downCount = headaches.filter((record) => record.impact === "寝込んだ").length;
  const safetyFlags = [...new Set(headaches.flatMap((record) => record.safetyFlags))];

  const triggers = new Map();
  headaches.forEach((record) => record.triggers.forEach((trigger) => triggers.set(trigger, (triggers.get(trigger) || 0) + 1)));
  const triggerText = [...triggers.entries()].sort((a, b) => b[1] - a[1])
    .map(([trigger, count]) => `${trigger} ${count}回`).join("、") || "特になし・未確認";

  const medicines = new Map();
  headaches.filter((record) => record.med).forEach((record) => {
    const item = medicines.get(record.med) || { days: new Set(), count: 0, countKnown: false };
    item.days.add(record.date);
    if (Number.isFinite(record.medCount)) { item.count += record.medCount; item.countKnown = true; }
    medicines.set(record.med, item);
  });
  const medicineText = [...medicines.entries()].map(([name, item]) =>
    `${name} ${item.days.size}日${item.countKnown ? `・計${item.count}回分` : ""}`).join("、") || "なし・未確認";

  const recordHtml = records.map((record) => {
    if (record.entryType === "noHeadache") {
      return `<div class="doctor-record"><b>${escapeHtml(formatDate(record.date))}</b>　頭痛なし</div>`;
    }
    const severity = ["未確認", "軽い", "中くらい", "強い"][record.severity || 0];
    const when = [record.time, record.duration, record.ongoing ? "記録時も継続中" : ""].filter(Boolean).join("／") || "時刻・持続時間は未確認";
    const symptoms = [...record.symptoms, record.auraDetail ? `見え方の詳細：${record.auraDetail}` : ""].filter(Boolean).join("、") || "なし・未確認";
    const trigger = record.triggers.join("、") || "特になし・未確認";
    const medicine = record.med
      ? `${record.med}${record.medTiming ? `（${record.medTiming}）` : ""}${record.medEffect ? ` → ${record.medEffect}` : ""}`
      : "飲んでいない・未確認";
    const spoken = record.memoSummary || record.memo;
    return `<div class="doctor-record">
      <b>${escapeHtml(formatDate(record.date))}　${escapeHtml(severity)}</b>
      <p>${escapeHtml(when)}／場所：${escapeHtml(record.location || "未確認")}</p>
      <p>症状：${escapeHtml(symptoms)}</p>
      <p>きっかけ：${escapeHtml(trigger)}／薬：${escapeHtml(medicine)}／生活への影響：${escapeHtml(record.impact || "未確認")}</p>
      ${spoken ? `<p><strong>先生に伝えたいこと：</strong>${escapeHtml(spoken)}</p>` : ""}
      ${record.narrativeRaw ? `<p><strong>記録時に話したこと：</strong>${escapeHtml(record.narrativeRaw)}</p>` : ""}
    </div>`;
  }).join("");

  return `<article class="doctor-text-report">
    <h2>頭痛ダイアリー2　受診メモ</h2>
    <p class="doctor-period">${escapeHtml(formatDate(payload.startIso))} 〜 ${escapeHtml(formatDate(payload.endIso))}（過去${payload.summaryMonths}ヶ月）</p>
    <section class="doctor-summary">
      <p><strong>記録：</strong>${recordedDays}日　<strong>頭痛：</strong>${headacheDays}日　<strong>服薬：</strong>${medicineDays}日　<strong>強い頭痛：</strong>${severeCount}回　<strong>寝込んだ：</strong>${downCount}回</p>
      <p><strong>よくあるきっかけ：</strong>${escapeHtml(triggerText)}</p>
      <p><strong>使った頭痛の薬：</strong>${escapeHtml(medicineText)}</p>
      ${safetyFlags.length ? `<p class="doctor-warning"><strong>早めの受診を案内した言葉：</strong>${escapeHtml(safetyFlags.join("、"))}</p>` : ""}
    </section>
    <h3>日ごとの記録</h3>${recordHtml}
    <p class="doctor-disclaimer">本人の記録を整理したメモです。診断結果ではありません。</p>
  </article>`;
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
    $("result-card").innerHTML = renderDoctorMemo(payload);
    $("result-time").textContent = new Date().toLocaleString("ja-JP");
    show("scan-result");
  } catch (_) {
    resetTransfer();
    $("idle-status").textContent = "QRコードの内容を復元できませんでした。患者さんの画面で1番から読み直してください。";
    show("scan-idle");
  }
}

window.ZutsuReception = { parsePart, decodePayload, validatePayload, renderDoctorMemo };

$("btn-scan").addEventListener("click", startScan);
$("btn-stop").addEventListener("click", () => { stopScan(); show("scan-idle"); });
$("btn-again").addEventListener("click", () => { resetTransfer(); startScan(); });
$("btn-print").addEventListener("click", () => window.print());
$("btn-paste").addEventListener("click", () => {
  const text = $("paste-input").value.trim();
  if (text) { $("paste-input").value = ""; handleScannedData(text); }
});
window.addEventListener("pagehide", stopScan);
