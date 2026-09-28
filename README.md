# POS Platform

**Live:** https://kaihuan-huang.github.io/ledger-demo/

A restaurant point-of-sale platform you can operate in the browser, modelled on the POS work I led at [IPOT](https://ipot.food/), a team-built platform. All data is synthetic.

- **Run the restaurant:** a cashier terminal (floor plan, order tiles, ticket, payment with tip and tender, refund, void), a kitchen display fed over WebSocket rooms, and the guest's phone on the seated table. Every tap is a request through Router → Service → Model, one transaction each, and the backend trace shows the exact rows it wrote. A 40-second tour plays the whole shift.
- **The platform:** five clients, one FastAPI service in three layers, one PostgreSQL, and the Reservation API and Nalu assistant beside it with a hard boundary. Click a box for what it does and which parts I built.
- **Four calls or one transaction:** pick where the API process dies and compare the old four-call settlement with `POST /orders/{id}/settle`.
- **Try to break it:** twelve refused requests with the status and error code the real API answers, and zero rows written.
- **Tests:** 20, run in the browser or in Node.
- **[ledger.html](https://kaihuan-huang.github.io/ledger-demo/ledger.html):** the earlier tamper-evident ledger page, kept for the audit-trail story.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node -e 'require("./pos.js"); require("./pos-tests.js"); const r = PosTests.run(); console.log(r.filter(x => x.pass).length + "/" + r.length)'
```
