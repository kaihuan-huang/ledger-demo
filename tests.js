(function (root) {
  "use strict";
  const L = root.LedgerDemo;

  function fixedClock() {
    let n = 0;
    return () => new Date(Date.UTC(2026, 8, 25, 1, 0) + 60000 * n++).toISOString();
  }

  // A short synthetic shift: two paid bills (one partly refunded), one voided bill, plus attempts that must be refused.
  async function sampleShift(ledger) {
    const log = [];
    const run = async (label, p) => { const r = await p; log.push({ label, ...r }); return r; };
    await run("Open bill B-1 at table T3", ledger.openBill("B-1", "T3", "cashier:amy"));
    await run("B-1 round 1: 2 beef sets, 2 teas", ledger.addRound("B-1", [{ sku: "beef", qty: 2 }, { sku: "tea", qty: 2 }], "cashier:amy"));
    await run("Tea price goes up to $4.50", ledger.changePrice("tea", 450, "manager:raj"));
    await run("B-1 round 2: 1 noodles, 1 tea (new price)", ledger.addRound("B-1", [{ sku: "noodles", qty: 1 }, { sku: "tea", qty: 1 }], "cashier:amy"));
    await run("Pay B-1 by card, $12 tip", ledger.settle("B-1", { method: "card", tipCents: 1200, key: "till-7-0001" }, "cashier:amy"));
    await run("Same payment sent again (double tap)", ledger.settle("B-1", { method: "card", tipCents: 1200, key: "till-7-0001" }, "cashier:amy"));
    await run("Try to refund $200 on P-1", ledger.refund("P-1", { amountCents: 20000, reason: "cold food", approvedBy: "manager:raj" }, "cashier:amy"));
    await run("Refund $9.00 on P-1 (noodles were cold)", ledger.refund("P-1", { amountCents: 900, reason: "noodles were cold", approvedBy: "manager:raj" }, "cashier:amy"));
    await run("Open bill B-2 at table T5", ledger.openBill("B-2", "T5", "cashier:amy"));
    await run("B-2 round 1: 1 vegetable platter", ledger.addRound("B-2", [{ sku: "veg", qty: 1 }], "cashier:amy"));
    await run("Void B-2 without a reason", ledger.voidBill("B-2", "", "manager:raj"));
    await run("Void B-2: guest left before food arrived", ledger.voidBill("B-2", "guest left before food arrived", "manager:raj"));
    await run("Try to settle voided B-2", ledger.settle("B-2", { method: "cash" }, "cashier:amy"));
    await run("Open bill B-3 at table T1", ledger.openBill("B-3", "T1", "cashier:amy"));
    await run("B-3 round 1: 1 beef set, 1 noodles", ledger.addRound("B-3", [{ sku: "beef", qty: 1 }, { sku: "noodles", qty: 1 }], "cashier:amy"));
    await run("Pay B-3 in cash, $5 tip", ledger.settle("B-3", { method: "cash", tipCents: 500, key: "till-7-0002" }, "cashier:amy"));
    return log;
  }

  const TESTS = [
    ["an empty bill can't be settled", async (l) => { await l.openBill("B", "T1", "a"); const r = await l.settle("B", { method: "card" }, "a"); return !r.ok; }],
    ["the charge equals the bill total, tip recorded separately", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "beef", qty: 1 }, { sku: "tea", qty: 2 }], "a");
      const r = await l.settle("B", { method: "card", tipCents: 300 }, "a");
      return r.ok && r.event.data.amountCents === 3600 && r.event.data.tipCents === 300;
    }],
    ["a repeated payment with the same key charges once", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a");
      await l.settle("B", { method: "card", key: "k1" }, "a"); const again = await l.settle("B", { method: "card", key: "k1" }, "a");
      return again.ok && again.replay && l.events.filter((e) => e.type === "bill_settled").length === 1;
    }],
    ["the same key with a different payment is refused", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a");
      await l.settle("B", { method: "card", key: "k1" }, "a"); const r = await l.settle("B", { method: "card", tipCents: 500, key: "k1" }, "a");
      return !r.ok;
    }],
    ["a voided bill can't be settled", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a"); await l.voidBill("B", "test", "m");
      return !(await l.settle("B", { method: "cash" }, "a")).ok;
    }],
    ["a void needs a reason", async (l) => { await l.openBill("B", "T1", "a"); return !(await l.voidBill("B", "  ", "m")).ok; }],
    ["a paid bill is refunded, not voided", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a"); await l.settle("B", { method: "card" }, "a");
      return !(await l.voidBill("B", "mistake", "m")).ok;
    }],
    ["a refund can't exceed what is left, tip included", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a"); await l.settle("B", { method: "card", tipCents: 100 }, "a");
      const over = await l.refund("P-1", { amountCents: 501, reason: "x", approvedBy: "m" }, "a");
      const exact = await l.refund("P-1", { amountCents: 500, reason: "x", approvedBy: "m" }, "a");
      return !over.ok && exact.ok;
    }],
    ["partial refunds add up, then a fully refunded payment refuses more", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a"); await l.settle("B", { method: "card" }, "a");
      await l.refund("P-1", { amountCents: 150, reason: "x", approvedBy: "m" }, "a"); await l.refund("P-1", { amountCents: 250, reason: "x", approvedBy: "m" }, "a");
      const more = await l.refund("P-1", { amountCents: 1, reason: "x", approvedBy: "m" }, "a");
      return !more.ok && l.state().payments["P-1"].status === "refunded";
    }],
    ["a refund needs a reason and an approver", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a"); await l.settle("B", { method: "card" }, "a");
      return !(await l.refund("P-1", { amountCents: 100, reason: "", approvedBy: "m" }, "a")).ok && !(await l.refund("P-1", { amountCents: 100, reason: "x" }, "a")).ok;
    }],
    ["a price change doesn't reprice items already ordered", async (l) => {
      await l.openBill("B", "T1", "a"); await l.addRound("B", [{ sku: "tea", qty: 1 }], "a"); await l.changePrice("tea", 999, "m");
      return l.state().bills.B.totalCents === 400;
    }],
    ["balances and invariants hold after the sample shift", async (l) => {
      await sampleShift(l);
      const t = l.state().totals;
      // B-1: 2x2800 + 2x400 + 900 + 450 (tea after the price change) = 7750; B-3: 2800 + 900 = 3700.
      return t.sales === 7750 + 3700 && t.tips === 1700 && t.refunds === 900 && t.cashDrawer === 4200 && L.invariants(l.events).every((x) => x.ok);
    }],
    ["an untouched chain verifies", async (l) => { await sampleShift(l); l.anchor(); return (await L.verify(l.events, l.anchors)).ok; }],
    ["editing an amount in place is caught at that event", async (l) => {
      await sampleShift(l);
      const seq = l.events.find((e) => e.type === "payment_refunded").seq;
      const v = await L.verify(L.editInPlace(l.events, seq, (d) => { d.amountCents = 100; }));
      return !v.ok && v.at === seq;
    }],
    ["deleting an event is caught", async (l) => {
      await sampleShift(l);
      const seq = l.events.find((e) => e.type === "bill_voided").seq;
      const v = await L.verify(L.deleteEvent(l.events, seq));
      return !v.ok && v.at === seq;
    }],
    ["rewriting and re-hashing passes alone but fails against an anchor", async (l) => {
      await sampleShift(l); l.anchor();
      const seq = l.events.find((e) => e.type === "payment_refunded").seq;
      const forged = await L.rewriteAndRehash(l.events, seq, (d) => { d.amountCents = 100; });
      return (await L.verify(forged)).ok && !(await L.verify(forged, l.anchors)).ok;
    }],
  ];

  async function run() {
    const out = [];
    for (const [name, fn] of TESTS) {
      let pass = false, error = null;
      try { pass = await fn(new L.Ledger(fixedClock())); } catch (e) { error = String(e); }
      out.push({ name, pass, error });
    }
    return out;
  }

  root.LedgerTests = { run, sampleShift, fixedClock };
})(typeof window !== "undefined" ? window : globalThis);
