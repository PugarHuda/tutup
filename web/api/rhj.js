// Same-origin proxy for two APIs that send no CORS headers: Robinhood's Stock Token API and the $WIF price.
// Only these read-only paths are forwarded; nothing else upstream is reachable through here.
const ALLOWED = [
  [/^prices\/[A-Z][A-Z0-9.]{0,9}$/, 15, (p) => `https://api.robinhood.com/rhj/${p}`],
  [/^assets$/, 300, (p) => `https://api.robinhood.com/rhj/${p}`],
  [/^corporate-actions$/, 3600, (p) => `https://api.robinhood.com/rhj/${p}`],
  [/^wif-price$/, 30, () => "https://api.worldisflat.fun/price"],
];

export default async function handler(req, res) {
  const path = String(req.query.path || "");
  const rule = ALLOWED.find(([re]) => re.test(path));
  if (req.method !== "GET" || !rule) {
    res.status(400).json({ error: "unsupported path" });
    return;
  }
  try {
    const r = await fetch(rule[2](path), { headers: { accept: "application/json" } });
    const body = await r.text();
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", `public, s-maxage=${rule[1]}, stale-while-revalidate=${rule[1]}`);
    res.status(r.status).send(body);
  } catch {
    res.status(502).json({ error: "upstream unavailable" });
  }
}
