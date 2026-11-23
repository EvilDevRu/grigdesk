package graphworkflow

import "encoding/json"

// BuiltinTemplate — предустановленный маршрут первой поставки, только чтение.
type BuiltinTemplate struct {
	ID        string
	Title     string
	InputKind string
	Document  json.RawMessage
}

const documentsTemplate = `{
  "title":"Разбор документов","inputKind":"documents","scope":{"returns":["report"],"steps":[
    {"id":"inventory","title":"Список файлов","kind":"input","reads":["$inputs"]},
    {"id":"files","title":"По документу","kind":"forEach","needs":["inventory"],"source":"inventory","scope":{
      "returns":["parts"],"steps":[
        {"id":"sections","title":"Выделить разделы","kind":"sections","reads":["$item"]},
        {"id":"parts","title":"По разделу","kind":"forEach","needs":["sections"],"source":"sections","scope":{
          "returns":["summary"],"steps":[{"id":"summary","title":"Краткое содержание","kind":"agent",
            "reads":["$item"],"prompt":"Кратко опиши содержание раздела и укажи исходный фрагмент."}]
        }}
      ]
    }},
    {"id":"report","title":"Собрать результаты","kind":"join","mode":"all","needs":["files"]}
  ]}
}`

const meetingTemplate = `{
  "title":"Разбор встречи","inputKind":"transcript","scope":{"returns":["review"],"steps":[
    {"id":"transcript","title":"Подготовить расшифровку","kind":"input","reads":["$inputs"]},
    {"id":"decisions","title":"Составить протокол","kind":"agent","needs":["transcript"],
      "prompt":"Выдели принятые решения, приложи указатели на реплики."},
    {"id":"drafts","title":"Найти поручения","kind":"meetingTasks","needs":["transcript"],"reads":["$inputs"]},
    {"id":"check","title":"Проверить каждое поручение","kind":"forEach","needs":["drafts"],"source":"drafts","scope":{
      "returns":["draft"],"steps":[{"id":"draft","title":"Черновик поручения","kind":"agent","reads":["$item"],
        "prompt":"Сформулируй черновик задачи по этому поручению, сохрани исходный смысл."}]
    }},
    {"id":"summary","title":"Собрать протокол и черновики","kind":"join","mode":"all","needs":["decisions","check"]},
    {"id":"review","title":"Утвердить протокол и поручения","kind":"approval","needs":["summary"],
      "retryFrom":["decisions","drafts"]}
  ]}
}`

// Builtins отдаёт канонические документы шаблонов; валидатор проверяет их при выдаче.
// Названия отображаются переводом по стабильным ID, введённый текст клона — данные.
func Builtins() []BuiltinTemplate {
	return []BuiltinTemplate{
		{ID: "builtin-documents", Title: "Разбор документов", InputKind: "documents", Document: json.RawMessage(documentsTemplate)},
		{ID: "builtin-meeting", Title: "Разбор встречи", InputKind: "transcript", Document: json.RawMessage(meetingTemplate)},
	}
}