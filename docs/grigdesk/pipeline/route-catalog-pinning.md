# Каталог маршрутов сверяется внутри движка, а не в HTTP-preflight

`launch-options` и `factory check` — быстрый fail-fast, но current catalog может смениться
после любого из них. Авторитетное сравнение `expectedCatalogHash` происходит в
`_attempt_state_create_locked` под task lock; прочитанный там же hash становится пином
attempt/pins. Перечитывать current между сверкой и записью попытки нельзя — иначе пин снова
разъедется с тем, что показали человеку.

При расхождении движок печатает `FACTORY_ERROR=catalog_changed EXPECTED=… ACTUAL=…|none`,
не публикует attempt/registry, а GrigDesk освобождает свою новую slot reservation и отвечает
409 `catalog_changed`.
