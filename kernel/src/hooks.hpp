// Cai hook len steamclient qua MinHook, dua tren dia chi do Resolver tra ve.
#pragma once
#include "resolver.hpp"

namespace g4::hooks {

// Nap ticket tu CA HAI nguon roi cai hook:
//   <steamDir>\cwk\*.cwk                          (block lua da ma hoa)
//   <steamDir>\config\{lua,stplug-in}\denuvo_g4play.lua  (block lua tron)
// steamDir = thu muc chua dwmapi.dll = thu muc Steam (xem dllmain.cpp).
bool install(Resolver& r, const std::wstring& steamDir);
void uninstall();

} // namespace g4::hooks
