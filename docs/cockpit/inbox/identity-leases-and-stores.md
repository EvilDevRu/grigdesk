# Identity, leases и stores

Provider identity подтверждает сам provider:

~~~text
Telegram = [1, "api.telegram.org", "bot", bot.id]
GitHub   = [1, "github.com", "repository", repository.id]
~~~

Display username, repository name и присланный клиентом ID security identity не являются.
Durable bindings связывают provider identity со случайным `accountRef`. Все Inbox refs
типизированы и включают owner:

~~~text
messageRef = [1, "message", channel, accountRef, sourceId, messageId]
itemRef    = [1, "item",    channel, accountRef, localBundleId]
scopeRef   = [1, "scope",   channel, accountRef, policyScopeId]
~~~

Каждая list/action операция захватывает immutable lease конкретных
`accountRef + generation + stores`. Switch сначала переводит прежнюю generation в
draining, запрещает новые leases и ждёт уже выданные. Перед HTTP response, durable commit
и внешним side effect выполняется generation check; поздний результат прежнего аккаунта
целиком отбрасывается.

Нативная mutation формы дополнительно присылает увиденный `botId`/`repositoryId` как
optimistic CAS. Server никогда не выбирает по нему namespace: он сначала захватывает
immutable lease, сравнивает provider ID с lease и live connection и только затем пишет.
Поэтому старая вкладка не может очистить rules или сменить service chat уже подключённого
другого account даже пустым payload. У Telegram rules есть второй CAS: `GET
/api/telegram/rules` отдаёт canonical `policyFingerprint`, а обычный `PUT` обязан вернуть
exact увиденное значение. Compare и durable atomic write сериализованы внутри account
store; устаревшая форма получает `409 telegram_rules_stale`, а не затирает новую policy.

~~~text
telegram/
  account-bindings.json
  accounts/<accountRef>/
    state.json
    archive/<chatId>/YYYY-MM.ndjson
    rules.json
    bot-settings.json
    inbox-state.json

github/
  account-bindings.json
  accounts/<accountRef>/
    archive/issues.ndjson
    ingress-state.json
    rules.json
    inbox-state.json

server/.state/
  telegram-account-creds.json
  github-creds.json
~~~

Files с credentials имеют режим `0600`; они не лежат в prefs и не попадают в browser DTO.
Runtime открывает только account-aware paths и актуальные owner-bound schemas. Flat stores,
старый credential и старые schemas он не импортирует, не читает и не удаляет.

Источник до переноса: docs/cockpit/inbox.md § Identity, leases и stores
