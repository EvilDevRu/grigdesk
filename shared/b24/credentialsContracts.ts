// Публичный снимок подключения не содержит сохранённого пароля.
// Его поля совместно читают серверный store и адаптер настроек браузера.
// Безопасное представление для UI: без пароля.
export interface B24CredsView {
  configured: boolean;
  baseUrl: string;
  login: string;
}

