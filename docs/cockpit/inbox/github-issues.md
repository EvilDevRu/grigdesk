# GitHub Issues

V1 подключает один repository `github.com` и принимает только `issues/opened`. Один issue —
одно сообщение/item, `settleMs=0`; pull requests, comments, edits и attachments не входят
в v1. Allowlist содержит exact repository owner и выбранный B24 project.

У rule есть отдельный additive opt-in `agentSearch`.

Этот opt-in относится только к будущему внешнему корпусу GitHub.

Старый файл без поля и новое правило
нормализуются в `agentSearch: false`; человеческий Inbox от него не зависит. Обычный
`PUT /api/github/rules` не принимает это поле и при редактировании kind/B24 сохраняет
его текущее server-owned значение; перенос rule в другой project fail-closed сбрасывает
opt-in. Переключение доступно только отдельной ручкой
`PUT /api/github/rules/agent-search` с exact `repositoryId`, boolean `enabled` и CAS по
`expectedPolicyFingerprint`, полученному из `GET /api/github/rules`. Canonical SHA-256
fingerprint включает account, repository и всю нормализованную policy, в том числе
`agentSearch`; stale форма получает `409 github_rules_stale_policy`. Этот CAS-контракт не
подменяет будущие durable policy epoch и `PolicyScopeFence`: до их появления агентский
поиск по внешнему корпусу не считается готовым к production.

`POST /api/github/connect` проверяет repository через authenticated REST, использует
immutable `repository.id`, создаёт управляемый webhook только на operator-owned HTTPS
callback и завершает connection лишь после signed ping на
`POST /hooks/github/:ingressRef`. HMAC-SHA256 проверяется по exact raw body до JSON parse.
Ingress также сверяет hook ID, target/repository ID, generation и delivery GUID.

Dedupe durable по двум ключам: transport `X-GitHub-Delivery` и semantic
`repository.id + issue.id`. После connect/start и затем раз в пять минут bounded REST
reconciliation восстанавливает потерянные webhook deliveries; pull requests отбрасываются.
При недостижимой сохранённой boundary cursor не продвигается и канал становится degraded.
Issues REST возвращает mutable текущую проекцию: обычный edit уже известного issue является
semantic duplicate/no-op. Первый принятый snapshot остаётся immutable, archive sequence и
activation не двигаются, а повторная reconciliation продолжает работу без ложного conflict.

Disconnect немедленно закрывает локальный ingress, затем удаляет только сохранённый remote
hook. Если GitHub недоступен, состояние становится `remote_cleanup_pending`; повторный
disconnect повторяет cleanup. Operator-only `POST /api/github/force-forget` требует
`{"confirmOrphanHook":true}` и допускает оставшийся remote orphan hook. Account data purge
в v1 отсутствует.

До реального connect оператор задаёт `COCKPIT_GITHUB_WEBHOOK_BASE_URL` как публичный HTTPS
base без query/fragment, создаёт fine-grained PAT для одного repository с Metadata read,
Issues read и Webhooks write, затем выбирает B24 project в rules и явно активирует GitHub
на `/inbox`. Код, тесты и установка сами remote webhook не создают.

Источник до переноса: docs/cockpit/inbox.md § GitHub Issues
