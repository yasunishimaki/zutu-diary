/* ============================================================
   頭痛ダイアリー ─ 音声問診つき
   系譜: 就活ノート(デザイン) × ココマデ(音声問診・記録主義)
   原則: このアプリは記録の道具。診断・推測はしない。
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "zutsu-diary-v1";

/* ---------------- 状態と保存 ---------------- */

let state = {
  records: [],                       // 記録の配列
  settings: { soundOn: true, speechRate: 1.0, aiSummaryOn: false },
};

function isHeadacheRecord(r) { return r.entryType !== "noHeadache"; }
function answered(r, key) { return Array.isArray(r.answeredFields) && r.answeredFields.includes(key); }
function markAnswered(r, key) {
  if (!Array.isArray(r.answeredFields)) r.answeredFields = [];
  if (!r.answeredFields.includes(key)) r.answeredFields.push(key);
}
function markSkipped(r, key) {
  if (!Array.isArray(r.skippedFields)) r.skippedFields = [];
  if (!r.skippedFields.includes(key)) r.skippedFields.push(key);
}

const FIELD_LABELS = {
  overview: "自由に話した内容", time: "始まった時間", duration: "続いた時間",
  severity: "痛みの強さ", location: "痛む場所", quality: "痛み方",
  movement: "動いたときの変化", aura: "痛む前の見え方の変化",
  auraDetail: "見え方の変化の内容と時間",
  nausea: "吐き気・嘔吐", photophono: "光・音", triggers: "思い当たるきっかけ",
  med: "薬の名前", medTiming: "薬を飲んだ時刻・回数", medEffect: "薬の効きめ",
  impact: "生活への影響", memo: "先生に伝えたいこと",
};
function fieldLabel(key) { return FIELD_LABELS[key] || key; }
function emptyAnswerText(r, key, whenAnswered = "なし") {
  if (answered(r, key)) return whenAnswered;
  return Array.isArray(r.answeredFields) ? "未確認" : "旧版では未記録";
}

function normalizeRecord(r) {
  // 旧版でAI要約済みの記録は、本人の原文を主データへ戻す。
  if (r.memoRaw && !r.memoSummary) {
    r.memoSummary = r.memo || "";
    r.memo = r.memoRaw;
  }
  if (!r.entryType) r.entryType = "headache";
  if (!Array.isArray(r.symptoms)) r.symptoms = [];
  const symptomNames = {
    "拍動性": "ズキズキする痛み", "前兆": "痛む前の見え方の変化",
    "前兆あり": "痛む前の見え方の変化", "吐き気": "吐き気あり",
    "嘔吐あり": "実際に吐いた",
  };
  r.symptoms = [...new Set(r.symptoms.map((x) => symptomNames[x] || x))];
  if (!Array.isArray(r.triggers)) r.triggers = [];
  return r;
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.records = Array.isArray(data.records) ? data.records.map(normalizeRecord) : [];
      Object.assign(state.settings, data.settings || {});
    }
  } catch (_) { /* 壊れていたら初期状態で開始 */ }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("sv-SE"); // YYYY-MM-DD (ローカル時刻)
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${dow})`;
}

/* ---------------- 音声出力 (Web Speech API) ---------------- */

function speak(text, onEnd) {
  if (!state.settings.soundOn || !("speechSynthesis" in window)) {
    if (onEnd) onEnd();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  u.rate = state.settings.speechRate;
  ttsGuardUntil = Number.MAX_SAFE_INTEGER; // 読み上げ中はマイクの結果を捨てる
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    ttsGuardUntil = Date.now() + 800; // 読み上げ直後に確定する拾い込みも捨てる
    if (onEnd) onEnd();
  };
  u.onend = finish;
  u.onerror = finish;
  // onend が来ない環境向けの保険
  setTimeout(finish, Math.max(3000, text.length * 350));
  window.speechSynthesis.speak(u);
}

function stopSpeech() {
  try { window.speechSynthesis.cancel(); } catch (_) {}
  // 読み上げを打ち切ったらマイクをすぐ有効に戻す
  if (ttsGuardUntil > Date.now() + 1000) ttsGuardUntil = Date.now() + 300;
}
window.addEventListener("pagehide", stopSpeech);
window.addEventListener("beforeunload", stopSpeech);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopSpeech(); });

/* ---------------- 音声認識 (Web Speech API) ----------------
   問診中はマイクを開きっぱなしにする(continuous)。
   質問ごとに認識を起動し直すと毎回1〜2秒待たされるため。
   読み上げ中に拾った自分の声は ttsGuardUntil で捨てる。 */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let liveRec = null;
let liveRecBlocked = false; // マイク拒否などで開けない
let ttsGuardUntil = 0;      // この時刻までの認識結果は読み上げの拾い込みとして無視

function startListening() {
  if (!SR) { setMicStatus("この端末では音声認識が使えません。ボタンか文字入力で答えてください。", false); return; }
  if (liveRec || liveRecBlocked) return;
  const rec = new SR();
  rec.lang = "ja-JP";
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    if (Date.now() < ttsGuardUntil) return; // 自分の読み上げ声
    if (!interview) return;
    const q = currentQuestion();
    if (q && q.collect) {
      // メモの聞き溜め。
      // Android Chrome は認識途中の「育っていくテキスト」を何度も届けてくるため、
      // 足し算はせず、確定済み(isFinal)の結果だけを毎回ゼロから組み立て直す。
      let finals = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finals += e.results[i][0].transcript;
      }
      if (finals.trim()) collectUpdate(finals.trim());
    } else {
      // 単発の回答も、確定した結果だけを使う(途中経過で誤回答しない)
      const last = e.results[e.results.length - 1];
      if (!last.isFinal) return;
      submitAnswer(last[0].transcript);
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      liveRecBlocked = true;
      setMicStatus("マイクが許可されていません。ボタンか文字入力で答えてください。", false);
    }
  };
  rec.onend = () => {
    if (liveRec !== rec) return;
    liveRec = null;
    // 認識セッションが切れたら、聞き溜め分を確定に格上げしてから開き直す
    const q = interview && currentQuestion();
    if (q && q.collect) collectCommitted = $("q-input").value.trim();
    // 無音で自動停止したら、問診が続いている間は開き直す
    if (interview && !liveRecBlocked) startListening();
  };
  try { rec.start(); liveRec = rec; setMicStatus("聞いています…", true); } catch (_) {}
}

function stopListening() {
  if (liveRec) { const r = liveRec; liveRec = null; try { r.abort(); } catch (_) {} }
}

/* ---------------- 日本語の解析（ルールベース） ---------------- */

function parseYesNo(t) {
  if (/ありません|ないです|無い|ない|いいえ|いえ|しない|大丈夫|平気/.test(t)) return false;
  if (/はい|あります|ある|そう|うん|ええ|します|する|つらい|辛い/.test(t)) return true;
  return null;
}

function parseSeverity(t) {
  const n = t.match(/(10|[0-9])/);
  if (n) { const v = Number(n[1]); return v <= 3 ? 1 : v <= 6 ? 2 : 3; }
  if (/激し|ひど|強|寝込|動けな|最悪/.test(t)) return 3;
  if (/中|普通|そこそこ|まあまあ/.test(t)) return 2;
  if (/軽|少し|ちょっと|弱/.test(t)) return 1;
  return null;
}

function parseLocations(t) {
  const found = [];
  if (/右/.test(t)) found.push("右側");
  if (/左/.test(t)) found.push("左側");
  if (/両|りょう/.test(t)) found.push("両側");
  if (/こめかみ/.test(t)) found.push("こめかみ");
  if (/目の奥|目のおく|眼/.test(t)) found.push("目の奥");
  if (/後頭|うしろ|後ろ|首/.test(t)) found.push("後頭部");
  if (/全体|全部|頭中/.test(t)) found.push("頭全体");
  return found.length ? found : null;
}

/* 薬の名前はカタカナで表示する(音声認識が漢字・ひらがなにしても直す) */

function toKatakana(s) {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

const MED_NAMES = [
  // 一般的な鎮痛薬
  "ロキソニン", "ロキソプロフェン", "カロナール", "アセトアミノフェン", "バファリン",
  "イブプロフェン", "イブクイック", "イブ", "ナロン", "セデス", "リングルアイビー",
  "タイレノール", "ボルタレン",
  // トリプタン系
  "スマトリプタン", "イミグラン", "ゾルミトリプタン", "ゾーミッグ",
  "エレトリプタン", "レルパックス", "リザトリプタン", "マクサルト",
  "ナラトリプタン", "アマージ",
  // その他の片頭痛治療薬・予防薬
  "ラスミジタン", "レイボー", "アジョビ", "エムガルティ", "アイモビーグ",
  "ミグシス", "ミグリステン", "デパケン", "バルプロ酸", "インデラル", "トリプタノール",
  // 漢方
  "呉茱萸湯", "五苓散", "釣藤散", "葛根湯",
];

function normalizeMedName(raw) {
  // 聞き取った名前のカタカナ表記を最優先。
  // ひらがな→カタカナだけ変換し、言われたままを残す。
  const kata = toKatakana(String(raw).trim());
  if (!/[一-鿿]/.test(kata)) return kata;
  // 漢字が混ざった(=認識が漢字変換してしまった)場合だけ、辞書で救済を試みる
  const hits = [];
  for (const name of [...MED_NAMES].sort((a, b) => b.length - a.length)) {
    if (kata.includes(name) && !hits.some((h) => h.includes(name))) hits.push(name);
  }
  return hits.length ? hits.join("、") : kata;
}

function parseTime(t) {
  const r = { time: null, dateOffset: 0 };
  if (/昨日|きのう|昨夜|ゆうべ/.test(t)) r.dateOffset = -1;
  if (/一昨日|おととい/.test(t)) r.dateOffset = -2;
  const h = t.match(/(\d{1,2})\s*時/);
  if (h) r.time = `${h[1]}時ごろ`;
  else if (/起き|起床|目が覚め/.test(t)) r.time = "起床時";
  else if (/朝/.test(t)) r.time = "朝";
  else if (/昼|午後|ひる/.test(t)) r.time = "昼";
  else if (/夕方|夕/.test(t)) r.time = "夕方";
  else if (/夜中|深夜|真夜中/.test(t)) r.time = "夜中";
  else if (/夜|晩/.test(t)) r.time = "夜";
  else if (/今|さっき|少し前/.test(t)) r.time = "さっき";
  return (r.time || r.dateOffset) ? r : null;
}

const TRIGGER_WORDS = [
  [/寝不足|睡眠不足|眠れ|徹夜/, "寝不足"],
  [/寝すぎ|寝過ぎ/, "寝すぎ"],
  [/天気|雨|低気圧|台風|気圧/, "天気・低気圧"],
  [/生理|月経/, "生理"],
  [/ストレス|疲れ|緊張|イライラ/, "ストレス"],
  [/肩こり|肩凝り|首こり|こり/, "肩こり"],
  [/お酒|酒|アルコール|飲み|ワイン|ビール/, "アルコール"],
  [/人混み|ひとごみ|光|まぶし|眩し|匂い|におい|音/, "人混み・光・匂い"],
  [/スマホ|パソコン|画面|目の疲れ/, "目の疲れ・画面"],
  [/食べ|空腹|チョコ|チーズ/, "食事・空腹"],
];

function parseTriggers(t) {
  // 先に辞書照合(「眠れない」等が否定語と誤判定されないよう順序が重要)
  const found = [];
  for (const [re, label] of TRIGGER_WORDS) if (re.test(t)) found.push(label);
  if (found.length) return found;
  if (/特にない|とくにない|ありません|ないです|わからない|分からない|不明/.test(t)) return [];
  // 辞書にない言葉は、言われたままを「きっかけ」として記録する(はじかない)
  const custom = t.trim().slice(0, 40);
  return custom ? [custom] : null;
}

function parseMedEffect(t) {
  if (/よく効|効いた|楽にな|治った|おさま|収ま/.test(t) && !/少し|ちょっと|あまり/.test(t)) return "よく効いた";
  if (/少し|ちょっと|多少|まあまあ/.test(t)) return "少し効いた";
  if (/効かな|変わらな|だめ|ダメ|効いてない/.test(t)) return "効かなかった";
  return null;
}

function parseImpact(t) {
  if (/寝込|休んだ|動けな|欠勤|欠席/.test(t)) return "寝込んだ";
  if (/支障|つらかった|辛かった|大変|しんどか/.test(t)) return "支障あり";
  if (/普段|普通|いつも|どおり|通り|大丈夫/.test(t)) return "普段どおり";
  return null;
}

function parseNarrativeSeverity(t) {
  if (/激し|ひど|強い痛|寝込|動けな|最悪/.test(t)) return 3;
  if (/中くらい|中等度|そこそこ|まあまあの痛/.test(t)) return 2;
  if (/軽い痛|軽い頭痛|少し痛|ちょっと痛|弱い痛/.test(t)) return 1;
  const m = t.match(/(?:痛みの強さ|痛みは|強さは|程度は).{0,8}(10|[0-9])(?:段階|点|くらい|\/10)?/);
  if (!m) return null;
  const v = Number(m[1]);
  return v <= 3 ? 1 : v <= 6 ? 2 : 3;
}

function addSymptom(draft, label) {
  if (!draft.symptoms.includes(label)) draft.symptoms.push(label);
}

function parseDuration(t) {
  if (/まだ.*(続|痛)|続いて|治まっていない|おさまっていない/.test(t)) {
    return { label: "まだ続いている", minutes: null, ongoing: true };
  }
  let m = t.match(/(\d+)\s*時間半/);
  if (m) return { label: `${m[1]}時間半くらい`, minutes: Number(m[1]) * 60 + 30, ongoing: false };
  m = t.match(/(\d+(?:\.\d+)?)\s*時間/);
  if (m) return { label: `${m[1]}時間くらい`, minutes: Math.round(Number(m[1]) * 60), ongoing: false };
  m = t.match(/(\d+)\s*分/);
  if (m) return { label: `${m[1]}分くらい`, minutes: Number(m[1]), ongoing: false };
  m = t.match(/(\d+)\s*日/);
  if (m) return { label: `${m[1]}日くらい`, minutes: Number(m[1]) * 1440, ongoing: false };
  if (/半日以上/.test(t)) return { label: "半日以上", minutes: 720, ongoing: false };
  if (/半日|12時間/.test(t)) return { label: "半日くらい", minutes: 720, ongoing: false };
  if (/一日|1日|丸一日/.test(t)) return { label: "1日くらい", minutes: 1440, ongoing: false };
  if (/30分|三十分/.test(t)) return { label: "30分くらい", minutes: 30, ongoing: false };
  if (/1[〜～~-]3時間/.test(t)) return { label: "1〜3時間", minutes: 120, ongoing: false };
  if (/4[〜～~-]12時間/.test(t)) return { label: "4〜12時間", minutes: 480, ongoing: false };
  return null;
}

function parseMedTiming(t) {
  const raw = t.trim().slice(0, 80);
  if (!raw) return null;
  let count = null;
  const n = raw.match(/(\d+)\s*(回|錠)/);
  if (n && !/以上/.test(raw)) count = Number(n[1]);
  else if (/一回|1回|一錠|1錠/.test(raw)) count = 1;
  else if (/二回|2回|二錠|2錠/.test(raw)) count = 2;
  return { label: raw, count };
}

const RED_FLAG_RULES = [
  { re: /(突然|急に|いきなり).*(激し|ひど|最悪)|(今まで|これまで).*(ない|無い).*(痛|頭痛)/, label: "突然の、いつもと違う強い頭痛" },
  { re: /しびれ|麻痺|まひ|ろれつ|言葉が出|話しにく|意識|けいれん/, label: "しびれ、話しにくさ、意識の変化など" },
  { re: /発熱|高熱|熱が(ある|出た|高い)/, label: "発熱を伴う頭痛" },
  { re: /(頭|あたま).*(打った|ぶつけた)|転倒|交通事故/, label: "頭を打った後の頭痛" },
  { re: /妊娠中|産後|出産後/, label: "妊娠中または出産後の頭痛" },
];

function redFlagsIn(text) {
  return RED_FLAG_RULES.filter((x) => x.re.test(text)).map((x) => x.label);
}

function extractNarrative(text, draft) {
  draft.narrativeRaw = text.trim();
  const time = parseTime(text);
  if (time) {
    if (time.dateOffset) draft.date = todayStr(time.dateOffset);
    draft.time = time.time || "";
    markAnswered(draft, "time");
  }
  const duration = parseDuration(text);
  if (duration) {
    draft.duration = duration.label; draft.durationMinutes = duration.minutes; draft.ongoing = duration.ongoing;
    markAnswered(draft, "duration");
  }
  const severity = parseNarrativeSeverity(text);
  if (severity) { draft.severity = severity; markAnswered(draft, "severity"); }
  const locations = parseLocations(text);
  if (locations) { draft.location = locations.join("、"); markAnswered(draft, "location"); }

  if (/ズキ|脈打/.test(text)) { addSymptom(draft, "ズキズキする痛み"); markAnswered(draft, "quality"); }
  else if (/締め|しめ|圧迫|重い感じ/.test(text)) { addSymptom(draft, "締めつける痛み"); markAnswered(draft, "quality"); }
  if (/(動くと|歩くと|階段|体を動か).*(悪|強|つら)|じっとしていた/.test(text)) {
    addSymptom(draft, "動くと悪化"); markAnswered(draft, "movement");
  } else if (/(動いても|歩いても|階段でも).*(変わら|平気|大丈夫)|動くと.*(変わら|悪くなら)/.test(text)) {
    markAnswered(draft, "movement");
  }
  if (/(前兆|ギザギザ|チカチカ).{0,8}(ない|なく|なし|ありません|なかった)/.test(text)) markAnswered(draft, "aura");
  else if (/前兆|ギザギザ|チカチカ|視野.*欠/.test(text)) { addSymptom(draft, "痛む前の見え方の変化"); markAnswered(draft, "aura"); }
  if (/吐い(た|て)|吐きました|嘔吐/.test(text)) { addSymptom(draft, "実際に吐いた"); markAnswered(draft, "nausea"); }
  else if (/(吐き気|むかむか).{0,8}(ない|なく|なし|ありません|なかった)/.test(text)) markAnswered(draft, "nausea");
  else if (/吐き気|むかむか/.test(text)) { addSymptom(draft, "吐き気あり"); markAnswered(draft, "nausea"); }
  const noLightSound = /(光|音|まぶし|うるさ).{0,16}(つらくない|つらくなかった|平気|大丈夫|気にならない|気にならなかった)/.test(text);
  const light = !noLightSound && /光|まぶし|眩し/.test(text);
  const sound = !noLightSound && /音|うるさ/.test(text);
  if (light || sound) {
    if (light) addSymptom(draft, "光がつらい");
    if (sound) addSymptom(draft, "音がつらい");
    markAnswered(draft, "photophono");
  } else if (noLightSound) markAnswered(draft, "photophono");
  const knownTriggers = /寝不足|睡眠不足|寝すぎ|寝過ぎ|天気|低気圧|台風|生理|月経|ストレス|疲れ|緊張|肩こり|首こり|お酒|アルコール|人混み|匂い|におい|スマホ|パソコン|画面|空腹/.test(text);
  if (knownTriggers) { draft.triggers = parseTriggers(text) || []; markAnswered(draft, "triggers"); }
  const medHits = MED_NAMES.filter((name) => text.includes(name));
  if (medHits.length) { draft.med = medHits.join("、"); markAnswered(draft, "med"); }
  else if (/薬.*(飲んでいない|飲んでない|飲まなかった)/.test(text)) markAnswered(draft, "med");
  const effect = /(効|楽にな|治った|おさま|収ま|変わら|だめ|ダメ)/.test(text) ? parseMedEffect(text) : null;
  if (effect && draft.med) { draft.medEffect = effect; markAnswered(draft, "medEffect"); }
  const impact = parseImpact(text);
  if (impact) { draft.impact = impact; markAnswered(draft, "impact"); }
}

// 音声認識が日本語の語中へ入れる空白（例:「あっ た」）を吸収する。
// 単語間の空白が意味を持つ英数字はそのまま残す。
function normalizeSpeechText(value) {
  let text = String(value ?? "").normalize("NFKC").trim();
  const japanese = "ぁ-んァ-ヶ一-龠々ー";
  let previous;
  do {
    previous = text;
    text = text.replace(new RegExp(`([${japanese}])\\s+(?=[${japanese}])`, "g"), "$1");
  } while (text !== previous);
  return text
    .replace(/\s+([、。！？,.!?])/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

// 患者さんの意味は変えず、明らかな言いよどみだけを自由メモから除く。
function cleanSpokenMemo(value) {
  let text = normalizeSpeechText(value);
  text = text.replace(/(?:う(?:ー|〜|～)+ん|えっと|え(?:ー|〜|～)+と|あの(?:ー|〜|～)+|その(?:ー|〜|～)+|え(?:ー|〜|～)+|あ(?:ー|〜|～)+|ん(?:ー|〜|～)+)/g, "");
  text = text
    .replace(/^[、。,.\s]+/, "")
    .replace(/[、,](?=[、。！？,.!?])/g, "")
    .replace(/[、,]{2,}/g, "、")
    .replace(/[、,\s]+$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (text && !/[。！？!?]$/.test(text)) text += "。";
  return text;
}

/* ---------------- 問診の質問定義 ---------------- */

const QUESTIONS = [
  {
    key: "hasHeadache", label: "きょうの頭痛",
    ask: "きょうは頭痛がありましたか？",
    quick: ["あった", "なかった"],
    handle(t, draft) {
      if (/なかった|ありません|ないです|頭痛なし/.test(t)) {
        draft.entryType = "noHeadache";
        return "頭痛なし";
      }
      if (/あっ?た|有った|ありました|あります|ある|痛/.test(t)) {
        draft.entryType = "headache";
        return "頭痛あり";
      }
      return null;
    },
  },
  {
    key: "overview", label: "話してくれた内容",
    ask: "まず、きょうの頭痛について自由に話してください。いつから、どこが、どんなふうに痛んだかなど、分かる範囲で大丈夫です。話し終わったら『以上です』と言ってください。",
    quick: ["あとで質問に答える"], collect: true,
    handle(t, draft) {
      if (/^あとで質問に答える$/.test(t.trim())) return "個別に質問";
      extractNarrative(t, draft);
      return "話した内容を記録";
    },
  },
  {
    key: "time", label: "始まった時間",
    ask: "頭痛はいつごろ始まりましたか？",
    quick: ["起床時", "朝", "昼", "夕方", "夜", "昨日から"],
    skipIf: (draft) => answered(draft, "time"),
    handle(t, draft) {
      const r = parseTime(t);
      if (!r) return null;
      if (r.dateOffset) draft.date = todayStr(r.dateOffset);
      draft.time = r.time || "";
      return draft.time || (r.dateOffset === -1 ? "昨日" : "一昨日");
    },
  },
  {
    key: "duration", label: "続いた時間",
    ask: "頭痛はどれくらい続きましたか？まだ痛む場合は、まだ続いている、と答えてください。",
    quick: ["30分くらい", "1〜3時間", "4〜12時間", "半日以上", "まだ続いている"],
    skipIf: (draft) => answered(draft, "duration"),
    handle(t, draft) {
      const v = parseDuration(t);
      if (!v) return null;
      draft.duration = v.label; draft.durationMinutes = v.minutes; draft.ongoing = v.ongoing;
      return v.label;
    },
  },
  {
    key: "severity", label: "強さ",
    ask: "痛みの強さを教えてください。軽い、中くらい、強い、のどれですか？",
    quick: ["軽い", "中くらい", "強い"],
    skipIf: (draft) => answered(draft, "severity"),
    handle(t, draft) {
      const v = parseSeverity(t);
      if (v == null) return null;
      draft.severity = v;
      return ["", "軽い", "中くらい", "強い"][v];
    },
  },
  {
    key: "location", label: "場所",
    ask: "どのあたりが痛みますか？",
    quick: ["右側", "左側", "両側", "こめかみ", "目の奥", "後頭部", "頭全体"],
    multi: true,
    skipIf: (draft) => answered(draft, "location"),
    handle(t, draft) {
      const v = parseLocations(t);
      if (!v) return null;
      draft.location = v.join("、");
      return draft.location;
    },
  },
  {
    key: "quality", label: "痛み方",
    ask: "どんなふうに痛みますか？",
    quick: ["ズキズキする", "締めつけられる", "重い感じ", "どれでもない"],
    skipIf: (draft) => answered(draft, "quality"),
    handle(t, draft) {
      if (/ズキ|脈打/.test(t)) { addSymptom(draft, "ズキズキする痛み"); return "ズキズキする"; }
      if (/締め|しめ|圧迫/.test(t)) { addSymptom(draft, "締めつける痛み"); return "締めつけられる"; }
      if (/重い/.test(t)) { addSymptom(draft, "重い痛み"); return "重い感じ"; }
      if (/どれでもない|その他|違う/.test(t)) return "どれでもない";
      return null;
    },
  },
  {
    key: "movement", label: "動いたとき",
    ask: "歩いたり階段を上ったりすると、痛みが強くなりましたか？",
    quick: ["強くなった", "変わらなかった", "動けなかった"],
    skipIf: (draft) => answered(draft, "movement"),
    handle(t, draft) {
      if (/強く|悪化|つらく/.test(t)) { addSymptom(draft, "動くと悪化"); return "強くなった"; }
      if (/動けな/.test(t)) { addSymptom(draft, "動けなかった"); return "動けなかった"; }
      if (/変わら|ならな|いいえ|ない/.test(t)) return "変わらなかった";
      return null;
    },
  },
  {
    key: "aura", label: "痛む前の見え方",
    ask: "痛み出す前に、ギザギザした光やチカチカなどの前兆はありましたか？",
    quick: ["はい", "いいえ"],
    skipIf: (draft) => answered(draft, "aura"),
    handle(t, draft) {
      const v = parseYesNo(t);
      if (v == null) return null;
      if (v) addSymptom(draft, "痛む前の見え方の変化");
      return v ? "あった" : "なかった";
    },
  },
  {
    key: "auraDetail", label: "見え方の変化の詳しい内容",
    ask: "どんなふうに見えて、どれくらい続きましたか？分かる範囲で教えてください。",
    quick: ["5分より短かった", "5分〜1時間くらい", "1時間以上続いた", "覚えていない"],
    skipIf: (draft) => !draft.symptoms.some((x) => ["前兆", "前兆あり", "痛む前の見え方の変化"].includes(x)) || answered(draft, "auraDetail"),
    handle(t, draft) {
      draft.auraDetail = t.trim().slice(0, 120);
      return draft.auraDetail || null;
    },
  },
  {
    key: "nausea", label: "吐き気",
    ask: "吐き気はありますか？",
    quick: ["はい", "いいえ", "吐いた"],
    skipIf: (draft) => answered(draft, "nausea"),
    handle(t, draft) {
      if (/吐い(た|て)|吐きました|嘔吐/.test(t)) { addSymptom(draft, "実際に吐いた"); return "吐いた"; }
      const v = parseYesNo(t);
      if (v == null) return null;
      if (v) addSymptom(draft, "吐き気あり");
      return v ? "ある" : "ない";
    },
  },
  {
    key: "photophono", label: "光・音",
    ask: "光や音が、いつもよりつらく感じますか？",
    quick: ["両方つらい", "光だけ", "音だけ", "いいえ"],
    skipIf: (draft) => answered(draft, "photophono"),
    handle(t, draft) {
      const hikari = /光|ひかり|まぶし|眩し/.test(t);
      const oto = /音|おと|うるさ/.test(t);
      const v = parseYesNo(t);
      if (!hikari && !oto && v == null) return null;
      if (hikari || (v && !oto)) addSymptom(draft, "光がつらい");
      if (oto || (v && !hikari)) addSymptom(draft, "音がつらい");
      if (v === false && !hikari && !oto) return "いいえ";
      return [hikari || v ? "光" : null, oto || v ? "音" : null].filter(Boolean).join("・") + "がつらい";
    },
  },
  {
    key: "triggers", label: "きっかけ",
    ask: "思い当たるきっかけはありますか？たとえば、寝不足、天気、ストレス、生理、など。",
    quick: ["寝不足", "寝すぎ", "天気・低気圧", "生理", "ストレス", "肩こり", "アルコール"],
    multi: true, multiNone: "特にない",
    skipIf: (draft) => answered(draft, "triggers"),
    handle(t, draft) {
      const v = parseTriggers(t);
      if (v === null) return null;
      draft.triggers = v;
      return v.length ? v.join("、") : "特になし";
    },
  },
  {
    key: "med", label: "薬",
    ask: "この頭痛が起きたときに使う薬は飲みましたか？飲んだ場合は、薬の名前を教えてください。",
    quick: ["飲んでいない"],
    freeText: true,
    skipIf: (draft) => answered(draft, "med"),
    handle(t, draft) {
      if (/飲んでいない|飲んでない|飲まな|なし|ない/.test(t)) { draft.med = ""; return "飲んでいない"; }
      const name = t.replace(/を?飲みました|を?飲んだ|です|飲みます/g, "").trim();
      if (!name) return null;
      draft.med = normalizeMedName(name);
      return draft.med;
    },
  },
  {
    key: "medTiming", label: "薬を飲んだタイミング",
    ask: "頭痛が始まってどれくらいで、薬を何回分飲みましたか？たとえば『30分くらいで1錠』のように教えてください。",
    quick: ["すぐに1回分", "30分以内に1回分", "1時間くらいで1回分", "2時間以上たって1回分", "2回分以上"],
    skipIf: (draft) => !draft.med || answered(draft, "medTiming"),
    handle(t, draft) {
      const v = parseMedTiming(t);
      if (!v) return null;
      draft.medTiming = v.label; draft.medCount = v.count;
      return v.label;
    },
  },
  {
    key: "medEffect", label: "薬の効きめ",
    ask: "お薬は効きましたか？",
    quick: ["よく効いた", "少し効いた", "効かなかった", "まだわからない"],
    skipIf: (draft) => !draft.med || answered(draft, "medEffect"),
    handle(t, draft) {
      if (/まだ|わからない|分からない/.test(t)) { draft.medEffect = "まだ不明"; return "まだ不明"; }
      const v = parseMedEffect(t);
      if (!v) return null;
      draft.medEffect = v;
      return v;
    },
  },
  {
    key: "impact", label: "生活への影響",
    ask: "きょうの生活への影響はどうでしたか？普段どおり、支障があった、寝込んだ、のどれですか？",
    quick: ["普段どおり", "支障あり", "寝込んだ"],
    skipIf: (draft) => answered(draft, "impact"),
    handle(t, draft) {
      const v = parseImpact(t);
      if (!v) return null;
      draft.impact = v;
      return v;
    },
  },
  {
    key: "memo", label: "メモ",
    ask: "ほかに、先生に伝えておきたいことはありますか？ゆっくりどうぞ。話し終わったら、「以上です」と言ってください。",
    quick: ["特にない"],
    collect: true, // 一言で確定せず、話し終わるまで聞き溜める
    handle(t, draft) {
      const spoken = normalizeSpeechText(t);
      draft.memoSpokenRaw = spoken;
      if (/^(特にない|ありません|ないです|大丈夫)/.test(spoken)) { draft.memo = ""; return "特になし"; }
      draft.memo = cleanSpokenMemo(spoken);
      if (!draft.memo) return "特になし";
      return "メモに記録";
    },
  },
];

/* ---------------- 問診の進行 ---------------- */

let interview = null; // { idx, draft, answers: [{label, display}], retries }

function blankDraft() {
  return {
    id: newId(), entryType: "headache", date: todayStr(), time: "", duration: "",
    durationMinutes: null, ongoing: false, severity: null, location: "",
    symptoms: [], triggers: [], med: "", medTiming: "", medCount: null,
    medEffect: "", impact: "", auraDetail: "", memo: "", memoSpokenRaw: "", narrativeRaw: "",
    answeredFields: [], skippedFields: [], safetyFlags: [],
    source: "voice", createdAt: Date.now(),
  };
}

function startInterview() {
  interview = { idx: 0, draft: blankDraft(), answers: [], retries: 0 };
  liveRecBlocked = false;
  $("interview-idle").classList.add("hidden");
  $("interview-confirm").classList.add("hidden");
  $("interview-live").classList.remove("hidden");
  $("safety-alert").classList.add("hidden");
  $("answered-chips").innerHTML = "";
  askCurrent(true);
}

function currentQuestion() {
  while (interview.idx < QUESTIONS.length) {
    const q = QUESTIONS[interview.idx];
    if (q.skipIf && q.skipIf(interview.draft)) { interview.idx++; continue; }
    return q;
  }
  return null;
}

function askCurrent(fresh) {
  const q = currentQuestion();
  if (!q) { finishInterview(); return; }
  if (fresh) interview.retries = 0;

  const visibleCount = QUESTIONS.filter(x => !(x.skipIf && x.skipIf(interview.draft))).length;
  const visibleIdx = QUESTIONS.slice(0, interview.idx).filter(x => !(x.skipIf && x.skipIf(interview.draft))).length;
  $("q-progress").textContent = `質問 ${visibleIdx + 1} / ${visibleCount}`;
  $("q-text").textContent = q.ask;
  $("q-input").value = "";
  collectCommitted = "";

  const quick = $("q-quick");
  quick.innerHTML = "";
  if (q.multi) {
    // 複数選択: タップでON/OFF → 「これで決定」でまとめて回答
    for (const label of q.quick) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => b.classList.toggle("sel");
      quick.appendChild(b);
    }
    if (q.multiNone) {
      const none = document.createElement("button");
      none.textContent = q.multiNone;
      none.onclick = () => submitAnswer(q.multiNone);
      quick.appendChild(none);
    }
    const done = document.createElement("button");
    done.textContent = "これで決定 →";
    done.className = "q-done";
    done.onclick = () => {
      const sel = [...quick.querySelectorAll("button.sel")].map((x) => x.textContent);
      if (!sel.length && !q.multiNone) {
        setMicStatus("あてはまるものをタップするか、声で答えてください。", !!liveRec);
        return;
      }
      submitAnswer(sel.length ? sel.join("、") : q.multiNone);
    };
    quick.appendChild(done);
  } else {
    for (const label of q.quick) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = () => submitAnswer(label);
      quick.appendChild(b);
    }
    if (q.collect) {
      const done = document.createElement("button");
      done.textContent = "🎤 話し終わった →";
      done.className = "q-done";
      done.onclick = () => submitAnswer($("q-input").value.trim() || "特にない");
      quick.appendChild(done);
    }
  }

  startListening(); // すでに開いていれば何もしない(開きっぱなし)
  if (liveRec) setMicStatus(q.collect ? "聞いています… 話し終わったら「以上です」と言ってください" : "聞いています…", true);
  speak(q.ask);
}

function setMicStatus(msg, listening) {
  const box = $("q-mic");
  box.classList.toggle("listening", !!listening);
  $("mic-status").textContent = msg || (SR ? "マイク待機中" : "音声認識なし(ボタンで回答)");
}

function submitAnswer(text) {
  if (!interview) return;
  const q = currentQuestion();
  if (!q || !text || !text.trim()) return;

  const clean = normalizeSpeechText(text);
  const flags = redFlagsIn(clean);
  if (flags.length) showSafetyAlert(flags, interview.draft);
  const display = q.handle(clean, interview.draft);
  if (display === null) {
    interview.retries++;
    if (interview.retries <= 1) {
      setMicStatus(`「${text}」を解釈できませんでした。`, !!liveRec);
      speak("すみません、もう一度お願いします。");
    } else {
      setMicStatus(`「${text}」を解釈できませんでした。ボタンか文字入力で答えてください。`, !!liveRec);
    }
    return;
  }

  markAnswered(interview.draft, q.key);
  interview.answers.push({ label: q.label, display });
  renderAnsweredChips();
  if (q.key === "hasHeadache" && interview.draft.entryType === "noHeadache") {
    interview.idx = QUESTIONS.length;
    askCurrent(true);
    return;
  }
  interview.idx++;
  askCurrent(true);
}

function renderAnsweredChips() {
  const box = $("answered-chips");
  box.innerHTML = "";
  for (const a of interview.answers) {
    const s = document.createElement("span");
    s.className = "chip-done";
    s.innerHTML = `${escapeHtml(a.label)}: <b>${escapeHtml(a.display)}</b>`;
    box.appendChild(s);
  }
}

/* メモの聞き溜め: 「以上です」等の締め言葉が来たときだけ確定する。
   collectCommitted = 前の認識セッションまでに確定した分。
   現在セッションの確定結果(finals)はイベントごとに丸ごと届くので、
   常に committed + finals で入力欄を作り直す(足し算しない)。 */
const COLLECT_END_RE = /(以上です|以上でお願いします|以上|終わりです|おわりです|これで終わり|おしまい)[。．！!？?]?\s*$/;
let collectCommitted = "";

function collectUpdate(sessionFinals) {
  let text = collectCommitted ? `${collectCommitted} ${sessionFinals}` : sessionFinals;
  let done = false;
  if (COLLECT_END_RE.test(text)) {
    text = text.replace(COLLECT_END_RE, "").trim();
    done = true;
  }
  $("q-input").value = text;
  if (done) {
    submitAnswer(text || "特にない");
  } else {
    setMicStatus("聞いています… 話し終わったら「以上です」と言ってください", true);
  }
}

function skipCurrent() {
  if (!interview) return;
  stopSpeech(); // マイクは開いたまま次の質問へ
  const q = currentQuestion();
  if (q) markSkipped(interview.draft, q.key);
  interview.idx++;
  askCurrent(true);
}

function showSafetyAlert(flags, draft) {
  for (const flag of flags) if (!draft.safetyFlags.includes(flag)) draft.safetyFlags.push(flag);
  const box = $("safety-alert");
  box.innerHTML = `<strong>記録を続ける前に確認してください</strong>
    <p>${escapeHtml([...new Set(draft.safetyFlags)].join("、"))}が話に含まれていました。すぐに医療機関へ相談してください。意識がおかしい、体が動かないなど緊急の場合は119番へ連絡してください。</p>`;
  box.classList.remove("hidden");
  speak("急いで受診したほうがよい症状が含まれている可能性があります。画面の案内を確認してください。");
}

function abortInterview(silent) {
  stopListening(); stopSpeech();
  interview = null;
  $("interview-live").classList.add("hidden");
  $("interview-confirm").classList.add("hidden");
  $("interview-idle").classList.remove("hidden");
  if (!silent) toast("問診を中止しました");
}

let lastInterviewRecord = null; // 直前に自動保存した記録(取り消し用)

function finishInterview() {
  stopListening();
  const d = interview.draft;
  interview = null;

  // 頭痛なしは同じ日の「頭痛なし」を更新する。頭痛記録がある日は上書きしない。
  if (d.entryType === "noHeadache") {
    if (state.records.some((r) => r.date === d.date && isHeadacheRecord(r))) {
      $("interview-live").classList.add("hidden");
      $("interview-confirm").classList.add("hidden");
      $("interview-idle").classList.remove("hidden");
      toast("この日はすでに頭痛の記録があります");
      return;
    }
    state.records = state.records.filter((r) => !(r.date === d.date && !isHeadacheRecord(r)));
  } else {
    state.records = state.records.filter((r) => !(r.date === d.date && !isHeadacheRecord(r)));
  }
  state.records.push(d);
  save();
  renderRecent();
  lastInterviewRecord = d;

  $("interview-live").classList.add("hidden");
  $("interview-confirm").classList.remove("hidden");
  const confirmSafety = $("confirm-safety");
  if (d.safetyFlags.length) {
    confirmSafety.innerHTML = `<strong>記録だけで済ませず、すぐに相談してください</strong><p>${escapeHtml(d.safetyFlags.join("、"))}が話に含まれていました。すぐに医療機関へ相談してください。意識がおかしい、体が動かないなど緊急の場合は119番へ連絡してください。</p>`;
    confirmSafety.classList.remove("hidden");
  } else {
    confirmSafety.classList.add("hidden");
  }
  const rows = d.entryType === "noHeadache" ? [
    ["日付", fmtDate(d.date)],
    ["記録", "頭痛はなかった"],
  ] : [
    ["日付", `${fmtDate(d.date)} ${d.time}`],
    ["続いた時間", d.duration || "未確認"],
    ["強さ", d.severity ? ["", "軽い", "中くらい", "強い"][d.severity] : "─"],
    ["場所", d.location || "─"],
    ["症状", d.symptoms.join("、") || "─"],
    ["痛む前の見え方の詳しい内容", d.auraDetail || "─"],
    ["きっかけ", d.triggers.join("、") || "特になし"],
    ["薬", d.med ? `${d.med}（${d.medTiming || "飲んだ時刻・回数は未確認"}、${d.medEffect || "効きめは未確認"}）` : "飲んでいない"],
    ["生活への影響", d.impact || "─"],
    ["最初に話した内容", d.narrativeRaw || "─"],
    ["メモ", d.memo || "─"],
    ["質問を飛ばした項目", d.skippedFields.length ? d.skippedFields.map(fieldLabel).join("、") : "なし"],
  ];
  $("confirm-list").innerHTML = rows.map(([k, v]) =>
    `<dt>${k}</dt><dd${k === "メモ" ? ' id="confirm-memo"' : ""}>${escapeHtml(v)}</dd>`).join("");
  toast(d.entryType === "noHeadache" ? `${fmtDate(d.date)} は頭痛なしで記録しました` : `${fmtDate(d.date)} の頭痛を記録しました`);
  speak(d.safetyFlags.length ? "記録だけで済ませず、画面の案内を確認して、すぐに医療機関へ相談してください。" : d.entryType === "noHeadache" ? "頭痛がなかった日として記録しました。" : "記録しました。お大事にしてください。");
  summarizeMemoIfLong(d); // 長い自由発話のメモは裏で要約(失敗しても原文が残る)
}

function removeLastInterviewRecord() {
  if (!lastInterviewRecord) return;
  state.records = state.records.filter((r) => r.id !== lastInterviewRecord.id);
  lastInterviewRecord = null;
  save();
  renderRecent();
}

function closeConfirm() {
  $("interview-confirm").classList.add("hidden");
  $("interview-idle").classList.remove("hidden");
}

/* ---------------- メモの自由発話を要約する ----------------
   本人が許可した場合だけ、長いメモを /api/summarize (Pages Functions → OpenAI API) に送る。
   API未設定・オフライン・エラー時は原文のまま残す(要約は上乗せ機能)。 */

const SUMMARIZE_MIN_CHARS = 40;

async function summarizeMemoIfLong(record) {
  if (!state.settings.aiSummaryOn || !record.memo || record.memo.length < SUMMARIZE_MIN_CHARS) return;
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: record.memo }),
    });
    if (!res.ok) return;
    const { summary } = await res.json();
    if (!summary) return;

    const r = state.records.find((x) => x.id === record.id);
    if (!r) return; // 取り消し済みなら何もしない
    r.memoSummary = summary; // 本人の原文は r.memo に残す
    save();
    renderRecent();

    if (lastInterviewRecord && lastInterviewRecord.id === r.id) toast("医師向けの短いまとめを追加しました");
  } catch (_) { /* 原文のまま */ }
}

/* ---------------- フォーム入力 ---------------- */

function saveNoHeadache(date = todayStr()) {
  if (state.records.some((r) => r.date === date && isHeadacheRecord(r))) {
    toast("この日はすでに頭痛の記録があります");
    return;
  }
  state.records = state.records.filter((r) => !(r.date === date && !isHeadacheRecord(r)));
  state.records.push(normalizeRecord({
    id: newId(), entryType: "noHeadache", date, source: "quick",
    symptoms: [], triggers: [], answeredFields: ["hasHeadache"], skippedFields: [],
    createdAt: Date.now(),
  }));
  save(); renderRecent(); renderCalendar(); renderSummary();
  toast(`${fmtDate(date)} は頭痛なしで記録しました`);
}

function setupChips(el, single) {
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      if (single) {
        const was = b.classList.contains("sel");
        el.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
        if (!was) b.classList.add("sel");
      } else {
        if (b.dataset.none === "true") {
          const willSelect = !b.classList.contains("sel");
          el.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
          if (willSelect) b.classList.add("sel");
          return;
        }
        el.querySelectorAll("button[data-none='true']").forEach((x) => x.classList.remove("sel"));
        b.classList.toggle("sel");
      }
    });
  });
}
function chipValue(el) {
  const b = el.querySelector("button.sel");
  return b ? b.dataset.v : "";
}
function chipValues(el) {
  return [...el.querySelectorAll("button.sel")].map((b) => b.dataset.v);
}
function clearChips(el) { el.querySelectorAll("button").forEach((b) => b.classList.remove("sel")); }

function submitForm(e) {
  e.preventDefault();
  const severity = Number(chipValue($("f-severity")));
  if (!severity) { toast("痛みの強さを選んでください"); return; }
  const durationText = $("f-duration-free").value.trim() || $("f-duration").value;
  const parsedDuration = parseDuration(durationText || "");
  const med = normalizeMedName($("f-med").value);
  const medTiming = $("f-medtiming").value.trim();
  if (med && $("f-no-med").checked) {
    toast("薬の名前か「飲んでいない」のどちらか一方を選んでください");
    return;
  }
  const symptomChoices = chipValues($("f-symptoms"));
  const triggerChoices = chipValues($("f-triggers"));
  const rec = {
    id: newId(),
    entryType: "headache",
    date: $("f-date").value || todayStr(),
    time: $("f-time").value,
    duration: durationText,
    durationMinutes: parsedDuration?.minutes ?? null,
    ongoing: parsedDuration?.ongoing || false,
    severity,
    location: chipValues($("f-location")).join("、"),
    symptoms: symptomChoices.filter((x) => x !== "症状なし"),
    triggers: triggerChoices.filter((x) => x !== "特になし"),
    med,
    medTiming,
    medCount: parseMedTiming(medTiming)?.count ?? null,
    medEffect: $("f-medeffect").value,
    impact: chipValue($("f-impact")),
    auraDetail: $("f-aura-detail").value.trim(),
    memo: $("f-memo").value.trim(),
    answeredFields: ["severity"],
    skippedFields: [],
    safetyFlags: redFlagsIn($("f-memo").value.trim()),
    source: "form",
    createdAt: Date.now(),
  };
  if (rec.time) markAnswered(rec, "time");
  if (rec.duration) markAnswered(rec, "duration");
  if (rec.location) markAnswered(rec, "location");
  if (symptomChoices.length) ["quality", "movement", "aura", "nausea", "photophono"].forEach((k) => markAnswered(rec, k));
  if (rec.auraDetail) markAnswered(rec, "auraDetail");
  if (triggerChoices.length) markAnswered(rec, "triggers");
  if (rec.med || $("f-no-med").checked) markAnswered(rec, "med");
  if (rec.medTiming) markAnswered(rec, "medTiming");
  if (rec.medEffect) markAnswered(rec, "medEffect");
  if (rec.impact) markAnswered(rec, "impact");
  if (rec.memo) markAnswered(rec, "memo");
  if (rec.safetyFlags.length) {
    window.alert("急いで受診したほうがよい症状が含まれている可能性があります。すぐに医療機関へ相談してください。意識がおかしい、体が動かないなど緊急の場合は119番へ連絡してください。");
  }
  state.records = state.records.filter((r) => !(r.date === rec.date && !isHeadacheRecord(r)));
  state.records.push(rec);
  save();
  summarizeMemoIfLong(rec);
  $("entry-form").reset();
  $("f-date").value = todayStr();
  ["f-severity", "f-location", "f-symptoms", "f-triggers", "f-impact"].forEach((id) => clearChips($(id)));
  renderRecent();
  toast(`${fmtDate(rec.date)} の頭痛を記録しました`);
}

/* ---------------- 記録の表示 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function entryHtml(r, withDelete) {
  if (!isHeadacheRecord(r)) {
    return `<div class="entry no-headache-entry">
      <div class="e-sev-mark">なし<small>頭痛</small></div>
      <div><div class="e-head"><span class="e-date">${fmtDate(r.date)}</span>
      ${withDelete ? `<button class="e-del" data-del="${r.id}">削除</button>` : ""}</div>
      <div class="e-body">この日は頭痛がなかったと記録しました。</div></div></div>`;
  }
  const sevMark = ["", "軽", "中", "強"][r.severity] || "未";
  const sevLabel = ["", "軽い", "中くらい", "強い"][r.severity] || "未確認";
  const parts = [];
  parts.push(`続いた時間: ${r.duration || emptyAnswerText(r, "duration", "未入力")}`);
  if (r.location) parts.push(`場所: ${r.location}`);
  if (r.symptoms && r.symptoms.length) parts.push(`症状: ${r.symptoms.join("、")}`);
  if (r.auraDetail) parts.push(`痛む前の見え方: ${r.auraDetail}`);
  if (r.triggers && r.triggers.length) parts.push(`きっかけ: ${r.triggers.join("、")}`);
  parts.push(r.med ? `薬: ${r.med}${r.medTiming ? `（${r.medTiming}）` : ""}${r.medEffect ? `・${r.medEffect}` : ""}` : `薬: ${emptyAnswerText(r, "med", "飲んでいない")}`);
  if (r.impact) parts.push(`影響: ${r.impact}`);
  if (r.memoSummary) parts.push(`医師向けの短いまとめ: ${r.memoSummary}`);
  if (r.narrativeRaw) parts.push(`最初に話した内容: ${r.narrativeRaw}`);
  if (r.memo) parts.push(`本人の言葉: ${r.memo}`);
  return `<div class="entry sev${r.severity}">
    <div class="e-sev-mark">${sevMark}<small>${sevLabel}</small></div>
    <div>
      <div class="e-head">
        <span class="e-date">${fmtDate(r.date)} ${escapeHtml(r.time || "")}</span>
        <span class="e-src">${r.source === "voice" ? "音声で記録" : "フォームで記録"}</span>
        ${withDelete ? `<button class="e-del" data-del="${r.id}">削除</button>` : ""}
      </div>
      <div class="e-body">${escapeHtml(parts.join(" ／ "))}</div>
    </div>
  </div>`;
}

function sortedRecords() {
  return [...state.records].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt) || b.createdAt - a.createdAt);
}

function renderRecent() {
  const box = $("recent-list");
  const recent = sortedRecords().slice(0, 5);
  box.innerHTML = recent.length
    ? recent.map((r) => entryHtml(r, true)).join("")
    : `<div class="empty">まだ記録がありません<small>「🎤 問診をはじめる」から最初の記録をどうぞ</small></div>`;
  bindDelete(box);
  $("meta-count").textContent = state.records.length;
  $("nav-count").textContent = state.records.length || "";
}

function bindDelete(container) {
  container.querySelectorAll("[data-del]").forEach((b) => {
    b.addEventListener("click", () => {
      if (!confirm("この記録を削除しますか？")) return;
      state.records = state.records.filter((r) => r.id !== b.dataset.del);
      save();
      renderRecent(); renderCalendar(); renderSummary();
      toast("削除しました");
    });
  });
}

/* ---------------- カレンダー ---------------- */

let calYear, calMonth; // month: 0-11
let selectedDay = null;

function recordsByDate() {
  const map = new Map();
  for (const r of state.records) {
    if (!map.has(r.date)) map.set(r.date, []);
    map.get(r.date).push(r);
  }
  return map;
}

function renderCalendar() {
  if (calYear == null) { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); }
  $("cal-title").textContent = `${calYear}年 ${calMonth + 1}月`;

  const map = recordsByDate();
  const first = new Date(calYear, calMonth, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const today = todayStr();

  let html = "日月火水木金土".split("").map((d) => `<div class="cal-dow">${d}</div>`).join("");
  for (let i = 0; i < startDow; i++) html += `<div class="cal-cell out"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const recs = map.get(iso) || [];
    const headacheRecs = recs.filter(isHeadacheRecord);
    const maxSev = headacheRecs.reduce((m, r) => Math.max(m, r.severity || 0), 0);
    const hasMed = headacheRecs.some((r) => r.med);
    const confirmedNoHeadache = recs.some((r) => !isHeadacheRecord(r)) && !headacheRecs.length;
    const cls = ["cal-cell"];
    if (maxSev) cls.push(`sev${maxSev}`);
    if (confirmedNoHeadache) cls.push("no-headache");
    if (iso === today) cls.push("today");
    if (iso === selectedDay) cls.push("selected");
    html += `<div class="${cls.join(" ")}" data-day="${iso}">
      <span class="d">${d}</span>${hasMed ? `<span class="med">💊</span>` : ""}${confirmedNoHeadache ? `<span class="no-headache-mark">✓</span>` : ""}
    </div>`;
  }
  $("cal-grid").innerHTML = html;
  $("cal-grid").querySelectorAll("[data-day]").forEach((c) => {
    c.addEventListener("click", () => { selectedDay = c.dataset.day; renderCalendar(); });
  });

  // 月間集計
  const monthPrefix = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-`;
  const monthRecs = state.records.filter((r) => r.date.startsWith(monthPrefix));
  const headacheMonthRecs = monthRecs.filter(isHeadacheRecord);
  const headacheDays = new Set(headacheMonthRecs.map((r) => r.date)).size;
  const recordedDays = new Set(monthRecs.map((r) => r.date)).size;
  const medDays = new Set(headacheMonthRecs.filter((r) => r.med).map((r) => r.date)).size;
  const severe = headacheMonthRecs.filter((r) => r.severity === 3).length;
  let statsHtml = `
    <div class="stat"><div class="n">${headacheDays}</div><div class="l">頭痛のあった日</div></div>
    <div class="stat"><div class="n">${recordedDays}</div><div class="l">記録できた日</div></div>
    <div class="stat"><div class="n ${medDays >= 10 ? "warn" : ""}">${medDays}</div><div class="l">薬を飲んだ日</div></div>
    <div class="stat"><div class="n">${severe}</div><div class="l">強い発作の回数</div></div>`;
  if (medDays >= 10) {
    statsHtml += `<div class="stat-note">この月は頭痛の薬を飲んだ日が${medDays}日あります。使いすぎの目安は薬の種類によって月10日または15日で、その状態が3か月を超えて続くかも重要です。自己判断で薬をやめず、この画面を先生に見せて相談してください。</div>`;
  }
  $("cal-stats").innerHTML = statsHtml;

  // 選択した日の詳細
  const detail = $("cal-day-detail");
  if (selectedDay && selectedDay.startsWith(monthPrefix)) {
    const recs = map.get(selectedDay) || [];
    detail.innerHTML = `<h3 class="sum-head">${fmtDate(selectedDay)} の記録</h3>` +
      (recs.length
        ? `<div class="entry-list">${recs.map((r) => entryHtml(r, true)).join("")}</div>`
        : `<div class="empty">この日の記録はありません。</div>`);
    bindDelete(detail);
  } else {
    detail.innerHTML = "";
  }
}

/* ---------------- 受診メモ ---------------- */

let summaryMonths = 1;

function renderSummary() {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - summaryMonths);
  const startIso = start.toLocaleDateString("sv-SE");
  const endIso = end.toLocaleDateString("sv-SE");

  const recs = sortedRecords().filter((r) => r.date >= startIso && r.date <= endIso).reverse(); // 古い順
  const box = $("summary-body");

  if (!recs.length) {
    box.innerHTML = `<div class="empty">この期間の記録がありません。</div>`;
    return;
  }

  const headacheRecs = recs.filter(isHeadacheRecord);
  const headacheDays = new Set(headacheRecs.map((r) => r.date)).size;
  const recordedDays = new Set(recs.map((r) => r.date)).size;
  const totalDays = Math.round((new Date(`${endIso}T12:00:00`) - new Date(`${startIso}T12:00:00`)) / 86400000) + 1;
  const medDays = new Set(headacheRecs.filter((r) => r.med).map((r) => r.date)).size;
  const sevCount = [0, 0, 0, 0];
  headacheRecs.forEach((r) => sevCount[r.severity || 0]++);
  const symptomCount = (...labels) => headacheRecs.filter((r) => labels.some((x) => (r.symptoms || []).includes(x))).length;
  const auraCount = symptomCount("前兆", "前兆あり", "痛む前の見え方の変化");
  const downCount = headacheRecs.filter((r) => r.impact === "寝込んだ").length;
  const durationValues = headacheRecs.map((r) => r.durationMinutes).filter((n) => Number.isFinite(n) && n > 0);
  const averageMinutes = durationValues.length ? Math.round(durationValues.reduce((a, b) => a + b, 0) / durationValues.length) : null;
  const durationText = averageMinutes == null ? "未集計" : averageMinutes < 60 ? `入力された目安から平均約${averageMinutes}分` : `入力された目安から平均約${(averageMinutes / 60).toFixed(averageMinutes % 60 ? 1 : 0)}時間`;
  const ongoingCount = headacheRecs.filter((r) => r.ongoing).length;
  const skippedCount = headacheRecs.filter((r) => (r.skippedFields || []).length).length;
  const safetyFlags = [...new Set(headacheRecs.flatMap((r) => r.safetyFlags || []))];
  const monthStats = new Map();
  recs.forEach((r) => {
    const key = r.date.slice(0, 7);
    const m = monthStats.get(key) || { recorded: new Set(), headache: new Set(), med: new Set() };
    m.recorded.add(r.date);
    if (isHeadacheRecord(r)) {
      m.headache.add(r.date);
      if (r.med) m.med.add(r.date);
    }
    monthStats.set(key, m);
  });

  // 誘因の頻度
  const trigFreq = new Map();
  headacheRecs.forEach((r) => (r.triggers || []).forEach((t) => trigFreq.set(t, (trigFreq.get(t) || 0) + 1)));
  const trigTop = [...trigFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const trigMax = trigTop.length ? trigTop[0][1] : 1;

  const period = `${fmtDate(startIso)} 〜 ${fmtDate(endIso)}（過去${summaryMonths}ヶ月）`;

  let html = `
    <h3 class="sum-head">診察で先生に見せるメモ</h3>
    <div class="doctor-note">
      <p><strong>${period}</strong></p>
      <p>${totalDays}日間のうち、${recordedDays}日を記録しました。頭痛があったのは${headacheDays}日、頭痛の薬を飲んだのは${medDays}日です。</p>
      <p>強い頭痛は${sevCount[3]}回、寝込んだり休んだりしたのは${downCount}回でした。続いた時間は${durationText}${ongoingCount ? `、記録時にまだ続いていた頭痛が${ongoingCount}回` : ""}です。</p>
      <p>ズキズキする痛み ${symptomCount("拍動性", "ズキズキする痛み")}回、動くと悪化 ${symptomCount("動くと悪化")}回、吐き気 ${symptomCount("吐き気", "吐き気あり")}回、実際に吐いた ${symptomCount("嘔吐あり", "実際に吐いた")}回、光がつらい ${symptomCount("光がつらい")}回、音がつらい ${symptomCount("音がつらい")}回、痛む前の見え方の変化 ${auraCount}回でした。</p>
      ${safetyFlags.length ? `<p class="safety-note"><strong>早めの受診を案内した言葉：</strong>${escapeHtml(safetyFlags.join("、"))}</p>` : ""}
      ${skippedCount ? `<p class="unknown-note">一部の質問を飛ばした記録が${skippedCount}件あります。空欄は「症状なし」ではなく「未確認」の場合があります。</p>` : ""}
    </div>
    <div class="cal-stats">
      <div class="stat"><div class="n">${recordedDays}<small> / ${totalDays}</small></div><div class="l">記録できた日</div></div>
      <div class="stat"><div class="n">${headacheDays}</div><div class="l">頭痛のあった日</div></div>
      <div class="stat"><div class="n">${medDays}</div><div class="l">頭痛の薬を飲んだ日</div></div>
      <div class="stat"><div class="n">${sevCount[3]}</div><div class="l">強い頭痛</div></div>
      <div class="stat"><div class="n">${auraCount}</div><div class="l">痛む前の見え方の変化</div></div>
      <div class="stat"><div class="n">${downCount}</div><div class="l">寝込んだ回数</div></div>
    </div>`;

  html += `<h3 class="sum-head">月ごとの日数</h3><div style="overflow-x:auto"><table class="sum-table monthly-table">
    <tr><th>月</th><th>記録できた日</th><th>頭痛のあった日</th><th>頭痛の薬を飲んだ日</th></tr>` +
    [...monthStats.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, m]) => {
      const [y, mo] = month.split("-");
      return `<tr><td>${Number(y)}年${Number(mo)}月</td><td class="c">${m.recorded.size}日</td><td class="c">${m.headache.size}日</td><td class="c">${m.med.size}日</td></tr>`;
    }).join("") + `</table></div>`;

  if (trigTop.length) {
    html += `<h3 class="sum-head">よくあるきっかけ</h3>` + trigTop.map(([t, n]) =>
      `<div class="trigger-bar"><span class="tl">${escapeHtml(t)}</span>
       <span class="bar" style="width:${Math.round((n / trigMax) * 200)}px"></span><span>${n}回</span></div>`).join("");
  }

  const medFreq = new Map();
  headacheRecs.filter((r) => r.med).forEach((r) => {
    const item = medFreq.get(r.med) || { days: new Set(), count: 0, known: false };
    item.days.add(r.date);
    if (Number.isFinite(r.medCount)) { item.count += r.medCount; item.known = true; }
    medFreq.set(r.med, item);
  });
  if (medFreq.size) {
    html += `<h3 class="sum-head">使った頭痛の薬</h3><ul class="plain-list">` +
      [...medFreq.entries()].map(([name, v]) => `<li>${escapeHtml(name)}：${v.days.size}日${v.known ? `、分かる範囲で合計${v.count}回分` : ""}</li>`).join("") + `</ul>`;
  }

  html += `<h3 class="sum-head">記録一覧</h3>
    <div style="overflow-x:auto"><table class="sum-table">
    <tr><th>日付</th><th>始まった時間・続いた時間</th><th>強さ</th><th>場所</th><th>一緒に起きたこと</th><th>きっかけ</th><th>薬と効きめ</th><th>生活への影響</th><th>本人の言葉</th></tr>` +
    recs.map((r) => !isHeadacheRecord(r) ? `<tr class="no-headache-row"><td class="c">${fmtDate(r.date)}</td><td colspan="8">頭痛なし</td></tr>` : `<tr>
      <td class="c">${fmtDate(r.date)}</td>
      <td>${escapeHtml([r.time || `開始時刻は${emptyAnswerText(r, "time", "未入力")}`, r.duration || `続いた時間は${emptyAnswerText(r, "duration", "未入力")}`].join(" / "))}</td>
      <td class="c">${["", "軽い", "中くらい", "強い"][r.severity] || "未確認"}</td>
      <td>${escapeHtml(r.location || emptyAnswerText(r, "location", "未入力"))}</td>
      <td>${escapeHtml(((r.symptoms || []).join("、") || (["quality", "movement", "aura", "nausea", "photophono"].every((k) => answered(r, k)) ? "どれもなし" : "未確認の項目あり")) + (r.auraDetail ? `（見え方の詳細: ${r.auraDetail}）` : ""))}</td>
      <td>${escapeHtml((r.triggers || []).join("、") || emptyAnswerText(r, "triggers", "特になし"))}</td>
      <td>${escapeHtml(r.med ? `${r.med}${r.medTiming ? `（${r.medTiming}）` : "（飲んだ時刻・回数は未確認）"}、${r.medEffect || "効きめは未確認"}` : emptyAnswerText(r, "med", "飲んでいない"))}</td>
      <td class="c">${escapeHtml(r.impact || emptyAnswerText(r, "impact", "未入力"))}</td>
      <td>${r.memoSummary ? `<b>短いまとめ：</b>${escapeHtml(r.memoSummary)}<br>` : ""}${r.narrativeRaw ? `<b>最初に話した内容：</b>${escapeHtml(r.narrativeRaw)}<br>` : ""}${r.memo ? `<b>追加で伝えたこと：</b>${escapeHtml(r.memo)}` : ""}</td>
    </tr>`).join("") + `</table></div>
    <p class="hint">このまとめは本人の記録から自動集計したものです（診断ではありません）。</p>`;

  box.innerHTML = html;
}

/* ---------------- QRコード（受診時に先生に読み取ってもらう） ---------------- */

function summaryRangeRecords() {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - summaryMonths);
  const startIso = start.toLocaleDateString("sv-SE");
  const endIso = end.toLocaleDateString("sv-SE");
  return { startIso, endIso, recs: sortedRecords().filter((r) => r.date >= startIso && r.date <= endIso) };
}

function buildQrText(recs, startIso, endIso, limit) {
  const headacheRecs = recs.filter(isHeadacheRecord);
  const days = new Set(headacheRecs.map((r) => r.date)).size;
  const recordedDays = new Set(recs.map((r) => r.date)).size;
  const medDays = new Set(headacheRecs.filter((r) => r.med).map((r) => r.date)).size;
  const sev3 = headacheRecs.filter((r) => r.severity === 3).length;
  const trigFreq = new Map();
  headacheRecs.forEach((r) => (r.triggers || []).forEach((t) => trigFreq.set(t, (trigFreq.get(t) || 0) + 1)));
  const trigTop = [...trigFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, n]) => `${t}${n}`).join(" ");

  const lines = [
    `【頭痛ダイアリー】${startIso}〜${endIso}`,
    `記録${recordedDays}日 頭痛${days}日 服薬${medDays}日 強い頭痛${sev3}回`,
  ];
  if (trigTop) lines.push(`誘因: ${trigTop}`);
  lines.push(`─記録(新しい順)─`);
  const list = recs.slice(0, limit); // sortedRecords は新しい順
  for (const r of list) {
    if (!isHeadacheRecord(r)) {
      lines.push(`${r.date.slice(5)} 頭痛なし`);
      continue;
    }
    const sym = (r.symptoms || []).length ? " " + r.symptoms.join("・") : "";
    const med = r.med ? ` 薬:${r.med}${r.medTiming ? `(${r.medTiming})` : ""} ${r.medEffect || "効きめ未確認"}` : "";
    lines.push(`${r.date.slice(5)}${r.time || ""} ${["", "軽い", "中くらい", "強い"][r.severity] || "未確認"} ${r.location || ""} ${r.duration || ""}${sym}${med}`);
  }
  if (recs.length > limit) lines.push(`…ほか${recs.length - limit}件は紙・画面で`);
  return { text: lines.join("\n"), shown: list.length };
}

function renderQr() {
  const panel = $("qr-panel");
  const img = $("qr-img");
  const info = $("qr-info");
  panel.classList.remove("hidden");

  if (typeof qrcode === "undefined") {
    img.innerHTML = "";
    info.textContent = "QRコードの部品を読み込めませんでした。インターネット接続を確認して、ページを開き直してください。";
    return;
  }
  const { startIso, endIso, recs } = summaryRangeRecords();
  if (!recs.length) {
    img.innerHTML = "";
    info.textContent = "この期間の記録がありません。";
    return;
  }

  qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];
  const encoder = new TextEncoder();
  let limit = Math.min(recs.length, 20);
  let built = buildQrText(recs, startIso, endIso, limit);
  // 画面のQRは詰め込みすぎると読み取りにくいので ~500バイトに収める
  while (limit > 1 && encoder.encode(built.text).length > 500) {
    limit--;
    built = buildQrText(recs, startIso, endIso, limit);
  }

  try {
    const qr = qrcode(0, "L"); // 画面表示は汚れ・破損がないので L で密度を下げる
    qr.addData(built.text, "Byte");
    qr.make();
    img.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
    info.textContent = `期間のまとめ＋直近${built.shown}件を収録（テキスト形式）。`;
  } catch (e) {
    img.innerHTML = "";
    info.textContent = "QRコードを作れませんでした。期間を短くして試してください。";
  }
}

/* ---------------- データ管理 ---------------- */

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `zutsu-diary-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("書き出しました");
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.records)) throw new Error();
      const existing = new Set(state.records.map((r) => r.id));
      let added = 0;
      for (const r of data.records) {
        if (!existing.has(r.id)) { state.records.push(normalizeRecord(r)); added++; }
      }
      save();
      renderRecent(); renderCalendar(); renderSummary();
      toast(`${added}件を読み込みました`);
    } catch (_) {
      toast("読み込めませんでした（ファイル形式を確認してください）");
    }
  };
  reader.readAsText(file);
}

function insertSample() {
  const trigPool = [["寝不足"], ["天気・低気圧"], ["ストレス", "肩こり"], ["生理"], [], ["天気・低気圧", "寝不足"]];
  const locs = ["右側", "左側", "こめかみ", "目の奥", "両側"];
  const times = ["起床時", "朝", "昼", "夕方", "夜"];
  let added = 0;
  for (let i = 55; i >= 1; i -= 2 + (i % 5)) {
    const sev = 1 + (i % 3);
    const hasMed = sev >= 2 || i % 4 === 0;
    state.records.push({
      id: newId() + i,
      entryType: "headache",
      date: todayStr(-i),
      time: times[i % times.length],
      duration: ["1〜3時間", "4〜12時間", "半日以上"][i % 3],
      durationMinutes: [120, 480, 720][i % 3],
      ongoing: false,
      severity: sev,
      location: locs[i % locs.length],
      symptoms: [
        ...(sev >= 2 ? ["ズキズキする痛み", "動くと悪化"] : ["締めつける痛み"]),
        ...(i % 7 === 0 ? ["痛む前の見え方の変化"] : []),
        ...(sev === 3 ? ["吐き気あり", "光がつらい"] : []),
      ],
      triggers: trigPool[i % trigPool.length],
      med: hasMed ? (i % 3 === 0 ? "スマトリプタン" : "ロキソニン") : "",
      medTiming: hasMed ? "始まって30分ほどで1回分" : "",
      medCount: hasMed ? 1 : null,
      medEffect: hasMed ? ["よく効いた", "少し効いた", "効かなかった"][i % 3] : "",
      impact: ["普段どおり", "支障あり", "寝込んだ"][sev - 1],
      memo: i % 11 === 0 ? "会議中に悪化した" : "",
      answeredFields: ["time", "duration", "severity", "location", "quality", "movement", "aura", "nausea", "photophono", "triggers", "med", "medTiming", "medEffect", "impact"],
      skippedFields: [], safetyFlags: [],
      source: i % 2 ? "voice" : "form",
      createdAt: Date.now() - i * 86400000,
    });
    added++;
  }
  save();
  renderRecent(); renderCalendar(); renderSummary();
  toast(`サンプル${added}件を追加しました`);
}

function wipeAll() {
  if (!confirm("すべての記録を削除します。よろしいですか？\n（書き出しをしていないデータは戻せません）")) return;
  state.records = [];
  save();
  renderRecent(); renderCalendar(); renderSummary();
  toast("全データを削除しました");
}

/* ---------------- UI 配線 ---------------- */

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function switchView(name) {
  stopListening(); stopSpeech();
  if (interview) abortInterview(true);
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  $(`view-${name}`).classList.remove("hidden");
  document.querySelectorAll(".cat-row").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  if (name === "calendar") renderCalendar();
  if (name === "summary") renderSummary();
}

function init() {
  load();

  // サイドバーのビュー切替
  document.querySelectorAll(".cat-row").forEach((t) =>
    t.addEventListener("click", () => switchView(t.dataset.view)));

  // 見出しメタ
  $("meta-today").textContent = todayStr();

  // 音声ON/OFF
  const soundBtn = $("btn-sound");
  const renderSound = () => {
    soundBtn.textContent = state.settings.soundOn ? "🔊 音声ON" : "🔇 音声OFF";
    soundBtn.classList.toggle("off", !state.settings.soundOn);
  };
  soundBtn.addEventListener("click", () => {
    state.settings.soundOn = !state.settings.soundOn;
    if (!state.settings.soundOn) stopSpeech();
    save(); renderSound();
  });
  renderSound();

  const aiToggle = $("ai-summary-on");
  aiToggle.checked = !!state.settings.aiSummaryOn;
  aiToggle.addEventListener("change", () => {
    state.settings.aiSummaryOn = aiToggle.checked;
    save();
    toast(aiToggle.checked ? "AIによる短いまとめを有効にしました" : "メモは端末内だけに保存します");
  });

  // 記録モード切替
  $("mode-voice").addEventListener("click", () => {
    $("mode-voice").classList.add("on"); $("mode-form").classList.remove("on");
    $("pane-voice").classList.remove("hidden"); $("pane-form").classList.add("hidden");
  });
  $("mode-form").addEventListener("click", () => {
    if (interview) abortInterview(true);
    $("mode-form").classList.add("on"); $("mode-voice").classList.remove("on");
    $("pane-form").classList.remove("hidden"); $("pane-voice").classList.add("hidden");
  });

  // 問診
  $("btn-start-interview").addEventListener("click", startInterview);
  $("btn-no-headache").addEventListener("click", () => saveNoHeadache());
  $("q-repeat").addEventListener("click", () => askCurrent(false));
  $("q-skip").addEventListener("click", skipCurrent);
  $("q-abort").addEventListener("click", () => abortInterview(false));
  $("q-input-send").addEventListener("click", () => submitAnswer($("q-input").value));
  $("q-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitAnswer($("q-input").value); }
  });
  $("btn-done-interview").addEventListener("click", closeConfirm);
  $("btn-undo-interview").addEventListener("click", () => {
    removeLastInterviewRecord();
    closeConfirm();
    toast("記録を取り消しました");
  });
  $("btn-redo-interview").addEventListener("click", () => {
    removeLastInterviewRecord();
    startInterview();
  });

  // フォーム
  $("f-date").value = todayStr();
  setupChips($("f-severity"), true);
  setupChips($("f-location"), false); // 場所は複数選択可(こめかみ+両側 など)
  setupChips($("f-symptoms"), false);
  setupChips($("f-triggers"), false);
  setupChips($("f-impact"), true);
  $("entry-form").addEventListener("submit", submitForm);

  // カレンダー
  $("cal-prev").addEventListener("click", () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } selectedDay = null; renderCalendar(); });
  $("cal-next").addEventListener("click", () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } selectedDay = null; renderCalendar(); });
  $("cal-today").addEventListener("click", () => { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); selectedDay = null; renderCalendar(); });

  // サマリー
  document.querySelectorAll(".range-btn").forEach((b) =>
    b.addEventListener("click", () => {
      summaryMonths = Number(b.dataset.months);
      document.querySelectorAll(".range-btn").forEach((x) => x.classList.toggle("on", x === b));
      renderSummary();
      // 期間が変わったら作り直してもらう
      if (!$("qr-panel").classList.contains("hidden")) renderQr();
    }));
  $("btn-print").addEventListener("click", () => window.print());
  $("btn-qr").addEventListener("click", () => {
    const panel = $("qr-panel");
    if (panel.classList.contains("hidden")) renderQr();
    else panel.classList.add("hidden");
  });

  // データ管理
  $("btn-export").addEventListener("click", exportJson);
  $("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });
  $("btn-sample").addEventListener("click", insertSample);
  $("btn-wipe").addEventListener("click", wipeAll);

  renderRecent();
}

document.addEventListener("DOMContentLoaded", init);
