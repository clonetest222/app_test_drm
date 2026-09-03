// Doi chieu THAT SU giua backend (Deno) va app (Node): Deno niem phong bi mot payload
// dung dung ham cua backend, roi goi node de mo bang dung thuat toan trong api.js.
// Neu 2 ben lech nhau 1 byte, app se khong doc noi credential -> phai bat loi o day,
// khong phai o may nguoi dung.
//
//   deno run --allow-run --allow-write --allow-read --allow-env scripts/interop_check.ts
import { deriveResponseKey, seal } from "../src/crypto.ts";

const deviceSecret = "a".repeat(64);          // dang device_secret that (64 hex)
const nonce = "0123456789abcdef0123456789abcdef";
const deviceId = "11111111-2222-3333-4444-555555555555";
const payload = { mode: "lease", lease_id: 7, account_id: 42, username: "steamuser", password: "p@ss w0rd!" };

const key = await deriveResponseKey(deviceSecret, nonce);
const box = await seal(key, JSON.stringify(payload), `resp:${deviceId}:${nonce}`);

// Ban sao chinh xac cua openSealed() trong api.js.
const nodeSrc = `
const crypto = require("crypto");
const box = ${JSON.stringify(box)};
const secret = ${JSON.stringify(deviceSecret)};
const nonce = ${JSON.stringify(nonce)};
const deviceId = ${JSON.stringify(deviceId)};
const key = Buffer.from(crypto.hkdfSync("sha256",
  Buffer.from(secret, "utf8"), Buffer.from(nonce, "utf8"),
  Buffer.from("g4play-denuvo-response-v1", "utf8"), 32));
const data = Buffer.from(box.ct, "base64");
const tag = data.subarray(data.length - 16);
const ct = data.subarray(0, data.length - 16);
const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
d.setAAD(Buffer.from("resp:" + deviceId + ":" + nonce, "utf8"));
d.setAuthTag(tag);
process.stdout.write(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
`;

const tmp = await Deno.makeTempFile({ suffix: ".cjs" });
await Deno.writeTextFile(tmp, nodeSrc);

const out = await new Deno.Command("node", { args: [tmp], stdout: "piped", stderr: "piped" }).output();
await Deno.remove(tmp);

const stdout = new TextDecoder().decode(out.stdout);
const stderr = new TextDecoder().decode(out.stderr);

if (!out.success) {
  console.error("NODE KHONG MO DUOC PHONG BI:\n" + stderr);
  Deno.exit(1);
}
const back = JSON.parse(stdout);
const same = JSON.stringify(back) === JSON.stringify(payload);
console.log(same ? "OK — Deno seal <-> Node open khop hoan toan." : "LECH!\n gui: " + JSON.stringify(payload) + "\n nhan: " + stdout);
Deno.exit(same ? 0 : 1);
