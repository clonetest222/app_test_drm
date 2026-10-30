// TU SINH - bang con tro ham that + init (include trong dllmain.cpp).
// Proxy cung ten 'dwmapi.dll' -> KHONG LoadLibrary thang System32\dwmapi.dll duoc
// (trung basename -> err 126). Nen copy ban that ra file temp ten khac roi nap ban copy.
// 1 FILE deploy duy nhat; ban copy sinh luc chay trong %TEMP%.
extern "C" void* g_realProcs[119] = {0};
static HMODULE g_realDwm = nullptr;
static wchar_t g_realDwmTmp[MAX_PATH] = {0};
static HMODULE loadRealDwmapi() {
    wchar_t sys[MAX_PATH] = {0}, tmpdir[MAX_PATH] = {0};
    if (!GetSystemDirectoryW(sys, MAX_PATH)) return nullptr;
    lstrcatW(sys, L"\\dwmapi.dll");
    if (!GetTempPathW(MAX_PATH, tmpdir)) return nullptr;
    // Don ban copy g4d*.tmp cu khong con bi khoa (process lan truoc da thoat) -> khong tich luy.
    {
        WIN32_FIND_DATAW fd; wchar_t pat[MAX_PATH];
        lstrcpyW(pat, tmpdir); lstrcatW(pat, L"g4d*.tmp");
        HANDLE hf = FindFirstFileW(pat, &fd);
        if (hf != INVALID_HANDLE_VALUE) {
            do { wchar_t old[MAX_PATH]; lstrcpyW(old, tmpdir); lstrcatW(old, fd.cFileName); DeleteFileW(old); }
            while (FindNextFileW(hf, &fd));
            FindClose(hf);
        }
    }
    if (!GetTempFileNameW(tmpdir, L"g4d", 0, g_realDwmTmp)) return nullptr;
    if (!CopyFileW(sys, g_realDwmTmp, FALSE)) return nullptr;   // ghi de file temp bang ban dwmapi that
    return LoadLibraryW(g_realDwmTmp);                          // basename khac 'dwmapi.dll' -> nap OK
}
static void initRealProcs() {
    g_realDwm = loadRealDwmapi();
    if (!g_realDwm) return;
    HMODULE m = g_realDwm;
    g_realProcs[0] = (void*)GetProcAddress(m, "DllCanUnloadNow");
    g_realProcs[1] = (void*)GetProcAddress(m, "DllGetClassObject");
    g_realProcs[2] = (void*)GetProcAddress(m, "DwmAttachMilContent");
    g_realProcs[3] = (void*)GetProcAddress(m, "DwmDefWindowProc");
    g_realProcs[4] = (void*)GetProcAddress(m, "DwmDetachMilContent");
    g_realProcs[5] = (void*)GetProcAddress(m, "DwmEnableBlurBehindWindow");
    g_realProcs[6] = (void*)GetProcAddress(m, "DwmEnableComposition");
    g_realProcs[7] = (void*)GetProcAddress(m, "DwmEnableMMCSS");
    g_realProcs[8] = (void*)GetProcAddress(m, "DwmExtendFrameIntoClientArea");
    g_realProcs[9] = (void*)GetProcAddress(m, "DwmFlush");
    g_realProcs[10] = (void*)GetProcAddress(m, "DwmGetColorizationColor");
    g_realProcs[11] = (void*)GetProcAddress(m, "DwmGetCompositionTimingInfo");
    g_realProcs[12] = (void*)GetProcAddress(m, "DwmGetGraphicsStreamClient");
    g_realProcs[13] = (void*)GetProcAddress(m, "DwmGetGraphicsStreamTransformHint");
    g_realProcs[14] = (void*)GetProcAddress(m, "DwmGetTransportAttributes");
    g_realProcs[15] = (void*)GetProcAddress(m, "DwmGetUnmetTabRequirements");
    g_realProcs[16] = (void*)GetProcAddress(m, "DwmGetWindowAttribute");
    g_realProcs[17] = (void*)GetProcAddress(m, "DwmInvalidateIconicBitmaps");
    g_realProcs[18] = (void*)GetProcAddress(m, "DwmIsCompositionEnabled");
    g_realProcs[19] = (void*)GetProcAddress(m, "DwmModifyPreviousDxFrameDuration");
    g_realProcs[20] = (void*)GetProcAddress(m, "DwmQueryThumbnailSourceSize");
    g_realProcs[21] = (void*)GetProcAddress(m, "DwmRegisterThumbnail");
    g_realProcs[22] = (void*)GetProcAddress(m, "DwmRenderGesture");
    g_realProcs[23] = (void*)GetProcAddress(m, "DwmSetDxFrameDuration");
    g_realProcs[24] = (void*)GetProcAddress(m, "DwmSetIconicLivePreviewBitmap");
    g_realProcs[25] = (void*)GetProcAddress(m, "DwmSetIconicThumbnail");
    g_realProcs[26] = (void*)GetProcAddress(m, "DwmSetPresentParameters");
    g_realProcs[27] = (void*)GetProcAddress(m, "DwmSetWindowAttribute");
    g_realProcs[28] = (void*)GetProcAddress(m, "DwmShowContact");
    g_realProcs[29] = (void*)GetProcAddress(m, "DwmTetherContact");
    g_realProcs[30] = (void*)GetProcAddress(m, "DwmTetherTextContact");
    g_realProcs[31] = (void*)GetProcAddress(m, "DwmTransitionOwnedWindow");
    g_realProcs[32] = (void*)GetProcAddress(m, "DwmUnregisterThumbnail");
    g_realProcs[33] = (void*)GetProcAddress(m, "DwmUpdateThumbnailProperties");
    g_realProcs[34] = (void*)GetProcAddress(m, "DwmpAllocateSecurityDescriptor");
    g_realProcs[35] = (void*)GetProcAddress(m, "DwmpDxGetWindowSharedSurface");
    g_realProcs[36] = (void*)GetProcAddress(m, "DwmpDxUpdateWindowSharedSurface");
    g_realProcs[37] = (void*)GetProcAddress(m, "DwmpDxgiIsThreadDesktopComposited");
    g_realProcs[38] = (void*)GetProcAddress(m, "DwmpEnableDDASupport");
    g_realProcs[39] = (void*)GetProcAddress(m, "DwmpFreeSecurityDescriptor");
    g_realProcs[40] = (void*)GetProcAddress(m, "DwmpGetColorizationParameters");
    g_realProcs[41] = (void*)GetProcAddress(m, "DwmpRenderFlick");
    g_realProcs[42] = (void*)GetProcAddress(m, "DwmpSetColorizationParameters");
    g_realProcs[43] = (void*)GetProcAddress(m, "DwmpUpdateProxyWindowForCapture");
    g_realProcs[44] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)103); // NONAME
    g_realProcs[45] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)104); // NONAME
    g_realProcs[46] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)105); // NONAME
    g_realProcs[47] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)106); // NONAME
    g_realProcs[48] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)107); // NONAME
    g_realProcs[49] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)108); // NONAME
    g_realProcs[50] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)109); // NONAME
    g_realProcs[51] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)110); // NONAME
    g_realProcs[52] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)112); // NONAME
    g_realProcs[53] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)113); // NONAME
    g_realProcs[54] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)114); // NONAME
    g_realProcs[55] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)124); // NONAME
    g_realProcs[56] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)132); // NONAME
    g_realProcs[57] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)138); // NONAME
    g_realProcs[58] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)139); // NONAME
    g_realProcs[59] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)140); // NONAME
    g_realProcs[60] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)141); // NONAME
    g_realProcs[61] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)142); // NONAME
    g_realProcs[62] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)144); // NONAME
    g_realProcs[63] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)145); // NONAME
    g_realProcs[64] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)147); // NONAME
    g_realProcs[65] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)148); // NONAME
    g_realProcs[66] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)150); // NONAME
    g_realProcs[67] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)151); // NONAME
    g_realProcs[68] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)152); // NONAME
    g_realProcs[69] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)153); // NONAME
    g_realProcs[70] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)154); // NONAME
    g_realProcs[71] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)155); // NONAME
    g_realProcs[72] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)157); // NONAME
    g_realProcs[73] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)158); // NONAME
    g_realProcs[74] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)159); // NONAME
    g_realProcs[75] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)160); // NONAME
    g_realProcs[76] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)161); // NONAME
    g_realProcs[77] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)162); // NONAME
    g_realProcs[78] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)163); // NONAME
    g_realProcs[79] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)164); // NONAME
    g_realProcs[80] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)165); // NONAME
    g_realProcs[81] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)166); // NONAME
    g_realProcs[82] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)167); // NONAME
    g_realProcs[83] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)168); // NONAME
    g_realProcs[84] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)169); // NONAME
    g_realProcs[85] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)170); // NONAME
    g_realProcs[86] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)171); // NONAME
    g_realProcs[87] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)172); // NONAME
    g_realProcs[88] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)173); // NONAME
    g_realProcs[89] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)174); // NONAME
    g_realProcs[90] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)175); // NONAME
    g_realProcs[91] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)176); // NONAME
    g_realProcs[92] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)177); // NONAME
    g_realProcs[93] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)178); // NONAME
    g_realProcs[94] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)179); // NONAME
    g_realProcs[95] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)180); // NONAME
    g_realProcs[96] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)181); // NONAME
    g_realProcs[97] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)182); // NONAME
    g_realProcs[98] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)184); // NONAME
    g_realProcs[99] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)185); // NONAME
    g_realProcs[100] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)186); // NONAME
    g_realProcs[101] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)187); // NONAME
    g_realProcs[102] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)188); // NONAME
    g_realProcs[103] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)189); // NONAME
    g_realProcs[104] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)190); // NONAME
    g_realProcs[105] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)191); // NONAME
    g_realProcs[106] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)192); // NONAME
    g_realProcs[107] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)193); // NONAME
    g_realProcs[108] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)194); // NONAME
    g_realProcs[109] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)195); // NONAME
    g_realProcs[110] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)196); // NONAME
    g_realProcs[111] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)197); // NONAME
    g_realProcs[112] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)198); // NONAME
    g_realProcs[113] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)199); // NONAME
    g_realProcs[114] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)200); // NONAME
    g_realProcs[115] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)201); // NONAME
    g_realProcs[116] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)202); // NONAME
    g_realProcs[117] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)203); // NONAME
    g_realProcs[118] = (void*)GetProcAddress(m, (LPCSTR)(ULONG_PTR)204); // NONAME
}
