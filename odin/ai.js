// =====================================================================================================
// Odin 0.10: AI writing, shared by Odin and DI-ana. It writes new reading passages (for fluency practice) and new
// multiple-choice questions (for tests and practice sheets) with whichever AI the school chooses: one running on the
// school's own computer (Ollama, LM Studio), a free tier (Google Gemini, Groq, OpenRouter: each needs a free key) or a paid
// service (Claude, OpenAI, or any service that works like OpenAI's).
//
// The AI is only ever told the grade, the subject, the skill and the teacher's topic. Never anything about a student:
// aiGuard() refuses a request that has a student's name or code in it, here and again on Odin's server.
// The teacher reads and can change everything the AI writes before it is saved or printed.
//
// At school, Odin's server holds the key and makes the call (api/ai/chat), so phones and browsers never hold keys.
// In a demo, aiChat() calls the service straight from the page with a key kept only while the page is open.
// =====================================================================================================
const AI_PROVIDERS = [
  { id: "ollama", name: "Ollama, on a computer at school", kind: "local", api: "openai", url: "http://localhost:11434/v1", model: "llama3.1:8b", key: false,
    help: "Free and private: the AI runs on the school's own computer and nothing leaves it. Install Ollama, run \"ollama pull llama3.1:8b\", and use that computer's address." },
  { id: "lmstudio", name: "LM Studio, on a computer at school", kind: "local", api: "openai", url: "http://localhost:1234/v1", model: "", key: false,
    help: "Free and private: load a model in LM Studio, start its server, and type the model's name as LM Studio shows it." },
  { id: "gemini", name: "Google Gemini (free tier)", kind: "free", api: "gemini", url: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash-lite", key: true,
    keyUrl: "https://aistudio.google.com/apikey", help: "A free key from Google AI Studio. The free tier has daily limits, and Google may use what is sent to improve its products: only grade, skill and topic are sent." },
  { id: "groq", name: "Groq (free tier)", kind: "free", api: "openai", url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", key: true,
    keyUrl: "https://console.groq.com/keys", help: "A free key from Groq. Fast, with daily limits." },
  { id: "openrouter", name: "OpenRouter (free models)", kind: "free", api: "openai", url: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", key: true,
    keyUrl: "https://openrouter.ai/keys", help: "A free key from OpenRouter. Models whose names end in :free cost nothing, with daily limits." },
  { id: "anthropic", name: "Claude (paid)", kind: "paid", api: "anthropic", url: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", key: true,
    keyUrl: "https://console.anthropic.com/", help: "A paid key from Anthropic's console." },
  { id: "openai", name: "OpenAI (paid)", kind: "paid", api: "openai", url: "https://api.openai.com/v1", model: "gpt-4.1-mini", key: true,
    keyUrl: "https://platform.openai.com/api-keys", help: "A paid key from OpenAI." },
  { id: "custom", name: "Another service that works like OpenAI's", kind: "custom", api: "openai", url: "", model: "", key: "optional",
    help: "Any service with an OpenAI-style chat API: type its address (ending in /v1), the model's name and, if it needs one, a key." }
];
const AI_BY_ID = Object.fromEntries(AI_PROVIDERS.map(p => [p.id, p]));
const AI_KIND_WORD = { local: "local, private", free: "free tier", paid: "paid", custom: "other" };
const AI_WORDS = [45, 95, 135, 170, 200, 225];   // fluency passages at each level, as long as Odin's own
const aiGradeWord = band => (band <= 0 ? "kindergarten" : `grade ${band}`);

// ---------- what the AI is asked ----------
const AI_SYSTEM = "You write classroom materials for elementary school students in the United States. Everything you write is for children: kind, accurate, " +
  "free of anything scary, violent, romantic, political or about real brands and celebrities. You never invent facts about real people. Reply with JSON only, no other text.";

// o: { subject: "math" | "reading", band: 0 to 5, skill: "the skill's name", topic, n: 4 to 8, choices: 3 or 4, kind: "test" | "practice", passage: bool }
function aiPromptQuestions(o) {
  const n = Math.max(2, Math.min(o.passage ? 6 : 8, o.n | 0 || 6)), k = o.choices === 3 ? 3 : 4, letters = "ABCD".slice(0, k).split("").join(", ");
  const grade = aiGradeWord(o.band | 0), words = Math.round((AI_WORDS[o.band | 0] || 150) * 0.8);
  const lines = [
    `Write ${n} multiple-choice questions for a ${o.kind === "practice" ? "practice sheet" : "short test"} for ${grade} students.`,
    `Subject: ${o.subject === "math" ? "math" : "reading"}. Skill: ${o.skill}.${o.topic ? ` Topic or theme: ${o.topic}.` : ""}`,
    o.passage ? `First write one short ${o.subject === "math" ? "word-problem story" : "passage"} of about ${words} words that ${grade} students can read, then ask every question about it.` : "",
    `Each question has exactly ${k} answer choices (${letters}) and exactly one right answer. Wrong choices should be believable mistakes, not silly.`,
    "Questions and choices must make sense without pictures, tables or diagrams. No \"all of the above\" or \"none of the above\".",
    `Keep each question under ${o.band <= 1 ? 90 : 140} characters and each choice under ${o.band <= 1 ? 25 : 40} characters. Use words ${grade} students know.`,
    o.kind === "practice" ? "Add a short hint (under 80 characters) to each question that helps without giving the answer away." : "",
    "Mix up which letter is right.",
    "Reply with JSON in exactly this shape:",
    `{"title": "a short title for the sheet", ${o.passage ? '"passage": {"title": "...", "text": "..."}, ' : ""}"questions": [{"question": "...", "choices": [${"\"...\"".repeat(k).split("\"\"").join("\", \"")}], "answer": "A"${o.kind === "practice" ? ', "hint": "..."' : ""}}]}`
  ];
  return { system: AI_SYSTEM, user: lines.filter(Boolean).join("\n"), maxTokens: 2500 };
}
// o: { band: 0 to 5, topic, genre: "story" | "information" }
function aiPromptPassage(o) {
  const band = Math.max(0, Math.min(5, o.band | 0)), words = AI_WORDS[band], grade = aiGradeWord(band);
  const lines = [
    `Write a ${o.genre === "information" ? "short informational text" : "short story"} for ${grade} students to read aloud for fluency practice.`,
    o.topic ? `Topic: ${o.topic}.` : "Pick a topic children like: animals, school, family, sports, nature, food or friends.",
    `It must be between ${Math.round(words * 0.9)} and ${Math.round(words * 1.1)} words long, at a ${grade} reading level.`,
    band <= 1 ? "Use mostly high-frequency sight words and short, simple sentences." : "Use sentences of different lengths, and a few words that stretch a reader at this level.",
    "Write every number as words (\"seven\", not \"7\"). Don't use titles like Mr., Mrs., Ms. or Dr., abbreviations, or the symbols & % $ #.",
    "Use plain punctuation. Put a blank line between paragraphs.",
    "Reply with JSON in exactly this shape:",
    "{\"title\": \"...\", \"text\": \"...\"}"
  ];
  return { system: AI_SYSTEM, user: lines.filter(Boolean).join("\n"), maxTokens: 1200 };
}

// ---------- reading what the AI wrote ----------
// The first JSON object in the reply (models sometimes wrap it in ``` fences or add a sentence).
function aiJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("The AI didn't answer with the expected form. Try again, or try another model.");
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error("The AI's answer couldn't be read. Try again, or try another model."); }
}
const aiClean = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
// Returns { title, passage, items: [{ stem, choices, key, hint }], warnings }; throws when nothing usable came back.
function aiParseQuestions(text, o) {
  const j = aiJSON(text), qs = Array.isArray(j.questions) ? j.questions : Array.isArray(j.items) ? j.items : [];
  const k = o && o.choices === 3 ? 3 : 4, warnings = [], items = [];
  let skipped = 0;
  qs.forEach((q, i) => {
    const stem = aiClean(q.question || q.stem), choices = (Array.isArray(q.choices) ? q.choices : []).map(c => aiClean(c).replace(/^[A-E][.)]\s+/, "")).filter(Boolean);
    let key = typeof q.answer === "number" ? q.answer : "ABCDE".indexOf(aiClean(q.answer).toUpperCase().charAt(0));
    if (key < 0 && typeof q.answer === "string") key = choices.findIndex(c => c.toLowerCase() === aiClean(q.answer).toLowerCase());
    if (!stem || choices.length < 2 || key < 0 || key >= choices.length) { skipped++; return; }
    if (new Set(choices.map(c => c.toLowerCase())).size < choices.length) warnings.push(`Question ${items.length + 1} has the same choice twice: check it.`);
    if (choices.length !== k) warnings.push(`Question ${items.length + 1} has ${choices.length} choices.`);
    items.push({ stem, choices: choices.slice(0, 5), key: Math.min(key, 4), hint: aiClean(q.hint).slice(0, 120) });
  });
  if (skipped) warnings.unshift(skipped === 1 ? "One question the AI wrote wasn't complete, so it was left out." : `${skipped} questions the AI wrote weren't complete, so they were left out.`);
  if (!items.length) throw new Error("The AI didn't write any usable questions. Try again, or try another model.");
  const p = j.passage && aiClean(j.passage.text) ? { title: aiClean(j.passage.title).slice(0, 80) || "Read this", text: String(j.passage.text).replace(/\r/g, "").trim() } : null;
  if (o && o.passage && !p) warnings.push("The AI didn't write the passage. The questions may need it: try again.");
  return { title: aiClean(j.title).slice(0, 80) || (o && o.skill) || "Questions", passage: p, items: items.slice(0, p ? 6 : 8), warnings };
}
// Returns { title, text, words, warnings }. Numbers are written as words, so the speech recognizer and the page agree.
function aiParsePassage(text, o) {
  const j = aiJSON(text);
  const body = String(j.text || j.passage || "").trim();
  if (!body) throw new Error("The AI didn't write a passage. Try again, or try another model.");
  return aiCleanPassage(j.title, body, o && o.band);
}
// A passage's title and text made ready for fluency practice (AI or typed in): tidy spaces and paragraphs, numbers as words,
// and warnings about what the voice and the recognizer may not match.
function aiCleanPassage(title, text, band) {
  const warnings = [];
  let body = String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n\n").replace(/([^\n])\n(?!\n)/g, "$1 ").trim();
  if (typeof flNumWords === "function") body = body.replace(/([.!?]["”’]?\s+)?(?<![\d.,])\b(\d{1,3})\b(?![.,]\d)/g, (m, start, d, off) => {
    const w = flNumWords(Number(d)).join(" ").replace(/(ty) (one|two|three|four|five|six|seven|eight|nine)$/, "$1-$2");
    return (start || "") + (start || off === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  });
  if (/\d/.test(body)) warnings.push("It still has a number written in digits: write it as words.");
  if (/\b(Mr|Mrs|Ms|Dr|St)\./.test(body)) warnings.push("It has a title like Mr. or Dr.: the voice may not match it. Change it to a name.");
  if (/[&%$#@]/.test(body)) warnings.push("It has a symbol (& % $ # @): write it as a word.");
  const words = body.split(/\s+/).filter(Boolean).length, want = AI_WORDS[Math.max(0, Math.min(5, band | 0))];
  if (words < want * 0.75 || words > want * 1.3) warnings.push(`It has ${words} words; Odin's passages at this level have about ${want}.`);
  return { title: aiClean(title).slice(0, 60) || "A new passage", text: body, words, warnings };
}
// ---------- never anything about a student ----------
// roster: [{ code, name }]. Throws if any of the texts has a student's code, full name, or first or last name as a word.
function aiGuard(texts, roster) {
  const all = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || "")).join("\n");
  const hit = (roster || []).find(s => {
    if (s.code && new RegExp(`\\b${String(s.code).replace(/[^\w-]/g, "")}\\b`, "i").test(all)) return true;
    return String(s.name || "").split(/[\s,.]+/).filter(w => w.length >= 3).some(w => new RegExp(`\\b${w.replace(/[^\p{L}'-]/gu, "")}\\b`, "u").test(all));
  });
  if (hit) throw new Error("Leave students' names and codes out: the AI is never told anything about a student. Change the topic and try again.");
  return true;
}

// ---------- calling the AI straight from the page (demos; at school Odin's server calls it) ----------
// cfg: { provider, url, model, key }. Resolves the AI's text; rejects with an Error whose message a teacher can act on.
async function aiChat(cfg, prompt, opt = {}) {
  const P = AI_BY_ID[cfg.provider] || AI_BY_ID.custom, base = String(cfg.url || P.url || "").replace(/\/+$/, ""), model = String(cfg.model || P.model || "").trim();
  if (!base) throw new Error("Type the AI's address first.");
  if (!model) throw new Error("Type the model's name first.");
  if (P.key === true && !cfg.key) throw new Error(`${P.name} needs a key. Get one at ${P.keyUrl || "the service's site"}.`);
  const fetchFn = opt.fetch || fetch, max = prompt.maxTokens || 2000;
  let url, headers = { "Content-Type": "application/json" }, body;
  if (P.api === "anthropic") {
    url = base + "/messages";
    Object.assign(headers, { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" });
    body = { model, max_tokens: max, system: prompt.system, messages: [{ role: "user", content: prompt.user }] };
  } else if (P.api === "gemini") {
    url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
    headers["x-goog-api-key"] = cfg.key;
    body = { systemInstruction: { parts: [{ text: prompt.system }] }, contents: [{ role: "user", parts: [{ text: prompt.user }] }], generationConfig: { temperature: 0.8, maxOutputTokens: max, responseMimeType: "application/json" } };
  } else {
    url = base + "/chat/completions";
    if (cfg.key) headers.Authorization = "Bearer " + cfg.key;
    body = { model, temperature: 0.8, max_tokens: max, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] };
  }
  let r;
  try { r = await fetchFn(url, { method: "POST", headers, body: JSON.stringify(body) }); }
  catch (e) { throw new Error(P.kind === "local" ? `Can't reach the AI at ${base}. Is it running? A page can reach Ollama only when Ollama allows it (OLLAMA_ORIGINS).` : `Can't reach ${P.name}. Check the internet connection.`); }
  const raw = await r.text();
  if (!r.ok) throw new Error(aiError(r.status, raw, P));
  return aiText(P.api, raw);
}
function aiText(api, raw) {
  let j; try { j = JSON.parse(raw); } catch (e) { throw new Error("The AI's answer couldn't be read."); }
  const t = api === "anthropic" ? (j.content || []).map(c => c.text || "").join("") : api === "gemini" ? (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || "").join("")
    : (((j.choices || [])[0] || {}).message || {}).content || "";
  if (!t) throw new Error("The AI sent back nothing. Try again, or try another model.");
  return t;
}
function aiError(status, raw, P) {
  let msg = ""; try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error)) || j.message || ""; } catch (e) {}
  const why = status === 401 || status === 403 ? "The key wasn't accepted." : status === 404 ? "That model or address wasn't found: check the model's name." : status === 429 ? "Too many requests for now (free tiers have limits). Wait a little, or try another service." : `${P.name} answered ${status}.`;
  return why + (msg ? ` (${String(msg).slice(0, 160)})` : "");
}

if (typeof module !== "undefined") module.exports = Object.assign(module.exports || {}, { AI_PROVIDERS, AI_BY_ID, AI_WORDS, AI_SYSTEM, aiPromptQuestions, aiPromptPassage, aiJSON, aiParseQuestions, aiParsePassage, aiCleanPassage, aiGuard, aiChat, aiText, aiError });
