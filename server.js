// GemShop – server tunggal tanpa dependensi. Jalankan: node server.js (Node 18+)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

/* ===== KONFIGURASI: isi lewat environment variable di hosting ===== */
const PORT = process.env.PORT || 3000;
const MIDTRANS_KEY = process.env.MIDTRANS_SERVER_KEY || "";   // kosong = MODE UJI COBA (tanpa pembayaran asli)
const MIDTRANS_URL = process.env.MIDTRANS_PRODUCTION ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
const DIGI_USER = process.env.DIGIFLAZZ_USERNAME || "";
const DIGI_KEY = process.env.DIGIFLAZZ_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";                // untuk melihat daftar pesanan
const MARGIN = 0.02, ROUND = 50;                              // untung 2%, dibulatkan ke atas per Rp50
const MOCK = !MIDTRANS_KEY;

/* Produk: [jumlah, modal]. Ganti modal sesuai harga pemasok Anda; harga jual dihitung otomatis. */
const GAMES = {
  ml: { zone: true, idRe: /^\d{5,14}$/, packs: [[12,3859],[19,6199],[28,9151],[44,13331],[59,17880],[85,25781],[113,34795],[170,51673],[240,72737],[296,88611],[408,124955],[568,167757],[750,221624],[875,255156],[1136,333395],[1412,419179],[2010,572896],[2180,627103],[4830,1330365]] },
  ff: { zone: false, idRe: /^\d{5,14}$/, packs: [[50,7218],[70,9603],[100,13980],[140,19456],[210,29183],[355,48221],[500,68474],[720,96443],[1000,135020],[1450,194814],[2180,289378],[3640,483411]] },
  rb: { zone: false, idRe: /^[A-Za-z0-9_]{3,20}$/, packs: [[100,16000],[200,31900],[300,47300],[400,62700],[500,78100],[600,93500],[700,108900],[800,124300],[900,139700],[1000,155100]] }
};
/* Kode produk pemasok (Digiflazz), contoh: "ml:170": "KODE_DARI_PRICELIST".
   Kosong = pesanan yang sudah dibayar ditandai "manual" untuk Anda proses sendiri. */
const SKU = {};

const priceOf = m => Math.ceil(m * (1 + MARGIN) / ROUND) * ROUND;

/* ===== Penyimpanan pesanan (file JSON; untuk skala besar pindah ke database) ===== */
const DB_FILE = path.join(__dirname, "orders.json");
let orders = {};
try { orders = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
const save = () => { try { fs.writeFileSync(DB_FILE, JSON.stringify(orders)); } catch (e) { console.error("Gagal simpan:", e.message); } };

/* ===== Pembayaran & pengiriman ===== */
async function createPayment(o) {
  if (MOCK) return { qr: "MOCK-" + o.id };
  const r = await fetch(MIDTRANS_URL + "/v2/charge", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json",
               Authorization: "Basic " + Buffer.from(MIDTRANS_KEY + ":").toString("base64") },
    body: JSON.stringify({ payment_type: "qris", transaction_details: { order_id: o.id, gross_amount: o.total }, qris: { acquirer: "gopay" } })
  });
  const d = await r.json();
  if (!d.qr_string) throw new Error("Gagal membuat QRIS");
  return { qr: d.qr_string };
}

async function fulfill(o) {
  const sku = SKU[o.game + ":" + o.qty];
  if (!DIGI_USER || !sku) { o.status = "manual"; return save(); }
  o.status = "processing"; save();
  try {
    const sign = crypto.createHash("md5").update(DIGI_USER + DIGI_KEY + o.id).digest("hex");
    const r = await fetch("https://api.digiflazz.com/v1/transaction", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: DIGI_USER, buyer_sku_code: sku, customer_no: o.target, ref_id: o.id, sign })
    });
    const d = (await r.json()).data || {};
    o.status = d.status === "Sukses" ? "success" : d.status === "Gagal" ? "failed" : "manual"; // Pending: cek di dashboard pemasok
  } catch (e) { o.status = "failed"; }
  save();
}

function markPaid(o) {
  if (o.status !== "pending") return;
  o.status = "paid"; save();
  fulfill(o);
}

/* ===== Server HTTP ===== */
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => {
  let s = ""; req.on("data", c => { s += c; if (s.length > 10000) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { ok({}); } });
});
const FILES = { "/": "index.html", "/index.html": "index.html", "/images.js": "images.js" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
const hits = {};

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (req.method === "GET" && FILES[url]) {
      const f = FILES[url];
      res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] });
      return res.end(fs.readFileSync(path.join(__dirname, f)));
    }

    if (req.method === "GET" && url === "/api/products") {
      const out = {};
      for (const k in GAMES) out[k] = GAMES[k].packs.map(([q, m]) => [q, priceOf(m)]);
      return send(res, 200, out);
    }

    if (req.method === "POST" && url === "/api/order") {
      const ip = req.socket.remoteAddress, now = Date.now();
      hits[ip] = (hits[ip] || []).filter(t => now - t < 60000);
      if (hits[ip].length >= 10) return send(res, 429, { error: "Terlalu banyak permintaan, coba lagi sebentar" });
      hits[ip].push(now);

      const b = await readBody(req), g = GAMES[b.game];
      const pack = g && g.packs.find(p => p[0] === Number(b.qty));
      const id = String(b.id || "").trim(), zone = String(b.zone || "").trim();
      if (!pack || !g.idRe.test(id) || (g.zone && !/^\d{3,6}$/.test(zone))) return send(res, 400, { error: "Data pesanan tidak valid" });

      const o = { id: "GS" + now.toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase(),
                  game: b.game, qty: pack[0], target: g.zone ? id + zone : id, account: g.zone ? `${id} (${zone})` : id,
                  total: priceOf(pack[1]), status: "pending", created: now };
      o.qr = (await createPayment(o)).qr;
      orders[o.id] = o; save();
      return send(res, 200, { id: o.id, total: o.total, qr: o.qr, mock: MOCK });
    }

    if (req.method === "GET" && url.startsWith("/api/order/")) {
      const o = orders[url.split("/").pop()];
      return o ? send(res, 200, { status: o.status, total: o.total }) : send(res, 404, { error: "Pesanan tidak ditemukan" });
    }

    if (req.method === "POST" && url.startsWith("/api/mock-pay/") && MOCK) {
      const o = orders[url.split("/").pop()];
      if (!o) return send(res, 404, { error: "Pesanan tidak ditemukan" });
      markPaid(o); return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url === "/api/webhook/midtrans") {
      const b = await readBody(req), o = orders[b.order_id];
      const sig = crypto.createHash("sha512").update(String(b.order_id) + b.status_code + b.gross_amount + MIDTRANS_KEY).digest("hex");
      if (!o || MOCK || sig !== b.signature_key || Number(b.gross_amount) !== o.total) return send(res, 403, { error: "invalid" });
      if (["settlement", "capture"].includes(b.transaction_status)) markPaid(o);
      else if (["expire", "cancel", "deny"].includes(b.transaction_status) && o.status === "pending") { o.status = "expired"; save(); }
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url === "/api/admin/orders") {
      const key = new URL(req.url, "http://x").searchParams.get("key");
      if (!ADMIN_KEY || key !== ADMIN_KEY) return send(res, 403, { error: "forbidden" });
      return send(res, 200, Object.values(orders).sort((a, b) => b.created - a.created).slice(0, 100));
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    console.error(e.message);
    send(res, 500, { error: "Terjadi kesalahan server" });
  }
}).listen(PORT, () => console.log(`GemShop jalan di http://localhost:${PORT}  [${MOCK ? "MODE UJI COBA" : "LIVE"}]`));
