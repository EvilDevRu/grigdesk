# Guard данных и внешние команды payload

Ранний startDataHome проверяет размещение D относительно runtimeInstallationRoot(),
а owner server.lock продолжает хранить фактический ресурсный R. Это допускает
R внутри D/runtimes/server/packages, сохраняя прежний запрет D внутри I и source-кода внутри D.
Общий checkPlacement не ослаблен. DataHomeCheck без --code-root использует I;
явный аргумент сохраняет прежнее source-поведение.

Config публикует installationBin и выбирает DeepSeek от I/bin. Explicit override сохраняется.
Fallback selectedDeepSeekBinary без config тоже использует физическую установку;
rootDir fallback применяется только к source. GrigDeskCliPath принимает явный binDirectory,
app и Factory передают installationBin. Module URLs и ресурсы продолжают использовать R.
