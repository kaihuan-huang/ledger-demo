(function (root) {
  "use strict";

  const MAX_PARTY = 20;
  const CJK = /[一-鿿]/;
  const EN_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const ZH_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const ZH_NUM = "[零一二两三四五六七八九十]{1,3}";
  const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  const ZH_WEEKDAY = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const NOT_NAMES = new Set(["Table", "Tomorrow", "Today", "Tonight", "Here", "Looking", "Back", ...Object.keys(WEEKDAYS).map(cap), ...MONTHS.map(cap)]);

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function zhNum(s) {
    if (/^\d+$/.test(s)) return Number(s);
    if (s === "十") return 10;
    const i = s.indexOf("十");
    if (i < 0) return s.length === 1 ? ZH_DIGIT[s] : NaN;
    const tens = i === 0 ? 1 : ZH_DIGIT[s[0]];
    const ones = i === s.length - 1 ? 0 : ZH_DIGIT[s[i + 1]];
    return tens * 10 + ones;
  }

  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // ---- resolvers: each returns { value, from } or null, never a guess ----

  function resolveParty(text) {
    const word = `(\\d{1,2}|${Object.keys(EN_NUM).join("|")})`;
    const toN = (w) => (/^\d+$/.test(w) ? Number(w) : EN_NUM[w.toLowerCase()]);
    let m = text.match(new RegExp(`\\b(?:table for|party of|group of|for)\\s+${word}\\b(?!\\s*(?::|a\\.?m\\b|p\\.?m\\b|o'?clock|th\\b|st\\b|nd\\b|rd\\b))`, "i"))
      || text.match(new RegExp(`\\b${word}\\s+(?:people|persons|person|guests|pax|adults|of us)\\b`, "i"));
    if (m) return { value: toN(m[1]), from: m[0] };
    m = text.match(new RegExp(`(\\d{1,2}|${ZH_NUM})\\s*(?:位|个人|口人|人)`));
    if (m) return { value: zhNum(m[1]), from: m[0] };
    return null;
  }

  function meridiem(text) {
    if (/\b(p\.?m\.?|tonight|this evening|evening|dinner)\b/i.test(text) || /(下午|傍晚|晚上|今晚|明晚|晚饭|晚餐)/.test(text)) return "pm";
    if (/\b(a\.?m\.?|morning|breakfast)\b/i.test(text) || /(早上|早晨|上午|早餐)/.test(text)) return "am";
    if (/\blunch\b/i.test(text) || /(中午|午饭|午餐)/.test(text)) return "noon";
    return null;
  }

  function applyMeridiem(hour, mer) {
    if (mer === "pm") return hour < 12 ? hour + 12 : hour;
    if (mer === "am") return hour === 12 ? 0 : hour;
    if (mer === "noon") return hour >= 11 ? hour : hour + 12;
    return null;
  }

  // Returns { value: "HH:MM" } or { ambiguous: { hour, minute } }.
  function resolveTime(text) {
    let m = text.match(/(?<![\d:])(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) {
      const h = applyMeridiem(Number(m[1]), /p/i.test(m[3]) ? "pm" : "am");
      return { value: `${pad(h)}:${m[2] || "00"}`, from: m[0] };
    }
    if (/\bnoon\b/i.test(text)) return { value: "12:00", from: "noon" };
    m = text.match(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/)
      || text.match(/\bat\s+(\d{1,2})()\b(?!\s*(?:people|persons|guests|pax|:))/i)
      || text.match(/\b(\d{1,2})()\s*o'?clock\b/i);
    let zh = null;
    if (!m) {
      // A digit after 点 is only minutes when a headcount word doesn't follow it ("7点3个人" is 7:00 for 3).
      zh = text.match(new RegExp(`(\\d{1,2}|${ZH_NUM})\\s*[点點]\\s*(半|一刻|三刻|(\\d{1,2})(?!\\d|\\s*(?:个|位|人|口))\\s*分?)?`));
      if (zh) m = [zh[0], String(zhNum(zh[1])), zh[2] === "半" ? "30" : zh[2] === "一刻" ? "15" : zh[2] === "三刻" ? "45" : zh[3] ? pad(Number(zh[3])) : "00"];
    }
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = m[2] ? pad(Number(m[2])) : "00";
    if (hour > 23 || Number(minute) > 59) return null;
    if (hour === 0 || hour >= 13) return { value: `${pad(hour)}:${minute}`, from: m[0] };
    const mer = meridiem(text);
    if (mer) return { value: `${pad(applyMeridiem(hour, mer))}:${minute}`, from: m[0] };
    return { ambiguous: { hour, minute }, from: m[0] };
  }

  function resolveDate(text, now) {
    const today = startOfDay(now);
    let m = text.match(/\b(today|tonight|tomorrow|day after tomorrow)\b/i) || text.match(/(今天|今晚|明天|明晚|后天)/);
    if (m) {
      const k = m[1].toLowerCase();
      const n = k === "day after tomorrow" || k === "后天" ? 2 : k === "tomorrow" || k === "明天" || k === "明晚" ? 1 : 0;
      return { value: ymd(addDays(today, n)), from: m[0] };
    }
    const weekdayNames = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join("|");
    m = text.match(new RegExp(`\\b(?:(this|next)\\s+)?(${weekdayNames})\\b`, "i"));
    if (m) {
      const target = WEEKDAYS[m[2].toLowerCase()];
      let ahead = (target - today.getDay() + 7) % 7;
      if (m[1] && m[1].toLowerCase() === "next") ahead += 7;
      return { value: ymd(addDays(today, ahead)), from: m[0] };
    }
    m = text.match(/(下个?|这个?|本)?\s*(?:周|星期|礼拜)([一二三四五六日天])/);
    if (m) {
      let ahead = (ZH_WEEKDAY[m[2]] - today.getDay() + 7) % 7;
      if (m[1] && m[1].startsWith("下")) ahead += 7;
      return { value: ymd(addDays(today, ahead)), from: m[0] };
    }
    let month = null, day = null, from = null;
    m = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
    if (m) { month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; day = Number(m[2]); from = m[0]; }
    if (!m && (m = text.match(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/))) { month = Number(m[1]); day = Number(m[2]); from = m[0]; }
    if (!m && (m = text.match(new RegExp(`(\\d{1,2}|${ZH_NUM})\\s*月\\s*(\\d{1,2}|${ZH_NUM})\\s*[日号號]`)))) { month = zhNum(m[1]); day = zhNum(m[2]); from = m[0]; }
    if (!m && (m = text.match(new RegExp(`(?<![月\\d])(\\d{1,2}|${ZH_NUM})\\s*[号號]`)))) {
      day = zhNum(m[1]); month = today.getMonth() + 1; from = m[0];
      if (day < today.getDate()) month += 1;
    }
    if (month === null) return null;
    let year = today.getFullYear();
    if (month > 12) { month -= 12; year += 1; }
    let d = new Date(year, month - 1, day);
    if (d.getMonth() !== month - 1) return null;
    // A date well in the past means next year; one a few weeks back is more likely a typo, so reject it.
    const daysAgo = (today - d) / 864e5;
    if (daysAgo > 30) d = new Date(year + 1, month - 1, day);
    else if (daysAgo > 0) return { past: true, from };
    return { value: ymd(d), from };
  }

  function resolveName(text) {
    let m = text.match(/(?:[Mm]y name is|[Nn]ame is|[Nn]ame's|[Uu]nder(?: the name(?: of)?)?|[Tt]his is|I am|I'm|I’m)\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)/);
    if (m && !NOT_NAMES.has(m[1].split(/\s+/)[0])) return { value: m[1], from: m[0] };
    m = text.match(/((?:(?![位人个点號号日月周天])[一-鿿]){1,2}(?:先生|女士|小姐))/);
    if (m) return { value: m[1], from: m[0] };
    m = text.match(/(?:我叫|我是|名字(?:是|叫)?|姓名(?:是)?|预订人(?:是)?)[:：\s]*([一-鿿]{2,4}|[A-Za-z][A-Za-z'-]*(?:\s[A-Za-z][A-Za-z'-]*)?)/);
    if (m) {
      const name = m[1].replace(/(今天|明天|后天|今晚|明晚|周|星期|礼拜|下午|晚上|上午|中午|早上|订|要|想|预订|的).*$/, "");
      if (name.length >= 2 || /[A-Za-z]/.test(name)) return { value: name, from: m[0] };
    }
    return null;
  }

  function resolveAll(text, now) {
    return { party: resolveParty(text), date: resolveDate(text, now), time: resolveTime(text), name: resolveName(text) };
  }

  // ---- intents ----
  // Only a bare, explicit yes books. "ok", "sure", "好", "嗯" are too vague: the agent asks again.
  const CONFIRM_WORDS = new Set(["yes", "y", "yep", "yeah", "confirm", "confirmed", "correct", "right"]);
  const FILLER_WORDS = new Set(["please", "it", "that", "is", "book", "do", "go", "ahead", "thanks", "thank", "you", "i", "sounds", "good", "looks", "great", "perfect", "all", "the", "this"]);
  const CONFIRM_PHRASES = new Set(["book it", "do it", "please book", "please book it", "go ahead", "sounds good", "looks good"]);
  const ZH_CONFIRM = new Set(["是", "是的", "对", "对的", "确认", "好的", "没错", "没问题", "可以", "行", "确认预订", "请确认"]);
  function isYes(t) {
    if (/[?？]/.test(t)) return false;
    const s = t.trim().replace(/[.!。！,，~]+$/g, "").trim();
    if (ZH_CONFIRM.has(s)) return true;
    const words = s.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!words.length) return false;
    if (CONFIRM_PHRASES.has(words.join(" "))) return true;
    return words.some((w) => CONFIRM_WORDS.has(w)) && words.every((w) => CONFIRM_WORDS.has(w) || FILLER_WORDS.has(w));
  }
  const isVague = (t) => /^\s*(ok|okay|k|sure|fine|alright|好|嗯|嗯嗯|哦|好吧)\s*[.!。！]*\s*$/i.test(t);
  const isNo = (t) => /^\s*(no|n|nope|cancel|don't|do not|不|不是|不对|不用|取消)\b/i.test(t) || /^\s*(不|不是|不对|不用|取消)/.test(t);
  const asksContact = (t) => /\b(e-?mail|send (me )?(a |the )?confirmation|text me|call me)\b/i.test(t) || /(邮件|邮箱|发.{0,4}确认|短信|打电话给我)/.test(t);
  const asksStatus = (t) => /\b(status|did (it|my booking|that) go through|is (it|my (booking|reservation)) (confirmed|booked))\b/i.test(t) || /(订上了吗|订好了吗|预订成功了吗|成功了吗)/.test(t);
  const onlyMeridiem = (t) => meridiem(t) && !/\d/.test(t) && t.replace(/[\s.!。！,，]/g, "").length <= 12;

  // ---- replies (fixed templates; the agent never promises an action it has no tool for) ----
  const EN_WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ZH_WD = ["日", "一", "二", "三", "四", "五", "六"];
  function fmtDate(v, lang) {
    const [y, mo, d] = v.split("-").map(Number);
    const wd = new Date(y, mo - 1, d).getDay();
    return lang === "zh" ? `${mo}月${d}日（周${ZH_WD[wd]}）` : `${EN_WD[wd]}, ${cap(MONTHS[mo - 1])} ${d}`;
  }
  function fmtTime(v, lang) {
    const [h, mi] = v.split(":").map(Number);
    if (lang === "zh") {
      const p = h < 12 ? "上午" : h === 12 ? "中午" : h < 18 ? "下午" : "晚上";
      return `${p}${h > 12 ? h - 12 : h}:${pad(mi)}`;
    }
    return `${((h + 11) % 12) + 1}:${pad(mi)} ${h < 12 ? "AM" : "PM"}`;
  }

  const T = {
    en: {
      party: "how many people", date: "which date", time: "what time", name: "the name for the booking",
      ask: (xs) => `Got it. I still need ${xs.join(", ").replace(/, ([^,]*)$/, " and $1")}.`,
      ampm: (h, mi) => `Is that ${h}:${mi} AM or ${h}:${mi} PM?`,
      past: "That date has already passed. Which date would you like?",
      pastTime: "That time has already passed. What time would you like?",
      bigParty: `I can book up to ${MAX_PARTY} people here. How many will there be?`,
      summary: (f) => `Table for ${f.party} on ${fmtDate(f.date, "en")} at ${fmtTime(f.time, "en")}, under ${f.name}. Reply YES to book it.`,
      booked: (c) => `Request sent, reference ${c}. It stays pending until the restaurant confirms it.`,
      explicit: "To book, please reply YES. Or tell me what to change.",
      nothing: "There's nothing to confirm yet.",
      cancelled: "No problem, nothing was booked. What would you like to change?",
      contact: "I can't send emails, texts or calls from this chat. Your booking reference appears here once the request is sent.",
      statusNone: "There's no booking yet in this chat.",
      statusDone: (c) => `Your latest request, ${c}, is pending until the restaurant confirms it.`,
    },
    zh: {
      party: "人数", date: "日期", time: "时间", name: "预订人姓名",
      ask: (xs) => `好的，还需要：${xs.join("、")}。`,
      ampm: (h, mi) => `请问是上午 ${h}:${mi} 还是晚上 ${h}:${mi}？`,
      past: "这个日期已经过了，请问想订哪一天？",
      pastTime: "这个时间已经过了，请问想订几点？",
      bigParty: `这里最多可以订 ${MAX_PARTY} 位，请问一共几位？`,
      summary: (f) => `为 ${f.name} 预订 ${fmtDate(f.date, "zh")} ${fmtTime(f.time, "zh")}，${f.party} 位。回复“确认”即可预订。`,
      booked: (c) => `已提交预订，编号 ${c}。餐厅确认之前为待确认状态。`,
      explicit: "如需预订，请回复“确认”；也可以告诉我要改哪一项。",
      nothing: "目前还没有需要确认的预订。",
      cancelled: "好的，没有预订。请问要改哪一项？",
      contact: "这个对话里无法发邮件、短信或打电话。提交预订后，预订编号会显示在这里。",
      statusNone: "这个对话里还没有预订。",
      statusDone: (c) => `最近一笔预订 ${c} 正在等待餐厅确认。`,
    },
  };

  function initialState() {
    return { fields: { party: null, date: null, time: null, name: null }, rejected: {}, ambiguousTime: null, awaitingConfirm: false, bookings: [] };
  }

  const FIELD_ORDER = ["party", "date", "time", "name"];

  function step(prev, text, now) {
    const state = JSON.parse(JSON.stringify(prev));
    const lang = CJK.test(text) ? "zh" : "en";
    const t = T[lang];
    const out = { state, reply: "", toolCalls: [], trace: [] };
    const say = (s) => { out.reply = out.reply ? `${out.reply} ${s}` : s; };

    if (state.awaitingConfirm && isYes(text)) {
      const f = state.fields;
      if (new Date(`${f.date}T${f.time}:00`) <= now) {
        state.awaitingConfirm = false; state.fields.time = null; state.rejected.time = "time already passed";
        say(t.pastTime); return out;
      }
      const confirmation = `R-${1001 + state.bookings.length}`;
      const call = { name: "create_reservation", args: { party_size: f.party, date: f.date, time: f.time, name: f.name }, result: { confirmation, status: "pending" } };
      out.toolCalls.push(call);
      state.bookings.push(confirmation);
      Object.assign(state, { fields: initialState().fields, rejected: {}, ambiguousTime: null, awaitingConfirm: false });
      say(t.booked(confirmation)); return out;
    }
    if (isYes(text)) { say(t.nothing); return out; }
    if (state.awaitingConfirm && isVague(text)) { say(t.explicit); return out; }
    // "no, make it 6" is a change, not a cancel: only a refusal with no new details cancels.
    const carriesDetails = Object.values(resolveAll(text, now)).some(Boolean);
    if (state.awaitingConfirm && isNo(text) && !carriesDetails) { state.awaitingConfirm = false; say(t.cancelled); return out; }
    if (asksStatus(text)) { say(state.bookings.length ? t.statusDone(state.bookings[state.bookings.length - 1]) : t.statusNone); return out; }

    const r = resolveAll(text, now);
    if (state.ambiguousTime && !r.time && onlyMeridiem(text)) {
      const { hour, minute } = state.ambiguousTime;
      r.time = { value: `${pad(applyMeridiem(hour, meridiem(text)))}:${minute}`, from: text.trim() };
    }
    let changed = false, problem = null;
    for (const k of FIELD_ORDER) {
      const x = r[k];
      if (!x) continue;
      if (k === "date" && x.past) { problem = t.past; state.rejected.date = "date already passed"; out.trace.push({ field: k, value: "(past date, rejected)", from: x.from }); continue; }
      if (k === "time" && x.ambiguous) { state.ambiguousTime = x.ambiguous; state.fields.time = null; out.trace.push({ field: k, value: "(AM or PM?)", from: x.from }); continue; }
      if (k === "party" && (x.value < 1 || x.value > MAX_PARTY)) { problem = t.bigParty; state.rejected.party = `over ${MAX_PARTY} people`; out.trace.push({ field: k, value: `${x.value} (out of range)`, from: x.from }); continue; }
      if (k === "time") state.ambiguousTime = null;
      delete state.rejected[k];
      if (state.fields[k] !== x.value) changed = true;
      state.fields[k] = x.value;
      out.trace.push({ field: k, value: x.value, from: x.from });
    }
    if (changed) state.awaitingConfirm = false;
    const f = state.fields;
    if (f.date && f.time && new Date(`${f.date}T${f.time}:00`) <= now) { problem = problem || t.pastTime; f.time = null; state.rejected.time = "time already passed"; }

    if (asksContact(text)) say(t.contact);
    if (problem) { say(problem); return out; }
    if (state.ambiguousTime && !f.time) {
      const { hour, minute } = state.ambiguousTime;
      say(t.ampm(hour, minute)); return out;
    }
    const missing = FIELD_ORDER.filter((k) => !f[k]);
    if (missing.length === 0) {
      if (state.awaitingConfirm && !changed) { say(t.summary(f)); return out; }
      state.awaitingConfirm = true; say(t.summary(f)); return out;
    }
    if (!asksContact(text) || out.trace.length) say(t.ask(missing.map((k) => t[k])));
    return out;
  }

  // ---- comparison with an LLM-only extraction ----
  function llmMessages(userTurns, now) {
    const system = [
      "You extract restaurant booking details from a conversation.",
      `Today is ${ymd(now)} (${EN_WD[now.getDay()]}). Current time is ${pad(now.getHours())}:${pad(now.getMinutes())}.`,
      'Reply with JSON only: {"party_size": integer or null, "date": "YYYY-MM-DD" or null, "time": "HH:MM" (24h) or null, "name": string or null}.',
      "Use null for anything the guest has not stated.",
    ].join("\n");
    return [{ role: "system", content: system }, { role: "user", content: userTurns.map((u, i) => `Guest message ${i + 1}: ${u}`).join("\n") }];
  }

  function compare(llm, state) {
    const map = { party: "party_size", date: "date", time: "time", name: "name" };
    return FIELD_ORDER.map((k) => {
      let v = llm ? llm[map[k]] : null;
      if (v === "" || v === undefined) v = null;
      if (k === "party" && v !== null) v = Number(v);
      const rule = state.fields[k];
      let verdict;
      if (v === null) verdict = rule === null ? "agree: not given" : "missed";
      else if (rule !== null && String(rule) === String(v)) verdict = "matches rules";
      else if (k === "time" && rule === null && state.ambiguousTime) verdict = "assumed AM/PM";
      else if (rule === null && state.rejected && state.rejected[k]) verdict = `accepted a rejected value (${state.rejected[k]})`;
      else if (rule === null) verdict = "invented";
      else verdict = "differs from rules";
      return { field: k, llm: v, rules: rule, verdict };
    });
  }

  root.BookingAgent = { initialState, step, resolveAll, llmMessages, compare, fmtDate, fmtTime };
})(typeof window !== "undefined" ? window : globalThis);
