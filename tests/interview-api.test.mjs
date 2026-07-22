import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/interview.js";

function request(body, origin = "https://zutsu-diary-2.pages.dev") {
  return new Request("https://zutsu-diary-2.pages.dev/api/interview", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

let response = await onRequestPost({
  request: request({ questionKey: "hasHeadache", question: "頭痛はありましたか", text: "ないよ" }),
  env: {},
});
assert.equal(response.status, 503);

response = await onRequestPost({
  request: request({ questionKey: "hasHeadache", question: "頭痛はありましたか", text: "ないよ" }, "https://example.com"),
  env: { OPENAI_API_KEY: "test-key" },
});
assert.equal(response.status, 403);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, options) => {
  assert.equal(options.headers.authorization, "Bearer test-key");
  const payload = JSON.parse(options.body);
  assert.equal(payload.response_format.type, "json_object");
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      understood: true,
      answerSummary: "頭痛なし",
      acknowledgement: "今日は頭痛がなかったのですね。",
      answeredFields: ["entryType"],
      fields: { entryType: "noHeadache" },
    }) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  response = await onRequestPost({
    request: request({ questionKey: "hasHeadache", question: "頭痛はありましたか", text: "今日は大丈夫だったよ" }),
    env: { OPENAI_API_KEY: "test-key" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fields.entryType, "noHeadache");
  assert.deepEqual(body.answeredFields, ["hasHeadache"]);
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({
    understood: true,
    answerSummary: "昨日の頭痛を記録",
    acknowledgement: "昨日はつらかったのですね。",
    answeredFields: ["time", "duration", "severity", "location", "quality", "movement", "nausea", "med", "medEffect", "impact"],
    fields: {
      dateOffset: 0, time: "20:00", duration: "2時間", durationMinutes: 120, severity: 3,
      location: ["右のこめかみ"], symptoms: ["ズキズキする痛み", "動くと悪化", "吐き気あり"],
      med: "ロキソニン", medTaken: true, medEffect: "少し効いた", impact: "支障あり",
    },
  }) } }],
}), { status: 200, headers: { "content-type": "application/json" } });

try {
  response = await onRequestPost({
    request: request({
      questionKey: "overview",
      question: "頭痛について自由に話してください",
      text: "昨日の夜8時から右のこめかみがズキズキして、歩くとひどくなりました。吐き気もあり、ロキソニンで少し楽になりました。",
    }),
    env: { OPENAI_API_KEY: "test-key" },
  });
  const body = await response.json();
  assert.equal(body.fields.dateOffset, -1);
  assert.ok(body.answeredFields.includes("overview"));
  assert.ok(body.answeredFields.includes("time"));
  assert.ok(!body.answeredFields.includes("duration"));
  assert.ok(!body.answeredFields.includes("severity"));
  assert.ok(!body.answeredFields.includes("impact"));
} finally {
  globalThis.fetch = originalFetch;
}

console.log("interview api tests: ok");
