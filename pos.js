/* POS platform demo engine: an in-memory PostgreSQL, one transaction per request,
   Router -> Service -> Model. Independent reimplementation; all data is synthetic. */
(function (root) {
  "use strict";

  class ApiError extends Error {
    constructor(status, detail, code) { super(detail); this.status = status; this.code = code || null; }
  }
  class ProcessDied extends Error {
    constructor(point) { super(`process died (${point})`); this.point = point; }
  }
  const raise422 = (d, c) => { throw new ApiError(422, d, c); };
  const raise409 = (d, c) => { throw new ApiError(409, d, c); };
  const raise404 = (d) => { throw new ApiError(404, d); };

  const TAX_RATE = 0.085;
  const SLA_MINUTES = 3;
  const EDITABLE = ["open", "submitted", "preparing", "ready"];
  const TICKET_FLOW = { received: "preparing", preparing: "ready", ready: "served" };
  const REQUEST_FLOW = { open: ["acked", "resolved", "escalated"], acked: ["resolved", "escalated"], resolved: [], escalated: [] };

  const money = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
  const taxOn = (cents) => Math.round(cents * TAX_RATE);

  function seedDb() {
    return {
      menu_item_instances: [
        { id: "beef", name: "Beef set", menu: "Dinner", price_cents: 2800 },
        { id: "lamb", name: "Lamb set", menu: "Dinner", price_cents: 2600 },
        { id: "veg", name: "Vegetable platter", menu: "Dinner", price_cents: 1400 },
        { id: "noodles", name: "Hand-pulled noodles", menu: "Dinner", price_cents: 900 },
        { id: "tea", name: "Jasmine tea", menu: "Dinner", price_cents: 400 },
        { id: "soda", name: "Soda", menu: "Dinner", price_cents: 300 },
      ],
      tables: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: i, name: `T${i}`, status: "available", current_order_id: null, reservation_code: null })),
      table_sessions: [], orders: [], order_items: [], kds_tickets: [], payments: [],
      cash_drawer_logs: [], guest_requests: [], activity_logs: [], events: [],
    };
  }

  // ---- database helpers ---------------------------------------------------
  const nextId = (rows) => rows.reduce((m, r) => (typeof r.id === "number" && r.id > m ? r.id : m), 0) + 1;
  const find = (rows, id) => rows.find((r) => r.id === id);

  function withTransaction(db, fn) {
    const snapshot = JSON.stringify(db);
    try {
      return fn();
    } catch (e) {
      const back = JSON.parse(snapshot);
      for (const k of Object.keys(db)) delete db[k];
      Object.assign(db, back);
      throw e;
    }
  }

  function diff(beforeStr, db) {
    const before = JSON.parse(beforeStr), out = [];
    for (const t of Object.keys(db)) {
      const prev = new Map((before[t] || []).map((r) => [r.id, r]));
      for (const r of db[t]) {
        const b = prev.get(r.id);
        if (!b) out.push({ table: t, op: "INSERT", id: r.id, fields: JSON.parse(JSON.stringify(r)) });
        else {
          const changed = Object.keys(r).filter((k) => JSON.stringify(r[k]) !== JSON.stringify(b[k]));
          if (changed.length) out.push({ table: t, op: "UPDATE", id: r.id, fields: JSON.parse(JSON.stringify(Object.fromEntries(changed.map((k) => [k, r[k]])))) });
        }
      }
    }
    return out;
  }

  // ---- projections (read side) --------------------------------------------
  function billOf(db, orderId) {
    const o = find(db.orders, orderId);
    if (!o) return null;
    const lines = db.order_items.filter((l) => l.order_id === orderId);
    const tickets = db.kds_tickets.filter((t) => t.order_id === orderId);
    const payments = db.payments.filter((p) => p.order_id === orderId);
    return { ...o, lines, tickets, payments };
  }
  function drawerBalance(db) {
    return db.cash_drawer_logs.reduce((s, l) => s + l.amount_cents, 0);
  }
  function invariants(db) {
    const out = [];
    for (const o of db.orders) {
      const lines = db.order_items.filter((l) => l.order_id === o.id);
      const sub = lines.reduce((s, l) => s + l.quantity * l.price_cents, 0);
      out.push({ name: `order ${o.id}: total equals the sum of its price-snapshotted lines plus tax`, ok: o.total_cents === sub + lines.reduce((s, l) => s + l.tax_cents, 0) });
      const captured = db.payments.filter((p) => p.order_id === o.id && ["captured", "partial_refund", "refunded"].includes(p.status));
      out.push({ name: `order ${o.id}: service_tips equals the tips on captured, unrefunded payments`, ok: o.service_tips_cents === captured.filter((p) => p.status !== "refunded").reduce((s, p) => s + p.tip_cents, 0) });
      if (o.status === "closed") out.push({ name: `order ${o.id}: a closed bill is fully paid and its table is not seated on it`, ok: o.paid_total_cents >= o.total_cents && !db.tables.some((t) => t.current_order_id === o.id) });
      if (o.is_voided) out.push({ name: `order ${o.id}: a voided bill records who and why, and every round is cancelled`, ok: Boolean(o.void_reason && o.voided_by) && db.kds_tickets.filter((t) => t.order_id === o.id).every((t) => t.status === "cancelled") });
    }
    for (const p of db.payments) out.push({ name: `${p.intent_id}: refunds never exceed amount + tip`, ok: p.refunded_cents <= p.amount_cents + p.tip_cents });
    const cash = db.payments.filter((p) => p.payment_method === "cash" && p.status !== "intent_created" && p.status !== "canceled").reduce((s, p) => s + p.amount_cents + p.tip_cents - p.refunded_cents, 0);
    out.push({ name: "cash drawer equals cash captured minus cash refunded", ok: cash === drawerBalance(db) });
    return out;
  }

  // ---- services -------------------------------------------------------------
  function audit(ctx, object_type, activity_type, content, obj, notes) {
    const db = ctx.db;
    db.activity_logs.push({ id: nextId(db.activity_logs), at: ctx.now, object_type, activity_type, content, object: String(obj), actor: ctx.actor, notes: notes || null });
  }
  function logEvent(ctx, event_name, order_id, payload) {
    const db = ctx.db;
    db.events.push({ id: nextId(db.events), at: ctx.now, event_name, order_id, actor: ctx.actor, payload });
  }
  function broadcast(ctx, room, message) { ctx.ws.push({ room, message }); }

  function recalc(db, order) {
    const lines = db.order_items.filter((l) => l.order_id === order.id);
    order.subtotal_cents = lines.reduce((s, l) => s + l.quantity * l.price_cents, 0);
    order.tax_cents = lines.reduce((s, l) => s + l.tax_cents, 0);
    order.total_cents = order.subtotal_cents + order.tax_cents;
  }
  function deriveStatus(db, order) {
    const live = db.kds_tickets.filter((t) => t.order_id === order.id && t.status !== "cancelled");
    if (!live.length) return "open";
    if (live.some((t) => t.status === "preparing")) return "preparing";
    if (live.some((t) => t.status === "received")) return "submitted";
    return "ready";
  }
  function closeSessions(db, tableId, now) {
    for (const s of db.table_sessions) if (s.table_id === tableId && s.is_active) { s.is_active = false; s.closed_at = now; }
  }
  function capturedTips(db, orderId, exclude, plus) {
    return db.payments.filter((p) => p.order_id === orderId && p.id !== exclude && ["captured", "partial_refund"].includes(p.status)).reduce((s, p) => s + p.tip_cents, 0) + (plus || 0);
  }

  const TableService = {
    seat(ctx, tableId, body) {
      const db = ctx.db, table = find(db.tables, tableId);
      if (!table) raise404(`Table ${tableId} not found`);
      if (table.status === "reserved" && body.reservation_code !== table.reservation_code) raise409(`Table ${table.name} is reserved for ${table.reservation_code}; pass that reservation_code to seat the party`, "TABLE_OCCUPIED");
      if (table.status !== "available" && table.status !== "reserved") raise409(`Table ${table.name} is ${table.status}`, "TABLE_OCCUPIED");
      const session = { id: `ts_${db.table_sessions.length + 1}`, table_id: tableId, party_size: body.party_size || null, reservation_code: body.reservation_code || null, is_active: true, created_at: ctx.now, closed_at: null };
      db.table_sessions.push(session);
      table.status = "occupied"; table.reservation_code = null;
      return [201, { table_session_id: session.id, table_id: tableId, status: table.status, reservation_code: session.reservation_code }];
    },
    reserve(ctx, tableId, body) {
      const db = ctx.db, table = find(db.tables, tableId);
      if (!table) raise404(`Table ${tableId} not found`);
      if (!body.reservation_code) raise422("reservation_code is required");
      if (table.status !== "available") raise409(`Table ${table.name} is ${table.status}`, "TABLE_OCCUPIED");
      table.status = "reserved"; table.reservation_code = body.reservation_code; table.reserved_for = body.time || null;
      return [200, { table_id: tableId, status: table.status, reservation_code: table.reservation_code }];
    },
    floorStatus(ctx, tableId, body) {
      const db = ctx.db, table = find(db.tables, tableId);
      if (!table) raise404(`Table ${tableId} not found`);
      const allowed = ["available", "dirty"];
      if (!allowed.includes(body.status)) raise422(`status must be one of ${JSON.stringify(allowed)}`);
      if (table.current_order_id) raise409(`Table ${table.name} still has open bill ${table.current_order_id}`, "TABLE_OCCUPIED");
      table.status = body.status;
      return [200, { table_id: tableId, status: table.status }];
    },
  };

  function resolveInstance(db, instanceId) {
    const inst = find(db.menu_item_instances, instanceId);
    if (!inst) raise422(`Menu item instance ${instanceId} not found`);
    return inst;
  }
  function addLines(db, order, items) {
    const clean = (items || []).filter((i) => i.qty > 0);
    if (!clean.length) raise422("An order needs at least one item");
    for (const i of clean) {
      const inst = resolveInstance(db, i.instance_id);
      const line_total = inst.price_cents * i.qty;
      db.order_items.push({ id: nextId(db.order_items), order_id: order.id, menu_item_instance_id: inst.id, name: inst.name, quantity: i.qty,
        price_cents: inst.price_cents, tax_rate: TAX_RATE, tax_cents: taxOn(line_total), notes: i.notes || null, kds_ticket_id: null, status: "pending" });
    }
    recalc(db, order);
  }

  const OrderService = {
    create(ctx, body) {
      const db = ctx.db, table = find(db.tables, body.table_id);
      if (!table) raise404(`Table ${body.table_id} not found`);
      const session = db.table_sessions.find((s) => s.table_id === table.id && s.is_active);
      if (!session) raise422(`Table ${table.name} has no active session; seat the party first`);
      if (table.current_order_id) raise409(`Table ${table.name} already has open bill ${table.current_order_id}`, "TABLE_OCCUPIED");
      const order = { id: nextId(db.orders), table_id: table.id, table_session_id: session.id, reservation_code: session.reservation_code || null, status: "open", payment_status: "pending", payment_method: null,
        subtotal_cents: 0, tax_cents: 0, total_cents: 0, service_tips_cents: 0, paid_total_cents: 0, refunded_total_cents: 0, refund_status: "na",
        is_voided: false, voided_by: null, void_reason: null, order_number: null, server_name: ctx.actor, created_at: ctx.now, closed_at: null, notes: null };
      db.orders.push(order);
      addLines(db, order, body.items);
      table.current_order_id = order.id;
      return [201, billOf(db, order.id)];
    },
    addItems(ctx, orderId, body) {
      const db = ctx.db, order = find(db.orders, orderId);
      if (!order) raise404(`Order ${orderId} not found`);
      if (!EDITABLE.includes(order.status) || order.is_voided) raise422(`Order ${orderId} is ${order.is_voided ? "voided" : order.status}; it can't take new items`, "ORDER_LOCKED");
      addLines(db, order, body.items);
      return [200, billOf(db, orderId)];
    },
    removeItem(ctx, orderId, lineId) {
      const db = ctx.db, order = find(db.orders, orderId);
      if (!order) raise404(`Order ${orderId} not found`);
      const line = db.order_items.find((l) => l.id === lineId && l.order_id === orderId);
      if (!line) raise404(`Line ${lineId} not found on order ${orderId}`);
      if (line.kds_ticket_id) raise422(`Line ${lineId} is already with the kitchen (ticket ${line.kds_ticket_id}); pulling it back is a void, not an edit`, "ORDER_LOCKED");
      db.order_items.splice(db.order_items.indexOf(line), 1);
      recalc(db, order);
      return [200, billOf(db, orderId)];
    },
    patch(ctx, orderId, body) {
      const db = ctx.db, order = find(db.orders, orderId);
      if (!order) raise404(`Order ${orderId} not found`);
      if (body.status === "closed") raise409("Closing a bill goes through /close or /settle only; PATCH may not skip the payment checks", "ORDER_LOCKED");
      if (order.status === "closed" || order.status === "canceled" || order.is_voided) raise409(`Order ${orderId} is locked (${order.is_voided ? "voided" : order.status})`, "ORDER_LOCKED");
      if (body.is_voided) {
        if (!body.void_reason) raise422("A void needs a reason");
        order.is_voided = true; order.status = "canceled"; order.voided_by = ctx.actor; order.void_reason = body.void_reason;
        for (const t of db.kds_tickets) if (t.order_id === orderId && t.status !== "served") t.status = "cancelled";
        const table = find(db.tables, order.table_id);
        if (table && table.current_order_id === orderId) { table.current_order_id = null; table.status = "available"; closeSessions(db, table.id, ctx.now); }
        audit(ctx, "Order", "Void", `Bill voided (${money(order.total_cents)})`, orderId, body.void_reason);
        logEvent(ctx, "order.voided", orderId, { voided_by: ctx.actor, void_reason: body.void_reason });
      }
      if (body.notes !== undefined) order.notes = body.notes;
      return [200, billOf(db, orderId)];
    },
    settle(ctx, orderId, body) {
      const db = ctx.db;
      const target = (body.table_status || "dirty").toLowerCase();
      if (!["dirty", "available"].includes(target)) raise422(`table_status must be one of ["available","dirty"]`);
      const order = find(db.orders, orderId);
      if (!order) raise404(`Order ${orderId} not found`);
      if (order.status === "closed") raise409(`Order ${orderId} is already closed`, "ORDER_LOCKED");
      if (order.status === "canceled") raise409(`Order ${orderId} is canceled and cannot be settled`, "ORDER_LOCKED");
      if (order.is_voided) raise422(`Order ${orderId} is voided and cannot be settled`);

      const [payment, change] = PaymentService.captureInTransaction(ctx, body.payment_intent_id, body);
      ctx.checkpoint("after_capture");
      if (payment.order_id !== orderId) raise422(`Payment intent ${body.payment_intent_id} belongs to order ${payment.order_id}, not ${orderId}`);
      if (order.payment_status !== "captured") raise422(`Order ${orderId} cannot be settled: payment not fully captured (paid ${money(order.paid_total_cents)} of ${money(order.total_cents)})`);

      order.status = "closed"; order.closed_at = ctx.now;
      if (!order.order_number) order.order_number = order.id.toString(16).toUpperCase().padStart(6, "0");
      if (body.final_notes) order.notes = body.final_notes;
      ctx.checkpoint("after_close");

      const table = find(db.tables, order.table_id);
      if (table) { table.status = target; table.current_order_id = null; closeSessions(db, table.id, ctx.now); }
      ctx.checkpoint("after_table");

      const drawer = [...db.cash_drawer_logs].reverse().find((l) => l.payment_id === payment.id) || null;
      audit(ctx, "Order", "Settle", `Bill settled (${money(order.paid_total_cents)} ${order.payment_method})`, order.order_number);
      logEvent(ctx, "order.settled", orderId, { table_id: order.table_id, total: order.total_cents, paid_total: order.paid_total_cents, tip: order.service_tips_cents, payment_method: order.payment_method, table_status: target, drawer_log_id: drawer ? drawer.id : null });
      broadcast(ctx, "cashier", { event: "order_settled", order_id: orderId, table_id: order.table_id });
      // One commit: everything above lands together or not at all.
      return [200, { order_id: orderId, status: order.status, payment_status: order.payment_status, total: order.total_cents, paid_total: order.paid_total_cents,
        tip: order.service_tips_cents, change_due: change, table_id: order.table_id, table_status: target, drawer_log_id: drawer ? drawer.id : null, closed_at: order.closed_at }];
    },
    reopen(ctx, orderId, body) {
      const db = ctx.db, order = find(db.orders, orderId);
      if (!order) raise404(`Order ${orderId} not found`);
      if (order.status !== "closed") raise409(`Order ${orderId} is not closed`, "ORDER_LOCKED");
      if (order.is_voided) raise422(`Order ${orderId} is voided and cannot be reopened`);
      if (order.refunded_total_cents > 0) raise422(`Order ${orderId} has been refunded and cannot be reopened`);
      const table = find(db.tables, order.table_id);
      if (table.current_order_id) raise409(`Table ${table.name} is seated on bill ${table.current_order_id}`, "TABLE_OCCUPIED");
      order.status = "open"; order.closed_at = null; order.reopened_by = ctx.actor; order.reopened_at = ctx.now;
      table.status = "occupied"; table.current_order_id = orderId;
      audit(ctx, "Order", "Reopen", `Bill reopened`, orderId, body.reason || null);
      return [200, billOf(db, orderId)];
    },
  };

  const KDSService = {
    submit(ctx, orderId) {
      const db = ctx.db, order = find(db.orders, orderId);
      if (!order) raise404(`Order ${orderId} not found`);
      if (order.is_voided || order.status === "closed" || order.status === "canceled") raise422(`Order ${orderId} is ${order.is_voided ? "voided" : order.status}`, "ORDER_LOCKED");
      const unsent = db.order_items.filter((l) => l.order_id === orderId && !l.kds_ticket_id);
      if (!unsent.length) raise422(`Order ${orderId} has nothing new to send; every line is already with the kitchen`);
      const round = db.kds_tickets.filter((t) => t.order_id === orderId).length + 1;
      const ticket = { id: nextId(db.kds_tickets), order_id: orderId, round_number: round, ticket_number: `${orderId}-${round}`, status: "received", station: "hotpot",
        items: unsent.map((l) => ({ line_id: l.id, name: l.name, qty: l.quantity, notes: l.notes })), created_at: ctx.now, ready_at: null, served_at: null };
      db.kds_tickets.push(ticket);
      for (const l of unsent) { l.kds_ticket_id = ticket.id; l.status = "sent"; }
      order.status = deriveStatus(db, order);
      audit(ctx, "Order", "Submit", `Round ${round} sent to the kitchen (${unsent.length} lines)`, orderId);
      logEvent(ctx, "kds.ticket_created", orderId, { ticket_id: ticket.id, ticket_number: ticket.ticket_number, round_number: round });
      const note = { event: "kds.ticket_created", ticket_number: ticket.ticket_number, table_id: order.table_id, items: ticket.items.length };
      broadcast(ctx, "kds", note); broadcast(ctx, "cashier", note);
      return [201, { ticket_id: ticket.id, ticket_number: ticket.ticket_number, round_number: round, lines: unsent.length }];
    },
    setStatus(ctx, ticketId, body) {
      const db = ctx.db, ticket = find(db.kds_tickets, ticketId);
      if (!ticket) raise404(`Ticket ${ticketId} not found`);
      if (TICKET_FLOW[ticket.status] !== body.status) raise422(`Ticket ${ticket.ticket_number} is ${ticket.status}; next is ${TICKET_FLOW[ticket.status] || "nothing"}, not ${body.status}`, "INVALID_TRANSITION");
      ticket.status = body.status;
      if (body.status === "ready") ticket.ready_at = ctx.now;
      if (body.status === "served") ticket.served_at = ctx.now;
      const order = find(db.orders, ticket.order_id);
      order.status = deriveStatus(db, order);
      broadcast(ctx, "cashier", { event: "kds.ticket_" + body.status, ticket_number: ticket.ticket_number, table_id: order.table_id });
      return [200, ticket];
    },
  };

  const MenuService = {
    setPrice(ctx, instanceId, body) {
      const db = ctx.db, inst = resolveInstance(db, instanceId);
      if (!Number.isInteger(body.price_cents) || body.price_cents <= 0) raise422("price_cents must be a positive integer");
      const was = inst.price_cents; inst.price_cents = body.price_cents;
      audit(ctx, "MenuItemInstance", "Price", `${inst.name} ${money(was)} → ${money(inst.price_cents)} (existing bills keep ${money(was)})`, instanceId);
      return [200, inst];
    },
  };

  const GuestRequestService = {
    create(ctx, body) {
      const db = ctx.db, session = db.table_sessions.find((s) => s.id === body.table_session_id);
      if (!session || !session.is_active) raise404("Active table session not found");
      const types = ["call", "cash", "split", "pace", "cancel"];
      if (!types.includes(body.request_type)) raise422(`request_type must be one of ${JSON.stringify(types)}`);
      const existing = db.guest_requests.find((r) => r.table_session_id === session.id && r.request_type === body.request_type && ["open", "acked"].includes(r.status));
      if (existing) return [200, { ...existing, deduplicated: true }];
      const due = new Date(new Date(ctx.now).getTime() + SLA_MINUTES * 60000).toISOString();
      const r = { id: nextId(db.guest_requests), table_session_id: session.id, table_id: session.table_id, request_type: body.request_type, status: "open", created_at: ctx.now, sla_due_at: due, resolved_at: null, outcome: null };
      db.guest_requests.push(r);
      broadcast(ctx, "cashier", { event: "guest_request.created", table_id: session.table_id, request_type: body.request_type });
      return [201, r];
    },
    transition(ctx, id, body) {
      const db = ctx.db, r = find(db.guest_requests, id);
      if (!r) raise404(`Guest request ${id} not found`);
      if (!REQUEST_FLOW[r.status].includes(body.status)) raise422(`Guest request ${id} is ${r.status}; it can go to ${JSON.stringify(REQUEST_FLOW[r.status])}, not ${body.status}`, "GUEST_REQUEST_INVALID_TRANSITION");
      r.status = body.status;
      if (body.status === "resolved") { r.resolved_at = ctx.now; r.outcome = body.outcome || "done"; }
      return [200, r];
    },
  };

  const PaymentService = {
    createIntent(ctx, body) {
      const db = ctx.db, order = find(db.orders, body.order_id);
      if (!order) raise404(`Order ${body.order_id} not found`);
      if (order.is_voided) raise409(`Order ${order.id} is voided, cannot create payment`, "ORDER_LOCKED");
      const unpaid = order.total_cents - order.paid_total_cents;
      const tip = body.tip_cents || 0;
      if (unpaid <= 0 && tip <= 0) raise409(`Order ${order.id} is fully paid; a payment intent needs a tip or an unpaid balance`, "ORDER_LOCKED");
      const p = { id: nextId(db.payments), intent_id: `pi_${nextId(db.payments)}`, order_id: order.id, payment_method: body.payment_method || "cash", status: "intent_created",
        amount_cents: Math.max(unpaid, 0), tip_cents: tip, refunded_cents: 0, created_at: ctx.now, captured_at: null };
      db.payments.push(p);
      // The tip lives on the payment. order.total is untouched, so an abandoned intent cannot raise the bill.
      return [201, { payment_intent_id: p.intent_id, order_id: order.id, amount: p.amount_cents, tip: p.tip_cents, status: p.status }];
    },
    cancelIntent(ctx, body) {
      const db = ctx.db, p = db.payments.find((x) => x.intent_id === body.payment_intent_id);
      if (!p) raise404(`Payment ${body.payment_intent_id} not found`);
      if (p.status !== "intent_created") raise409(`Payment ${p.intent_id} is ${p.status}; only an open intent can be cancelled`);
      p.status = "canceled";
      return [200, { payment_intent_id: p.intent_id, status: p.status }];
    },
    captureInTransaction(ctx, intentId, body) {
      const db = ctx.db, p = db.payments.find((x) => x.intent_id === intentId);
      if (!p) raise404(`Payment intent ${intentId} not found`);
      if (p.status !== "intent_created") raise409(`Payment ${intentId} is ${p.status}; only an open intent can be captured`);
      const due = p.amount_cents + p.tip_cents;
      let change = 0;
      if (p.payment_method === "cash") {
        const tendered = body.amount_tendered_cents;
        if (!Number.isInteger(tendered)) raise422("amount_tendered_cents is required for cash");
        if (tendered < due) raise422(`Tendered ${money(tendered)} is less than ${money(due)} due`);
        change = tendered - due;
      }
      p.status = "captured"; p.captured_at = ctx.now;
      const order = find(db.orders, p.order_id);
      order.paid_total_cents += p.amount_cents;
      order.service_tips_cents = capturedTips(db, order.id, p.id, p.tip_cents);
      order.payment_method = p.payment_method;
      order.payment_status = order.paid_total_cents >= order.total_cents ? "captured" : "pending";
      if (p.payment_method === "cash") db.cash_drawer_logs.push({ id: nextId(db.cash_drawer_logs), at: ctx.now, action: "sale", amount_cents: due, payment_id: p.id, notes: `Cash sale on order ${order.id}` });
      logEvent(ctx, "payment.captured", order.id, { intent_id: p.intent_id, amount: p.amount_cents, tip: p.tip_cents, method: p.payment_method });
      return [p, change];
    },
    capture(ctx, body) {
      const [p, change] = PaymentService.captureInTransaction(ctx, body.payment_intent_id, body);
      return [200, { payment_intent_id: p.intent_id, status: p.status, change_due: change }];
    },
    refund(ctx, ref, body) {
      const db = ctx.db, p = db.payments.find((x) => x.intent_id === ref || x.id === ref);
      if (!p) raise404(`Payment ${ref} not found`);
      if (!["captured", "partial_refund"].includes(p.status)) raise409(`Cannot refund a payment with status '${p.status}'; only a captured payment can be refunded`);
      const charged = p.amount_cents + p.tip_cents, remaining = charged - p.refunded_cents;
      if (remaining <= 0) raise409(`Payment ${p.intent_id} is already fully refunded`);
      const amount = body.amount_cents == null ? remaining : body.amount_cents;
      if (!Number.isInteger(amount) || amount <= 0) raise422("amount_cents must be a positive integer");
      if (amount > remaining) raise422(`Refund of ${money(amount)} exceeds the ${money(remaining)} still refundable on payment ${p.intent_id}`);
      if (!body.reason) raise422("A refund needs a reason");
      if (!body.approved_by) raise422("A refund needs an approver");
      p.refunded_cents += amount;
      const fully = p.refunded_cents >= charged;
      p.status = fully ? "refunded" : "partial_refund";
      const order = find(db.orders, p.order_id);
      order.refunded_total_cents += amount;
      // A fully refunded payment is no longer captured, so its tip drops out.
      order.service_tips_cents = capturedTips(db, order.id, p.id, fully ? 0 : p.tip_cents);
      if (order.refunded_total_cents >= order.paid_total_cents && order.paid_total_cents > 0) { order.refund_status = "full"; order.payment_status = "refunded"; }
      else if (order.refunded_total_cents > 0) { order.refund_status = "partial"; order.payment_status = "partial_refund"; }
      let drawer = null;
      if (p.payment_method === "cash") { drawer = { id: nextId(db.cash_drawer_logs), at: ctx.now, action: "refund", amount_cents: -amount, payment_id: p.id, notes: `Cash refund on order ${order.id}` }; db.cash_drawer_logs.push(drawer); }
      audit(ctx, "Payment", "Refund", `Refunded ${money(amount)} of ${money(charged)}`, p.intent_id, `${body.reason} · approved by ${body.approved_by}`);
      logEvent(ctx, "payment." + p.status, order.id, { intent_id: p.intent_id, refunded: amount, reason: body.reason, approved_by: body.approved_by });
      return [200, { payment_intent_id: p.intent_id, order_id: order.id, status: p.status, refunded_now: amount, refunded_total_on_payment: p.refunded_cents, refunded_total_on_order: order.refunded_total_cents, order_refund_status: order.refund_status, drawer_log_id: drawer ? drawer.id : null }];
    },
  };

  // ---- routers: validate the shape, name the service, nothing else ----------
  const ROUTES = [
    { m: "POST", re: /^\/tables\/(\d+)\/seat$/, router: "routers/tables.py", service: "TableService.seat", h: (c, p, b) => TableService.seat(c, +p[1], b) },
    { m: "GET", re: /^\/menu-items$/, router: "routers/menu_items.py", service: "MenuItemService.list (read-only)", h: (c) => [200, { items: c.db.menu_item_instances.map((i) => ({ id: i.id, name: i.name, price_cents: i.price_cents, menu: i.menu })), total: c.db.menu_item_instances.length }] },
    { m: "GET", re: /^\/tables$/, router: "routers/tables.py", service: "TableService.list (read-only)", h: (c) => [200, { items: c.db.tables.map((t) => ({ id: t.id, name: t.name, status: t.status })), total: c.db.tables.length }] },
    { m: "GET", re: /^\/orders\/(\d+)$/, router: "routers/orders.py", service: "OrderService.get_order_with_items (read-only)", h: (c, p) => { const b = billOf(c.db, +p[1]); if (!b) raise404(`Order ${p[1]} not found`); return [200, b]; } },
    { m: "PATCH", re: /^\/tables\/(\d+)\/reserve$/, router: "routers/tables.py", service: "TableService.reserve", h: (c, p, b) => TableService.reserve(c, +p[1], b) },
    { m: "PATCH", re: /^\/tables\/(\d+)\/floor-status$/, router: "routers/tables.py", service: "TableService.set_floor_status", h: (c, p, b) => TableService.floorStatus(c, +p[1], b) },
    { m: "POST", re: /^\/orders$/, router: "routers/orders.py", service: "OrderService.create_order → resolve_menu_item_instance", h: (c, p, b) => OrderService.create(c, b) },
    { m: "PATCH", re: /^\/orders\/(\d+)\/items$/, router: "routers/orders.py", service: "OrderService.update_order_items → resolve_menu_item_instance", h: (c, p, b) => OrderService.addItems(c, +p[1], b) },
    { m: "DELETE", re: /^\/orders\/(\d+)\/items\/(\d+)$/, router: "routers/orders.py", service: "OrderService.update_order_items (_assert_not_sent)", h: (c, p) => OrderService.removeItem(c, +p[1], +p[2]) },
    { m: "PATCH", re: /^\/orders\/(\d+)$/, router: "routers/orders.py", service: "OrderService.update_order", h: (c, p, b) => OrderService.patch(c, +p[1], b) },
    { m: "POST", re: /^\/orders\/(\d+)\/submit$/, router: "routers/orders.py", service: "KDSService.submit_order (WebSocket rooms kds, cashier)", h: (c, p) => KDSService.submit(c, +p[1]) },
    { m: "POST", re: /^\/orders\/(\d+)\/settle$/, router: "routers/orders.py", service: "OrderService.settle_order → PaymentService.capture_in_transaction", h: (c, p, b) => OrderService.settle(c, +p[1], b) },
    { m: "POST", re: /^\/orders\/(\d+)\/reopen$/, router: "routers/orders.py", service: "OrderService.reopen_order", h: (c, p, b) => OrderService.reopen(c, +p[1], b) },
    { m: "PATCH", re: /^\/kds\/tickets\/(\d+)$/, router: "routers/kds.py", service: "KDSService.update_ticket_status (WebSocket room cashier)", h: (c, p, b) => KDSService.setStatus(c, +p[1], b) },
    { m: "PATCH", re: /^\/menu-items\/([a-z]+)\/price$/, router: "routers/menu_items.py", service: "MenuItemInstancesService.set_price", h: (c, p, b) => MenuService.setPrice(c, p[1], b) },
    { m: "POST", re: /^\/customer\/guest-requests$/, router: "routers/guest_requests.py (public, keyed by table_session_id)", service: "GuestRequestService.create", h: (c, p, b) => GuestRequestService.create(c, b) },
    { m: "PATCH", re: /^\/guest-requests\/(\d+)$/, router: "routers/guest_requests.py", service: "GuestRequestService.transition", h: (c, p, b) => GuestRequestService.transition(c, +p[1], b) },
    { m: "POST", re: /^\/payments\/intent$/, router: "routers/payments.py", service: "PaymentService.create_payment_intent", h: (c, p, b) => PaymentService.createIntent(c, b) },
    { m: "POST", re: /^\/payments\/cancel$/, router: "routers/payments.py", service: "PaymentService.cancel_payment_intent", h: (c, p, b) => PaymentService.cancelIntent(c, b) },
    { m: "POST", re: /^\/payments\/capture$/, router: "routers/payments.py", service: "PaymentService.capture_payment", h: (c, p, b) => PaymentService.capture(c, b) },
    { m: "POST", re: /^\/payments\/([\w-]+)\/refund$/, router: "routers/payments.py", service: "PaymentService.refund_payment", h: (c, p, b) => PaymentService.refund(c, p[1], b) },
  ];

  const MODEL_OF = { menu_item_instances: "MenuItemInstance", tables: "Table", table_sessions: "TableSession", orders: "Order", order_items: "OrderItem", kds_tickets: "KDSTicket",
    payments: "Payment", cash_drawer_logs: "CashDrawerLog", guest_requests: "GuestRequest", activity_logs: "ActivityLog", events: "Event" };

  class Service {
    constructor(name, db, routes, modelOf, bus) {
      this.name = name; this.db = db; this.routes = routes; this.modelOf = modelOf;
      this.bus = bus || { tick: 0, log: [] };
      this.crashPoint = null;
    }
    get log() { return this.bus.log; }
    get tick() { return this.bus.tick; }
    set tick(v) { this.bus.tick = v; }
    now() { return new Date(Date.UTC(2026, 8, 14, 18, 2, 0) + this.bus.tick * 90000).toISOString(); }

    request(method, path, body, actor, headers) {
      body = body || {}; actor = actor || "cashier:mei"; headers = headers || {};
      this.bus.tick += 1;
      const route = this.routes.find((r) => r.m === method && r.re.test(path));
      const entry = { service_name: this.name, method, path, body, headers, actor, at: this.now(), ws: [], writes: [], outbound: [], router: route ? route.router : null, service: route ? route.service : null, models: [] };
      this.bus.log.push(entry);
      if (!route) { Object.assign(entry, { status: 404, response: { detail: `No route for ${method} ${path}` }, error: true }); return entry; }
      const ctx = { db: this.db, now: entry.at, actor, headers, ws: [], outbound: [], checkpoint: (pt) => { if (this.crashPoint === pt) throw new ProcessDied(pt); } };
      const before = JSON.stringify(this.db);
      try {
        const [status, response] = withTransaction(this.db, () => route.h(ctx, route.re.exec(path), body));
        entry.status = status; entry.response = JSON.parse(JSON.stringify(response)); entry.ws = ctx.ws; entry.outbound = ctx.outbound;
        entry.writes = diff(before, this.db);
        entry.models = [...new Set(entry.writes.map((w) => this.modelOf[w.table] || w.table))];
      } catch (e) {
        if (e instanceof ApiError) { entry.status = e.status; entry.response = { detail: e.message, code: e.code }; entry.error = true; }
        else if (e instanceof ProcessDied) { entry.status = 0; entry.response = { detail: `Process died ${e.point.replace("_", " ")}. The open transaction was rolled back.` }; entry.crashed = true; }
        else throw e;
        entry.writes = [];
      }
      return entry;
    }
  }

  class Pos extends Service {
    constructor(bus) { super("POS API", seedDb(), ROUTES, MODEL_OF, bus); }

    // The flow before 6de5698: four separate calls from the till, each its own commit.
    legacySettle(orderId, intentId, tenderedCents, crashAfter) {
      const steps = [
        ["capture", () => this.request("POST", "/payments/capture", { payment_intent_id: intentId, amount_tendered_cents: tenderedCents })],
        ["close bill", () => { const db = this.db, o = find(db.orders, orderId); const before = JSON.stringify(db); this.tick += 1;
          // legacy PATCH status=closed: no payment check, back-fill paid_total from total, free the table
          const e = { method: "PATCH", path: `/orders/${orderId}`, body: { status: "closed" }, actor: "cashier:mei", at: this.now(), ws: [], router: "routers/orders.py", service: "OrderService.update_order (legacy)", models: [] };
          o.status = "closed"; o.closed_at = e.at; o.paid_total_cents = o.total_cents; o.payment_status = "captured";
          e.status = 200; e.response = billOf(db, orderId); e.writes = diff(before, db); this.log.push(e); return e; }],
        ["move table", () => { const db = this.db, o = find(db.orders, orderId), t = find(db.tables, o.table_id); const before = JSON.stringify(db); this.tick += 1;
          const e = { method: "PATCH", path: `/tables/${t.id}/status`, body: { status: "dirty" }, actor: "cashier:mei", at: this.now(), ws: [], router: "routers/tracking.py", service: "TableService.update_status (legacy)", models: [] };
          t.status = "dirty"; t.current_order_id = null; closeSessions(db, t.id, e.at);
          e.status = 200; e.response = t; e.writes = diff(before, db); this.log.push(e); return e; }],
        ["write drawer", () => { const db = this.db, p = db.payments.find((x) => x.intent_id === intentId); const before = JSON.stringify(db); this.tick += 1;
          const e = { method: "POST", path: "/cash-drawer/log", body: { action: "sale", payment_intent_id: intentId }, actor: "cashier:mei", at: this.now(), ws: [], router: "routers/cash_drawer.py", service: "CashDrawerService.record_action (legacy)", models: [] };
          if (!db.cash_drawer_logs.some((l) => l.payment_id === p.id)) db.cash_drawer_logs.push({ id: nextId(db.cash_drawer_logs), at: e.at, action: "sale", amount_cents: p.amount_cents + p.tip_cents, payment_id: p.id, notes: `Cash sale on order ${orderId}` });
          e.status = 200; e.response = { ok: true }; e.writes = diff(before, db); this.log.push(e); return e; }],
      ];
      // In this demo's legacy capture, the drawer row is written by call 4, not by capture.
      const out = [];
      for (let i = 0; i < steps.length; i++) {
        if (crashAfter === i) { out.push({ step: steps[i][0], status: 0, crashed: true }); break; }
        const e = steps[i][1]();
        if (i === 0 && e.status === 200) { const p = this.db.payments.find((x) => x.intent_id === intentId); this.db.cash_drawer_logs = this.db.cash_drawer_logs.filter((l) => l.payment_id !== p.id); }
        out.push({ step: steps[i][0], status: e.status, entry: e });
        if (e.status >= 400) break;
      }
      return out;
    }

    settlementState(orderId) {
      const db = this.db, o = find(db.orders, orderId), t = find(db.tables, o.table_id);
      const p = db.payments.find((x) => x.order_id === orderId);
      const captured = Boolean(p && p.status === "captured");
      const closed = o.status === "closed";
      const freed = t.current_order_id !== orderId && t.status !== "occupied";
      const drawer = Boolean(p && db.cash_drawer_logs.some((l) => l.payment_id === p.id));
      const flags = [captured, closed, freed, drawer];
      return { captured, closed, freed, drawer, consistent: flags.every(Boolean) || flags.every((f) => !f) };
    }

    bill(id) { return billOf(this.db, id); }
    drawer() { return drawerBalance(this.db); }
    checks() { return invariants(this.db); }
  }

  root.POS = { Pos, Service, money, seedDb, invariants, ApiError, raise404, raise409, raise422, withTransaction, diff, TAX_RATE, SLA_MINUTES };
})(typeof globalThis !== "undefined" ? globalThis : this);
