package runner

// policyAllowsSwitch решает, разрешён ли автоматический переход к следующему
// кандидату цепочки. Отказ до старта — причина сменить провайдера; отказ после
// работы модели и неизвестные классы оставляют исполнителя на месте, чтобы не
// платить дважды за один узел.
func policyAllowsSwitch(phase, class string, started bool) bool {
	if phase == "preflight" && !started {
		return class == "unavailable_preflight" || class == "route_unavailable"
	}
	if phase == "started" && started {
		return class == "limited" || class == "provider_unavailable"
	}
	return false
}
