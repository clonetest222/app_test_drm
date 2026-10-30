// Parser TOML toi gian — chi du de doc dinh dang steam-monitor xuat ra:
//   [section]
//   key = "value"      (hoac so khong ngoac)
// Khong ho tro array/nested/multiline. Giu nguyen thu tu section.
#pragma once
#include <string>
#include <vector>
#include <map>
#include <cstdint>
#include <cstdlib>

namespace g4::toml {

struct Section {
    std::string name;                         // vd "CheckAppOwnership" hoac "IClientUser.GetAppID"
    std::map<std::string, std::string> kv;    // name/rva/sig/method_index/vtable_rva...
};

inline std::string trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return "";
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

inline std::string unquote(std::string v) {
    v = trim(v);
    if (v.size() >= 2 && v.front() == '"' && v.back() == '"') return v.substr(1, v.size() - 2);
    return v;
}

inline std::vector<Section> parse(const std::string& text) {
    std::vector<Section> out;
    size_t i = 0;
    auto line = [&]() -> std::string {
        size_t e = text.find('\n', i);
        std::string l = text.substr(i, e == std::string::npos ? std::string::npos : e - i);
        i = (e == std::string::npos) ? text.size() : e + 1;
        return l;
    };
    while (i < text.size()) {
        std::string l = trim(line());
        if (l.empty() || l[0] == '#') continue;
        if (l.front() == '[' && l.back() == ']') {
            out.push_back(Section{ l.substr(1, l.size() - 2), {} });
        } else if (!out.empty()) {
            size_t eq = l.find('=');
            if (eq != std::string::npos) {
                std::string k = trim(l.substr(0, eq));
                std::string v = unquote(l.substr(eq + 1));
                out.back().kv[k] = v;
            }
        }
    }
    return out;
}

// Chuyen "0x1234" / "4660" -> so.
inline uint64_t toU64(const std::string& s) {
    if (s.empty()) return 0;
    return (s.size() > 1 && (s[1] == 'x' || s[1] == 'X'))
        ? std::strtoull(s.c_str(), nullptr, 16)
        : std::strtoull(s.c_str(), nullptr, 10);
}

} // namespace g4::toml
