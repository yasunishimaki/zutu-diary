/* 患者用と受付用で共通の受診メモ表示。診断・推測は行わない。 */
(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtDate(iso) {
    const [y, m, d] = String(iso).split("-").map(Number);
    const dow = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
    return `${m}/${d}(${dow})`;
  }

  function isHeadacheRecord(record) { return record.entryType !== "noHeadache"; }
  function answered(record, key) { return Array.isArray(record.answeredFields) && record.answeredFields.includes(key); }
  function emptyAnswerText(record, key, whenAnswered = "なし") {
    if (answered(record, key)) return whenAnswered;
    return Array.isArray(record.answeredFields) ? "未確認" : "旧版では未記録";
  }

  function render({ records, startIso, endIso, summaryMonths }) {
    const recs = Array.isArray(records) ? records : [];
    if (!recs.length) return `<div class="empty">この期間の記録がありません。</div>`;

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
      const month = monthStats.get(key) || { recorded: new Set(), headache: new Set(), med: new Set() };
      month.recorded.add(r.date);
      if (isHeadacheRecord(r)) {
        month.headache.add(r.date);
        if (r.med) month.med.add(r.date);
      }
      monthStats.set(key, month);
    });

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
      [...monthStats.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, item]) => {
        const [year, number] = month.split("-");
        return `<tr><td>${Number(year)}年${Number(number)}月</td><td class="c">${item.recorded.size}日</td><td class="c">${item.headache.size}日</td><td class="c">${item.med.size}日</td></tr>`;
      }).join("") + `</table></div>`;

    if (trigTop.length) {
      html += `<h3 class="sum-head">よくあるきっかけ</h3>` + trigTop.map(([trigger, count]) =>
        `<div class="trigger-bar"><span class="tl">${escapeHtml(trigger)}</span><span class="bar" style="width:${Math.round((count / trigMax) * 200)}px"></span><span>${count}回</span></div>`).join("");
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
        [...medFreq.entries()].map(([name, item]) => `<li>${escapeHtml(name)}：${item.days.size}日${item.known ? `、分かる範囲で合計${item.count}回分` : ""}</li>`).join("") + `</ul>`;
    }

    html += `<h3 class="sum-head">記録一覧</h3><div style="overflow-x:auto"><table class="sum-table record-table">
      <thead><tr><th>日付</th><th>始まった時間・続いた時間</th><th>強さ</th><th>場所</th><th>一緒に起きたこと</th><th>きっかけ</th><th>薬と効きめ</th><th>生活への影響</th></tr></thead>` +
      recs.map((r) => !isHeadacheRecord(r) ? `<tbody class="record-block"><tr class="no-headache-row"><td class="c">${fmtDate(r.date)}</td><td colspan="7">頭痛なし</td></tr></tbody>` : `<tbody class="record-block"><tr>
        <td class="c">${fmtDate(r.date)}</td>
        <td>${escapeHtml([r.time || `開始時刻は${emptyAnswerText(r, "time", "未入力")}`, r.duration || `続いた時間は${emptyAnswerText(r, "duration", "未入力")}`].join(" / "))}</td>
        <td class="c">${["", "軽い", "中くらい", "強い"][r.severity] || "未確認"}</td>
        <td>${escapeHtml(r.location || emptyAnswerText(r, "location", "未入力"))}</td>
        <td>${escapeHtml(((r.symptoms || []).join("、") || (["quality", "movement", "aura", "nausea", "photophono"].every((key) => answered(r, key)) ? "どれもなし" : "未確認の項目あり")) + (r.auraDetail ? `（見え方の詳細: ${r.auraDetail}）` : ""))}</td>
        <td>${escapeHtml((r.triggers || []).join("、") || emptyAnswerText(r, "triggers", "特になし"))}</td>
        <td>${escapeHtml(r.med ? `${r.med}${r.medTiming ? `（${r.medTiming}）` : "（飲んだ時刻・回数は未確認）"}、${r.medEffect || "効きめは未確認"}` : emptyAnswerText(r, "med", "飲んでいない"))}</td>
        <td class="c">${escapeHtml(r.impact || emptyAnswerText(r, "impact", "未入力"))}</td>
      </tr>${r.memoSummary || r.narrativeRaw || r.memo ? `<tr class="record-words-row"><td colspan="8"><b class="record-words-label">本人の言葉</b>${r.memoSummary ? `<b>短いまとめ：</b>${escapeHtml(r.memoSummary)}<br>` : ""}${r.narrativeRaw ? `<b>最初に話した内容：</b>${escapeHtml(r.narrativeRaw)}<br>` : ""}${r.memo ? `<b>追加で伝えたこと：</b>${escapeHtml(r.memo)}` : ""}</td></tr>` : ""}</tbody>`).join("") + `</table></div><p class="hint">このまとめは本人の記録から自動集計したものです（診断ではありません）。</p>`;

    return html;
  }

  global.ZutsuSummary = { render };
})(window);
