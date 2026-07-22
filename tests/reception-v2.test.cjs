const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "reception-v2.js"), "utf8");
const elements = new Map();
const element = () => ({
  classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, textContent: "", innerHTML: "", value: "",
});
const context = vm.createContext({
  console,
  document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } },
  window: { addEventListener() {}, print() {} },
  navigator: {}, requestAnimationFrame() {},
  crypto: require("node:crypto").webcrypto,
  TextDecoder, Blob, Response, DecompressionStream, atob,
});
vm.runInContext(source, context, { filename: "reception-v2.js" });

const payload = JSON.parse(JSON.stringify({
  type: "zutsu-diary-2-summary", version: 2, summaryMonths: 1,
  startIso: "2026-06-22", endIso: "2026-07-22",
  records: [{
    entryType: "headache", date: "2026-07-21", time: "朝", duration: "2時間",
    severity: 3, location: "右のこめかみ", symptoms: ["ズキズキする痛み"],
    triggers: ["寝不足"], med: "ロキソニン", medTiming: "朝に1錠", medCount: 1,
    medEffect: "少し効いた", impact: "寝込んだ",
    memoSummary: "薬について相談したい。", narrativeRaw: "朝から痛みました。",
    answeredFields: [], skippedFields: [], safetyFlags: [],
  }, { entryType: "noHeadache", date: "2026-07-22" }],
}));

context.payloadForTest = payload;
const html = vm.runInContext("window.ZutsuReception.renderDoctorMemo(window.ZutsuReception.validatePayload(payloadForTest))", context);
assert.match(html, /頭痛ダイアリー2　受診メモ/);
assert.match(html, /頭痛：<\/strong>1日/);
assert.match(html, /よくあるきっかけ：<\/strong>寝不足 1回/);
assert.match(html, /先生に伝えたいこと：<\/strong>薬について相談したい。/);
assert.match(html, /頭痛なし/);
assert.doesNotMatch(html, /sum-table|cal-stats|trigger-bar|<table/);

payload.records[0].memoSummary = "<script>alert(1)</script>";
context.unsafePayloadForTest = JSON.parse(JSON.stringify(payload));
const escaped = vm.runInContext("window.ZutsuReception.renderDoctorMemo(window.ZutsuReception.validatePayload(unsafePayloadForTest))", context);
assert.doesNotMatch(escaped, /<script>/);
assert.match(escaped, /&lt;script&gt;/);

console.log("reception v2 tests: ok");
