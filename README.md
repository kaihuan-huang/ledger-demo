# POS Platform

**Live:** https://kaihuan-huang.github.io/ledger-demo/

A restaurant point-of-sale platform you can operate in the browser, modelled on the POS work I led at [IPOT](https://ipot.food/), a team-built platform. All data is synthetic.

- **Run the restaurant:** a cashier terminal (floor plan, order tiles, ticket, payment with tip and tender, refund, void), a kitchen display fed over WebSocket rooms, and the guest's phone on the seated table. Every tap is a request through Router → Service → Model, one transaction each, and the backend trace shows the exact rows it wrote. A 40-second tour plays the whole shift.
- **Talk to Nalu:** the bilingual guest assistant at the edge. Rules classify the intent and read every field; a booking runs only after a bare "yes", as one `POST` to the in-page Reservation API with an `Idempotency-Key` (a retry replays, a different payload gets 409, a full slot gets 409 and other times). Twilio delivery status arrives by callback; the Revenue Agent gets the attribution. Nalu reads the POS read-only, and a refund is a proposal until a manager approves it on the terminal. Zero model calls. An agent tour plays the whole flow.
- **The entry points:** every way something outside the POS gets in or out (guest QR app, Nalu, Reservation API, Twilio, Revenue Agent, the floor, the kitchen, the iOS station), what guards it, and a "Show me" button where a click makes sense.
- **The platform:** five clients, one FastAPI service in three layers, one PostgreSQL, and the Reservation API and Nalu assistant beside it with a hard boundary. Click a box for what it does and which parts I built.
- **Four calls or one transaction:** pick where the API process dies and compare the old four-call settlement with `POST /orders/{id}/settle`.
- **Try to break it:** twelve refused requests with the status and error code the real API answers, and zero rows written.
- **Tests:** 28, run in the browser or in Node.
- **[ledger.html](https://kaihuan-huang.github.io/ledger-demo/ledger.html):** the earlier tamper-evident ledger page, kept for the audit-trail story.

`booking-agent.js` is the resolver and confirmation-gate code from my [booking agent demo](https://github.com/kaihuan-huang/booking-agent-demo), unchanged.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node -e 'globalThis.window = globalThis; require("./pos.js"); require("./reservations.js"); require("./booking-agent.js"); require("./nalu.js"); require("./pos-tests.js"); const r = PosTests.run(); console.log(r.filter(x => x.pass).length + "/" + r.length)'
```
