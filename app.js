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
  settings: { soundOn: true, speechRate: 1.0 },
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.records = Array.isArray(data.records) ? data.records : [];
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

/* ---------------- 問診の質問定義 ---------------- */

const QUESTIONS = [
  {
    key: "time", label: "始まった時間",
    ask: "頭痛はいつごろ始まりましたか？",
    quick: ["起床時", "朝", "昼", "夕方", "夜", "昨日から"],
    handle(t, draft) {
      const r = parseTime(t);
      if (!r) return null;
      if (r.dateOffset) draft.date = todayStr(r.dateOffset);
      draft.time = r.time || "";
      return draft.time || (r.dateOffset === -1 ? "昨日" : "一昨日");
    },
  },
  {
    key: "severity", label: "強さ",
    ask: "痛みの強さを教えてください。軽い、中くらい、強い、のどれですか？",
    quick: ["軽い", "中くらい", "強い"],
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
    handle(t, draft) {
      const v = parseLocations(t);
      if (!v) return null;
      draft.location = v.join("、");
      return draft.location;
    },
  },
  {
    key: "throbbing", label: "ズキズキ",
    ask: "ズキンズキンと脈打つような痛みですか？",
    quick: ["はい", "いいえ", "締めつけられる感じ"],
    handle(t, draft) {
      if (/締め|しめ|圧迫/.test(t)) { return "締めつけ感"; }
      const v = parseYesNo(t);
      if (v == null) return null;
      if (v) draft.symptoms.push("拍動性");
      return v ? "はい" : "いいえ";
    },
  },
  {
    key: "aura", label: "前兆",
    ask: "痛み出す前に、ギザギザした光やチカチカなどの前兆はありましたか？",
    quick: ["はい", "いいえ"],
    handle(t, draft) {
      const v = parseYesNo(t);
      if (v == null) return null;
      if (v) draft.symptoms.push("前兆");
      return v ? "あった" : "なかった";
    },
  },
  {
    key: "nausea", label: "吐き気",
    ask: "吐き気はありますか？",
    quick: ["はい", "いいえ", "吐いた"],
    handle(t, draft) {
      if (/吐いた|嘔吐/.test(t)) { draft.symptoms.push("吐き気"); return "嘔吐あり"; }
      const v = parseYesNo(t);
      if (v == null) return null;
      if (v) draft.symptoms.push("吐き気");
      return v ? "ある" : "ない";
    },
  },
  {
    key: "photophono", label: "光・音",
    ask: "光や音が、いつもよりつらく感じますか？",
    quick: ["両方つらい", "光だけ", "音だけ", "いいえ"],
    handle(t, draft) {
      const hikari = /光|ひかり|まぶし|眩し/.test(t);
      const oto = /音|おと|うるさ/.test(t);
      const v = parseYesNo(t);
      if (!hikari && !oto && v == null) return null;
      if (hikari || (v && !oto)) draft.symptoms.push("光がつらい");
      if (oto || (v && !hikari)) draft.symptoms.push("音がつらい");
      if (v === false && !hikari && !oto) return "いいえ";
      return [hikari || v ? "光" : null, oto || v ? "音" : null].filter(Boolean).join("・") + "がつらい";
    },
  },
  {
    key: "triggers", label: "きっかけ",
    ask: "思い当たるきっかけはありますか？たとえば、寝不足、天気、ストレス、生理、など。",
    quick: ["寝不足", "寝すぎ", "天気・低気圧", "生理", "ストレス", "肩こり", "アルコール"],
    multi: true, multiNone: "特にない",
    handle(t, draft) {
      const v = parseTriggers(t);
      if (v === null) return null;
      draft.triggers = v;
      return v.length ? v.join("、") : "特になし";
    },
  },
  {
    key: "med", label: "薬",
    ask: "お薬は飲みましたか？飲んだ場合は、薬の名前を教えてください。",
    quick: ["飲んでいない"],
    freeText: true,
    handle(t, draft) {
      if (/飲んでいない|飲んでない|飲まな|なし|ない/.test(t)) { draft.med = ""; return "飲んでいない"; }
      const name = t.replace(/を?飲みました|を?飲んだ|です|飲みます/g, "").trim();
      if (!name) return null;
      draft.med = normalizeMedName(name);
      return draft.med;
    },
  },
  {
    key: "medEffect", label: "薬の効きめ",
    ask: "お薬は効きましたか？",
    quick: ["よく効いた", "少し効いた", "効かなかった", "まだわからない"],
    skipIf: (draft) => !draft.med,
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
      if (/^(特にない|ありません|ないです|大丈夫)/.test(t.trim())) { draft.memo = ""; return "特になし"; }
      draft.memo = t.trim();
      return "メモに記録";
    },
  },
];

/* ---------------- 問診の進行 ---------------- */

let interview = null; // { idx, draft, answers: [{label, display}], retries }

function blankDraft() {
  return {
    id: newId(), date: todayStr(), time: "", severity: null, location: "",
    symptoms: [], triggers: [], med: "", medEffect: "", impact: "", memo: "",
    source: "voice", createdAt: Date.now(),
  };
}

function startInterview() {
  interview = { idx: 0, draft: blankDraft(), answers: [], retries: 0 };
  liveRecBlocked = false;
  $("interview-idle").classList.add("hidden");
  $("interview-confirm").classList.add("hidden");
  $("interview-live").classList.remove("hidden");
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
  $("q-progress").textContent = `Q ${visibleIdx + 1} / ${visibleCount}`;
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

  const display = q.handle(text.trim(), interview.draft);
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

  interview.answers.push({ label: q.label, display });
  renderAnsweredChips();
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
  interview.idx++;
  askCurrent(true);
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

  // 最後の質問に答えた時点で自動保存する
  state.records.push(d);
  save();
  renderRecent();
  lastInterviewRecord = d;

  $("interview-live").classList.add("hidden");
  $("interview-confirm").classList.remove("hidden");
  const rows = [
    ["日付", `${fmtDate(d.date)} ${d.time}`],
    ["強さ", d.severity ? ["", "軽い", "中くらい", "強い"][d.severity] : "─"],
    ["場所", d.location || "─"],
    ["症状", d.symptoms.join("、") || "─"],
    ["きっかけ", d.triggers.join("、") || "特になし"],
    ["薬", d.med ? `${d.med}（${d.medEffect || "効果未記入"}）` : "飲んでいない"],
    ["生活への影響", d.impact || "─"],
    ["メモ", d.memo || "─"],
  ];
  $("confirm-list").innerHTML = rows.map(([k, v]) =>
    `<dt>${k}</dt><dd${k === "メモ" ? ' id="confirm-memo"' : ""}>${escapeHtml(v)}</dd>`).join("");
  toast(`${fmtDate(d.date)} の頭痛を記録しました`);
  speak("記録しました。お大事にしてください。");
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
   長いメモだけ /api/summarize (Pages Functions → Anthropic API) に送る。
   API未設定・オフライン・エラー時は原文のまま残す(要約は上乗せ機能)。 */

const SUMMARIZE_MIN_CHARS = 40;

async function summarizeMemoIfLong(record) {
  if (!record.memo || record.memo.length < SUMMARIZE_MIN_CHARS) return;
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
    r.memoRaw = r.memo; // 原文も保持
    r.memo = summary;
    save();
    renderRecent();

    // 保存直後の控え画面が開いていれば、メモ表示も差し替える
    const memoEl = $("confirm-memo");
    if (memoEl && lastInterviewRecord && lastInterviewRecord.id === r.id) {
      memoEl.textContent = summary;
      toast("メモを要約しました");
    }
  } catch (_) { /* 原文のまま */ }
}

/* ---------------- フォーム入力 ---------------- */

function setupChips(el, single) {
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      if (single) {
        const was = b.classList.contains("sel");
        el.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
        if (!was) b.classList.add("sel");
      } else {
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
  const rec = {
    id: newId(),
    date: $("f-date").value || todayStr(),
    time: $("f-time").value,
    severity,
    location: chipValues($("f-location")).join("、"),
    symptoms: chipValues($("f-symptoms")),
    triggers: chipValues($("f-triggers")),
    med: normalizeMedName($("f-med").value),
    medEffect: $("f-medeffect").value,
    impact: chipValue($("f-impact")),
    memo: $("f-memo").value.trim(),
    source: "form",
    createdAt: Date.now(),
  };
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
  const sevMark = ["", "△", "○", "◎"][r.severity] || "?";
  const sevLabel = ["", "軽い", "中", "強い"][r.severity] || "?";
  const parts = [];
  if (r.location) parts.push(`場所: ${r.location}`);
  if (r.symptoms && r.symptoms.length) parts.push(`症状: ${r.symptoms.join("、")}`);
  if (r.triggers && r.triggers.length) parts.push(`きっかけ: ${r.triggers.join("、")}`);
  parts.push(r.med ? `薬: ${r.med}${r.medEffect ? `（${r.medEffect}）` : ""}` : "薬: なし");
  if (r.impact) parts.push(`影響: ${r.impact}`);
  if (r.memo) parts.push(`メモ${r.memoRaw ? "(要約)" : ""}: ${r.memo}`);
  return `<div class="entry sev${r.severity}">
    <div class="e-sev-mark">${sevMark}<small>${sevLabel}</small></div>
    <div>
      <div class="e-head">
        <span class="e-date">${fmtDate(r.date)} ${escapeHtml(r.time || "")}</span>
        <span class="e-src">${r.source === "voice" ? "🎤 voice" : "✍️ form"}</span>
        ${withDelete ? `<button class="e-del" data-del="${r.id}">delete</button>` : ""}
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
    const maxSev = recs.reduce((m, r) => Math.max(m, r.severity || 0), 0);
    const hasMed = recs.some((r) => r.med);
    const cls = ["cal-cell"];
    if (maxSev) cls.push(`sev${maxSev}`);
    if (iso === today) cls.push("today");
    if (iso === selectedDay) cls.push("selected");
    html += `<div class="${cls.join(" ")}" data-day="${iso}">
      <span class="d">${d}</span>${hasMed ? `<span class="med">💊</span>` : ""}
    </div>`;
  }
  $("cal-grid").innerHTML = html;
  $("cal-grid").querySelectorAll("[data-day]").forEach((c) => {
    c.addEventListener("click", () => { selectedDay = c.dataset.day; renderCalendar(); });
  });

  // 月間集計
  const monthPrefix = `${calYear}-${String(calMonth + 1).padStart(2, "0")}-`;
  const monthRecs = state.records.filter((r) => r.date.startsWith(monthPrefix));
  const headacheDays = new Set(monthRecs.map((r) => r.date)).size;
  const medDays = new Set(monthRecs.filter((r) => r.med).map((r) => r.date)).size;
  const severe = monthRecs.filter((r) => r.severity === 3).length;
  let statsHtml = `
    <div class="stat"><div class="n">${headacheDays}</div><div class="l">頭痛のあった日</div></div>
    <div class="stat"><div class="n ${medDays >= 10 ? "warn" : ""}">${medDays}</div><div class="l">薬を飲んだ日</div></div>
    <div class="stat"><div class="n">${severe}</div><div class="l">強い発作の回数</div></div>`;
  if (medDays >= 10) {
    statsHtml += `<div class="stat-note">💊 この月は薬を飲んだ日が ${medDays}日 あります。頭痛薬を月10日以上飲む状態が続くと、薬の使いすぎによる頭痛（薬剤の使用過多による頭痛）につながることがあります。この画面を先生に見せて相談してください。</div>`;
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

/* ---------------- 受診サマリー ---------------- */

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

  const headacheDays = new Set(recs.map((r) => r.date)).size;
  const medDays = new Set(recs.filter((r) => r.med).map((r) => r.date)).size;
  const sevCount = [0, 0, 0, 0];
  recs.forEach((r) => sevCount[r.severity || 0]++);
  const auraCount = recs.filter((r) => (r.symptoms || []).includes("前兆")).length;
  const downCount = recs.filter((r) => r.impact === "寝込んだ").length;

  // 誘因の頻度
  const trigFreq = new Map();
  recs.forEach((r) => (r.triggers || []).forEach((t) => trigFreq.set(t, (trigFreq.get(t) || 0) + 1)));
  const trigTop = [...trigFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const trigMax = trigTop.length ? trigTop[0][1] : 1;

  const period = `${fmtDate(startIso)} 〜 ${fmtDate(endIso)}（過去${summaryMonths}ヶ月）`;

  let html = `
    <h3 class="sum-head">頭痛ダイアリー まとめ ─ ${period}</h3>
    <div class="cal-stats">
      <div class="stat"><div class="n">${headacheDays}</div><div class="l">頭痛のあった日</div></div>
      <div class="stat"><div class="n ${medDays >= 10 * summaryMonths ? "warn" : ""}">${medDays}</div><div class="l">薬を飲んだ日</div></div>
      <div class="stat"><div class="n">${sevCount[3]}</div><div class="l">強い発作</div></div>
      <div class="stat"><div class="n">${auraCount}</div><div class="l">前兆あり</div></div>
      <div class="stat"><div class="n">${downCount}</div><div class="l">寝込んだ回数</div></div>
    </div>`;

  if (trigTop.length) {
    html += `<h3 class="sum-head">よくあるきっかけ</h3>` + trigTop.map(([t, n]) =>
      `<div class="trigger-bar"><span class="tl">${escapeHtml(t)}</span>
       <span class="bar" style="width:${Math.round((n / trigMax) * 200)}px"></span><span>${n}回</span></div>`).join("");
  }

  html += `<h3 class="sum-head">記録一覧</h3>
    <div style="overflow-x:auto"><table class="sum-table">
    <tr><th>日付</th><th>時間</th><th>強さ</th><th>場所</th><th>症状</th><th>きっかけ</th><th>薬→効果</th><th>影響</th><th>メモ</th></tr>` +
    recs.map((r) => `<tr>
      <td class="c">${fmtDate(r.date)}</td>
      <td class="c">${escapeHtml(r.time || "")}</td>
      <td class="c">${["", "△軽", "○中", "◎強"][r.severity] || ""}</td>
      <td>${escapeHtml(r.location || "")}</td>
      <td>${escapeHtml((r.symptoms || []).join("、"))}</td>
      <td>${escapeHtml((r.triggers || []).join("、"))}</td>
      <td>${escapeHtml(r.med ? `${r.med}→${r.medEffect || "?"}` : "")}</td>
      <td class="c">${escapeHtml(r.impact || "")}</td>
      <td>${escapeHtml(r.memo || "")}</td>
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
  const days = new Set(recs.map((r) => r.date)).size;
  const medDays = new Set(recs.filter((r) => r.med).map((r) => r.date)).size;
  const sev3 = recs.filter((r) => r.severity === 3).length;
  const trigFreq = new Map();
  recs.forEach((r) => (r.triggers || []).forEach((t) => trigFreq.set(t, (trigFreq.get(t) || 0) + 1)));
  const trigTop = [...trigFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, n]) => `${t}${n}`).join(" ");

  const lines = [
    `【頭痛ダイアリー】${startIso}〜${endIso}`,
    `頭痛${days}日 服薬${medDays}日 強い発作${sev3}回`,
  ];
  if (trigTop) lines.push(`誘因: ${trigTop}`);
  lines.push(`─記録(新しい順)─`);
  const list = recs.slice(0, limit); // sortedRecords は新しい順
  for (const r of list) {
    const sym = (r.symptoms || []).length ? " " + r.symptoms.join("・") : "";
    const med = r.med ? ` 薬:${r.med}→${r.medEffect || "?"}` : "";
    lines.push(`${r.date.slice(5)}${r.time || ""} ${["", "軽", "中", "強"][r.severity] || "?"} ${r.location || ""}${sym}${med}`);
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
        if (!existing.has(r.id)) { state.records.push(r); added++; }
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
      date: todayStr(-i),
      time: times[i % times.length],
      severity: sev,
      location: locs[i % locs.length],
      symptoms: [
        ...(sev >= 2 ? ["拍動性"] : []),
        ...(i % 7 === 0 ? ["前兆"] : []),
        ...(sev === 3 ? ["吐き気", "光がつらい"] : []),
      ],
      triggers: trigPool[i % trigPool.length],
      med: hasMed ? (i % 3 === 0 ? "スマトリプタン" : "ロキソニン") : "",
      medEffect: hasMed ? ["よく効いた", "少し効いた", "効かなかった"][i % 3] : "",
      impact: ["普段どおり", "支障あり", "寝込んだ"][sev - 1],
      memo: i % 11 === 0 ? "会議中に悪化した" : "",
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
