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
      answeredFields: ["hasHeadache"],
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
} finally {
  globalThis.fetch = originalFetch;
}

console.log("interview api tests: ok");
