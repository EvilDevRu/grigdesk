/* Проба 4 плана grigdesk-additional-platforms-tdd.md: ConPTY-helper.
 * Создаёт псевдоконсоль, запускает дочернюю копию, делает resize, посылает символ и
 * читает вывод. Код 0 — ConPTY работает; любой отказ — ненулевой код.
 * Сборка на runner/машине владельца: cl /W4 conpty-probe.c /link kernel32.lib
 * (MSVC) либо clang-cl conpty-probe.c -o conpty-probe.exe.
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

/*
 * Дочерний процесс подтверждает канал ввода и фактический размер окна.
 * Метка выводится после чтения символа и проверки размеров консоли.
 */
static int verifyConsole(void) {
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    CONSOLE_SCREEN_BUFFER_INFO screen;
    DWORD mode = 0, count = 0;
    WCHAR token;
    const WCHAR marker[] = L"conpty-probe-ok";

    if (!GetConsoleMode(input, &mode)
        || !SetConsoleMode(input, mode & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT))
        || !ReadConsoleW(input, &token, 1, &count, NULL) || count != 1 || token != L'q') {
        return 21;
    }
    if (!GetConsoleScreenBufferInfo(output, &screen)
        || screen.srWindow.Right - screen.srWindow.Left + 1 != 120
        || screen.srWindow.Bottom - screen.srWindow.Top + 1 != 40) {
        return 22;
    }

    return WriteConsoleW(output, marker, 15, &count, NULL) && count == 15 ? 0 : 23;
}

int wmain(int argc, WCHAR **argv) {
    if (argc == 2 && wcscmp(argv[1], L"--child") == 0) {
        return verifyConsole();
    }
    HRESULT hr;
    HPCON pseudo = NULL;
    COORD size = {80, 25};
    HANDLE inPipeRead = NULL, inPipeWrite = NULL;
    HANDLE outPipeRead = NULL, outPipeWrite = NULL;
    SECURITY_ATTRIBUTES sa;
    STARTUPINFOEXW si;
    PROCESS_INFORMATION pi;
    SIZE_T attrSize = 0;
    char buffer[4096];
    DWORD readBytes = 0;
    const char token = 'q';
    int ok = 0;

    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;

    if (!CreatePipe(&inPipeRead, &inPipeWrite, &sa, 0)) { return 1; }
    if (!CreatePipe(&outPipeRead, &outPipeWrite, &sa, 0)) { return 2; }

    hr = CreatePseudoConsole(size, inPipeRead, outPipeWrite, 0, &pseudo);
    if (FAILED(hr)) { return 3; }

    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    InitializeProcThreadAttributeList(NULL, 1, 0, &attrSize);
    si.lpAttributeList = (PPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, attrSize);
    if (si.lpAttributeList == NULL) { return 4; }
    if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &attrSize)) { return 5; }
    if (!UpdateProcThreadAttribute(si.lpAttributeList, 0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudo, sizeof(pseudo), NULL, NULL)) {
        return 6;
    }

    CloseHandle(inPipeRead);
    CloseHandle(outPipeWrite);
    WCHAR exe[MAX_PATH];
    WCHAR commandLine[MAX_PATH + 16];
    DWORD length = GetModuleFileNameW(NULL, exe, MAX_PATH);
    if (length == 0 || length >= MAX_PATH) { return 11; }
    if (swprintf_s(commandLine, MAX_PATH + 16, L"\"%ls\" --child", exe) < 0) { return 12; }
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(exe, commandLine, NULL, NULL, FALSE,
            EXTENDED_STARTUPINFO_PRESENT, NULL, NULL,
            &si.StartupInfo, &pi)) {
        return 7;
    }

    /* Resize псевдоконсоли — отдельная проверяемая операция. */
    COORD resized = {120, 40};
    if (FAILED(ResizePseudoConsole(pseudo, resized))) { return 8; }

    DWORD written = 0;
    if (!WriteFile(inPipeWrite, &token, 1, &written, NULL) || written != 1) { return 9; }

    /* Читаем вывод до появления метки; цикл ограничен, чтобы не зависнуть. */
    for (int i = 0; i < 200; i++) {
        DWORD available = 0;
        if (!PeekNamedPipe(outPipeRead, NULL, 0, NULL, &available, NULL)) { break; }
        if (available == 0) { Sleep(50); continue; }
        if (!ReadFile(outPipeRead, buffer, sizeof(buffer) - 1, &readBytes, NULL)) { break; }
        buffer[readBytes] = '\0';
        if (strstr(buffer, "conpty-probe-ok") != NULL) { ok = 1; break; }
    }

    CloseHandle(inPipeWrite);
    if (WaitForSingleObject(pi.hProcess, 5000) == WAIT_TIMEOUT) {
        TerminateProcess(pi.hProcess, 1);
    }
    DWORD childCode = 0;
    if (!GetExitCodeProcess(pi.hProcess, &childCode) || childCode != 0) {
        fprintf(stderr, "ConPTY child exit code: %lu\n", childCode);
        ok = 0;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    ClosePseudoConsole(pseudo);
    DeleteProcThreadAttributeList(si.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
    CloseHandle(outPipeRead);

    return ok ? 0 : 10;
}
