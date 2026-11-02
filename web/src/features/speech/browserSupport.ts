/**
 * Android WebView объявляет on-device API без обслуживающего его native binder.
 * Сам вызов завершает renderer, поэтому try/catch и проверка наличия метода не защищают.
 */
export function browserLocalSpeechAllowed(userAgent: string): boolean {
  return !/\bwv\b/u.test(userAgent);
}
