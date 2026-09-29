/* Nalu demo agent: bilingual guest assistant. Rules classify the intent and read every field; the
   booking gate is a bare "yes"; every tool is an HTTP request into the POS (read-only) or the
   Reservation API. Refunds are proposals until a manager approves them on the terminal.
   In production the model is qwen2.5:7b served by Ollama on the restaurant's own GPU box; here it is
   off unless you connect a local Ollama. When it is on, it gets one call per turn to classify the intent
   and fill fields the rules missed, and every value it returns is re-validated before it is used
   (the 230ce19 rule: the model proposes, the code decides). All data is synthetic. */
(function (root) {
  "use strict";
  const B = root.BookingAgent, { money } = root.POS;
  const CJK = /[一-鿿]/;
  const MANAGER_OVER_CENTS = 5000;
  const RESTAURANT_PHONE = "(415) 555-0142";

  // Intent names mirror app/agent/intents.py; refund_request and guest_request are the demo's additions.
  function classify(text, mid, now) {
    const t = text.toLowerCase();
    const has = (...xs) => xs.some((x) => t.includes(x));
    const r = now ? B.resolveAll(text, now) : {};
    const details = ["party", "date", "time"].filter((k) => r[k]).length;
    if (has("cancel my reservation", "cancel my booking", "reschedule", "change my reservation", "change my booking", "取消预订", "改期", "改时间")) return "reservation_action_unsupported";
    if (has("refund", "money back", "charge me back", "退款", "退钱")) return "refund_request";
    if (has("call a server", "call the server", "call a waiter", "someone come", "need a server", "服务员", "叫人")) return "guest_request:call";
    if (has("bring the bill", "check please", "the check", "买单", "结账")) return "guest_request:cash";
    if (has("book ", "book a", "reserve", "reservation", "table for", "预订", "订位", "订桌", "订一") || details >= 2) return "reservation_create";
    if (has("what times", "available times", "any tables", "openings", "有位", "有空位", "几点有位")) return "availability_question";
    if (has("hours", "open until", "when do you close", "when do you open", "营业时间", "几点关门", "几点开门")) return "hours_question";
    if (has("my bill", "how much do i owe", "bill so far", "账单", "我的账", "多少钱了")) return "bill_request";
    if (has("price", "how much", "cost", "多少钱", "价格")) return "pricing_question";
    if (has("menu", "dish", "food", "what do you have", "菜单", "有什么菜", "吃什么")) return "menu_question";
    if (mid) return "reservation_create";
    return "general";
  }

  const T = {
    en: {
      unsupported: `I can't change or cancel a booking from this chat. Use the link in your confirmation text, or call ${RESTAURANT_PHONE}.`,
      hours: "We're open 5:00 PM to 10:00 PM daily. Last seating is 9:00 PM.",
      menu: (items) => `Tonight's menu: ${items.map((i) => `${i.name} ${money(i.price_cents)}`).join(", ")}.`,
      avail: (d, times) => times.length ? `Open times on ${d}: ${times.join(", ")}.` : `Nothing left on ${d}. Try another day?`,
      noTable: "I can't see a bill for you. Scan the QR code on your table first.",
      bill: (o) => `Your bill so far is ${money(o.total_cents)} (${o.lines.map((l) => `${l.quantity}× ${l.name}`).join(", ")}).`,
      reqSent: (k) => k === "call" ? "A server is on the way." : "Asked for your bill; a server will bring it.",
      reqDup: "That request is already with the floor staff.",
      needBill: "I can only request a refund on a bill that has been paid. I don't see one for your table.",
      whichRefund: (o) => `Which item, or how much? Your paid bill has ${o.lines.map((l) => `${l.name} (${money(l.price_cents)})`).join(", ")}.`,
      proposed: (c) => `I've sent a refund request for ${money(c)} to a manager. Nothing has been refunded until they approve it.`,
      blocked: (why) => `I can't request that: ${why}.`,
      general: "I can help with the menu, opening hours, your bill, calling a server, or booking a table.",
      approved: (c) => `A manager approved the refund of ${money(c)}. It's back on your card or in cash at the till.`,
      rejected: (why) => `A manager declined the refund request${why ? `: ${why}` : ""}.`,
      slotFull: (t, times) => `${t} is full. Open times: ${times.join(", ")}. Which one?`,
    },
    zh: {
      unsupported: `这个对话里无法修改或取消预订。请用确认短信里的链接，或致电 ${RESTAURANT_PHONE}。`,
      hours: "每天 17:00 至 22:00 营业，最后入座 21:00。",
      menu: (items) => `今晚菜单：${items.map((i) => `${i.name} ${money(i.price_cents)}`).join("、")}。`,
      avail: (d, times) => times.length ? `${d} 还有空位：${times.join("、")}。` : `${d} 已经订满了，换一天？`,
      noTable: "我看不到您的账单，请先扫桌上的二维码。",
      bill: (o) => `您目前的账单是 ${money(o.total_cents)}（${o.lines.map((l) => `${l.name}×${l.quantity}`).join("、")}）。`,
      reqSent: (k) => k === "call" ? "服务员马上过来。" : "已请服务员送账单。",
      reqDup: "这个请求已经在处理中了。",
      needBill: "只能对已付款的账单申请退款，我没有看到您桌上的已付账单。",
      whichRefund: (o) => `请问退哪一项或多少钱？已付账单有：${o.lines.map((l) => `${l.name}（${money(l.price_cents)}）`).join("、")}。`,
      proposed: (c) => `已把 ${money(c)} 的退款申请发给经理。经理批准前不会退款。`,
      blocked: (why) => `无法申请：${why}。`,
      general: "我可以帮您看菜单、营业时间、账单、叫服务员或订位。",
      approved: (c) => `经理已批准退款 ${money(c)}。`,
      rejected: (why) => `经理没有批准这笔退款${why ? `：${why}` : ""}。`,
      slotFull: (t, times) => `${t} 已满。还有：${times.join("、")}。选哪个？`,
    },
  };

  function resolveAmount(text, bill) {
    const m = /\$?\s*(\d+(?:\.\d{1,2})?)\s*(dollars|块|元|美元)?/.exec(text);
    if (m && (m[0].includes("$") || m[2])) return { cents: Math.round(parseFloat(m[1]) * 100), from: m[0].trim() };
    const ZH = { beef: "牛", lamb: "羊", vegetable: "菜", noodles: "面", tea: "茶", soda: "汽水" };
    for (const l of bill.lines) {
      const words = l.name.toLowerCase().split(/[\s-]+/).filter((w) => w.length >= 3);
      const hit = words.find((w) => text.toLowerCase().includes(w.replace(/s$/, ""))) || words.find((w) => ZH[w] && text.includes(ZH[w]));
      if (hit) return { cents: l.price_cents, from: l.name, line: l };
    }
    return null;
  }

  const INTENTS = ["menu_question", "pricing_question", "availability_question", "hours_question", "bill_request", "reservation_create", "reservation_action_unsupported", "refund_request", "guest_request:call", "guest_request:cash", "general"];
  function extractionMessages(userTurns, now) {
    const pad = (n) => String(n).padStart(2, "0");
    const system = [
      "You read messages from a restaurant guest. Reply with JSON only, no prose.",
      `Today is ${now.toISOString().slice(0, 10)}; the current time is ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}.`,
      `{"intent": one of ${JSON.stringify(INTENTS)}, "party_size": integer or null, "date": "YYYY-MM-DD" or null, "time": "HH:MM" 24h or null, "name": string or null}`,
      "Use null for anything the guest has not stated. Never guess.",
    ].join("\n");
    return [{ role: "system", content: system }, { role: "user", content: userTurns.map((u, i) => `Guest message ${i + 1}: ${u}`).join("\n") }];
  }
  // Talks to a local Ollama. Bounded like production: one call per turn, ~150 output tokens, 10 s, invalid JSON = no result.
  class LocalModel {
    constructor(endpoint, model) { this.endpoint = (endpoint || "http://localhost:11434").replace(/\/$/, ""); this.model = model || "qwen2.5:7b"; this.calls = 0; this.failures = 0; this.lastMs = null; }
    async extract(userTurns, now) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000), t0 = Date.now();
      this.calls += 1;
      try {
        const res = await fetch(`${this.endpoint}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
          body: JSON.stringify({ model: this.model, messages: extractionMessages(userTurns, now), stream: false, format: "json", options: { temperature: 0, num_predict: 160 } }) });
        if (!res.ok) throw new Error(`Ollama answered ${res.status}`);
        const data = await res.json();
        this.lastMs = Date.now() - t0;
        try { return { ok: true, ms: this.lastMs, value: JSON.parse(data.message.content) }; } catch (e) { this.failures += 1; return { ok: false, ms: this.lastMs, error: "invalid JSON" }; }
      } catch (e) { this.failures += 1; this.lastMs = Date.now() - t0; return { ok: false, ms: this.lastMs, error: e.name === "AbortError" ? "timed out after 10 s" : e.message }; }
      finally { clearTimeout(timer); }
    }
  }
  // Re-validation of model output. A value is used only if the rules found nothing for that field and it survives these checks.
  function revalidate(llm, text, ruleFields, now) {
    const out = { accepted: {}, rejected: {} };
    if (!llm || typeof llm !== "object") return out;
    const today = now.toISOString().slice(0, 10);
    const cand = { party: llm.party_size, date: llm.date, time: llm.time, name: llm.name };
    for (const k of Object.keys(cand)) {
      let v = cand[k];
      if (v === null || v === undefined || v === "") continue;
      if (ruleFields[k] != null) { out.rejected[k] = "rules already had a value"; continue; }
      let why = null;
      if (k === "party") { v = Number(v); if (!Number.isInteger(v) || v < 1 || v > 20) why = "not 1–20"; }
      else if (k === "date") { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) why = "not YYYY-MM-DD"; else if (String(v) < today) why = "in the past"; }
      else if (k === "time") {
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v))) why = "not HH:MM";
        else {
          const h24 = parseInt(String(v).split(":")[0], 10), h12 = ((h24 + 11) % 12) + 1;
          const zh = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];
          const nums = (text.match(/\d+/g) || []).map(Number);
          const said = nums.includes(h24) || nums.includes(h12) || text.includes(zh[h12] + "点") || text.includes(zh[h24] + "点") || (h12 === 12 && /noon|中午/i.test(text));
          if (!said) why = `hour ${h24} is not in the guest's words`;
        }
      }
      else if (k === "name") { const n = String(v).trim(); if (n.length < 1 || n.length > 40) why = "bad length"; else if (!text.toLowerCase().includes(n.toLowerCase())) why = "not in the guest's words"; else if (/^(i|me|table|tomorrow|today|tonight|yes|no)$/i.test(n)) why = "not a name"; else v = n; }
      if (why) out.rejected[k] = `${JSON.stringify(cand[k])}: ${why}`; else out.accepted[k] = v;
    }
    return out;
  }

  class Nalu {
    constructor({ pos, reservations, guest }) {
      this.pos = pos; this.res = reservations; this.guest = guest;
      this.booking = B.initialState(); this.idemSeq = 0; this.idemKey = null; this.lastBooking = null;
      this.proposals = []; this.turns = [];
      this.model = null; this.modelCalls = 0;
    }
    connectModel(model) { this.model = model; }

    // The model-assisted turn: one bounded call, then the same deterministic path with the model's
    // output used only where the rules found nothing and the value re-validates.
    async handleAsync(text, extract) {
      const fn = extract || (this.model ? (turns, now) => this.model.extract(turns, now) : null);
      if (!fn) return this.handle(text);
      const userTurns = this.turns.filter((t) => t.text != null).slice(-2).map((t) => t.text).concat([text]);
      this.modelCalls += 1;
      const r = await fn(userTurns, this.now());
      const hint = { raw: r.ok ? r.value : null, ms: r.ms, error: r.ok ? null : r.error, intentUsed: false, accepted: {}, rejected: {}, verdicts: [] };
      const out = this.handle(text, hint);
      out.model = hint;
      this.turns[this.turns.length - 1].model = hint;
      return out;
    }
    now() { return new Date(this.pos.now()); }
    call(service, method, path, body, headers) { return service.request(method, path, body, "nalu", headers); }

    handle(text, hint) {
      const lang = CJK.test(text) ? "zh" : "en", t = T[lang];
      const mid = this.booking.awaitingConfirm || Object.values(this.booking.fields).some(Boolean);
      let intent = classify(text, false, this.now());
      // A keyword match wins. Where the rules only fall back (mid-booking, or nothing matched), the model's intent may fill in.
      if (intent === "general") {
        // Mid-booking, a short message ("yes", "ok", "8pm", "确认") is part of the booking whatever the model thinks; the gate is not the model's to reopen.
        const short = CJK.test(text) ? text.replace(/[\s，。！？,.!?]/g, "").length < 4 : text.trim().split(/\s+/).length < 3;
        const carries = mid && Object.values(B.resolveAll(text, this.now())).some(Boolean);
        const modelIntent = hint && hint.raw && INTENTS.includes(hint.raw.intent) && hint.raw.intent !== "general" ? hint.raw.intent : null;
        if (modelIntent && !(mid && (short || carries || modelIntent === "reservation_create"))) { intent = modelIntent; hint.intentUsed = true; }
        else if (mid) intent = "reservation_create";
      }
      if (hint) this._hint = hint;
      const out = { intent, lang, reply: "", tools: [], fields: null };
      const g = this.guest();
      const say = (s) => { out.reply = out.reply ? `${out.reply} ${s}` : s; };
      const tool = (name, service, method, path, body, headers) => { const e = this.call(service, method, path, body, headers); out.tools.push({ name, entry: e }); return e; };

      if (intent === "reservation_action_unsupported") say(t.unsupported);
      else if (intent === "hours_question") say(t.hours);
      else if (intent === "menu_question" || intent === "pricing_question") { const e = tool("get_menu", this.pos, "GET", "/menu-items"); say(t.menu(e.response.items)); }
      else if (intent === "availability_question") {
        const d = B.resolveAll(text, this.now()).date, date = d && !d.past ? d.value : this.pos.now().slice(0, 10);
        const e = tool("get_slots", this.res, "GET", `/api/v1/reservations/slots?date=${date}`);
        say(t.avail(date, e.response.open_times));
      } else if (intent === "bill_request") {
        if (!g || !g.order_id) say(t.noTable);
        else { const e = tool("get_bill", this.pos, "GET", `/orders/${g.order_id}`); say(t.bill(e.response)); }
      } else if (intent.startsWith("guest_request")) {
        const kind = intent.split(":")[1];
        if (!g || !g.session_id) say(t.noTable);
        else { const e = tool("raise_guest_request", this.pos, "POST", "/customer/guest-requests", { table_session_id: g.session_id, request_type: kind }); say(e.status === 201 ? t.reqSent(kind) : e.status === 200 ? t.reqDup : t.noTable); }
      } else if (intent === "refund_request") this.refund(text, g, t, out, tool, say);
      else if (intent === "reservation_create") this.book(text, g, t, lang, out, tool, say);
      else say(t.general);
      this._hint = null;
      this.turns.push({ text, ...out });
      return out;
    }

    book(text, g, t, lang, out, tool, say) {
      let r = B.step(this.booking, text, this.now());
      out.fields = r.trace;
      const hint = this._hint;
      if (hint && hint.raw && !r.toolCalls.length) {
        hint.verdicts = B.compare(hint.raw, r.state);
        const v = revalidate(hint.raw, text, r.state.fields, this.now());
        Object.assign(hint, { accepted: v.accepted, rejected: v.rejected });
        if (Object.keys(v.accepted).length) {
          const st = JSON.parse(JSON.stringify(r.state));
          for (const [k, val] of Object.entries(v.accepted)) { st.fields[k] = val; out.fields.push({ field: k, value: val, from: "local model, re-validated" }); }
          st.awaitingConfirm = false;
          r = { ...B.step(st, "", this.now()), trace: out.fields };
        }
      }
      const changed = JSON.stringify(r.state.fields) !== JSON.stringify(this.booking.fields);
      if (changed || !this.idemKey) this.idemKey = `nalu-${g && g.session_id ? g.session_id : "web"}-${++this.idemSeq}`;
      this.booking = r.state;
      const create = r.toolCalls.find((c) => c.name === "create_reservation");
      if (!create) { say(r.reply); return; }
      const a = create.args;
      const body = { guest_name: a.name, guest_phone: g && g.phone ? g.phone : "", party_size: a.party_size, reservation_date: a.date, reservation_time: a.time, source: "nalu", utm_source: g && g.utm ? g.utm.source : null, utm_campaign: g && g.utm ? g.utm.campaign : null, gclid: g && g.utm ? g.utm.gclid : null };
      const e = tool("create_reservation", this.res, "POST", "/api/v1/reservations", body, { "Idempotency-Key": this.idemKey });
      if (e.status === 201 || e.status === 200) { this.lastBooking = { body, key: this.idemKey, code: e.response.code }; say(r.reply.replace(/R-\d+/, e.response.code)); return; }
      // Refused by the service: put the fields back so the guest can change one, and say why.
      this.booking.fields = { party: a.party_size, date: a.date, time: a.time, name: a.name }; this.booking.awaitingConfirm = false;
      if (e.response.code === "SLOT_FULL") { const s = tool("get_slots", this.res, "GET", `/api/v1/reservations/slots?date=${a.date}`); this.booking.fields.time = null; say(t.slotFull(B.fmtTime(a.time, lang), s.response.open_times)); }
      else say(e.response.detail);
    }

    refund(text, g, t, out, tool, say) {
      if (!g || !g.paid_order_id) { say(t.needBill); return; }
      const bill = tool("get_bill", this.pos, "GET", `/orders/${g.paid_order_id}`).response;
      const p = bill.payments.find((x) => ["captured", "partial_refund"].includes(x.status));
      const remaining = p ? p.amount_cents + p.tip_cents - p.refunded_cents : 0;
      const amt = resolveAmount(text, bill);
      if (!amt) { say(t.whichRefund(bill)); return; }
      const proposal = { id: this.proposals.length + 1, order_id: bill.id, table_id: bill.table_id, payment_intent_id: p ? p.intent_id : null, amount_cents: amt.cents, from: amt.from, reason: text.trim().slice(0, 120), status: "queued", needsManager: amt.cents > MANAGER_OVER_CENTS, flags: [] };
      // Fixed checks, the same ones the refund endpoint will apply again; the agent never gets past them by wording.
      let why = null;
      if (!p) why = "there is no captured payment on that bill";
      else if (!Number.isInteger(amt.cents) || amt.cents <= 0) why = "the amount must be a positive number of cents";
      else if (amt.cents > remaining) why = `only ${money(remaining)} is still refundable on that bill`;
      if (amt.line && amt.cents === amt.line.price_cents && bill.lines.length > 1) proposal.flags.push("refunds a whole line; check the tax and tip are not owed too");
      if (why) { proposal.status = "blocked"; proposal.blocked_reason = why; this.proposals.push(proposal); say(t.blocked(why)); return; }
      this.proposals.push(proposal);
      say(t.proposed(amt.cents));
    }

    // Manager side, from the terminal. Approval is what moves money; it goes through the same refund endpoint.
    approve(id, approver) {
      const p = this.proposals.find((x) => x.id === id);
      if (!p || p.status !== "queued") return null;
      if (p.needsManager && !approver.startsWith("manager:")) return { blocked: `refunds over ${money(MANAGER_OVER_CENTS)} need a manager` };
      const e = this.pos.request("POST", `/payments/${p.payment_intent_id}/refund`, { amount_cents: p.amount_cents, reason: `guest via Nalu: ${p.reason}`, approved_by: approver }, approver);
      p.status = e.status === 200 ? "refunded" : "failed"; p.result = e.response;
      const lang = CJK.test(p.reason) ? "zh" : "en";
      this.turns.push({ text: null, intent: "notice", lang, reply: e.status === 200 ? T[lang].approved(p.amount_cents) : T[lang].rejected(e.response.detail), tools: [{ name: "refund_payment", entry: e }] });
      return e;
    }
    reject(id, approver, why) {
      const p = this.proposals.find((x) => x.id === id);
      if (!p || p.status !== "queued") return null;
      p.status = "rejected"; p.rejected_by = approver;
      const lang = CJK.test(p.reason) ? "zh" : "en";
      this.turns.push({ text: null, intent: "notice", lang, reply: T[lang].rejected(why), tools: [] });
      return p;
    }
    retryLastBooking() {
      if (!this.lastBooking) return null;
      const e = this.call(this.res, "POST", "/api/v1/reservations", this.lastBooking.body, { "Idempotency-Key": this.lastBooking.key });
      this.turns.push({ text: null, intent: "retry", lang: "en", reply: e.status === 200 && e.response.replayed ? `The phone retried the same request with the same Idempotency-Key: the API replayed ${e.response.code} and wrote nothing.` : `Retry answered ${e.status}.`, tools: [{ name: "create_reservation (retry)", entry: e }] });
      return e;
    }
  }
  root.NALU = { Nalu, LocalModel, classify, revalidate, extractionMessages, INTENTS, MANAGER_OVER_CENTS, RESTAURANT_PHONE };
})(typeof globalThis !== "undefined" ? globalThis : this);
