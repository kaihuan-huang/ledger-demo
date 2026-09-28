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

  // ---- agents and neighbouring services ----
  function agentWorld() {
    const pos = new Pos(), res = new root.RESERVATIONS.Reservations(pos.bus);
    const guest = { session_id: null, order_id: null, paid_order_id: null, phone: "+14155550100", utm: { source: "google", campaign: "hotpot-sf", gclid: "g1" } };
    const nalu = new root.NALU.Nalu({ pos, reservations: res, guest: () => guest });
    return { pos, res, nalu, guest };
  }
  const RES_BODY = { guest_name: "Kai", guest_phone: "+14155550100", party_size: 4, reservation_date: "2026-09-14", reservation_time: "20:00", source: "web" };
  tests.push(
    ["Reservation API: the same Idempotency-Key replays the same booking and writes nothing; a different payload answers 409", () => {
      const { res } = agentWorld(), h = { "Idempotency-Key": "k1" };
      const a = res.request("POST", "/api/v1/reservations", RES_BODY, "guest", h);
      eq(a.status, 201, "created"); eq(a.outbound.length, 2, "Twilio and Revenue Agent called");
      const b = res.request("POST", "/api/v1/reservations", RES_BODY, "guest", h);
      eq(b.status, 200, "replayed"); assert(b.response.replayed, "flagged"); eq(b.response.code, a.response.code, "same code"); eq(rowsWritten(b), 0, "nothing written");
      const c = res.request("POST", "/api/v1/reservations", { ...RES_BODY, party_size: 5 }, "guest", h);
      eq(c.status, 409, "mismatch"); eq(c.response.code, "IDEMPOTENCY_MISMATCH", "code");
      eq(res.request("POST", "/api/v1/reservations", RES_BODY, "guest", {}).status, 422, "key required");
    }],
    ["Reservation API: a full slot answers 409, the phone is masked, and the Twilio delivery callback lands", () => {
      const { res } = agentWorld();
      const full = res.request("POST", "/api/v1/reservations", { ...RES_BODY, reservation_time: "19:30" }, "guest", { "Idempotency-Key": "k2" });
      eq(full.status, 409, "full"); eq(full.response.code, "SLOT_FULL", "code");
      const a = res.request("POST", "/api/v1/reservations", RES_BODY, "guest", { "Idempotency-Key": "k3" });
      eq(a.response.guest_phone, "+1 415···0100", "masked in the response");
      assert(JSON.stringify(res.db).indexOf("5550100") === -1, "full number never stored");
      const sid = res.db.sms_messages[0].sid;
      eq(res.request("POST", "/webhooks/twilio/status", { MessageSid: sid, MessageStatus: "delivered" }, "twilio").status, 204, "callback");
      eq(res.db.sms_messages[0].status, "delivered", "delivered");
      eq(res.request("POST", "/webhooks/twilio/status", { MessageSid: "nope", MessageStatus: "delivered" }, "twilio").status, 404, "unknown sid");
    }],
    ["Nalu books only on a bare yes: 'ok' asks again, 'don't confirm' books nothing, 'yes' creates the reservation with an Idempotency-Key", () => {
      const { nalu, res } = agentWorld();
      nalu.handle("Table for 4 tonight at 8pm, under Kai");
      eq(nalu.handle("ok").tools.length, 0, "ok is vague"); eq(res.db.reservations.length, 0, "nothing booked");
      const no = nalu.handle("don't confirm"); eq(res.db.reservations.length, 0, "still nothing"); assert(no.tools.length === 0, "no call");
      nalu.handle("Table for 4 tonight at 8pm, under Kai");
      const y = nalu.handle("yes");
      eq(y.tools.length, 1, "one tool call"); eq(y.tools[0].entry.status, 201, "created"); assert(y.tools[0].entry.headers["Idempotency-Key"], "key sent");
      assert(y.reply.includes(res.db.reservations[0].code), "reply carries the real code"); eq(res.db.reservations[0].source, "nalu", "source");
      eq(nalu.retryLastBooking().response.replayed, true, "a retry replays");
    }],
    ["Nalu in Chinese: fields resolved by rules, 好 does not book, 确认 does", () => {
      const { nalu, res } = agentWorld();
      nalu.handle("明天晚上七点三个人"); nalu.handle("我叫小王");
      eq(nalu.handle("好").tools.length, 0, "好 is vague");
      const y = nalu.handle("确认"); eq(y.tools[0].entry.status, 201, "booked");
      const r = res.db.reservations[0]; eq(r.party_size, 3, "party"); eq(r.reservation_time, "19:00", "time"); eq(r.reservation_date, "2026-09-15", "date"); eq(r.guest_name, "小王", "name");
    }],
    ["Nalu offers other times when the slot is full, and never asks for the phone the guest signed in with", () => {
      const { nalu, res } = agentWorld();
      nalu.handle("Table for 2 tonight at 7:30pm, I am Lee");
      const y = nalu.handle("yes");
      eq(y.tools[0].entry.status, 409, "full"); assert(/full/i.test(y.reply) && y.reply.includes("20:00"), "offers open times"); eq(res.db.reservations.length, 0, "nothing booked");
      nalu.handle("8pm"); eq(nalu.handle("yes").tools[0].entry.status, 201, "booked at the new time");
    }],
    ["Nalu can read the POS but its only POS writes are guest requests; a refund moves money only when a manager approves it", () => {
      const w = agentWorld(), { pos, nalu, guest } = w;
      pos.request("POST", "/tables/3/seat", { party_size: 2 });
      const o = pos.request("POST", "/orders", { table_id: 3, items: [{ instance_id: "noodles", qty: 1 }, { instance_id: "tea", qty: 2 }] }).response;
      guest.session_id = "ts_1"; guest.order_id = o.id;
      nalu.handle("What's on the menu?"); nalu.handle("How much is my bill?"); nalu.handle("call a server please");
      const i = pos.request("POST", "/payments/intent", { order_id: o.id, payment_method: "card", tip_cents: 200 }).response;
      pos.request("POST", `/orders/${o.id}/settle`, { payment_intent_id: i.payment_intent_id });
      guest.order_id = null; guest.paid_order_id = o.id;
      const r = nalu.handle("my noodles were cold, refund please");
      assert(/nothing has been refunded/i.test(r.reply), "no false claim");
      eq(nalu.proposals[0].status, "queued", "queued"); eq(nalu.proposals[0].amount_cents, 900, "line price");
      const naluCalls = pos.log.filter((e) => e.actor === "nalu" && e.service_name === "POS API");
      assert(naluCalls.every((e) => e.method === "GET" || e.path === "/customer/guest-requests"), "read-only plus guest requests");
      eq(pos.bill(o.id).refunded_total_cents, 0, "no money moved yet");
      const e = nalu.approve(1, "manager:raj");
      eq(e.status, 200, "refund endpoint"); eq(e.actor, "manager:raj", "as the manager"); eq(pos.bill(o.id).refunded_total_cents, 900, "money moved");
      eq(nalu.proposals[0].status, "refunded", "status"); assert(nalu.turns[nalu.turns.length - 1].reply.includes("$9.00"), "guest told");
      eq(nalu.approve(1, "manager:raj"), null, "cannot approve twice");
    }],
    ["A refund proposal above what is refundable is blocked before any request, and a blocked proposal cannot be approved", () => {
      const { pos, nalu, guest } = agentWorld();
      pos.request("POST", "/tables/3/seat", { party_size: 2 });
      const o = pos.request("POST", "/orders", { table_id: 3, items: [{ instance_id: "tea", qty: 1 }] }).response;
      const i = pos.request("POST", "/payments/intent", { order_id: o.id, payment_method: "cash", tip_cents: 0 }).response;
      pos.request("POST", `/orders/${o.id}/settle`, { payment_intent_id: i.payment_intent_id, amount_tendered_cents: 1000 });
      guest.paid_order_id = o.id;
      const r = nalu.handle("refund me $500");
      eq(nalu.proposals[0].status, "blocked", "blocked"); assert(/can't request/i.test(r.reply), "told why");
      const before = pos.log.length; eq(nalu.approve(1, "manager:raj"), null, "no approval"); eq(pos.log.length, before, "no request made");
      eq(nalu.handle("refund the tea").proposals, undefined, "handle returns a turn");
      assert(nalu.proposals[1] && nalu.proposals[1].status === "queued", "a valid one queues");
    }],
    ["A reserved table needs the reservation code to seat, and the bill carries it", () => {
      const pos = new Pos();
      eq(pos.request("PATCH", "/tables/6/reserve", { reservation_code: "IPOT-1", time: "20:00" }).status, 200, "reserved");
      const r = pos.request("POST", "/tables/6/seat", { party_size: 4 }); eq(r.status, 409, "no code"); eq(r.response.code, "TABLE_OCCUPIED", "code");
      eq(pos.request("POST", "/tables/6/seat", { party_size: 4, reservation_code: "IPOT-1" }).status, 201, "with code");
      const o = pos.request("POST", "/orders", { table_id: 6, items: [{ instance_id: "tea", qty: 1 }] }).response;
      eq(o.reservation_code, "IPOT-1", "order carries the code"); eq(pos.db.tables.find((t) => t.id === 6).reservation_code, null, "cleared on the table");
    }],
  );

  function run() {
    return tests.map(([name, fn]) => { try { fn(); return { name, pass: true }; } catch (e) { return { name, pass: false, error: e.message }; } });
  }
  root.PosTests = { run, count: tests.length };
})(typeof globalThis !== "undefined" ? globalThis : this);
