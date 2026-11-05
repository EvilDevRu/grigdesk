# ttNNNN.pipeline — призраки

В `~/.factory/state` есть файлы с двойным префиксом `tt*` (баг двойного `t`). Глоб задач —
строго `^t(\d+)\.pipeline$` (см. `FactoryStateAdapter.listTaskIds`), призраки отсекаются.
