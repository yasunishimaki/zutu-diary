/**
 * メモ要約API (Cloudflare Pages Functions)
 * 患者が音声で自由に話した「先生に伝えたいこと」を、医師向けの短い要約にする。
 * APIキーは Pages のシークレット OPENAI_API_KEY に置く(ブラウザには渡らない)。
 * 未設定なら 503 を返し、クライアントは原文のまま保存する。
 */

const SYSTEM_PROMPT = [
  "あなたは頭痛ダイアリーの記録係です。",
  "患者が診察前に音声で話した「先生に伝えたいこと」を、医師が数秒で読める簡潔な日本語に要約してください。",
  "規則:",
  "・患者が話した事実だけを残す。推測・診断・助言・励ましは一切加えない",
  "・症状の時期・頻度・変化・薬・生活への影響など、診療に関わる情報を優先して残す",
  "・患者の言い回しのニュアンスは保つ",
  "・2文以内、または「・」区切りの箇条書き3点以内",
].join("\n");

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.OPENAI_API_KEY) {
    return json({ error: "not_configured" }, 503);
  }

  let text;
  try {
    ({ text } = await request.json());
  } catch (_) {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof text !== "string" || !text.trim() || text.length > 4000) {
    return json({ error: "bad_request" }, 400);
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini", // 短文要約なので低コスト・低遅延を優先
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.trim() },
      ],
    }),
  });

  if (!res.ok) {
    return json({ error: "upstream", status: res.status }, 502);
  }

  const data = await res.json();
  const summary = (data.choices?.[0]?.message?.content || "").trim();

  if (!summary) return json({ error: "empty" }, 502);
  return json({ summary });
}
