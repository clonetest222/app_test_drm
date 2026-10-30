// Ban du phong cua Deno KV, chay trong bo nho.
//
// Vi sao can: Deno Deploy bat phai GAN mot KV database trong dashboard truoc,
// khong gan thi Deno.openKv() nem loi va app chet ngay luc khoi dong. Mot buoc
// bam nut nua truoc khi chay duoc la khong dang.
//
// Nen: khong co KV -> dung cai nay, backend van chay binh thuong.
// Khac biet duy nhat: state mat khi isolate khoi dong lai
//   * thiet bi phai dang ky lai  -> app tu lam, khong ai thay gi (api.js bat
//     loi unknown_device roi dang ky lai va thu lai request)
//   * bo dem rate limit ve 0     -> yeu di, khong hong
//   * audit log mat              -> mat dau vet, tiec nhung khong chan viec gi
//
// Gan KV trong dashboard (Databases > attach) thi tu dong dung KV that va cac
// han che tren bien mat. Khong phai sua code.
//
// Chi hien thuc dung nhung gi kv.ts goi toi, khong hon.

type Key = readonly unknown[];
interface Entry { value: unknown; versionstamp: string; expiresAt: number }

const enc = (k: Key) => JSON.stringify(k);

/** So sanh khoa theo tung phan tu — de list() tra ve dung thu tu nhu KV that. */
function cmpKey(a: Key, b: Key): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      const sx = String(x), sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

export class MemKv {
  #map = new Map<string, { key: Key; entry: Entry }>();
  #seq = 0;

  #alive(k: string): { key: Key; entry: Entry } | null {
    const rec = this.#map.get(k);
    if (!rec) return null;
    if (rec.entry.expiresAt && rec.entry.expiresAt < Date.now()) {
      this.#map.delete(k);
      return null;
    }
    return rec;
  }

  // deno-lint-ignore require-await
  async get<T>(key: Key): Promise<{ key: Key; value: T | null; versionstamp: string | null }> {
    const rec = this.#alive(enc(key));
    return { key, value: (rec?.entry.value as T) ?? null, versionstamp: rec?.entry.versionstamp ?? null };
  }

  async getMany<T>(keys: Key[]): Promise<{ key: Key; value: T | null; versionstamp: string | null }[]> {
    return await Promise.all(keys.map((k) => this.get<T>(k)));
  }

  // deno-lint-ignore require-await
  async set(key: Key, value: unknown, opts?: { expireIn?: number }): Promise<{ ok: true }> {
    this.#map.set(enc(key), {
      key,
      entry: {
        value,
        versionstamp: String(++this.#seq).padStart(20, "0"),
        expiresAt: opts?.expireIn ? Date.now() + opts.expireIn : 0,
      },
    });
    return { ok: true };
  }

  // deno-lint-ignore require-await
  async delete(key: Key): Promise<void> {
    this.#map.delete(enc(key));
  }

  async *list<T>(
    sel: { prefix: Key },
    opts?: { limit?: number },
  ): AsyncIterableIterator<{ key: Key; value: T }> {
    const p = sel.prefix;
    const hits = [...this.#map.values()]
      .filter((r) => this.#alive(enc(r.key)))
      .filter((r) => r.key.length >= p.length && p.every((seg, i) => r.key[i] === seg))
      .sort((a, b) => cmpKey(a.key, b.key));
    let n = 0;
    for (const r of hits) {
      if (opts?.limit && n++ >= opts.limit) break;
      yield { key: r.key, value: r.entry.value as T };
    }
  }

  atomic(): MemAtomic {
    return new MemAtomic(this);
  }

  /** Cho MemAtomic dung — khong phai API cong khai. */
  _peek(key: Key): Entry | null {
    return this.#alive(enc(key))?.entry ?? null;
  }
}

type Op =
  | { t: "set"; key: Key; value: unknown; opts?: { expireIn?: number } }
  | { t: "sum"; key: Key; by: bigint };

class MemAtomic {
  #checks: { key: Key; versionstamp: string | null }[] = [];
  #ops: Op[] = [];
  constructor(private kv: MemKv) {}

  check(...cs: { key: Key; versionstamp: string | null }[]): this {
    this.#checks.push(...cs);
    return this;
  }
  set(key: Key, value: unknown, opts?: { expireIn?: number }): this {
    this.#ops.push({ t: "set", key, value, opts });
    return this;
  }
  sum(key: Key, by: bigint): this {
    this.#ops.push({ t: "sum", key, by });
    return this;
  }

  async commit(): Promise<{ ok: boolean }> {
    for (const c of this.#checks) {
      const cur = this.kv._peek(c.key);
      if ((cur?.versionstamp ?? null) !== c.versionstamp) return { ok: false };
    }
    for (const op of this.#ops) {
      if (op.t === "set") {
        await this.kv.set(op.key, op.value, op.opts);
      } else {
        // Khong dung Deno.KvU64: kieu do chi co khi KV bat. Cong bang so thuong.
        const cur = this.kv._peek(op.key)?.value;
        const base = typeof cur === "number" ? BigInt(cur) : 0n;
        await this.kv.set(op.key, Number(base + op.by));
      }
    }
    return { ok: true };
  }
}
