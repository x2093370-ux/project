// Tiny stand-in for the Anthropic API so the AI code path can be tested offline.
// Says "same content" unless the request contains the marker ZZZ_DIFFERENT.
const http = require("http");
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const different = body.includes("ZZZ_DIFFERENT");
    const verdict = different
      ? { same_content: false, similarity: 0.2, reason: "Different documents on a similar topic" }
      : { same_content: true, similarity: 0.93, reason: "Same document with light rewording" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: [{ type: "text", text: "```json\n" + JSON.stringify(verdict) + "\n```" }] }));
  });
}).listen(process.env.MOCK_PORT || 5055, () => console.log("mock AI listening"));
