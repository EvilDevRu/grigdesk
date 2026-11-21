package cli

import (
	"fmt"
	"io"
	"slices"

	"grigdesk.local/tools/utilities/factory/internal/route"
)

const maxRouteEditorInput = 64 * 1024 * 1024

type routeRequest struct {
	profile string
	dir     string
	mode    string
	flags   map[string]string
}

type routeFlags struct {
	required []string
	optional []string
}

var routeModes = map[string]routeFlags{
	"editor-check": {}, "editor-render": {}, "editor-step": {}, "editor-capabilities": {}, "current": {},
	"catalog":            {required: []string{"--catalog-hash"}},
	"route-hash":         {required: []string{"--catalog-hash", "--route"}},
	"describe-bootstrap": {required: []string{"--catalog-hash"}},
	"describe-route":     {required: []string{"--catalog-hash", "--route"}},
	"render-bootstrap":   {required: []string{"--catalog-hash", "--context"}, optional: []string{"--node"}},
	"render-route":       {required: []string{"--catalog-hash", "--route", "--node", "--context"}},
	"transition-bootstrap": {
		required: []string{"--catalog-hash", "--node", "--outcome"},
		optional: []string{"--failure-owner"},
	},
	"transition": {
		required: []string{"--catalog-hash", "--route", "--node", "--outcome"},
		optional: []string{"--failure-owner"},
	},
}

// parseRouteRequest проверяет глобальные параметры перед подкомандой.
// Параметры чтения закреплённого каталога принадлежат конкретному действию.
func parseRouteRequest(args []string) (routeRequest, error) {
	request := routeRequest{flags: make(map[string]string)}
	for len(args) != 0 {
		flag := args[0]
		if flag != "--profile" && flag != "--routes-dir" {
			break
		}
		if len(args) < 2 {
			return request, fmt.Errorf("%s: нужно значение", flag)
		}
		if flag == "--profile" {
			request.profile = args[1]
		} else {
			request.dir = args[1]
		}
		args = args[2:]
	}
	if len(args) == 0 {
		return request, fmt.Errorf("нужна подкоманда маршрута")
	}
	request.mode, args = args[0], args[1:]
	rules, known := routeModes[request.mode]
	if !known {
		return request, fmt.Errorf("неизвестная подкоманда: %s", request.mode)
	}
	if request.profile == "" {
		return request, fmt.Errorf("нужен --profile")
	}
	for len(args) != 0 {
		flag := args[0]
		if !slices.Contains(rules.required, flag) && !slices.Contains(rules.optional, flag) {
			return request, fmt.Errorf("неизвестный аргумент: %s", flag)
		}
		if len(args) < 2 {
			return request, fmt.Errorf("%s: нужно значение", flag)
		}
		request.flags[flag] = args[1]
		args = args[2:]
	}
	for _, flag := range rules.required {
		if _, exists := request.flags[flag]; !exists {
			return request, fmt.Errorf("нужен %s", flag)
		}
	}
	return request, nil
}

// runRoute разделяет чтение неизменяемых ревизий и операции редактора на stdin.
// Ошибки запроса редактора передаются через JSON, а ошибки чтения через stderr.
func runRoute(args []string, input io.Reader, out, diagnostic io.Writer) int {
	r, err := parseRouteRequest(args)
	if err != nil {
		fmt.Fprintf(diagnostic, "route v2: %s\n", err)
		return 2
	}
	switch r.mode {
	case "editor-check", "editor-render", "editor-step":
		return runRouteEditor(r, input, out)
	}
	var value any
	if r.mode == "editor-capabilities" {
		value, err = route.EditorCapabilities(r.profile)
	} else {
		value, err = r.immutable()
	}
	if err != nil {
		fmt.Fprintf(diagnostic, "route v2: %s\n", err)
		return 78
	}
	if text, ok := value.(string); ok {
		if _, err := io.WriteString(out, text); err != nil {
			return 1
		}
	} else if err := route.WriteJSON(out, value); err != nil {
		return 1
	}
	return 0
}

// runRouteEditor читает ограниченный JSON и возвращает его verdict неизменным.
// Диспетчер редактора не получает конфигурацию выполнения и пути к задачам.
func runRouteEditor(r routeRequest, input io.Reader, out io.Writer) int {
	data, err := io.ReadAll(io.LimitReader(input, maxRouteEditorInput+1))
	if err != nil || len(data) > maxRouteEditorInput {
		data = nil
	}
	var result map[string]any
	var accepted bool
	switch r.mode {
	case "editor-check":
		result, accepted = route.EditorCheck(data, r.profile)
	case "editor-render":
		result, accepted = route.EditorRender(data, r.profile)
	case "editor-step":
		result, accepted = route.EditorStep(data, r.profile)
	}
	if err := route.WriteJSON(out, result); err != nil {
		return 1
	}
	if !accepted {
		return 78
	}
	return 0
}

// immutable открывает конкретный каталог и только его закреплённый маршрут.
// В операциях с catalogHash текущий указатель не участвует.
func (r routeRequest) immutable() (any, error) {
	if r.dir == "" {
		return nil, fmt.Errorf("--routes-dir обязателен для команд immutable bundle")
	}
	reader, err := route.NewBundleReader(r.dir, r.profile)
	if err != nil {
		return nil, err
	}
	if r.mode == "current" {
		current, err := reader.ReadCurrent()
		if err != nil {
			return nil, err
		}
		return catalogResponse(r.profile, current), nil
	}
	catalog, err := reader.ReadCatalog(r.flags["--catalog-hash"])
	if err != nil {
		return nil, err
	}
	switch r.mode {
	case "catalog":
		return catalogResponse(r.profile, catalog), nil
	case "describe-bootstrap", "render-bootstrap", "transition-bootstrap":
		return r.apply(catalog, catalog.Bootstrap, "", "")
	}
	id := r.flags["--route"]
	hash := catalog.Routes[id]
	if hash == "" {
		return nil, fmt.Errorf("route %s: отсутствует в закреплённом каталоге", id)
	}
	if r.mode == "route-hash" {
		return hash + "\n", nil
	}
	bundle, err := reader.ReadRoute(id, hash)
	if err != nil {
		return nil, err
	}
	return r.apply(catalog, bundle, id, hash)
}

func catalogResponse(profile string, catalog route.CatalogBundle) map[string]any {
	return map[string]any{
		"schema": 2, "profile": profile, "catalogHash": catalog.Hash, "routes": catalog.Routes,
	}
}

// apply строит ответ из уже проверенной машины выбранной ревизии.
// Bootstrap не получает полей route и routeHash основного маршрута.
func (r routeRequest) apply(
	catalog route.CatalogBundle, bundle route.MachineBundle, id, hash string,
) (any, error) {
	switch r.mode {
	case "describe-bootstrap", "describe-route":
		result := map[string]any{
			"schema": 2, "profile": r.profile, "catalogHash": catalog.Hash, "machine": bundle.Machine,
		}
		if id != "" {
			result["route"], result["routeHash"] = id, hash
		}
		return result, nil
	case "render-bootstrap", "render-route":
		return route.RenderBundleFile(bundle, firstNonempty(r.flags["--node"], "scout"), r.flags["--context"])
	case "transition-bootstrap", "transition":
		owner := r.flags["--failure-owner"]
		result, err := bundle.Transition(r.flags["--node"], r.flags["--outcome"], owner)
		if err != nil {
			return nil, err
		}
		result["schema"], result["catalogHash"] = 2, catalog.Hash
		if id == "" {
			result["phase"] = "bootstrap"
		} else {
			result["route"], result["routeHash"] = id, hash
			result["failureOwner"] = nil
			if owner != "" {
				result["failureOwner"] = owner
			}
		}
		return result, nil
	default:
		return nil, fmt.Errorf("подкоманда недоступна")
	}
}

// checkCurrent подтверждает адрес каталога и возможности выбранного маршрута.
// Смена каталога возвращает отдельный код до каких-либо lifecycle эффектов.
func checkCurrent(r request, out, diagnostic io.Writer) int {
	profile := r.value("--profile")
	reader, err := route.NewBundleReader(r.routesDir(), profile)
	if err != nil {
		return fail(diagnostic, err)
	}
	current, err := reader.ReadCurrent()
	if err != nil {
		fmt.Fprintf(diagnostic, "route v2: %s\n", err)
		return fail(diagnostic, fmt.Errorf("current catalog v2 не прошёл проверку"))
	}
	if expected := r.value("--expected-catalog-hash"); expected != "" && expected != current.Hash {
		const message = "FACTORY_ERROR=catalog_changed EXPECTED=%s ACTUAL=%s\n"
		fmt.Fprintf(diagnostic, message, expected, current.Hash)
		return 75
	}
	result := fmt.Sprintf("OK profile=%s catalog=%s", profile, current.Hash)
	if id := r.value("--route"); id != "" {
		hash := current.Routes[id]
		if hash == "" {
			return fail(diagnostic, fmt.Errorf("route=%s отсутствует в current catalog", id))
		}
		machine, err := reader.ReadRoute(id, hash)
		if err != nil {
			return fail(diagnostic, err)
		}
		delivery, instrumentation := machine.LaunchTopology()
		result += fmt.Sprintf(" route=%s delivery=%s instrumentation=%s", id, delivery, instrumentation)
	}
	return printLine(out, result)
}
