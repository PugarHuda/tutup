"""Builds web/tokens.json: every active Robinhood Stock Token on chain 4663 with its Chainlink feeds.
usage: python scripts/tokens.py <assets.json from api.robinhood.com/rhj/assets> <feeds-robinhood-mainnet.json>"""
import json, re, sys
assets = json.load(open(sys.argv[1], encoding="utf-8"))["assets"]
feeds = json.load(open(sys.argv[2], encoding="utf-8"))
f5, f7 = {}, {}
for f in feeds:
    m = re.match(r"Robinhood ([A-Z.]+)\s*(?:/|-)\s*USD$", f["name"])
    if m: f5[m.group(1)] = f["proxyAddress"]
    m = re.match(r"Robinhood ([A-Z.]+) \(24/7\)$", f["name"])
    if m: f7[m.group(1)] = f["proxyAddress"]
out = []
for a in assets:
    d = next((x for x in a["deployments"] if x["chainId"] == 4663), None)
    if not d or a["status"] != "ASSET_STATUS_ACTIVE": continue
    s = a["tokenSymbol"]
    out.append({k: v for k, v in {"sym": s, "name": a["tokenName"].replace(" • Robinhood Token", ""), "addr": d["contractAddress"],
                "f5": f5.get(s), "f7": f7.get(s)}.items() if v})
out.sort(key=lambda t: (not t.get("f5"), t["sym"]))
json.dump(out, open("web/tokens.json", "w"), separators=(",", ":"))
print(len(out), "tokens,", sum(1 for t in out if t.get("f5")), "with 24/5 feeds,", sum(1 for t in out if t.get("f7")), "with 24/7 feeds")
