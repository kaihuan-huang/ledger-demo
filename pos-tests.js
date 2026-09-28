/* Browser and Node tests for the POS demo engine. Every test builds its own fresh POS. */
(function (root) {
  "use strict";
  const { Pos, money } = root.POS;
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
  const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

  // A seated table with round 1 sent, then a price change and round 2. Returns the pos and ids.
  function meal() {
    const pos = new Pos();
    pos.request("POST", "/tables/3/seat", { party_size: 3 });
    const o = pos.request("POST", "/orders", { table_id: 3, items: [{ instance_id: "beef", qty: 2 }, { instance_id: "veg", qty: 1 }, { instance_id: "tea", qty: 3 }] }).response;
    pos.request("POST", `/orders/${o.id}/submit`);
    pos.request("PATCH", "/menu-items/beef/price", { price_cents: 3200 }, "manager:raj");
    pos.request("PATCH", `/orders/${o.id}/items`, { items: [{ instance_id: "beef", qty: 1 }, { instance_id: "noodles", qty: 1, notes: "less salt" }] });
    pos.request("POST", `/orders/${o.id}/submit`);
    return { pos, orderId: o.id };
  }
  function settled(tip) {
    const m = meal();
    const intent = m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "cash", tip_cents: tip == null ? 1000 : tip }).response;
    const settle = m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: intent.payment_intent_id, amount_tendered_cents: 15000 });
    return { ...m, intent, settle };
  }
  const bill = (m) => m.pos.bill(m.orderId);
  const rowsWritten = (entry) => entry.writes.length;

  const tests = [
    ["Round 1 keeps the price the cashier saw; round 2 gets the new price", () => {
      const m = meal(), b = bill(m);
      const beef = b.lines.filter((l) => l.menu_item_instance_id === "beef");
      eq(beef[0].price_cents, 2800, "round 1 beef"); eq(beef[1].price_cents, 3200, "round 2 beef");
      eq(b.total_cents, 2 * 2800 + 1400 + 3 * 400 + 3200 + 900 + 476 + 119 + 102 + 272 + 77, "total from snapshots");
    }],
    ["Submit sends only the unsent lines; tickets are numbered bill-round", () => {
      const m = meal(), b = bill(m);
      eq(b.tickets.length, 2, "two rounds"); eq(b.tickets[0].ticket_number, "1-1", "round 1"); eq(b.tickets[1].ticket_number, "1-2", "round 2");
      eq(b.tickets[1].items.length, 2, "round 2 carries only the new lines");
      eq(m.pos.request("POST", `/orders/${m.orderId}/submit`).status, 422, "nothing left to send");
    }],
    ["A line already with the kitchen cannot be edited away", () => {
      const m = meal(), sent = bill(m).lines[0];
      const r = m.pos.request("DELETE", `/orders/${m.orderId}/items/${sent.id}`);
      eq(r.status, 422, "status"); eq(r.response.code, "ORDER_LOCKED", "code"); eq(rowsWritten(r), 0, "nothing written");
    }],
    ["Settle lands capture, close, table and drawer in one commit", () => {
      const m = settled(), s = m.pos.settlementState(m.orderId);
      assert(s.captured && s.closed && s.freed && s.drawer, "all four landed");
      eq(m.settle.status, 200, "status"); eq(m.settle.response.change_due, 15000 - (bill(m).total_cents + 1000), "change");
      const models = m.settle.models.slice().sort().join(",");
      eq(models, "ActivityLog,CashDrawerLog,Event,Order,Payment,Table,TableSession", "one request touches all seven models");
      eq(m.settle.ws.length, 1, "one WebSocket broadcast to the cashier room");
    }],
    ["If the process dies inside settle, nothing is written", () => {
      const m = meal();
      const intent = m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "cash", tip_cents: 1000 }).response;
      m.pos.crashPoint = "after_close";
      const r = m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: intent.payment_intent_id, amount_tendered_cents: 15000 });
      assert(r.crashed, "crashed"); eq(rowsWritten(r), 0, "no rows");
      const s = m.pos.settlementState(m.orderId);
      assert(!s.captured && !s.closed && !s.freed && !s.drawer && s.consistent, "state untouched and consistent");
      m.pos.crashPoint = null;
      eq(m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: intent.payment_intent_id, amount_tendered_cents: 15000 }).status, 200, "the till simply retries");
    }],
    ["The old four-call flow: dying after call 2 leaves a paid bill on a seated table", () => {
      const m = meal();
      const intent = m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "cash", tip_cents: 1000 }).response;
      m.pos.legacySettle(m.orderId, intent.payment_intent_id, 15000, 2);
      const s = m.pos.settlementState(m.orderId);
      assert(s.captured && s.closed && !s.freed && !s.drawer && !s.consistent, "inconsistent");
    }],
    ["PATCH status=closed can no longer close an unpaid bill", () => {
      const m = meal(), r = m.pos.request("PATCH", `/orders/${m.orderId}`, { status: "closed" });
      eq(r.status, 409, "refused"); eq(rowsWritten(r), 0, "nothing written");
      const b = bill(m); eq(b.status, "submitted", "still open"); eq(b.paid_total_cents, 0, "not back-filled");
      eq(m.pos.db.tables.find((t) => t.id === 3).current_order_id, m.orderId, "table still on the bill");
    }],
    ["The tip lives on the payment: an abandoned intent cannot raise the bill", () => {
      const m = meal(), before = bill(m).total_cents;
      const i1 = m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "card", tip_cents: 2000 }).response;
      m.pos.request("POST", "/payments/cancel", { payment_intent_id: i1.payment_intent_id });
      eq(bill(m).total_cents, before, "total unchanged"); eq(bill(m).service_tips_cents, 0, "no tip until capture");
      const i2 = m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "cash", tip_cents: 500 }).response;
      m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: i2.payment_intent_id, amount_tendered_cents: 20000 });
      eq(bill(m).service_tips_cents, 500, "only the captured tip counts"); eq(bill(m).total_cents, before, "total still unchanged");
    }],
    ["Settling the same bill twice answers 409", () => {
      const m = settled(), r = m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: m.intent.payment_intent_id, amount_tendered_cents: 15000 });
      eq(r.status, 409, "status"); eq(r.response.code, "ORDER_LOCKED", "code"); eq(rowsWritten(r), 0, "nothing written");
    }],
    ["A payment intent for another bill is refused and the transaction rolled back", () => {
      const m = meal();
      m.pos.request("POST", "/tables/5/seat", { party_size: 2 });
      const o2 = m.pos.request("POST", "/orders", { table_id: 5, items: [{ instance_id: "tea", qty: 1 }] }).response;
      const i2 = m.pos.request("POST", "/payments/intent", { order_id: o2.id, payment_method: "cash", tip_cents: 0 }).response;
      const r = m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: i2.payment_intent_id, amount_tendered_cents: 15000 });
      eq(r.status, 422, "status"); eq(rowsWritten(r), 0, "nothing written");
      eq(m.pos.db.payments.find((p) => p.intent_id === i2.payment_intent_id).status, "intent_created", "capture rolled back");
      eq(m.pos.drawer(), 0, "drawer untouched");
    }],
    ["A refund cannot exceed what is left, tip included", () => {
      const m = settled(), charged = bill(m).total_cents + 1000;
      const r = m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: charged + 1, reason: "test", approved_by: "manager:raj" }, "manager:raj");
      eq(r.status, 422, "status"); eq(rowsWritten(r), 0, "nothing written");
      eq(m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: charged, reason: "walked out", approved_by: "manager:raj" }, "manager:raj").status, 200, "exactly what is left is fine");
      eq(m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: 1, reason: "again", approved_by: "manager:raj" }, "manager:raj").status, 409, "already fully refunded");
    }],
    ["A refund records a reason and an approver, and a cash refund moves the drawer", () => {
      const m = settled();
      eq(m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: 900 }).status, 422, "needs a reason");
      const before = m.pos.drawer();
      const r = m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: 900, reason: "noodles arrived cold", approved_by: "manager:raj" }, "manager:raj");
      eq(r.status, 200, "ok"); eq(r.response.status, "partial_refund", "partial");
      eq(m.pos.drawer(), before - 900, "drawer down by the refund");
      const a = m.pos.db.activity_logs.find((x) => x.activity_type === "Refund");
      assert(a && a.notes.includes("noodles arrived cold") && a.notes.includes("manager:raj"), "audit row has reason and approver");
      eq(bill(m).refund_status, "partial", "order refund status");
    }],
    ["A full refund drops the tip off the bill", () => {
      const m = settled(), charged = bill(m).total_cents + 1000;
      m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: charged, reason: "comped by owner", approved_by: "owner:kai" }, "manager:raj");
      const b = bill(m); eq(b.service_tips_cents, 0, "tip gone"); eq(b.payment_status, "refunded", "status"); eq(b.refund_status, "full", "full");
    }],
    ["A void needs a reason, records who, and cancels every round", () => {
      const m = meal();
      eq(m.pos.request("PATCH", `/orders/${m.orderId}`, { is_voided: true }, "manager:raj").status, 422, "reason required");
      const r = m.pos.request("PATCH", `/orders/${m.orderId}`, { is_voided: true, void_reason: "guest left before food" }, "manager:raj");
      eq(r.status, 200, "ok");
      const b = bill(m); eq(b.voided_by, "manager:raj", "who"); eq(b.status, "canceled", "status");
      assert(b.tickets.every((t) => t.status === "cancelled"), "both rounds cancelled, not just the first");
      eq(m.pos.db.tables.find((t) => t.id === 3).status, "available", "table freed");
    }],
    ["A voided bill cannot be settled, paid or reopened", () => {
      const m = meal();
      const intent = m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "cash", tip_cents: 0 }).response;
      m.pos.request("PATCH", `/orders/${m.orderId}`, { is_voided: true, void_reason: "duplicate bill" }, "manager:raj");
      eq(m.pos.request("POST", `/orders/${m.orderId}/settle`, { payment_intent_id: intent.payment_intent_id, amount_tendered_cents: 20000 }).status, 409, "settle refused: a void cancels the bill");
      eq(m.pos.request("POST", "/payments/intent", { order_id: m.orderId, payment_method: "cash" }).status, 409, "new intent refused");
      eq(m.pos.request("POST", `/orders/${m.orderId}/reopen`, {}).status, 409, "reopen refused: not closed");
    }],
    ["A refunded bill cannot be reopened", () => {
      const m = settled();
      m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: 400, reason: "tea not served", approved_by: "manager:raj" }, "manager:raj");
      const r = m.pos.request("POST", `/orders/${m.orderId}/reopen`, { reason: "add dessert" }, "manager:raj");
      eq(r.status, 422, "status"); eq(rowsWritten(r), 0, "nothing written");
    }],
    ["A settled bill takes no new items", () => {
      const m = settled(), r = m.pos.request("PATCH", `/orders/${m.orderId}/items`, { items: [{ instance_id: "tea", qty: 1 }] });
      eq(r.status, 422, "status"); eq(rowsWritten(r), 0, "nothing written");
    }],
    ["Guest requests: tapping twice queues once, transitions are checked, SLA is 3 minutes", () => {
      const m = meal(), ts = m.pos.db.table_sessions[0].id;
      const a = m.pos.request("POST", "/customer/guest-requests", { table_session_id: ts, request_type: "call" }, "guest");
      const b = m.pos.request("POST", "/customer/guest-requests", { table_session_id: ts, request_type: "call" }, "guest");
      eq(a.status, 201, "first"); eq(b.status, 200, "second returns the existing one"); assert(b.response.deduplicated, "flagged"); eq(m.pos.db.guest_requests.length, 1, "one row");
      eq(new Date(a.response.sla_due_at) - new Date(a.response.created_at), 3 * 60000, "SLA");
      eq(m.pos.request("PATCH", `/guest-requests/${a.response.id}`, { status: "resolved" }).status, 200, "open → resolved");
      eq(m.pos.request("PATCH", `/guest-requests/${a.response.id}`, { status: "acked" }).status, 422, "resolved is terminal");
      eq(m.pos.request("POST", "/customer/guest-requests", { table_session_id: "ts_nope", request_type: "call" }, "guest").status, 404, "unknown session");
    }],
    ["Seating an occupied table answers 409; a bill needs a seated party", () => {
      const pos = new Pos();
      eq(pos.request("POST", "/orders", { table_id: 3, items: [{ instance_id: "tea", qty: 1 }] }).status, 422, "no session");
      pos.request("POST", "/tables/3/seat", { party_size: 2 });
      const r = pos.request("POST", "/tables/3/seat", { party_size: 4 });
      eq(r.status, 409, "status"); eq(r.response.code, "TABLE_OCCUPIED", "code");
    }],
    ["Every rejected request writes zero rows; every invariant holds after the full shift", () => {
      const m = settled();
      m.pos.request("POST", `/payments/${m.intent.payment_intent_id}/refund`, { amount_cents: 900, reason: "cold", approved_by: "manager:raj" }, "manager:raj");
      m.pos.request("PATCH", "/tables/12/floor-status", { status: "available" });
      const rejected = m.pos.log.filter((e) => e.status >= 400);
      assert(rejected.every((e) => e.writes.length === 0), "rejected requests wrote nothing");
      const bad = m.pos.checks().filter((c) => !c.ok);
      assert(bad.length === 0, `failed invariants: ${bad.map((c) => c.name).join("; ")}`);
      assert(m.pos.checks().length >= 5, "checks ran");
    }],
  ];

  function run() {
    return tests.map(([name, fn]) => { try { fn(); return { name, pass: true }; } catch (e) { return { name, pass: false, error: e.message }; } });
  }
  root.PosTests = { run, count: tests.length };
})(typeof globalThis !== "undefined" ? globalThis : this);
