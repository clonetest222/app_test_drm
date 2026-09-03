// Cat mat khau khoi moi dong account TRUOC khi tra ra bat ky endpoint nao.
//
// De rieng mot file, khong import config/DB, vi 2 ly do:
//   1. test chong ro ri (leak_test.ts) chay duoc ma khong can bien moi truong;
//   2. de doc review - chi can nhin 1 ham nay la biet API co lo mat khau khong.
import type { AccountRow } from "./supabase.ts";

export function maskAccount(a: AccountRow): Record<string, unknown> {
  return {
    id: a.id,
    appid: a.appid,
    username: a.username,
    status: a.status,
    // Chi bao CO hay KHONG, khong bao gio bao la gi.
    co_mat_khau: !!((a.password && a.password.length > 0) || a.password_enc),
    da_ma_hoa: !!a.password_enc,
  };
}
