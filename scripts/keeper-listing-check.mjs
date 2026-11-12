import assert from "node:assert";
const { fridayClose, reserveFrom, LOTS } = await import("../web/api/keeper.js");
const ts = (iso) => BigInt(Date.parse(iso) / 1000);
assert.equal(fridayClose(ts("2026-11-13T20:00:00Z")), true);   // Friday 20:00 cron
assert.equal(fridayClose(ts("2026-11-13T12:15:00Z")), false);  // Friday midday cron
assert.equal(fridayClose(ts("2026-11-14T12:15:00Z")), true);   // Saturday
assert.equal(fridayClose(ts("2026-11-16T20:00:00Z")), false);  // Monday
assert.equal(reserveFrom(60n), 540000000000n);                 // 0.0000006 WETH -> 90% = 5.4e-7 WETH
assert.equal(LOTS.length, 2);
console.log("keeper listing checks ok");
