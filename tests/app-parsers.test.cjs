const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const context = vm.createContext({
  console,
  window: { addEventListener() {} },
  document: { addEventListener() {}, getElementById() { return null; } },
  localStorage: { getItem() { return null; }, setItem() {} },
  setTimeout,
  clearTimeout,
  fetch: async () => ({ ok: false }),
  TextEncoder,
  Blob,
  URL,
});
vm.runInContext(source, context, { filename: "app.js" });

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

assert.deepEqual(
  JSON.parse(evaluate(`JSON.stringify(parseDuration("2時間くらい"))`)),
  { label: "2時間くらい", minutes: 120, ongoing: false },
);
assert.equal(evaluate(`parseDuration("まだ痛みが続いている").ongoing`), true);
assert.equal(evaluate(`parseDuration("2時間半").minutes`), 150);
assert.equal(evaluate(`parseNarrativeSeverity("夜8時から2時間続いた")`), null);
assert.equal(evaluate(`parseNarrativeSeverity("痛みの強さは10段階で8")`), 3);
assert.equal(evaluate(`normalizeSpeechText("あっ た")`), "あった");
assert.equal(evaluate(`normalizeSpeechText("な かっ た")`), "なかった");
for (const answer of ["ありません", "ないよ", "きょうは大丈夫です", "頭痛はなかったです", "全然ありませんでした"]) {
  assert.equal(evaluate(`parseHeadachePresence(${JSON.stringify(answer)})`), false, answer);
}
for (const answer of ["ありました", "あったよ", "頭が痛かったです", "頭痛が出ました", "今はないけど朝はあった"]) {
  assert.equal(evaluate(`parseHeadachePresence(${JSON.stringify(answer)})`), true, answer);
}
assert.equal(evaluate(`parseHeadachePresence("よくわからない")`), null);
assert.equal(
  evaluate(`cleanSpokenMemo("うーん、えっと、昨日は あのー 薬を飲んでも効きませんでした")`),
  "昨日は薬を飲んでも効きませんでした。",
);

const spokenAnswers = JSON.parse(evaluate(`(() => {
  const headache = blankDraft();
  const memo = blankDraft();
  return JSON.stringify({
    headacheResult: QUESTIONS.find((q) => q.key === "hasHeadache").handle(normalizeSpeechText("あっ た"), headache),
    headacheType: headache.entryType,
    memoResult: QUESTIONS.find((q) => q.key === "memo").handle("えっと、先生に薬の相談をしたい", memo),
    memo: memo.memo,
    memoSpokenRaw: memo.memoSpokenRaw,
  });
})()`));
assert.equal(spokenAnswers.headacheResult, "頭痛あり");
assert.equal(spokenAnswers.headacheType, "headache");
assert.equal(spokenAnswers.memoResult, "メモに記録");
assert.equal(spokenAnswers.memo, "先生に薬の相談をしたい。");
assert.equal(spokenAnswers.memoSpokenRaw, "えっと、先生に薬の相談をしたい");

const aiInterpretation = JSON.parse(evaluate(`(() => {
  const d = blankDraft();
  const answered = applyAiInterpretation({
    answeredFields: ["time", "severity", "location", "quality", "nausea", "unknown"],
    fields: {
      dateOffset: -1, time: "夜8時ごろ", severity: 3,
      location: ["右のこめかみ"], symptoms: ["ズキズキする痛み", "吐き気あり", "不正な症状"],
      triggers: [], medTaken: null, impact: "寝込んだ",
    },
  }, d);
  return JSON.stringify({ d, answered });
})()`));
assert.equal(aiInterpretation.d.date, evaluate(`todayStr(-1)`));
assert.equal(aiInterpretation.d.time, "夜8時ごろ");
assert.equal(aiInterpretation.d.severity, 3);
assert.equal(aiInterpretation.d.location, "右のこめかみ");
assert.deepEqual(aiInterpretation.d.symptoms, ["ズキズキする痛み", "吐き気あり"]);
assert.equal(aiInterpretation.d.impact, "");
assert.ok(!aiInterpretation.answered.includes("unknown"));

const narrative = evaluate(`(() => {
  const d = blankDraft();
  extractNarrative("昨日の夜から右のこめかみがズキズキして、歩くと悪化しました。吐いて、光と音もつらく、ロキソニンを飲んで少し効きました", d);
  return JSON.stringify(d);
})()`);
const parsed = JSON.parse(narrative);
assert.equal(parsed.date, evaluate(`todayStr(-1)`));
assert.equal(parsed.time, "夜");
assert.equal(parsed.location, "右側、こめかみ");
assert.equal(parsed.med, "ロキソニン");
assert.equal(parsed.medEffect, "少し効いた");
assert.ok(parsed.symptoms.includes("ズキズキする痛み"));
assert.ok(parsed.symptoms.includes("動くと悪化"));
assert.ok(parsed.symptoms.includes("実際に吐いた"));
assert.ok(parsed.symptoms.includes("光がつらい"));
assert.ok(parsed.symptoms.includes("音がつらい"));

const negative = JSON.parse(evaluate(`(() => {
  const d = blankDraft();
  extractNarrative("前兆はなく、吐き気もなく、光や音は気にならない", d);
  return JSON.stringify(d);
})()`));
assert.equal(negative.symptoms.length, 0);
assert.ok(negative.answeredFields.includes("aura"));
assert.ok(negative.answeredFields.includes("nausea"));
assert.ok(negative.answeredFields.includes("photophono"));

const mixed = JSON.parse(evaluate(`(() => {
  const d = blankDraft();
  extractNarrative("吐き気がありましたが、光や音は気にならない", d);
  return JSON.stringify(d);
})()`));
assert.ok(mixed.symptoms.includes("吐き気あり"));
assert.ok(!mixed.symptoms.includes("光がつらい"));
assert.ok(!mixed.symptoms.includes("音がつらい"));

const migrated = JSON.parse(evaluate(`JSON.stringify(normalizeRecord({
  id: "old", date: "2026-01-01", memo: "短い要約", memoRaw: "本人が話した原文",
  symptoms: ["拍動性", "前兆", "吐き気"]
}))`));
assert.equal(migrated.memo, "本人が話した原文");
assert.equal(migrated.memoSummary, "短い要約");
assert.equal(migrated.entryType, "headache");
assert.deepEqual(migrated.symptoms, ["ズキズキする痛み", "痛む前の見え方の変化", "吐き気あり"]);

const elements = { "summary-body": { innerHTML: "" } };
context.document.getElementById = (id) => elements[id] || null;
evaluate(`state.records = [
  normalizeRecord({ id: "h1", date: todayStr(-1), entryType: "headache", severity: 3,
    duration: "2時間くらい", durationMinutes: 120, symptoms: ["実際に吐いた", "動くと悪化"],
    triggers: [], med: "ロキソニン", medTiming: "30分で1錠", medCount: 1,
    medEffect: "よく効いた", impact: "寝込んだ", answeredFields: ["duration", "med", "impact"], createdAt: 2 }),
  normalizeRecord({ id: "n1", date: todayStr(), entryType: "noHeadache", createdAt: 3 })
]; renderSummary();`);
assert.match(elements["summary-body"].innerHTML, /頭痛があったのは1日/);
assert.match(elements["summary-body"].innerHTML, /実際に吐いた 1回/);
assert.match(elements["summary-body"].innerHTML, /頭痛なし/);

console.log("app parser tests: ok");
