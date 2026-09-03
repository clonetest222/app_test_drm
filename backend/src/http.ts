// Tien ich HTTP dung chung: doc IP that, tra JSON, tra loi co ma.
export const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Loi tra ve client CO CHU DICH nhung KHONG lo chi tiet noi bo. */
export function fail(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), { status, headers: JSON_HEADERS });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
  toResponse(): Response {
    return fail(this.status, this.code, this.message);
  }
}

export function clientIp(req: Request, info?: Deno.ServeHandlerInfo): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  const addr = info?.remoteAddr;
  return addr && "hostname" in addr ? addr.hostname : "unknown";
}

/** Log mot dong JSON — KHONG BAO GIO log password/secret. */
export function logLine(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}
