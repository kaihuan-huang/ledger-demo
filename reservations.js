/* Reservation API demo service: slots, idempotent create, Twilio delivery callback, revenue-agent callback.
   Independent reimplementation; all data is synthetic. Runs on the same Service base as the POS. */
(function (root) {
  "use strict";
  const { Service, raise404, raise409, raise422 } = root.POS;

  const CAPACITY = 4;
  const TIMES = ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"];
  const mask = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 4 ? `+${d.slice(0, 1)} ${d.slice(1, 4)}···${d.slice(-4)}` : "···"; };
  const hashOf = (obj) => { const s = JSON.stringify(obj, Object.keys(obj).sort()); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, "0"); };
  const codeFor = (n) => `IPOT-${(0x2f3a1 * (n + 7)).toString(36).toUpperCase().slice(-4)}`;
  const nextId = (rows) => rows.length + 1;

  function seedDb() {
    const slots = [];
    for (const d of ["2026-09-14", "2026-09-15"]) for (const t of TIMES) slots.push({ id: `${d}T${t}`, date: d, time: t, capacity: CAPACITY, booked: d === "2026-09-14" && t === "19:30" ? CAPACITY : 0 });
    return { slots, reservations: [], idempotency_keys: [], sms_messages: [], revenue_callbacks: [] };
  }
  const MODEL_OF = { slots: "TimeSlot", reservations: "Reservation", idempotency_keys: "ReservationIdempotencyKey", sms_messages: "SmsMessage", revenue_callbacks: "RevenueCallback" };

  function slotsFor(db, date, now) {
    return db.slots.filter((s) => s.date === date).map((s) => ({ time: s.time, is_full: s.booked >= s.capacity, past: `${s.date}T${s.time}:00Z` <= now }));
  }

  const ReservationService = {
    slots(ctx, date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) raise422("date must be YYYY-MM-DD");
      const out = slotsFor(ctx.db, date, ctx.now).filter((s) => !s.past);
      return [200, { date, slots: out, open_times: out.filter((s) => !s.is_full).map((s) => s.time) }];
    },
    create(ctx, body) {
      const db = ctx.db, key = ctx.headers["Idempotency-Key"];
      if (!key) raise422("Idempotency-Key header is required");
      const payload = { guest_name: body.guest_name, guest_phone: body.guest_phone, party_size: body.party_size, reservation_date: body.reservation_date, reservation_time: body.reservation_time };
      const request_hash = hashOf(payload);
      const seen = db.idempotency_keys.find((k) => k.idempotency_key === key);
      if (seen) {
        if (seen.request_hash !== request_hash) raise409("Idempotency-Key was already used with a different reservation payload", "IDEMPOTENCY_MISMATCH");
        const r = db.reservations.find((x) => x.code === seen.reservation_code);
        return [200, { ...r, replayed: true }];
      }
      if (!body.guest_name) raise422("guest_name is required");
      if (String(body.guest_phone || "").replace(/\D/g, "").length < 10) raise422("guest_phone must have at least 10 digits");
      if (!Number.isInteger(body.party_size) || body.party_size < 1 || body.party_size > 12) raise422("party_size must be between 1 and 12");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.reservation_date || "")) raise422("reservation_date must be YYYY-MM-DD");
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(body.reservation_time || "")) raise422("reservation_time must be HH:MM");
      if (`${body.reservation_date}T${body.reservation_time}:00Z` <= ctx.now) raise422("That date and time have already passed");
      const slot = db.slots.find((s) => s.date === body.reservation_date && s.time === body.reservation_time);
      if (!slot) raise422(`No slot at ${body.reservation_time}; slots are ${TIMES[0]} to ${TIMES[TIMES.length - 1]} every 30 minutes`);
      if (slot.booked >= slot.capacity) raise409(`${body.reservation_time} on ${body.reservation_date} is full`, "SLOT_FULL");
      slot.booked += 1;
      const r = { id: nextId(db.reservations), code: codeFor(db.reservations.length), status: "pending", guest_name: body.guest_name, guest_phone: mask(body.guest_phone), party_size: body.party_size,
        reservation_date: body.reservation_date, reservation_time: body.reservation_time, source: body.source || "web", utm_source: body.utm_source || null, utm_campaign: body.utm_campaign || null, gclid: body.gclid || null, created_at: ctx.now };
      db.reservations.push(r);
      db.idempotency_keys.push({ id: nextId(db.idempotency_keys), idempotency_key: key, request_hash, reservation_code: r.code, created_at: ctx.now });
      const sms = { id: nextId(db.sms_messages), sid: `SM${(1000 + db.sms_messages.length).toString(36)}`, to: r.guest_phone, template: "confirmation_with_self_service_links", reservation_code: r.code, status: "queued", queued_at: ctx.now, delivered_at: null };
      db.sms_messages.push(sms);
      ctx.outbound.push({ to: "Twilio", what: `SMS ${sms.sid} queued (template, self-service reschedule/cancel link)` });
      const cb = { id: nextId(db.revenue_callbacks), reservation_code: r.code, event: "reservation.created", utm_source: r.utm_source, utm_campaign: r.utm_campaign, gclid: r.gclid, status: "sent", at: ctx.now };
      db.revenue_callbacks.push(cb);
      ctx.outbound.push({ to: "Revenue Agent", what: `reservation.created with attribution (${r.utm_source || "direct"}${r.gclid ? ", gclid" : ""}) for Google Ads offline conversions` });
      return [201, r];
    },
    get(ctx, code) {
      const r = ctx.db.reservations.find((x) => x.code === code);
      if (!r) raise404(`Reservation ${code} not found`);
      return [200, r];
    },
    confirm(ctx, code) {
      const r = ctx.db.reservations.find((x) => x.code === code);
      if (!r) raise404(`Reservation ${code} not found`);
      if (r.status !== "pending") raise409(`Reservation ${code} is ${r.status}`);
      r.status = "confirmed"; r.confirmed_by = ctx.actor; r.confirmed_at = ctx.now;
      return [200, r];
    },
    cancel(ctx, code, body) {
      const db = ctx.db, r = db.reservations.find((x) => x.code === code);
      if (!r) raise404(`Reservation ${code} not found`);
      if (r.status === "cancelled") raise409(`Reservation ${code} is already cancelled`);
      r.status = "cancelled"; r.cancelled_at = ctx.now; r.cancel_reason = body.reason || null;
      const slot = db.slots.find((s) => s.date === r.reservation_date && s.time === r.reservation_time);
      if (slot && slot.booked > 0) slot.booked -= 1;
      return [200, r];
    },
    twilioStatus(ctx, body) {
      const sms = ctx.db.sms_messages.find((m) => m.sid === body.MessageSid);
      if (!sms) raise404(`Unknown MessageSid ${body.MessageSid}`);
      sms.status = body.MessageStatus;
      if (body.MessageStatus === "delivered") sms.delivered_at = ctx.now;
      return [204, { ok: true }];
    },
  };

  const q = (path, name) => { const m = new RegExp(`[?&]${name}=([^&]+)`).exec(path); return m ? decodeURIComponent(m[1]) : null; };
  const ROUTES = [
    { m: "GET", re: /^\/api\/v1\/reservations\/slots(\?.*)?$/, router: "app/api/reservations.py", service: "TimeSlotService.available_slots (read-only)", h: (c, p) => ReservationService.slots(c, q(p[0], "date")) },
    { m: "POST", re: /^\/api\/v1\/reservations$/, router: "app/api/reservations.py", service: "ReservationService.create → replay_idempotent_reservation · queue_confirmation_sms · RevenueAgentClient.post", h: (c, p, b) => ReservationService.create(c, b) },
    { m: "GET", re: /^\/api\/v1\/reservations\/([\w-]+)$/, router: "app/api/reservations.py", service: "ReservationService.get (read-only)", h: (c, p) => ReservationService.get(c, p[1]) },
    { m: "POST", re: /^\/api\/v1\/reservations\/([\w-]+)\/cancel$/, router: "app/api/reservations.py", service: "ReservationService.cancel", h: (c, p, b) => ReservationService.cancel(c, p[1], b) },
    { m: "POST", re: /^\/api\/v1\/admin\/reservations\/([\w-]+)\/confirm$/, router: "app/api/admin.py", service: "ReservationService.confirm", h: (c, p) => ReservationService.confirm(c, p[1]) },
    { m: "POST", re: /^\/webhooks\/twilio\/status$/, router: "app/api/webhooks.py", service: "SmsService.handle_status_callback", h: (c, p, b) => ReservationService.twilioStatus(c, b) },
  ];

  class Reservations extends Service {
    constructor(bus) { super("Reservation API", seedDb(), ROUTES, MODEL_OF, bus); }
  }
  root.RESERVATIONS = { Reservations, TIMES, CAPACITY, mask };
})(typeof globalThis !== "undefined" ? globalThis : this);
