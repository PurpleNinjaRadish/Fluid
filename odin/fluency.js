// ---------- Odin 0.5: fluency practice (repeated reading), scored like DIBELS 8 oral reading fluency ----------
// The computer's on-device speech recognizer turns the student's reading into words. Everything here is plain code:
// it lines those words up with the passage and counts words correct, errors and accuracy. No audio is ever kept.
//
// Marks, one character per passage word up to the last word the student reached:
//   .  correct        c  self-corrected (correct)      u  given the benefit of the doubt (counted correct, shown for checking)
//   x  misread        o  left out                      s  said for the student after a 3-second pause (an error, as in DIBELS)
const FL_KIND = { pre: "Pre-read", practice: "Practice", post: "Post-read" };
const FL_KIND_LONG = { pre: "Pre-read · 1 minute, first time with this passage", practice: "Practice · the whole passage", post: "Post-read · 1 minute, after practice" };
const FL_MARK_WORD = { ".": "correct", c: "self-corrected", u: "unsure: counted correct", x: "misread", o: "left out", s: "word given after a pause" };
const FL_TIMED = 60;           // seconds for the pre- and post-read, as in DIBELS
const FL_WAIT = { timed: 3000, practice: 2000 };   // pause before the voice says the word (DIBELS: 3 seconds; practice is quicker, 0.9)

// DIBELS 8th Edition benchmark goals (University of Oregon; goals updated July 2020, reformatted October 2025):
// the lowest "at benchmark" score for words correct and for accuracy (%), at the beginning, middle and end of the year.
// Odin's passages are not DIBELS passages, so these are a guide, not a DIBELS score.
const FL_GOALS = {
  1: { wc: [10, 21, 39], acc: [67, 87, 91] }, 2: { wc: [49, 78, 94], acc: [92, 96, 96] }, 3: { wc: [73, 105, 114], acc: [96, 96, 96] },
  4: { wc: [87, 121, 125], acc: [96, 96, 96] }, 5: { wc: [103, 122, 137], acc: [96, 96, 96] }
};
const FL_PERIOD = ["beginning of the year", "middle of the year", "end of the year"];
const FL_GOAL_K = 30;          // Odin's own practice goal for kindergarten-level passages (DIBELS has no oral reading fluency in kindergarten)
// June to September works toward the beginning-of-year goal, October to January the middle, February to May the end.
function flPeriod(iso) { const m = Number(String(iso).slice(5, 7)); return m >= 6 && m <= 9 ? 0 : m >= 10 || m <= 1 ? 1 : 2; }
// The goal for a passage level: on grade level, the next DIBELS goal for the grade; below grade level, the end-of-year goal
// for the passage's level (the usual rule for monitoring with easier passages).
function flGoal(grade, band, iso) {
  if (!FL_GOALS[band]) return band === 0 ? { wc: FL_GOAL_K, acc: 95, basis: "Odin's practice goal for kindergarten-level passages", dibels: false } : null;
  const p = band >= grade ? flPeriod(iso) : 2;
  return { wc: FL_GOALS[band].wc[p], acc: FL_GOALS[band].acc[p], basis: `DIBELS 8 goal, grade ${band}, ${FL_PERIOD[p]}`, dibels: true };
}

// ---------- words ----------
const FL_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const FL_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function flNumWords(n) {
  if (n < 20) return [FL_ONES[n]];
  if (n < 100) return n % 10 ? [FL_TENS[Math.floor(n / 10)], FL_ONES[n % 10]] : [FL_TENS[n / 10]];
  if (n < 1000) { const h = [FL_ONES[Math.floor(n / 100)], "hundred"]; return n % 100 ? h.concat(flNumWords(n % 100)) : h; }
  if (n < 10000 && n % 1000 === 0) return [FL_ONES[n / 1000], "thousand"];
  return [String(n)];
}
const FL_FILLERS = new Set("um umm uh uhh er erm hmm hm mm mhm ah".split(" "));
const flNorm = w => String(w).toLowerCase().replace(/[’‘'`]/g, "").replace(/[^a-z0-9]/g, "");
const flSplit = t => String(t).replace(/[—–\-/]+/g, " ").split(/\s+/).filter(Boolean);
// What the recognizer heard, as words: digits become number words ("100" → one hundred), punctuation goes.
function flSpoken(text) {
  const out = [];
  for (const raw of flSplit(text)) {
    const n = flNorm(raw);
    if (!n || FL_FILLERS.has(n)) continue;
    if (/^\d+$/.test(n)) out.push(...flNumWords(Number(n)));
    else if (/^\d+(st|nd|rd|th)$/.test(n)) out.push(n);
    else out.push(n);
  }
  return out;
}
// The passage as words: what to show, the plain form to match, and the paragraph it starts.
function flWords(p) {
  const out = [];
  String(p.text).split(/\n\s*\n/).forEach((para, k) => flSplit(para).forEach((w, j) => { const n = flNorm(w); if (n) out.push({ w, n, para: k, first: j === 0 }); }));
  return out;
}
const FL_WORDS_CACHE = new Map();
function flPassageWords(id) { if (!FL_WORDS_CACHE.has(id)) FL_WORDS_CACHE.set(id, FL_BY_ID[id] ? flWords(FL_BY_ID[id]) : []); return FL_WORDS_CACHE.get(id); }

// Share of the passage that is high-frequency words (Dolch sight words and Dolch nouns).
function flHfwShare(id) {
  const set = new Set([...Object.values(SH_DOLCH).join(" ").split(/\s+/), ...FL_DOLCH_NOUNS.split(" ")].map(flNorm));
  const ws = flPassageWords(id);
  return ws.length ? ws.filter(x => set.has(x.n) || set.has(x.n.replace(/s$/, ""))).length / ws.length : 0;
}

// Words that sound the same count as the word: a recognizer cannot tell "there" from "their".
const FL_HOMO = new Map();
["to too two", "there their theyre", "for four", "no know", "right write", "one won", "by buy bye", "see sea", "here hear", "red read", "blue blew",
 "ate eight", "new knew", "would wood", "so sew", "be bee", "i eye", "our hour are", "son sun", "where wear", "whole hole", "night knight", "road rode",
 "tail tale", "flower flour", "made maid", "meet meat", "week weak", "pair pear", "sail sale", "dear deer", "hi high", "not knot", "peace piece",
 "wait weight", "way weigh", "ok okay", "grey gray", "your youre", "sacs sacks", "threw through", "which witch", "weather whether", "heard herd",
 "rows rose", "some sum", "tied tide", "allowed aloud", "close clothes", "seen scene", "missed mist", "fair fare", "bear bare", "break brake",
 "plane plain", "mail male", "aunt ant", "lead led", "in inn", "poor pour", "flew flu", "mom mum", "its its"]
  .forEach(g => { const ws = g.split(" "); ws.forEach(w => { const s = FL_HOMO.get(w) || new Set(); ws.forEach(x => s.add(x)); FL_HOMO.set(w, s); }); });
// Two spoken words for one written word, and the reverse ("can not" read for "cannot", "head first" heard for "headfirst").
const FL_SPLITS = { dont: "do not", didnt: "did not", cant: "can not", cannot: "can not", im: "i am", lets: "let us", its: "it is", isnt: "is not",
  wont: "will not", thats: "that is", youre: "you are", theyre: "they are", shes: "she is", hes: "he is", wasnt: "was not" };
// Small words a recognizer often drops or swaps: a miss here is counted correct but shown for the teacher to check.
const FL_TINY = new Set("a an the to of in on at is it and as or i so by be up my do am an for but".split(" "));

function flLev(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}
// 2 = the same word, 1 = close enough that the recognizer may have misheard it (counted correct, shown for checking), 0 = different.
function flSame(spoken, written) {
  if (spoken === written) return 2;
  const h = FL_HOMO.get(written); if (h && h.has(spoken)) return 2;
  const a = spoken.length, b = written.length;
  if (Math.min(a, b) >= 5 && flLev(spoken, written, 1) <= 1) return 1;
  if (Math.min(a, b) >= 8 && flLev(spoken, written, 2) <= 2) return 1;
  return 0;
}

// Line up spoken words with the passage words from where this stretch of reading began. Every spoken word is used;
// the passage may stop anywhere, because the student is still reading. Costs: match 0, close match 0.25, misread 1,
// extra word 1 (0.6 for a repeat or a start on the next word), left-out word 1, and 0.35 for each further word left out
// in a row, so a skipped line is found after a few words. Two spoken words may stand for one written word, and one for two.
function flAlign(E, S) {
  const A = S.length, B = E.length, W = B + 1, N = (A + 1) * W, INF = 1e9, OPEN = 1, EXT = 0.35;
  const X = new Float64Array(N).fill(INF), Y = new Float64Array(N).fill(INF), Z = new Float64Array(N).fill(INF);   // ends with a written word read, left out, or an extra word
  const PX = new Int8Array(N), PY = new Int8Array(N), PZ = new Int8Array(N), KX = new Int8Array(N), QX = new Int8Array(N);
  const at = (a, b) => a * W + b;
  const best3 = i => (X[i] <= Y[i] && X[i] <= Z[i] ? [X[i], 0] : Y[i] <= Z[i] ? [Y[i], 1] : [Z[i], 2]);
  const insCost = (a, b) => { const s = S[a - 1]; return (b >= 1 && flSame(s, E[b - 1])) || (b >= 2 && flSame(s, E[b - 2])) || (b < B && s.length >= 2 && s !== E[b] && E[b].startsWith(s)) ? 0.6 : 1; };
  X[0] = 0;
  const BAND = 40;   // only cells near the diagonal: up to 40 words skipped or 40 extra words in one stretch
  for (let a = 0; a <= A; a++) for (let b = Math.max(0, a - BAND); b <= Math.min(B, a + BAND); b++) {
    if (!a && !b) continue;
    const i = at(a, b);
    if (a >= 1 && b >= 1) {
      const m = flSame(S[a - 1], E[b - 1]), [v, s] = best3(at(a - 1, b - 1));
      X[i] = v + (m === 2 ? 0 : m === 1 ? 0.25 : 1); PX[i] = s; KX[i] = m ? 1 : 2; QX[i] = m;
      if (a >= 2 && (S[a - 2] + S[a - 1] === E[b - 1] || FL_SPLITS[E[b - 1]] === S[a - 2] + " " + S[a - 1])) {
        const [jv, js] = best3(at(a - 2, b - 1)); if (jv < X[i]) { X[i] = jv; PX[i] = js; KX[i] = 5; QX[i] = 2; }
      }
      if (b >= 2 && (S[a - 1] === E[b - 2] + E[b - 1] || FL_SPLITS[S[a - 1]] === E[b - 2] + " " + E[b - 1])) {
        const [jv, js] = best3(at(a - 1, b - 2)); if (jv < X[i]) { X[i] = jv; PX[i] = js; KX[i] = 6; QX[i] = 2; }
      }
    }
    if (b >= 1) { const j = at(a, b - 1); let v = X[j] + OPEN, s = 0; if (Y[j] + EXT < v) { v = Y[j] + EXT; s = 1; } if (Z[j] + OPEN < v) { v = Z[j] + OPEN; s = 2; } Y[i] = v; PY[i] = s; }
    if (a >= 1) { const [v, s] = best3(at(a - 1, b)); Z[i] = v + insCost(a, b); PZ[i] = s; }
  }
  let end = 0, cost = best3(at(A, 0))[0];
  for (let b = 1; b <= B; b++) { const c = best3(at(A, b))[0]; if (c < cost - 1e-9) { cost = c; end = b; } }
  const ops = [];
  let a = A, b = end, st = best3(at(A, end))[1];
  while (a > 0 || b > 0) {
    const i = at(a, b);
    if (st === 0) {
      const k = KX[i], nx = PX[i];
      if (k === 1 || k === 2) { ops.push({ k, e: b - 1, s: a - 1, q: QX[i] }); a--; b--; }
      else if (k === 5) { ops.push({ k: 1, e: b - 1, s: a - 1, q: 2 }); a -= 2; b--; }
      else { ops.push({ k: 1, e: b - 1, s: a - 1, q: 2 }, { k: 1, e: b - 2, s: a - 1, q: 2 }); a--; b -= 2; }
      st = nx;
    } else if (st === 1) { ops.push({ k: 4, e: b - 1, s: null }); st = PY[i]; b--; }
    else { ops.push({ k: 3, e: null, s: a - 1 }); st = PZ[i]; a--; }
  }
  return { ops: ops.reverse(), cost, end };
}

// Marks for one stretch of reading (a "segment": what the recognizer heard since it last started).
// Only words up to the last matched word get a mark; anything after that is still being read.
function flSegment(words, seg) {
  const start = seg.start, toks = seg.tokens, E = [];
  for (let i = start; i < Math.min(words.length, start + toks.length + 30); i++) E.push(words[i].n);
  const { ops } = flAlign(E, toks);
  const marks = {}, said = {};
  let last = -1, attempt = false;
  for (const o of ops) {
    if (o.k === 3) { attempt = !(last >= start && flSame(toks[o.s], words[last].n)); continue; }   // an extra word just before a match: a self-correction
    const i = start + o.e;
    if (o.k === 1) { marks[i] = o.q === 1 ? "u" : attempt ? "c" : "."; last = Math.max(last, i); }
    else if (o.k === 2) { marks[i] = "x"; said[i] = toks[o.s]; }
    else marks[i] = "o";
    attempt = false;
  }
  Object.keys(marks).forEach(i => { if (Number(i) > last) { delete marks[i]; delete said[i]; } });
  Object.keys(marks).forEach(k => {
    const i = Number(k), w = words[i].n, alone = marks[i - 1] !== "o" && marks[i + 1] !== "o";
    if (marks[i] === "o" && alone && FL_TINY.has(w)) marks[i] = "u";
    else if (marks[i] === "x" && FL_TINY.has(w) && FL_TINY.has(said[i])) marks[i] = "u";
    else if (marks[i] === "o" && seg.restart && i === (seg.first != null ? seg.first : start)) marks[i] = "u";   // the first word after the microphone restarted may not have been heard
  });
  // 0.8.2: a phone's recognizer can take a second or two to start listening, so the first words of a reading (or after the
  // microphone restarted) may never reach Odin. As many left-out words as a quick reader says in that time (one every 0.3
  // seconds, and 2 more) are given the benefit of the doubt, shown for checking. deafMs: how long the recognizer took to start.
  const from = seg.first != null ? seg.first : start, forgive = Math.min(12, 2 + Math.ceil(Math.max(0, seg.deafMs || 0) / 300));
  if (seg.restart || from === 0) for (let i = from, k = 0; k < forgive && (marks[i] === "o" || marks[i] === "u"); i++, k++) marks[i] = "u";
  return { marks, said, last };
}

// Words correct, errors, words correct per minute (WCPM) and accuracy from the marks.
function flScore(marks, secs) {
  let c = 0, e = 0;
  for (const m of String(marks || "")) { if (m === "." || m === "c" || m === "u") c++; else if (m === "x" || m === "o" || m === "s") e++; }
  const t = Math.max(1, Number(secs) || FL_TIMED);
  return { correct: c, errors: e, wcpm: Math.round((c * 60) / t), acc: c + e ? Math.round((100 * c) / (c + e)) : 0 };
}
// A long run of left-out words is usually a skipped line: worth a look.
function flSkips(marks) { const m = String(marks || "").match(/o{5,}/g); return m ? m.map(x => x.length) : []; }

// ---------- levels and passages ----------
// The starting level comes from the student's high-frequency word level (or phonics, or overall reading), never above the grade.
function flBandFor(cls, code) {
  const p = profile(cls, "reading", code), lv = id => { const r = p.rungs.find(x => x.id === id); return r ? r.gl : null; };
  const gl = lv("HFW") ?? lv("PH") ?? (p.overall ? p.overall.gl : null);
  const G = cls.grade;
  if (gl == null) return Math.max(0, Math.min(5, G));
  return Math.max(0, Math.min(G, bandOf(gl)));
}
const flF = cls => { cls.fluency = cls.fluency || { runs: [], plans: [] }; cls.fluency.runs = cls.fluency.runs || []; cls.fluency.plans = cls.fluency.plans || []; return cls.fluency; };
function flHash(s) { let h = 7; for (const ch of String(s)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0; return h; }
const flWeekNo = wk => Math.round(Date.parse(wk + "T12:00:00Z") / 604800000);
// The level for a week: the teacher's latest choice up to that week, or the starting level.
function flBandAt(cls, code, week) {
  const pl = flF(cls).plans.filter(p => p.code === code && p.week <= week && p.band != null).sort((a, b) => b.week.localeCompare(a.week))[0];
  return pl ? pl.band : flBandFor(cls, code);
}
// The week's passage: the teacher's choice, else the one already read this week, else the next one at the level the student
// has not read in an earlier week. Classmates at the same level start at different passages.
function flPassageFor(cls, code, week) {
  const F = flF(cls), runs = F.runs.filter(r => r.code === code);
  const now = runs.filter(r => r.week === week).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.id || 0) - (b.id || 0))[0];
  if (now && FL_BY_ID[now.passage]) return { passage: FL_BY_ID[now.passage], chosen: false };
  const plan = F.plans.find(p => p.code === code && p.week === week && p.passage);
  if (plan && FL_BY_ID[plan.passage]) return { passage: FL_BY_ID[plan.passage], chosen: true };
  const band = flBandAt(cls, code, week), list = FL_PASSAGES.filter(p => p.band === band && !p.added);   // the school's added passages only when chosen
  const used = new Set(runs.filter(r => r.week < week).map(r => r.passage));
  const off = (flHash(code) + flWeekNo(week)) % list.length;
  for (let k = 0; k < list.length; k++) { const p = list[(off + k) % list.length]; if (!used.has(p.id)) return { passage: p, chosen: false }; }
  return { passage: list[off], chosen: false };
}
// 0.10: passages the school added (written with AI or typed in) join Odin's own, marked "added". Odin only gives them to a
// student when the teacher chooses one, so adding a passage never changes the passages students already have.
function flAddPassages(list) {
  (list || []).forEach(p => {
    if (!p || !/^A[0-5]-\d{1,4}$/.test(p.id) || FL_BY_ID[p.id]) return;
    const q = { id: p.id, band: p.band, title: p.title, text: p.text, topic: p.topic || "", source: p.source || "", added: true };
    FL_PASSAGES.push(q); FL_BY_ID[q.id] = q; FL_WORDS_CACHE.delete(q.id);
  });
}
function flDropPassage(id) { const i = FL_PASSAGES.findIndex(p => p.id === id && p.added); if (i >= 0) FL_PASSAGES.splice(i, 1); if (FL_BY_ID[id] && FL_BY_ID[id].added) delete FL_BY_ID[id]; FL_WORDS_CACHE.delete(id); }
function flWeekSummary(cls, code, week) {
  const runs = flF(cls).runs.filter(r => r.code === code && r.week === week).sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.id || 0) - (b.id || 0));
  const last = k => runs.filter(r => r.kind === k).slice(-1)[0] || null;
  const prac = runs.filter(r => r.kind === "practice");
  const done = prac.filter(r => r.finished);
  return { runs, pre: last("pre"), post: last("post"), practice: prac,
    best: done.length ? Math.max(...done.map(r => r.wcpm)) : null, fastest: done.length ? Math.min(...done.map(r => r.secs)) : null };
}

// ---------- achievements (worked out from the readings, never stored on their own) ----------
const FL_BADGES = [
  { id: "first", name: "First read", desc: "Read a whole passage in practice", icon: "book" },
  { id: "best", name: "New best", desc: "Beat your best words a minute on a passage", icon: "star" },
  { id: "speed", name: "Speedy", desc: "Read a passage faster than ever before", icon: "bolt" },
  { id: "smooth", name: "Smooth reader", desc: "Read a whole passage with no help", icon: "wave" },
  { id: "every", name: "Every word", desc: "Read every word right", icon: "check" },
  { id: "goal", name: "Goal!", desc: "Reach the goal for your level in practice", icon: "target" },
  { id: "three", name: "Three times", desc: "Read the same passage three times", icon: "three" },
  { id: "jump", name: "Big jump", desc: "Read 20 more words a minute than your first try on a passage", icon: "up" },
  { id: "days", name: "Three days", desc: "Practice on three different days in one week", icon: "cal" },
  { id: "ten", name: "Ten reads", desc: "Finish ten practice readings", icon: "ten" },
  { id: "level", name: "Level up", desc: "Move up to a harder reading level", icon: "arrow" }
];
// runs: one student's readings. grade: the student's grade. Returns { id: { n: times earned, date: first earned, dates: each time } }.
function flBadges(runs, grade) {
  const out = {}, give = (id, r) => { const o = out[id] || (out[id] = { n: 0, date: r.date, run: r.id, dates: [] }); o.n++; o.dates.push(r.date || r.week); };
  const list = [...runs].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.id || 0) - (b.id || 0));
  const seen = [];
  let practiced = 0;
  for (const r of list) {
    const same = seen.filter(x => x.passage === r.passage);
    if (r.kind === "practice" && r.finished) {
      practiced++;
      if (practiced === 1) give("first", r);
      const before = same.filter(x => x.wcpm != null);
      if (before.length && r.wcpm > Math.max(...before.map(x => x.wcpm))) give("best", r);
      const fin = same.filter(x => x.kind === "practice" && x.finished);
      if (fin.length && r.secs < Math.min(...fin.map(x => x.secs))) give("speed", r);
      if (!r.supplied && !r.errors) give("every", r);
      else if (!r.supplied && !r.helped) give("smooth", r);
      const g = flGoal(grade, r.band, r.date || r.week);
      if (g && r.wcpm >= g.wc && !same.some(x => x.kind === "practice" && x.finished && x.wcpm >= g.wc)) give("goal", r);
      if (fin.length === 2) give("three", r);
      if (practiced === 10) give("ten", r);
      const days = new Set([...seen, r].filter(x => x.kind === "practice" && x.week === r.week).map(x => x.date));
      if (days.size === 3 && !seen.some(x => x.kind === "practice" && x.week === r.week && x.date === r.date)) give("days", r);
    }
    if (r.kind !== "pre" && same.length) {
      const first = same[0];
      if (first.wcpm != null && r.wcpm >= first.wcpm + 20 && !same.some(x => x !== first && x.wcpm >= first.wcpm + 20)) give("jump", r);
    }
    if (seen.length && r.band > Math.max(...seen.map(x => x.band))) give("level", r);
    seen.push(r);
  }
  return out;
}
const FL_ICON = {
  book: '<path d="M5 6.5c2.5-1.2 5-1.2 7 .3 2-1.5 4.5-1.5 7-.3V18c-2.5-1.2-5-1.2-7 .3-2-1.5-4.5-1.5-7-.3z"/><path d="M12 6.8v11.5"/>',
  star: '<path d="M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 10l5.2-.8z"/>',
  bolt: '<path d="M13 3.5L6 13.5h5l-1 7 7-10h-5z"/>',
  wave: '<path d="M3.5 13c2-3 4-3 6 0s4 3 6 0 3.5-3 5 0"/><path d="M3.5 17.5c2-3 4-3 6 0s4 3 6 0 3.5-3 5 0"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  three: '<path d="M8.5 6.5h6l-3.5 4.5c3 0 4.5 1.4 4.5 3.4 0 2.2-1.9 3.6-4.2 3.6-1.7 0-3-.6-3.8-1.6"/>',
  up: '<path d="M12 19V6"/><path d="M6.5 11.5L12 6l5.5 5.5"/>',
  cal: '<rect x="4.5" y="6" width="15" height="13" rx="2"/><path d="M4.5 10h15M9 4v4M15 4v4"/>',
  ten: '<path d="M6.5 8l2-1.5V17"/><rect x="12" y="6.5" width="5.5" height="10.5" rx="2.75"/>',
  arrow: '<path d="M5 17.5h4v-4h4v-4h4V5.5"/><path d="M14.5 5.5H17V8"/>'
};
const flIcon = (name, size) => `<svg viewBox="0 0 24 24" width="${size || 24}" height="${size || 24}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${FL_ICON[name] || ""}</svg>`;
if (typeof module !== "undefined") module.exports = Object.assign(module.exports || {}, { flAlign, flSegment, flScore, flSpoken, flWords, flSame, flGoal, flBadges, flPassageFor, flBandFor, flWeekSummary, flHfwShare, flSkips });
