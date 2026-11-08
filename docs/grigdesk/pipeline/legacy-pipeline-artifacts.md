# ttNNNN.pipeline — призраки

В старом `~/.factory/state` встречались файлы с двойным префиксом `tt*` (баг двойного `t`):
после переноса данных в `~/.grigdesk/factory/state` таких файлов нет. Глоб задач —
строго `^t(\d+)\.pipeline$` (см. `FactoryStateAdapter.listTaskIds`), призраки отсекаются.
