/* ============================================================
 *  CheatTestWindow.cpp
 *  内存扫描 / 注入测试目标程序（Win32 原生 API，纯 C++）
 *
 *  MSVC 编译：
 *      cl /EHsc /O2 /DUNICODE /D_UNICODE CheatTestWindow.cpp ^
 *         /link user32.lib gdi32.lib
 *
 *  MinGW 编译：
 *      g++ -O2 -DUNICODE -D_UNICODE CheatTestWindow.cpp ^
 *          -o CheatTestWindow.exe -lgdi32 -luser32 -mwindows
 * ============================================================ */

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")

/* ============================================================
 *  一、目标数据（供内存扫描器练手）
 *  ------------------------------------------------------------
 *  volatile 用于阻止编译器把值缓存到寄存器，
 *  保证外部进程写入内存后，本程序能立刻读到新值。
 * ============================================================ */

/* --- 1. 独立标量变量 --- */
volatile int   g_hp    = 100;      /* 当前血量      */
volatile int   g_maxHp = 100;      /* 最大血量      */
volatile int   g_mp    = 50;       /* 魔法值        */
volatile int   g_gold  = 1234;     /* 金币          */
volatile int   g_level = 7;        /* 等级          */
volatile float g_posX  = 100.25f;  /* X 坐标        */
volatile float g_posY  = 250.75f;  /* Y 坐标        */
volatile float g_speed = 5.5f;     /* 移动速度      */

/* --- 2. 结构体对象 --- */
struct PlayerStats
{
    int   hp;      /* +0x00 */
    int   mp;      /* +0x04 */
    int   gold;    /* +0x08 */
    float x;       /* +0x0C */
    float y;       /* +0x10 */
};

PlayerStats  g_stats      = { 777, 333, 9999, 12.5f, 34.5f };

/* --- 3. 指针（用于多级指针扫描 / 指针链测试） --- */
PlayerStats* g_pStats     = &g_stats;   /* 指向 .data 段 */
PlayerStats* g_pHeapStats = NULL;       /* 指向堆上对象  */

/* ============================================================
 *  二、界面控件 ID
 * ============================================================ */
#define IDC_INFO        1001
#define IDC_BTN_DMG     1002
#define IDC_BTN_HEAL    1003
#define IDC_BTN_MOVE    1004
#define IDC_BTN_RESET   1005
#define TIMER_TICK      1

static HFONT g_hFont = NULL;
static HWND  g_hInfo = NULL;

/* ============================================================
 *  三、游戏逻辑模拟
 * ============================================================ */
static void ResetData(void)
{
    g_hp    = 100;
    g_maxHp = 100;
    g_mp    = 50;
    g_gold  = 1234;
    g_level = 7;
    g_posX  = 100.25f;
    g_posY  = 250.75f;
    g_speed = 5.5f;

    g_stats.hp   = 777;
    g_stats.mp   = 333;
    g_stats.gold = 9999;
    g_stats.x    = 12.5f;
    g_stats.y    = 34.5f;

    if (g_pHeapStats)
    {
        g_pHeapStats->hp   = 4242;
        g_pHeapStats->mp   = 1111;
        g_pHeapStats->gold = 8888;
        g_pHeapStats->x    = 3.25f;
        g_pHeapStats->y    = 9.75f;
    }
}

/* 每 100ms 调用一次 */
static void GameTick(void)
{
    static int tick = 0;
    tick++;

    /* 每 1 秒：血量自然衰减，金币自动增长（模拟游戏主循环） */
    if (tick % 10 == 0)
    {
        if (g_hp > 1)
            g_hp = g_hp - 1;          /* 被冻结时不会下降 —— 正好用于验证锁定功能 */
        g_gold = g_gold + 10;
        g_mp   = (g_mp + 1) % 100;
    }

    /* 每 0.5 秒：结构体浮点坐标漂移（用于测试浮点扫描） */
    if (tick % 5 == 0)
    {
        g_stats.x += 0.5f;
        if (g_stats.x > 200.0f)
            g_stats.x = 0.0f;
    }
}

/* ============================================================
 *  四、界面信息刷新
 * ============================================================ */
#define ADDR(p)  ((unsigned long long)(uintptr_t)(p))

static void UpdateInfo(HWND hwnd)
{
    wchar_t buf[4096];

    DWORD  pid  = GetCurrentProcessId();
    HMODULE hMod = GetModuleHandleW(NULL);
    unsigned long long base = (unsigned long long)(uintptr_t)hMod;

    PlayerStats* ph = g_pHeapStats;

    swprintf(buf, 4096,
        L"PID        : %lu\r\n"
        L"ImageBase  : 0x%016llX\r\n"
        L"==========================================\r\n"
        L"[ 独立变量 ]\r\n"
        L"  g_hp     = %-8d @ 0x%016llX\r\n"
        L"  g_maxHp  = %-8d @ 0x%016llX\r\n"
        L"  g_mp     = %-8d @ 0x%016llX\r\n"
        L"  g_gold   = %-8d @ 0x%016llX\r\n"
        L"  g_level  = %-8d @ 0x%016llX\r\n"
        L"  g_posX   = %-8.2f @ 0x%016llX\r\n"
        L"  g_posY   = %-8.2f @ 0x%016llX\r\n"
        L"  g_speed  = %-8.2f @ 0x%016llX\r\n"
        L"==========================================\r\n"
        L"[ 结构体 g_stats  sizeof=%u ]\r\n"
        L"  &g_stats = 0x%016llX\r\n"
        L"    .hp    = %-8d @ 0x%016llX\r\n"
        L"    .mp    = %-8d @ 0x%016llX\r\n"
        L"    .gold  = %-8d @ 0x%016llX\r\n"
        L"    .x     = %-8.2f @ 0x%016llX\r\n"
        L"    .y     = %-8.2f @ 0x%016llX\r\n"
        L"==========================================\r\n"
        L"[ 指针（多级指针测试） ]\r\n"
        L"  &g_pStats     = 0x%016llX\r\n"
        L"   g_pStats     = 0x%016llX -> hp = %d\r\n"
        L"  &g_pHeapStats = 0x%016llX\r\n"
        L"   g_pHeapStats = 0x%016llX -> hp = %d\r\n",

        pid, base,

        (int)g_hp,    ADDR(&g_hp),
        (int)g_maxHp, ADDR(&g_maxHp),
        (int)g_mp,    ADDR(&g_mp),
        (int)g_gold,  ADDR(&g_gold),
        (int)g_level, ADDR(&g_level),
        (double)g_posX,  ADDR(&g_posX),
        (double)g_posY,  ADDR(&g_posY),
        (double)g_speed, ADDR(&g_speed),

        (unsigned)sizeof(PlayerStats),
        ADDR(&g_stats),
        g_stats.hp,   ADDR(&g_stats.hp),
        g_stats.mp,   ADDR(&g_stats.mp),
        g_stats.gold, ADDR(&g_stats.gold),
        (double)g_stats.x, ADDR(&g_stats.x),
        (double)g_stats.y, ADDR(&g_stats.y),

        ADDR(&g_pStats),
        ADDR(g_pStats),    g_pStats ? g_pStats->hp : 0,
        ADDR(&g_pHeapStats),
        ADDR(ph),          ph ? ph->hp : 0
    );

    SetWindowTextW(g_hInfo, buf);
}

/* ============================================================
 *  五、窗口过程
 * ============================================================ */
LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg)
    {
    case WM_CREATE:
    {
        HINSTANCE hInst = ((LPCREATESTRUCTW)lParam)->hInstance;
        wchar_t title[160];

        swprintf(title, 160,
                 L"内存扫描测试目标  [PID: %lu]  —  Node Cheat Engine Test",
                 GetCurrentProcessId());
        SetWindowTextW(hwnd, title);

        /* 等宽字体，方便看地址 */
        g_hFont = CreateFontW(-15, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                              DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
                              CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY,
                              FIXED_PITCH | FF_MODERN, L"Consolas");
        if (!g_hFont)
            g_hFont = (HFONT)GetStockObject(DEFAULT_GUI_FONT);

        /* 信息显示区 */
        g_hInfo = CreateWindowExW(
            WS_EX_CLIENTEDGE, L"STATIC", L"",
            WS_CHILD | WS_VISIBLE | SS_LEFT,
            10, 10, 620, 400,
            hwnd, (HMENU)(INT_PTR)IDC_INFO, hInst, NULL);
        SendMessageW(g_hInfo, WM_SETFONT, (WPARAM)g_hFont, TRUE);

        /* 按钮组 */
        {
            const wchar_t* names[4] = { L"掉血 -10", L"回血 +10",
                                        L"随机移动",  L"重置数据" };
            int ids[4] = { IDC_BTN_DMG, IDC_BTN_HEAL,
                           IDC_BTN_MOVE, IDC_BTN_RESET };

            for (int i = 0; i < 4; ++i)
            {
                HWND hb = CreateWindowExW(
                    0, L"BUTTON", names[i],
                    WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                    10 + i * 156, 420, 146, 34,
                    hwnd, (HMENU)(INT_PTR)ids[i], hInst, NULL);
                SendMessageW(hb, WM_SETFONT, (WPARAM)g_hFont, TRUE);
            }
        }

        SetTimer(hwnd, TIMER_TICK, 100, NULL);
        UpdateInfo(hwnd);
        return 0;
    }

    case WM_TIMER:
        if (wParam == TIMER_TICK)
        {
            GameTick();
            UpdateInfo(hwnd);
        }
        return 0;

    case WM_COMMAND:
        switch (LOWORD(wParam))
        {
        case IDC_BTN_DMG:
            g_hp = g_hp - 10;
            if (g_hp < 0) g_hp = 0;
            break;

        case IDC_BTN_HEAL:
            g_hp = g_hp + 10;
            if (g_hp > g_maxHp) g_hp = g_maxHp;
            break;

        case IDC_BTN_MOVE:
            g_posX = (float)(rand() % 1000) + 0.5f;
            g_posY = (float)(rand() % 1000) + 0.25f;
            g_stats.x = g_posX;
            g_stats.y = g_posY;
            if (g_pHeapStats)
            {
                g_pHeapStats->x = g_posX * 0.5f;
                g_pHeapStats->y = g_posY * 0.5f;
            }
            break;

        case IDC_BTN_RESET:
            ResetData();
            break;

        default:
            break;
        }
        UpdateInfo(hwnd);
        return 0;

    case WM_CTLCOLORSTATIC:
        SetBkMode((HDC)wParam, TRANSPARENT);
        SetTextColor((HDC)wParam, RGB(0, 0, 0));
        return (LRESULT)GetStockObject(WHITE_BRUSH);

    case WM_DESTROY:
        KillTimer(hwnd, TIMER_TICK);
        if (g_hFont)
        {
            DeleteObject(g_hFont);
            g_hFont = NULL;
        }
        if (g_pHeapStats)
        {
            HeapFree(GetProcessHeap(), 0, g_pHeapStats);
            g_pHeapStats = NULL;
        }
        PostQuitMessage(0);
        return 0;

    default:
        break;
    }

    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

/* ============================================================
 *  六、入口点
 * ============================================================ */
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance,
                   LPSTR lpCmdLine, int nCmdShow)
{
    (void)hPrevInstance;
    (void)lpCmdLine;

    srand(GetTickCount());

    /* 在堆上再放一份数据，用于测试堆内存扫描 */
    g_pHeapStats = (PlayerStats*)HeapAlloc(GetProcessHeap(),
                                           HEAP_ZERO_MEMORY,
                                           sizeof(PlayerStats));
    if (g_pHeapStats)
    {
        g_pHeapStats->hp   = 4242;
        g_pHeapStats->mp   = 1111;
        g_pHeapStats->gold = 8888;
        g_pHeapStats->x    = 3.25f;
        g_pHeapStats->y    = 9.75f;
    }

    WNDCLASSEXW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.cbSize        = sizeof(wc);
    wc.style         = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc   = WndProc;
    wc.hInstance     = hInstance;
    wc.hCursor       = LoadCursorW(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
    wc.lpszClassName = L"CheatTestWndClass";
    wc.hIcon         = LoadIconW(NULL, IDI_APPLICATION);
    wc.hIconSm       = LoadIconW(NULL, IDI_APPLICATION);

    if (!RegisterClassExW(&wc))
    {
        MessageBoxW(NULL, L"注册窗口类失败！", L"错误", MB_ICONERROR);
        return 1;
    }

    RECT rc = { 0, 0, 640, 480 };
    AdjustWindowRect(&rc, WS_OVERLAPPEDWINDOW, FALSE);

    HWND hwnd = CreateWindowExW(
        0,
        L"CheatTestWndClass",
        L"内存扫描测试目标",
        WS_OVERLAPPEDWINDOW & ~WS_MAXIMIZEBOX & ~WS_THICKFRAME,
        CW_USEDEFAULT, CW_USEDEFAULT,
        rc.right - rc.left, rc.bottom - rc.top,
        NULL, NULL, hInstance, NULL);

    if (!hwnd)
    {
        MessageBoxW(NULL, L"创建窗口失败！", L"错误", MB_ICONERROR);
        return 1;
    }

    ShowWindow(hwnd, nCmdShow);
    UpdateWindow(hwnd);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0)
    {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    return (int)msg.wParam;
}