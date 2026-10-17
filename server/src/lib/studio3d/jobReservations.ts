export interface ReservationHold {
  amount: number;
  accepted: boolean;
  balanceBefore: number | null;
}

/**
 * Расчёт удерживает часть локальных резервов, ещё не отражённую доступным балансом.
 * Выбор аккаунта и допустимость отправки остаются у вызывающего кода.
 */
export function unreflectedReservationAmount(
  holds: readonly ReservationHold[],
  available: number | null,
): number {
  const pending = holds.filter((item) => item.accepted && item.balanceBefore !== null);
  const before = Math.max(0, ...pending.map((item) => item.balanceBefore!));
  const reflected = available === null ? 0 : Math.max(0, before - available);

  return holds.filter((item) => !item.accepted || item.balanceBefore === null)
    .reduce((total, item) => total + item.amount, 0)
    + Math.max(0, pending.reduce((total, item) => total + item.amount, 0) - reflected);
}
