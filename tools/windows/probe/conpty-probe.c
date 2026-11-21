/* Проба 4 плана grigdesk-additional-platforms-tdd.md: ConPTY-helper.
 * Создаёт псевдоконсоль, запускает cmd.exe, делает resize, пишет команду и
 * читает вывод. Код 0 — ConPTY работает; любой отказ — ненулевой код.
 * Сборка на runner/машине владельца: cl /W4 conpty-probe.c /link kernel32.lib
 * (MSVC) либо clang-cl conpty-probe.c -o conpty-probe.exe.
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>

int main(void) {
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
    const char *command = "conpty-probe\r\n";
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
    WCHAR commandLine[] = L"cmd.exe /D /Q /V:ON /C \"set /P input= & echo !input!-ok\"";
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, commandLine, NULL, NULL, FALSE,
            EXTENDED_STARTUPINFO_PRESENT, NULL, NULL,
            &si.StartupInfo, &pi)) {
        return 7;
    }

    /* Resize псевдоконсоли — отдельная проверяемая операция. */
    COORD resized = {120, 40};
    if (FAILED(ResizePseudoConsole(pseudo, resized))) { return 8; }

    DWORD written = 0;
    if (!WriteFile(inPipeWrite, command, (DWORD)strlen(command), &written, NULL)) { return 9; }

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
    WaitForSingleObject(pi.hProcess, 5000);
    TerminateProcess(pi.hProcess, 0);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    ClosePseudoConsole(pseudo);
    DeleteProcThreadAttributeList(si.lpAttributeList);
    HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
    CloseHandle(outPipeRead);

    return ok ? 0 : 10;
}
