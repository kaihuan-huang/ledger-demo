(function (root) {
  "use strict";

  const GENESIS = "0".repeat(64);
  const enc = new TextEncoder();

  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
  }

  async function sha256(text) {
    const buf = await root.crypto.subtle.digest("SHA-256", enc.encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  const body = (e) => canonical({ seq: e.seq, at: e.at, type: e.type, actor: e.actor, data: e.data });
  const hashOf = (prev, e) => sha256(`${prev}\n${body(e)}`);

  const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

  const DEFAULT_MENU = {
    beef: { name: "Beef set", cents: 2800 },
    veg: { name: "Vegetable platter", cents: 1400 },
    noodles: { name: "Hand-pulled noodles", cents: 900 },
    tea: { name: "Jasmine tea", cents: 400 },
  };

  // ---- projection: every balance is rebuilt from the events, never stored separately ----
  function project(events) {
    const menu = JSON.parse(JSON.stringify(DEFAULT_MENU));
    const bills = {}, payments = {}, keys = {};
    const totals = { sales: 0, tips: 0, refunds: 0, cashDrawer: 0 };
    for (const e of events) {
      const d = e.data;
      if (e.type === "menu_price_changed") menu[d.sku].cents = d.cents;
      else if (e.type === "bill_opened") bills[d.bill] = { id: d.bill, table: d.table, rounds: [], status: "open", totalCents: 0, payment: null };
      else if (e.type === "round_added") {
        const b = bills[d.bill];
        b.rounds.push(d.items);
        b.totalCents += d.items.reduce((s, i) => s + i.qty * i.unitCents, 0);
      } else if (e.type === "bill_voided") Object.assign(bills[d.bill], { status: "voided", voidedBy: e.actor, voidReason: d.reason });
      else if (e.type === "bill_settled") {
        const b = bills[d.bill];
        b.status = "settled"; b.payment = d.payment; b.table = `${b.table} (to clean)`;
        payments[d.payment] = { id: d.payment, bill: d.bill, method: d.method, amountCents: d.amountCents, tipCents: d.tipCents, refundedCents: 0, key: d.key };
        keys[d.key] = d.payment;
        totals.sales += d.amountCents; totals.tips += d.tipCents;
        if (d.method === "cash") totals.cashDrawer += d.amountCents + d.tipCents;
      } else if (e.type === "payment_refunded") {
        const p = payments[d.payment];
        p.refundedCents += d.amountCents;
        totals.refunds += d.amountCents;
        if (p.method === "cash") totals.cashDrawer -= d.amountCents;
      }
    }
    for (const p of Object.values(payments)) {
      const charged = p.amountCents + p.tipCents;
      p.status = p.refundedCents === 0 ? "captured" : p.refundedCents >= charged ? "refunded" : "partially refunded";
    }
    totals.net = totals.sales + totals.tips - totals.refunds;
    return { menu, bills, payments, keys, totals };
  }

  function invariants(events) {
    const s = project(events), out = [];
    for (const p of Object.values(s.payments)) {
      out.push({ name: `${p.id}: refunds never exceed what was charged`, ok: p.refundedCents <= p.amountCents + p.tipCents });
      out.push({ name: `${p.id}: charge equals the bill total`, ok: s.bills[p.bill].totalCents === p.amountCents });
    }
    for (const b of Object.values(s.bills)) if (b.status === "voided") out.push({ name: `${b.id}: voided bill has a reason and no payment`, ok: Boolean(b.voidReason) && !b.payment });
    const cash = Object.values(s.payments).filter((p) => p.method === "cash").reduce((t, p) => t + p.amountCents + p.tipCents - p.refundedCents, 0);
    out.push({ name: "cash drawer equals cash taken minus cash refunded", ok: cash === s.totals.cashDrawer });
    return out;
  }

  class Ledger {
    constructor(clock) {
      this.events = [];
      this.anchors = [];
      this.clock = clock || (() => new Date().toISOString());
    }
    get head() { return this.events.length ? this.events[this.events.length - 1].hash : GENESIS; }
    state() { return project(this.events); }

    async append(type, actor, data) {
      const e = { seq: this.events.length + 1, at: this.clock(), type, actor, data, prev: this.head };
      e.hash = await hashOf(e.prev, e);
      this.events.push(e);
      return e;
    }

    anchor() {
      if (!this.events.length) return null;
      const a = { seq: this.events.length, hash: this.head };
      this.anchors.push(a);
      return a;
    }

    // ---- commands: validate against the projection, then append exactly one event or reject ----
    async openBill(bill, table, actor) {
      if (this.state().bills[bill]) return reject(`Bill ${bill} already exists`);
      return ok(await this.append("bill_opened", actor, { bill, table }));
    }

    async addRound(bill, lines, actor) {
      const s = this.state(), b = s.bills[bill];
      if (!b) return reject(`Bill ${bill} not found`);
      if (b.status !== "open") return reject(`Bill ${bill} is ${b.status}; it can't take new items`);
      const items = lines.filter((l) => l.qty > 0).map((l) => ({ sku: l.sku, name: s.menu[l.sku].name, qty: l.qty, unitCents: s.menu[l.sku].cents }));
      if (!items.length) return reject("A round needs at least one item");
      return ok(await this.append("round_added", actor, { bill, items }));
    }

    async changePrice(sku, cents, actor) {
      if (!Number.isInteger(cents) || cents <= 0) return reject("Price must be a positive number of cents");
      return ok(await this.append("menu_price_changed", actor, { sku, cents }));
    }

    async voidBill(bill, reason, actor) {
      const b = this.state().bills[bill];
      if (!b) return reject(`Bill ${bill} not found`);
      if (b.status === "settled") return reject(`Bill ${bill} is already paid; refund it instead of voiding`);
      if (b.status === "voided") return reject(`Bill ${bill} is already voided`);
      if (!reason || !reason.trim()) return reject("A void needs a reason");
      if (!actor) return reject("A void records who did it");
      return ok(await this.append("bill_voided", actor, { bill, reason: reason.trim() }));
    }

    // Settlement is one event: charge, close the bill, free the table and write the drawer land together or not at all.
    async settle(bill, { method, tipCents = 0, key }, actor) {
      const s = this.state();
      if (key && s.keys[key]) {
        const p = s.payments[s.keys[key]];
        if (p.bill === bill && p.tipCents === tipCents && p.method === method) return { ok: true, replay: true, payment: p };
        return reject(`Key ${key} was already used for a different payment`);
      }
      const b = s.bills[bill];
      if (!b) return reject(`Bill ${bill} not found`);
      if (b.status === "settled") return reject(`Bill ${bill} is already closed`);
      if (b.status === "voided") return reject(`Bill ${bill} is voided and cannot be settled`);
      if (b.totalCents <= 0) return reject(`Bill ${bill} has nothing to charge`);
      if (!Number.isInteger(tipCents) || tipCents < 0) return reject("Tip must be zero or more");
      if (!["card", "cash"].includes(method)) return reject("Pay by card or cash");
      const payment = `P-${Object.keys(s.payments).length + 1}`;
      return ok(await this.append("bill_settled", actor, { bill, payment, method, amountCents: b.totalCents, tipCents, key: key || payment }));
    }

    async refund(payment, { amountCents, reason, approvedBy }, actor) {
      const p = this.state().payments[payment];
      if (!p) return reject(`Payment ${payment} not found`);
      const charged = p.amountCents + p.tipCents;
      const remaining = charged - p.refundedCents;
      if (remaining <= 0) return reject(`Payment ${payment} is already fully refunded`);
      const amount = amountCents == null ? remaining : amountCents;
      if (!Number.isInteger(amount) || amount <= 0) return reject("Refund must be a positive amount");
      if (amount > remaining) return reject(`Refund of ${money(amount)} exceeds the ${money(remaining)} still refundable on ${payment}`);
      if (!reason || !reason.trim()) return reject("A refund needs a reason");
      if (!approvedBy) return reject("A refund needs an approver");
      return ok(await this.append("payment_refunded", actor, { payment, amountCents: amount, reason: reason.trim(), approvedBy }));
    }
  }

  const ok = (event) => ({ ok: true, event });
  const reject = (reason) => ({ ok: false, reason });

  // ---- verification ----
  async function verify(events, anchors = []) {
    let prev = GENESIS;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.seq !== i + 1) return { ok: false, at: i + 1, reason: `event ${i + 1} is missing (found #${e.seq} in its place)` };
      if (e.prev !== prev) return { ok: false, at: e.seq, reason: `event #${e.seq} doesn't point to the event before it` };
      if ((await hashOf(e.prev, e)) !== e.hash) return { ok: false, at: e.seq, reason: `event #${e.seq} was changed after it was written` };
      prev = e.hash;
    }
    for (const a of anchors) {
      const e = events[a.seq - 1];
      if (!e || e.hash !== a.hash) return { ok: false, at: a.seq, reason: `the chain no longer matches the head anchored at #${a.seq}; history was rewritten` };
    }
    return { ok: true, count: events.length, head: prev };
  }

  // ---- what an attacker with database access could do ----
  const clone = (events) => JSON.parse(JSON.stringify(events));
  function editInPlace(events, seq, mutate) { const c = clone(events); mutate(c[seq - 1].data); return c; }
  function deleteEvent(events, seq) { const c = clone(events); c.splice(seq - 1, 1); return c; }
  async function rewriteAndRehash(events, seq, mutate) {
    const c = clone(events);
    mutate(c[seq - 1].data);
    let prev = seq > 1 ? c[seq - 2].hash : GENESIS;
    for (let i = seq - 1; i < c.length; i++) { c[i].prev = prev; c[i].hash = await hashOf(prev, c[i]); prev = c[i].hash; }
    return c;
  }

  root.LedgerDemo = { Ledger, project, invariants, verify, editInPlace, deleteEvent, rewriteAndRehash, money, GENESIS };
})(typeof window !== "undefined" ? window : globalThis);
