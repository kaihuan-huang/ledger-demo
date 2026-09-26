# Tamper-Evident Ledger

**Live:** https://kaihuan-huang.github.io/ledger-demo/

Restaurant bills, payments, refunds and voids written as a hash-chained event log. Change, delete or rewrite a row and verification points straight at it. All data is synthetic.

- **Money rules** follow the POS work I owned at [IPOT](https://ipot.food/): settlement is one transaction; refunds never exceed what is left, tip included, and record a reason and an approver; a void records who and why; a voided bill can't be settled; the same payment key never charges twice.
- **Every balance is rebuilt from the events,** in integer cents. Nothing is stored twice.
- **Three attacks:** editing a number and deleting a row are caught by the chain. Rewriting a row and recomputing every hash after it passes the chain, and is caught only by an anchored head hash kept outside the database.
- **Tests:** 16, run in the browser.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
node -e 'require("./ledger.js"); require("./tests.js"); LedgerTests.run().then(r => console.log(r.filter(x => x.pass).length + "/" + r.length))'
```
