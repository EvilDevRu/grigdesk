# Workspace-исходники модельного плагина GLM

Исходный snapshot для llm-pi-ai должен содержать workspace dependencies и peers
плагина вместе с их транзитивным замыканием. Добавление только корня
`packages/llm/llm-pi-ai` к прежнему selection не гарантирует полноту snapshot.

В закреплённом Harness commit `c291e7961a515f6d7af9304e7fd1d257929aef26`
плагин объявляет peer `@deepseek-ai/dsh-authorization: workspace:^`.
Upstream pnpm lock разрешает его как `link:../../credentials/authorization`:
исходный корень — `packages/credentials/authorization`.

Проверенный кандидат с добавленным одним корнем плагина не содержит этот корень
ни в selection, ни в дереве исходников. `discoverRuntimeClosure` прекращает сборку:

```text
@deepseek-ai/dsh-llm-pi-ai: нет exact lock для @deepseek-ai/dsh-authorization workspace:^
```

Сообщение связано с отсутствующим workspace-пакетом в source index.
Lock содержит link-запись; её нельзя превратить во внешнюю npm exact-версию.
Сборщик не скачивает отсутствующий пакет и не пропускает dependency.
Исходный snapshot подготавливается штатным sync с полным selection того же commit.

Отказ обнаружен до компиляции и создания generation. Проверки unit/inventory,
typecheck и читаемости не заменяют проверку замыкания настоящего source snapshot.

Полный selection вычисляется той же функцией `discoverRuntimeClosure` на полном
исходнике закреплённого commit: её список пакетов сравнивается с прежним selection,
недостающие корни добавляются с причинами. Для этого commit не хватало ровно одного
корня — `packages/credentials/authorization`; после штатного sync с расширенным
selection сборка проходит, замыкание содержит 180 workspace-пакетов.
